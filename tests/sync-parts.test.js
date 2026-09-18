// Property tests for per-part clocks (v4.5).
//
// Two devices start from the same record, each makes random edits to a
// protocol (steps, reagent rows, text lines, titles) at its own time, and the
// two results are merged. Hundreds of random trials check the properties that
// make sync converge and behave the way the user expects:
//   1. order does not matter      merge(A, B) == merge(B, A)
//   2. repeating changes nothing  merge(M, M) == M, merge(M, A) == M
//   3. edits to different parts both survive
//   4. the same field: the later edit wins
//   5. an item deleted by one side stays deleted unless the other side edited
//      it after the deletion (latest wins)
//
// Usage: node tests/sync-parts.test.js [trials]
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const window = {
  URLSearchParams,
  URL,
  location: { search: "?sync-test", origin: "https://example.test", href: "https://example.test/" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    documentElement: { dataset: {} },
    getElementById: () => ({ hidden: false, dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }),
    createElement: () => ({}),
    addEventListener() {},
    visibilityState: "visible",
  },
  navigator: { onLine: true },
  addEventListener() {},
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  fetch: async () => ({ ok: false }),
  supabase: {
    createClient: () => ({
      auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} },
      from: () => ({}),
      rpc: async () => ({ data: [] }),
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel: async () => {},
    }),
  },
};
window.window = window;
window.globalThis = window;
vm.createContext(window);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "sync-app.js"), "utf8"), window);
const api = window.__expNoteSyncDiagnostics;
assert.ok(api?.partMerge, "diagnostics must expose partMerge");

// --- deterministic random ----------------------------------------------------
let seed = Number(process.env.SEED) || 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const canon = (value) => JSON.stringify(value, (key, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v);
const content = (record) => {
  const payload = clone(record.payload);
  delete payload.__sync;
  return canon(payload);
};

// Realistic wall-clock times: part tombstones older than 90 days are pruned.
const T = Date.now() - 3600 * 1000;

// --- a protocol record ---------------------------------------------------------
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;
function makeProtocol() {
  const steps = [];
  for (let s = 0; s < 4; s += 1) {
    const rows = [];
    for (let r = 0; r < 3; r += 1) rows.push({ id: nextId("row"), material: `물질${r}`, volume: `${10 * (r + 1)}` });
    steps.push({
      id: nextId("step"),
      title: `단계 ${s}`,
      panelRows: [{ id: nextId("pr"), texts: [{ id: nextId("t"), content: `설명 ${s}` }], panels: [{ id: nextId("pa"), type: "reagent", rows }] }],
    });
  }
  return {
    entity_type: "experiment_protocol",
    entity_id: "p:e:pr",
    payload: { parent_id: "p", experiment_id: "e", item_order: 0, item: { id: "pr", name: "프로토콜", summary: "개요", draftVersion: { id: "v1", stepGroups: steps } } },
    updated_at: new Date(T + 1000).toISOString(),
    client_id: "intent-v3:seed",
    deleted_at: null,
  };
}
const stepsOf = (item) => item.draftVersion.stepGroups;
const rowsOf = (step) => step.panelRows[0].panels[0].rows;

// Random edit on one step (so two devices can be kept on disjoint steps).
function editStep(item, stepIndex, label, log) {
  const step = stepsOf(item)[stepIndex];
  if (!step) return;
  const op = pick(["title", "row-volume", "row-delete", "row-add", "text-clear", "rows-clear"]);
  if (op === "title") {
    step.title = `${label} 제목 ${uid++}`;
    log.push({ kind: "leaf", path: ["step", step.id, "title"], value: step.title });
  } else if (op === "row-volume" && rowsOf(step).length) {
    const row = pick(rowsOf(step));
    row.volume = `${label}-${uid++}`;
    log.push({ kind: "leaf", path: ["row", step.id, row.id, "volume"], value: row.volume });
  } else if (op === "row-delete" && rowsOf(step).length) {
    const row = pick(rowsOf(step));
    step.panelRows[0].panels[0].rows = rowsOf(step).filter((r) => r.id !== row.id);
    log.push({ kind: "delete", path: ["row", step.id, row.id] });
  } else if (op === "row-add") {
    const row = { id: nextId(`${label}row`), material: `${label} 새 물질`, volume: "1" };
    rowsOf(step).push(row);
    log.push({ kind: "add", path: ["row", step.id, row.id] });
  } else if (op === "text-clear") {
    step.panelRows[0].texts = [];
    log.push({ kind: "list-cleared", path: ["texts", step.id] });
  } else {
    step.panelRows[0].panels[0].rows = [];
    log.push({ kind: "list-cleared", path: ["rows", step.id] });
  }
}
const withItem = (record, item, time, device) => ({
  ...clone(record),
  payload: { ...clone(record.payload), item },
  updated_at: new Date(time).toISOString(),
  client_id: `intent-v3:${device}`,
  local_intent: true,
});
const findStep = (record, id) => stepsOf(record.payload.item).find((s) => s.id === id);
const findRow = (record, stepId, rowId) => (findStep(record, stepId) ? rowsOf(findStep(record, stepId)) : []).find((r) => r.id === rowId);

// --- trials --------------------------------------------------------------------
const trials = Number(process.argv[2]) || 400;
let checked = 0;
for (let trial = 0; trial < trials; trial += 1) {
  const legacy = makeProtocol();
  // Base: a clocked record (the first local edit converts a legacy record).
  const base = api.partEdit(legacy, withItem(legacy, clone(legacy.payload.item), T + 2000, "base"), T + 2000);

  const tx = T + 5000 + Math.floor(rand() * 1000);
  const ty = tx + 1 + Math.floor(rand() * 1000); // Y edits strictly later
  const sameStep = rand() < 0.35; // sometimes both touch the same step
  const xStep = Math.floor(rand() * 4);
  const yStep = sameStep ? xStep : (xStep + 1 + Math.floor(rand() * 3)) % 4;

  const xItem = clone(base.payload.item);
  const yItem = clone(base.payload.item);
  const xLog = [];
  const yLog = [];
  for (let n = 0, m = 1 + Math.floor(rand() * 3); n < m; n += 1) editStep(xItem, xStep, "X", xLog);
  for (let n = 0, m = 1 + Math.floor(rand() * 3); n < m; n += 1) editStep(yItem, yStep, "Y", yLog);

  const X = api.partEdit(base, withItem(base, xItem, tx, "x"), tx);
  const Y = api.partEdit(base, withItem(base, yItem, ty, "y"), ty);
  const XY = api.partMerge(X, Y);
  const YX = api.partMerge(Y, X);

  const where = `trial ${trial} (sameStep=${sameStep}) X=${JSON.stringify(xLog)} Y=${JSON.stringify(yLog)}`;
  assert.ok(api.partMeta(X) && api.partMeta(Y) && api.partMeta(XY), `clocks must be trusted: ${where}`);
  // 1. order does not matter
  assert.strictEqual(content(XY), content(YX), `merge must be commutative: ${where}`);
  // 2. repeating changes nothing
  assert.strictEqual(content(api.partMerge(XY, XY)), content(XY), `idempotent: ${where}`);
  assert.strictEqual(content(api.partMerge(XY, X)), content(XY), `absorbs X: ${where}`);
  assert.strictEqual(content(api.partMerge(XY, Y)), content(XY), `absorbs Y: ${where}`);
  assert.strictEqual(content(api.partMerge(Y, XY)), content(XY), `absorbs from Y side: ${where}`);

  if (!sameStep) {
    // 3. different parts: every edit from both sides survives
    for (const [log, from] of [[xLog, X], [yLog, Y]]) {
      for (const entry of log) {
        const [kind, stepId, rowId, field] = entry.path;
        if (entry.kind === "leaf" && kind === "step") {
          assert.strictEqual(findStep(XY, stepId)?.title, findStep(from, stepId)?.title, `title kept: ${where}`);
        } else if (entry.kind === "leaf" && kind === "row") {
          const expected = findRow(from, stepId, rowId);
          if (expected) assert.strictEqual(findRow(XY, stepId, rowId)?.[field], expected[field], `cell kept: ${where}`);
        } else if (entry.kind === "delete") {
          assert.ok(!findRow(XY, stepId, rowId), `deleted row stays deleted: ${where}`);
        } else if (entry.kind === "add") {
          if (findRow(from, stepId, rowId)) assert.ok(findRow(XY, stepId, rowId), `added row kept: ${where}`);
        } else if (entry.kind === "list-cleared") {
          const step = findStep(XY, stepId);
          const list = kind === "texts" ? step.panelRows[0].texts : rowsOf(step);
          const fromList = kind === "texts" ? findStep(from, stepId).panelRows[0].texts : rowsOf(findStep(from, stepId));
          assert.strictEqual(canon(list), canon(fromList), `cleared list stays as the editor left it: ${where}`);
        }
      }
    }
  } else {
    // 4. same step: for a field both sides set, Y (later) wins
    for (const yEntry of yLog.filter((entry) => entry.kind === "leaf")) {
      const [kind, stepId, rowId, field] = yEntry.path;
      if (kind === "step") {
        assert.strictEqual(findStep(XY, stepId)?.title, findStep(Y, stepId)?.title, `later title wins: ${where}`);
      } else if (findRow(Y, stepId, rowId) && findRow(XY, stepId, rowId)) {
        assert.strictEqual(findRow(XY, stepId, rowId)[field], findRow(Y, stepId, rowId)[field], `later cell wins: ${where}`);
      }
    }
    // 5. X deleted a row that Y did not touch afterwards -> gone
    for (const xEntry of xLog.filter((entry) => entry.kind === "delete")) {
      const [, stepId, rowId] = xEntry.path;
      const touchedByY = yLog.some((entry) => entry.path[2] === rowId && entry.kind === "leaf");
      if (!touchedByY) assert.ok(!findRow(XY, stepId, rowId), `row deleted by X stays deleted: ${where}`);
    }
  }
  checked += 1;
}
console.log(`  PASS  부분별 병합 성질 ${checked}회 무작위 검사 (순서 무관·반복 불변·다른 부분 보존·같은 칸 최신·삭제 유지)`);
console.log(`\n${checked}/${trials} passed`);
