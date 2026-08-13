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
