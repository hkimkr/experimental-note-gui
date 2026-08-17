// Runs the real sync-app.js inside a minimal browser stub and asserts the
// sync rules that protect user data:
//   1. new local work is never lost,
//   2. existing content is never blanked or resurrected,
//   3. stale or partial snapshots can never delete anything.
// Usage: node tests/sync-rules.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function makeStubWindow() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const element = () => ({
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
  });
  const document = {
    documentElement: { dataset: {} },
    getElementById: () => element(),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
  const window = {
    URLSearchParams,
    JSON,
    Date,
    Math,
    Promise,
    Map,
    Set,
    location: { search: "?sync-test", origin: "https://example.test", href: "https://example.test/" },
    localStorage,
    document,
    navigator: { onLine: true },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          onAuthStateChange() {},
        },
        from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
        rpc: async () => ({ data: [] }),
        channel: () => ({ on() { return this; }, subscribe() { return this; } }),
        removeChannel: async () => {},
      }),
    },
  };
  window.window = window;
  window.globalThis = window;
  window.self = window;
  return window;
}

const sandbox = makeStubWindow();
vm.createContext(sandbox);
const source = fs.readFileSync(
  path.join(__dirname, "..", "sync-app.js"),
  "utf8"
);
vm.runInContext(source, sandbox);

const api = sandbox.window.__expNoteSyncDiagnostics;
assert.ok(api, "diagnostics API should be exposed with ?sync-test");

// Values returned from the sandbox belong to another realm, so compare by
// value rather than with deepStrictEqual's realm-sensitive checks.
const equalList = (actual, expected, message) =>
  assert.strictEqual(
    JSON.stringify([...actual]),
    JSON.stringify(expected),
    message
  );

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

const project = (overrides = {}) => ({
  id: "project-1",
  name: "실험 프로젝트",
  experiments: [],
  notes: [],
  inventory: [],
  memoSnapshots: [],
  memoScratch: { content: "" },
  ...overrides,
});

const note = (id, purpose) => ({ id, title: `노트 ${id}`, purpose });

const cloudStore = {
  activeProjectId: "project-1",
  projects: [
    project({
      notes: [note("note-1", "클라우드에 있는 내용")],
      experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
    }),
  ],
};

// --- Rule 1: new local work survives a refresh -----------------------------

check("새로 쓴 노트는 새로고침 후에도 살아남는다", () => {
  const localStore = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "클라우드에 있는 내용"), note("note-2", "새로 쓴 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({ remoteStore: cloudStore, localStore });
  assert.ok(result.noteIds.includes("note-2"), "새 노트가 유지되어야 함");
  assert.ok(result.noteIds.includes("note-1"), "기존 노트도 유지되어야 함");
});

check("기존 노트를 고친 내용은 새로고침 후에도 살아남는다", () => {
  const edited = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "방금 고친 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: edited,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
  });
  assert.strictEqual(result.notePurposes["note-1"], "방금 고친 내용");
  assert.ok(result.outboxCount > 0, "고친 내용이 업로드 대기해야 함");
});

check("며칠 전 스냅샷을 든 기기가 재접속해도 최신 클라우드를 덮지 않는다", () => {
  const daysOldLocal = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "3일 전에 쓰던 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: daysOldLocal,
    // 이 기기가 마지막으로 적용한 상태도, 로컬을 마지막으로 쓴 시각도
    // 클라우드 행(1000)보다 앞선다.
    lastAppliedFingerprint: api.fingerprintStore(daysOldLocal),
    localUpdatedAt: 500,
  });
  assert.strictEqual(result.notePurposes["note-1"], "클라우드에 있는 내용");
});

check("페이지를 열며 다시 보낸 저장본은 신선도 증거가 되지 않는다", () => {
  const storedRaw = JSON.stringify({ projects: [project({ notes: [note("note-1", "저장본")] })] });
  // 저장본을 그대로 다시 보낸 in-flight 스냅샷: 저장 시각(500)이 그대로여야 한다.
  assert.strictEqual(
    api.localFreshnessAt({ pendingRaw: storedRaw, storedRaw, storedUpdatedAt: 500, now: 9000 }),
    500
  );
  // 키 순서만 다른 같은 내용도 마찬가지.
  const reverseKeys = (value) =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseKeys(value[k])]))
        : value;
  const reordered = JSON.stringify(reverseKeys(JSON.parse(storedRaw)));
  assert.notStrictEqual(reordered, storedRaw);
  assert.strictEqual(
    api.localFreshnessAt({ pendingRaw: reordered, storedRaw, storedUpdatedAt: 500, now: 9000 }),
    500
  );
  // in-flight 스냅샷이 없으면 저장 시각을 그대로 쓴다. 시각이 없으면 증거 없음(0).
  assert.strictEqual(api.localFreshnessAt({ storedRaw, storedUpdatedAt: 500, now: 9000 }), 500);
  assert.strictEqual(api.localFreshnessAt({ storedRaw, storedUpdatedAt: 0, now: 9000 }), 0);
});

check("저장본과 다른 in-flight 스냅샷(아직 안 쓴 편집)은 지금 시각을 증거로 삼는다", () => {
  const storedRaw = JSON.stringify({ projects: [project({ notes: [note("note-1", "저장본")] })] });
  const editedRaw = JSON.stringify({ projects: [project({ notes: [note("note-1", "방금 고친 내용")] })] });
  assert.strictEqual(
    api.localFreshnessAt({ pendingRaw: editedRaw, storedRaw, storedUpdatedAt: 500, now: 9000 }),
    9000
  );
});

check("오래된 기기가 새로 열려 저장본을 다시 보내도 최신 클라우드를 덮지 않는다", () => {
  const daysOldLocal = {
    activeProjectId: "project-1",
    projects: [project({ notes: [note("note-1", "3일 전에 쓰던 내용")] })],
  };
  const storedRaw = JSON.stringify(daysOldLocal);
  // 예전 코드는 in-flight 스냅샷만 있으면 Date.now()를 증거로 삼아 이 게이트를 항상 통과시켰다.
  const localUpdatedAt = api.localFreshnessAt({
    pendingRaw: storedRaw,
    storedRaw,
    storedUpdatedAt: 500,
    now: 9000,
  });
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: daysOldLocal,
    // 지문이 마지막 적용본과 다르다고 가정(배포로 정규화 형태가 바뀐 경우 등).
    lastAppliedFingerprint: "something-else",
    localUpdatedAt,
  });
  assert.strictEqual(result.notePurposes["note-1"], "클라우드에 있는 내용");
});

// 규칙 5의 증거는 "실제 편집"만이다. LOCAL_UPDATED_KEY는 클라우드 내용을 이 기기에
// 적용할 때도 찍히므로, 셸은 USER_EDITED_KEY만 본다. 예전 버전에서 올라온 기기에는
// 이 키가 없는데, 그때는 "편집 기록 없음(0)"으로 읽는다.
const localStorageStub = sandbox.window.localStorage;
const STORAGE_KEY = "hamin-exp-note-v1";
const LOCAL_UPDATED_KEY = "hamin-exp-note-v1-local-updated-at";
const USER_EDITED_KEY = "hamin-exp-note-v1-user-edited-at";
const setStoredLocal = ({ raw = "", localUpdatedAt = null, userEditedAt = null }) => {
  localStorageStub.setItem(STORAGE_KEY, raw);
  if (localUpdatedAt === null) localStorageStub.removeItem(LOCAL_UPDATED_KEY);
  else localStorageStub.setItem(LOCAL_UPDATED_KEY, String(localUpdatedAt));
  if (userEditedAt === null) localStorageStub.removeItem(USER_EDITED_KEY);
  else localStorageStub.setItem(USER_EDITED_KEY, String(userEditedAt));
};

check("실제 사용자 편집은 오래된 클라우드 행보다 우선한다", () => {
  const editedLocal = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "방금 고친 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  setStoredLocal({
    raw: JSON.stringify(editedLocal),
    // 클라우드를 적용하며 찍힌 시각은 더 최근이지만, 증거로 쓰여선 안 된다.
    localUpdatedAt: 9000,
    userEditedAt: 5000,
  });
  const evidence = api.localEditEvidenceAt();
  assert.strictEqual(evidence, 5000, "셸은 사용자 편집 시각만 증거로 읽어야 함");
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: editedLocal,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    localUpdatedAt: evidence,
  });
  assert.strictEqual(result.notePurposes["note-1"], "방금 고친 내용");
});

check("편집 없이 페이지만 열면 규칙 5의 증거가 없다", () => {
  const daysOldLocal = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "3일 전에 쓰던 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const storedRaw = JSON.stringify(daysOldLocal);
  // 편집 없이 열기만 한 기기: 사용자 편집 키가 없고, 저장 시각만 방금 찍혀 있다.
  setStoredLocal({ raw: storedRaw, localUpdatedAt: 9000, userEditedAt: null });
  assert.strictEqual(api.localEditEvidenceAt(), 0, "편집 기록이 없으면 증거도 없어야 함");
  // 저장본을 그대로 다시 보낸 in-flight 스냅샷도 증거가 되지 않는다.
  assert.strictEqual(api.localEditEvidenceAt(storedRaw), 0);
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: daysOldLocal,
    lastAppliedFingerprint: "something-else",
    localUpdatedAt: api.localEditEvidenceAt(storedRaw),
  });
  assert.strictEqual(result.notePurposes["note-1"], "클라우드에 있는 내용");
});

check("아직 저장되지 않은 in-flight 편집은 편집 키가 없어도 증거가 된다", () => {
  const storedRaw = JSON.stringify({ projects: [project({ notes: [note("note-1", "저장본")] })] });
  const editedRaw = JSON.stringify({ projects: [project({ notes: [note("note-1", "방금 고친 내용")] })] });
  setStoredLocal({ raw: storedRaw, localUpdatedAt: 9000, userEditedAt: null });
  assert.ok(api.localEditEvidenceAt(editedRaw) > 0);
});

check("다른 기기가 보던 프로젝트가 이 기기의 화면을 끌고 가지 않는다", () => {
  const twoProjectCloud = {
    activeProjectId: "project-2",
    projects: [
      project({ notes: [note("note-1", "클라우드에 있는 내용")] }),
      project({ id: "project-2", name: "다른 프로젝트" }),
    ],
  };
  const localViewingFirst = { ...twoProjectCloud, activeProjectId: "project-1" };
  const result = api.simulate({
    remoteStore: twoProjectCloud,
    localStore: localViewingFirst,
    lastAppliedFingerprint: api.fingerprintStore(localViewingFirst),
  });
  assert.strictEqual(result.activeProjectId, "project-1");
});

// --- Rule 2: stale local never overwrites or resurrects --------------------

check("오래된 로컬 스냅샷이 클라우드를 덮어쓰지 않는다", () => {
  const staleLocal = {
    activeProjectId: "project-1",
    projects: [project({ notes: [note("note-1", "")] })],
  };
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: staleLocal,
  });
  assert.strictEqual(result.reason, "cloud-authoritative");
  assert.strictEqual(result.outboxCount, 0, "덮어쓰기 업로드가 없어야 함");
});

check("다른 기기에서 지운 노트가 로컬 스냅샷으로 되살아나지 않는다", () => {
  const localWithDeleted = {
    activeProjectId: "project-1",
    projects: [
      project({ notes: [note("note-1", "지워진 노트"), note("note-9", "남아있는 노트")] }),
    ],
  };
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: localWithDeleted,
    lastAppliedFingerprint: api.fingerprintStore(localWithDeleted),
    remoteTombstoneKeys: ["project_note::project-1:note-1"],
  });
  assert.ok(
    !result.noteIds.includes("note-1") && !result.visibleNoteIds.includes("note-1"),
    "클라우드 삭제는 로컬 스냅샷으로 되살아나면 안 됨"
  );
});

check("이 기기에서 지운 노트는 새로고침 후 다시 나타나면 안 된다", () => {
  const afterDelete = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: afterDelete,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    remoteTombstoneKeys: ["project_note::project-1:note-1"],
  });
  assert.ok(!result.visibleNoteIds.includes("note-1"));
  assert.ok(!result.noteIds.includes("note-1"));
});

check("빈 로컬 상태가 클라우드 내용을 지우지 않는다", () => {
  const blank = { projects: [project()] };
  const result = api.simulate({ remoteStore: cloudStore, localStore: blank });
  assert.ok(result.contentScore > 0, "클라우드 내용이 남아 있어야 함");
});

// --- Rule 3: deletions require proof --------------------------------------

check("스냅샷에서 노트가 빠지면 실제 삭제로 처리된다", () => {
  const afterDelete = {
    activeProjectId: "project-1",
    projects: [
      project({ experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }] }),
    ],
  };
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: afterDelete,
  });
  equalList(removed, ["project_note::project-1:note-1"]);
});

check("프로젝트가 통째로 빠진 스냅샷은 아무것도 지우지 않는다", () => {
  const missingProject = { projects: [project({ id: "project-2", name: "다른 프로젝트" })] };
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: missingProject,
  });
  equalList(removed, [], "확인 없이는 삭제 금지");
});

check("사용자가 확인한 프로젝트 삭제는 하위 항목까지 정리한다", () => {
  const missingProject = { projects: [project({ id: "project-2", name: "다른 프로젝트" })] };
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: missingProject,
    approvedProjectIds: ["project-1"],
  });
  assert.ok(removed.includes("project::project-1"), "프로젝트가 삭제되어야 함");
  assert.ok(
    removed.includes("project_note::project-1:note-1"),
    "하위 노트도 함께 삭제되어야 함"
  );
});

check("다른 탭이 방금 만든 항목은 이 탭 스냅샷 때문에 삭제되지 않는다", () => {
  // This tab still shows only note-1; note-7 arrived from another tab and was
  // never displayed here, so this tab's snapshot must not remove it.
  const withOtherTabNote = {
    activeProjectId: "project-1",
    projects: [
      project({ notes: [note("note-1", "클라우드에 있는 내용"), note("note-7", "다른 탭에서 작성")] }),
    ],
  };
  const thisTabSnapshot = {
    activeProjectId: "project-1",
    projects: [project({ notes: [note("note-1", "클라우드에 있는 내용")] })],
  };
  const removed = api.deletionPlan({
    currentStore: withOtherTabNote,
    snapshotStore: thisTabSnapshot,
    seenStore: thisTabSnapshot,
  });
  assert.ok(
    !removed.includes("project_note::project-1:note-7"),
    "다른 탭의 새 노트가 삭제되면 안 됨"
  );
});

check("불확실한(추가 전용) 스냅샷은 절대 삭제하지 않는다", () => {
  const afterDelete = { activeProjectId: "project-1", projects: [project()] };
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: afterDelete,
    additiveOnly: true,
  });
  equalList(removed, []);
});

// --- Rule 4: field-level merges keep content ------------------------------

check("빈 값이 기존 내용을 덮어쓰지 않는다", () => {
  const blanked = {
    projects: [project({ notes: [note("note-1", "")] })],
  };
  const merged = api.mergeStores(cloudStore, blanked);
  assert.strictEqual(merged.projects[0].notes[0].purpose, "클라우드에 있는 내용");
});

check("실제로 바뀐 값은 최신 내용이 이긴다", () => {
  const edited = {
    projects: [project({ notes: [note("note-1", "새로 고친 내용")] })],
  };
  const merged = api.mergeStores(cloudStore, edited);
  assert.strictEqual(merged.projects[0].notes[0].purpose, "새로 고친 내용");
});

// --- Rule 5b: an empty cloud must be proven before local is promoted -------

check("캐시엔 행이 있는데 조회가 0행이면 승격하지 않는다", () => {
  const daysOldLocal = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "3일 전에 쓰던 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    // 조회는 0행. 그러나 이 기기는 전에 클라우드 행을 받아 캐시에 갖고 있다.
    remoteStore: null,
    cachedStore: cloudStore,
    localStore: daysOldLocal,
    // 카운트 조회까지 0을 확인해줘도 캐시에 행이 있으면 승격은 금지다.
    remoteEmptyConfirmed: true,
  });
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.strictEqual(result.outboxCount, 0, "오래된 스냅샷을 올려선 안 됨");
});

check("확인되지 않은 빈 클라우드에는 로컬을 올리지 않는다", () => {
  const localOnly = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "이 기기에만 있는 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: null,
    localStore: localOnly,
    // 카운트 조회가 실패했거나 0이 아니라고 답한 상황.
    remoteEmptyConfirmed: false,
  });
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.strictEqual(result.outboxCount, 0, "확인 전에는 업로드 보류");
  assert.ok(result.contentScore > 0, "로컬 내용은 이 기기에 남아 있어야 함");
});

check("정말 빈 계정의 첫 동기화는 로컬 내용을 올린다", () => {
  const firstSyncLocal = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "처음 쓴 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: null,
    cachedStore: null,
    localStore: firstSyncLocal,
    remoteEmptyConfirmed: true,
  });
  assert.strictEqual(result.reason, "meaningful-local-recovery");
  assert.ok(result.outboxCount > 0, "빈 계정에는 로컬 내용을 올려야 함");
  assert.ok(result.intentOnly, "업로드는 의도 기록이어야 함");
});

// --- Rule 4 again: an all-deleted cloud is not an empty cloud --------------

// 이름이 자리표시자인 프로젝트: 프로젝트 행이 살아 있어도 클라우드 점수가 0이라,
// "클라우드가 아무 말도 하지 않았다"고 판정되는 경로를 지나간다. 옛 전체 저장소
// 동기화가 남긴 빈 행이 이 모양이다.
const placeholderProject = (overrides = {}) =>
  project({ id: "default", name: "기본 프로젝트", ...overrides });

check("전부 삭제된 클라우드는 빈 클라우드가 아니다", () => {
  // 휴대폰에서 전부 지운 상태. 클라우드 행은 남아 있지만 모두 삭제 표시이고,
  // 이 기기는 옛 로컬 내용과 예전에 받아둔 캐시를 들고 있다.
  const result = api.simulate({
    remoteStore: cloudStore,
    remoteAllDeleted: true,
    cachedStore: cloudStore,
    localStore: cloudStore,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    // 카운트 조회는 삭제된 행까지 세므로 0을 확인해줄 수 없다.
    remoteEmptyConfirmed: false,
  });
  assert.ok(result.remoteRowCount > 0, "클라우드에 행이 있어야 하는 상황");
  assert.strictEqual(
    result.remoteTombstoneCount,
    result.remoteRowCount,
    "모든 행이 삭제 행인 상황"
  );
  assert.strictEqual(
    result.remoteSaysNothing,
    false,
    "행이 있는 클라우드는 침묵이 아니다"
  );
  assert.notStrictEqual(
    result.reason,
    "remote-empty-unverified",
    "삭제된 클라우드에 승격/보류 분기로 들어가면 안 됨"
  );
  assert.notStrictEqual(result.reason, "meaningful-local-recovery");
  assert.ok(!result.noteIds.includes("note-1"), "지운 노트가 되살아나면 안 됨");
  assert.ok(!result.visibleNoteIds.includes("note-1"));
  assert.strictEqual(result.outboxCount, 0, "지운 내용을 다시 올려선 안 됨");
});

check("업로드를 보류하는 동안에도 클라우드 삭제는 적용된다", () => {
  // 조회는 삭제 행 하나와 빈 행들만 돌려줬다(점수 0). 캐시에 행이 있어 승격은
  // 금지되지만, 클라우드가 지웠다고 말한 노트는 사라져야 한다.
  const placeholderCloud = {
    activeProjectId: "default",
    projects: [placeholderProject({ notes: [note("note-1", "클라우드에 있던 내용")] })],
  };
  const result = api.simulate({
    remoteStore: placeholderCloud,
    remoteTombstoneKeys: ["project_note::default:note-1"],
    cachedStore: placeholderCloud,
    localStore: placeholderCloud,
    lastAppliedFingerprint: api.fingerprintStore(placeholderCloud),
    remoteEmptyConfirmed: false,
  });
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.strictEqual(result.remoteTombstoneCount, 1);
  assert.strictEqual(result.outboxCount, 0, "보류 중에는 올리지 않는다");
  assert.ok(
    !result.noteIds.includes("note-1") && !result.visibleNoteIds.includes("note-1"),
    "업로드를 보류해도 클라우드 삭제는 반영되어야 함"
  );
});

check("행은 있지만 내용이 빈 클라우드는 내용 있는 기기를 지우지 않는다", () => {
  const blankCloudRows = {
    activeProjectId: "default",
    projects: [placeholderProject()],
  };
  const richDevice = {
    activeProjectId: "default",
    projects: [
      placeholderProject({
        notes: [note("note-1", "이 기기에 있는 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: blankCloudRows,
    cachedStore: richDevice,
    outboxStore: blankCloudRows,
    localStore: richDevice,
  });
  assert.ok(result.remoteRowCount > 0, "클라우드에 행은 있다");
  assert.strictEqual(result.remoteTombstoneCount, 0, "빈 행은 삭제 행이 아니다");
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.ok(
    result.visibleNoteIds.includes("note-1"),
    "빈 행이 이 기기의 내용을 지우면 안 됨"
  );
  assert.ok(result.contentScore > 0);
});

check("조회에 실패해도 로컬 스냅샷을 통째로 업로드 대기로 올리지 않는다", () => {
  const result = api.simulate({ remoteFetched: false, localStore: cloudStore });
  assert.strictEqual(result.reason, "offline-local");
  assert.strictEqual(result.outboxCount, 0, "조회 없이 올릴 것을 만들면 안 됨");
  assert.ok(
    result.visibleNoteIds.includes("note-1"),
    "로컬 내용은 이 기기에 남아 있어야 함"
  );
  // 옛 승격 분기의 전제는 "내용은 있는데 레코드는 0개"였다. 내용이 있는 스냅샷은
  // 언제나 최소한 root 행을 만들므로 그 전제는 성립할 수 없다.
  [
    cloudStore,
    { projects: [{ name: "이름만 있는 프로젝트" }] },
    { projects: [project({ notes: [note("note-1", "내용")] })] },
  ].forEach((localStore) => {
    const offline = api.simulate({ remoteFetched: false, localStore });
    assert.ok(
      offline.localRecordCount > 0,
      "내용이 있는 스냅샷은 항상 레코드를 만든다"
    );
    assert.strictEqual(offline.reason, "offline-local");
  });
});

check("다른 기기가 올린 최신은 이 기기의 옛 화면에 가려지지 않는다", () => {
  const phoneLatest = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "핸드폰에서 고친 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  // 노트 내용은 캐시와 같은데, 화면 상태만 달라 전체 지문이 어긋난다.
  // 예전에는 이  Drift 만으로 모든 행이 "로컬 편집"이 되어 핸드폰 내용을 덮었다.
  const desktopOld = {
    ...cloudStore,
    settings: { receivedProtocolTransferIds: ["stale-view"] },
  };
  const result = api.simulate({
    remoteStore: phoneLatest,
    cachedStore: cloudStore,
    localStore: desktopOld,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    localUpdatedAt: 9000,
  });
  assert.strictEqual(result.notePurposes["note-1"], "핸드폰에서 고친 내용");
});

check("캐시와 같은 아웃박스는 다른 기기의 최신 클라우드를 덮지 않는다", () => {
  const phoneLatest = {
    activeProjectId: "project-1",
    projects: [
      project({
        notes: [note("note-1", "핸드폰에서 고친 내용")],
        experiments: [{ id: "exp-1", name: "실험 A", protocols: [] }],
      }),
    ],
  };
  const result = api.simulate({
    remoteStore: phoneLatest,
    cachedStore: cloudStore,
    outboxStore: cloudStore,
    outboxIntent: true,
    localStore: cloudStore,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
  });
  assert.strictEqual(result.notePurposes["note-1"], "핸드폰에서 고친 내용");
});

// --- Report ---------------------------------------------------------------

let failed = 0;
results.forEach(({ name, ok, message }) => {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
});
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
