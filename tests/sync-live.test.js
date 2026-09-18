// Live, two-device integration test for sync-app.js.
//
// sync-rules.test.js checks the merge rules one function at a time. This file
// runs the whole shell twice — a "desktop" and a "phone", each in its own VM
// with its own localStorage, IndexedDB and app iframe — against one fake
// Supabase server and one shared fake clock. It drives the same messages the
// real app sends (focus, typing, visibility changes) and asserts on what each
// device's app actually ends up showing.
//
// The server is faithful where it matters: upsert is last-writer-wins on
// updated_at exactly like upsert_exp_note_records, it stamps
// server_received_at, and realtime can die silently per channel (a phone that
// was backgrounded) without ever reporting CLOSED.
//
// Usage: node tests/sync-live.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const nodeCrypto = require("crypto");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "sync-app.js"), "utf8");
const APP_VERSION = (SOURCE.match(/const APP_VERSION = "([^"]+)"/) || [])[1] || "0";
const STORAGE_KEY = "hamin-exp-note-v1";
const LOCAL_UPDATED_KEY = "hamin-exp-note-v1-local-updated-at";
const USER_EDITED_KEY = "hamin-exp-note-v1-user-edited-at";
const USER_ID = "user-1";
const ORIGIN = "https://example.test";
const hostImmediate = setImmediate;
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// --- shared fake clock and timers ------------------------------------------
let clock;
let timers;
let timerSeq;
function resetClock() {
  clock = { now: Date.UTC(2026, 8, 19, 0, 0, 0) };
  timers = new Map();
  timerSeq = 0;
}
const addTimer = (fn, ms, interval) => {
  timerSeq += 1;
  timers.set(timerSeq, {
    at: clock.now + Math.max(0, Number(ms) || 0),
    fn,
    interval: interval ? Math.max(1, Number(interval)) : 0,
  });
  return timerSeq;
};
const scheduler = {
  setTimeout: (fn, ms) => addTimer(fn, ms, 0),
  setInterval: (fn, ms) => addTimer(fn, ms, ms),
  clearTimeout: (id) => timers.delete(id),
  clearInterval: (id) => timers.delete(id),
};
async function settle(rounds = 80) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => hostImmediate(resolve));
}
async function advance(ms) {
  const target = clock.now + ms;
  for (;;) {
    let nextId = null;
    let next = null;
    for (const [id, timer] of timers) {
      if (timer.at <= target && (!next || timer.at < next.at)) {
        next = timer;
        nextId = id;
      }
    }
    if (!next) break;
    clock.now = Math.max(clock.now, next.at);
    if (next.interval) next.at = clock.now + next.interval;
    else timers.delete(nextId);
    try {
      next.fn();
    } catch (error) {
      console.error("timer threw:", error);
    }
    await settle();
  }
  clock.now = target;
  await settle();
}
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(clock.now);
    else super(...args);
  }
  static now() {
    return clock.now;
  }
}

// --- fake IndexedDB (only what sync-app.js uses) ---------------------------
function makeIndexedDB() {
  const stores = new Map();
  let upgraded = false;
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, options) {
      stores.set(name, { keyPath: options.keyPath, rows: new Map() });
    },
    transaction() {
      const tx = { oncomplete: null, onerror: null, error: null };
      // Completes after every request queued in this same tick has run.
      hostImmediate(() => hostImmediate(() => tx.oncomplete && tx.oncomplete()));
      tx.objectStore = (name) => {
        const store = stores.get(name);
        const request = (op) => {
          const req = { onsuccess: null, onerror: null, result: undefined };
          hostImmediate(() => {
            req.result = op();
            if (req.onsuccess) req.onsuccess({ target: req });
          });
          return req;
        };
        return {
          getAll: () => request(() => [...store.rows.values()].map(clone)),
          put: (value) => request(() => void store.rows.set(value[store.keyPath], clone(value))),
          delete: (key) => request(() => void store.rows.delete(key)),
        };
      };
      return tx;
    },
    close() {},
  };
  return {
    open() {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db };
      hostImmediate(() => {
        if (!upgraded) {
          upgraded = true;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

// --- fake Supabase server --------------------------------------------------
let server;
function resetServer() {
  server = {
    rows: new Map(),
    channels: new Set(),
    lastStamp: 0,
    offline: new Set(),
    upserts: [],
  };
}
const rowKey = (row) => `${row.entity_type}::${row.entity_id}`;
function serverStamp() {
  // Postgres now() has microseconds; keep stamps strictly increasing here.
  server.lastStamp = Math.max(clock.now, server.lastStamp + 1);
  return new Date(server.lastStamp).toISOString();
}
function serverUpsert(items, deviceName) {
  const changed = [];
  for (const item of items) {
    const key = rowKey(item);
    const existing = server.rows.get(key);
    // upsert_exp_note_records: ... where existing.updated_at <= excluded.updated_at
    if (existing && Date.parse(existing.updated_at) > Date.parse(item.updated_at)) continue;
    const row = {
      user_id: USER_ID,
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      payload: clone(item.payload),
      updated_at: item.updated_at,
      deleted_at: item.deleted_at ?? null,
      client_id: item.client_id,
      server_received_at: serverStamp(),
    };
    server.rows.set(key, row);
    changed.push(row);
  }
  server.upserts.push({ deviceName, count: changed.length });
  for (const channel of server.channels) {
    if (channel.dead || !channel.cb) continue;
    for (const row of changed) hostImmediate(() => channel.cb({ new: clone(row) }));
  }
}
function makeQuery(table, deviceName) {
  const query = { filters: [], orders: [], from: 0, to: Infinity, head: false };
  const builder = {
    select(_cols, options) {
      if (options?.head) query.head = true;
      return builder;
    },
    eq(col, val) {
      query.filters.push((row) => String(row[col]) === String(val));
      return builder;
    },
    in(col, vals) {
      const set = new Set(vals.map(String));
      query.filters.push((row) => set.has(String(row[col])));
      return builder;
    },
    gt(col, val) {
      query.filters.push((row) => String(row[col]) > String(val));
      return builder;
    },
    gte(col, val) {
      query.filters.push((row) => String(row[col]) >= String(val));
      return builder;
    },
    order(col, options) {
      query.orders.push([col, options?.ascending !== false]);
      return builder;
    },
    range(from, to) {
      query.from = from;
      query.to = to;
      return builder;
    },
    then(resolve) {
      hostImmediate(() => {
        if (server.offline.has(deviceName)) {
          resolve({ data: null, error: { message: "offline" } });
          return;
        }
        let rows = table === "exp_note_records" ? [...server.rows.values()] : [];
        rows = rows.filter((row) => query.filters.every((filter) => filter(row)));
        for (let i = query.orders.length - 1; i >= 0; i -= 1) {
          const [col, asc] = query.orders[i];
          rows.sort((a, b) => {
            const x = String(a[col]);
            const y = String(b[col]);
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        if (query.head) {
          resolve({ count: rows.length, data: null, error: null });
          return;
        }
        rows = rows.slice(query.from, query.to === Infinity ? undefined : query.to + 1);
        resolve({ data: rows.map(clone), error: null });
      });
    },
  };
  return builder;
}
function makeClient(deviceName) {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER_ID, email: "t@example.test" } } } }),
      onAuthStateChange() {},
      signOut: async () => ({}),
    },
    from: (table) => makeQuery(table, deviceName),
    rpc: (name, args) =>
      new Promise((resolve) =>
        hostImmediate(() => {
          if (server.offline.has(deviceName)) {
            resolve({ data: null, error: { message: "offline" } });
            return;
          }
          if (name === "upsert_exp_note_records") {
            serverUpsert(args.p_records || [], deviceName);
            resolve({ data: null, error: null });
            return;
          }
          resolve({ data: [], error: null });
        })
      ),
    channel: () => {
      const channel = {
        device: deviceName,
        cb: null,
        dead: false,
        on(_event, filter, cb) {
          if (filter?.table === "exp_note_records") channel.cb = cb;
          return channel;
        },
        subscribe(cb) {
          server.channels.add(channel);
          if (cb) hostImmediate(() => cb("SUBSCRIBED"));
          return channel;
        },
      };
      return channel;
    },
    removeChannel: async (channel) => {
      server.channels.delete(channel);
    },
  };
}

// --- one device: a full shell + a fake app iframe --------------------------
function makeElement() {
  const element = {
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    title: "",
    dataset: {},
    style: {},
    children: [],
    onclick: null,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
  };
  Object.defineProperty(element, "innerHTML", {
    get: () => "",
    set: () => {
      element.children = [];
    },
  });
  return element;
}

function makeDevice(name, { seedStore = null } = {}) {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const sessionMap = new Map();
  const sessionStorage = {
    getItem: (key) => (sessionMap.has(key) ? sessionMap.get(key) : null),
    setItem: (key, value) => sessionMap.set(key, String(value)),
    removeItem: (key) => sessionMap.delete(key),
  };
  const winListeners = new Map();
  const docListeners = new Map();
  const addTo = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const removeFrom = (map) => (type, fn) => {
    const list = map.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  const fire = (map, type, event = {}) => {
    for (const fn of [...(map.get(type) || [])]) fn(event);
  };

  const elements = new Map();
  const document = {
    visibilityState: "visible",
    documentElement: { dataset: {} },
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement: () => makeElement(),
    addEventListener: addTo(docListeners),
    removeEventListener: removeFrom(docListeners),
  };

  const app = { store: null, pushes: 0 };
  // Messages from the app to the shell are asynchronous, like postMessage.
  const toShell = (data) =>
    hostImmediate(() => fire(winListeners, "message", { origin: ORIGIN, source: frameWindow, data }));
  const frameWindow = {
    postMessage(message) {
      if (message?.type === "exp-note-cloud-store" && message.store) {
        app.store = clone(message.store);
        app.pushes += 1;
        // The real iframe applies the store and acknowledges right away.
        toShell({ type: "exp-note-cloud-store-applied", fingerprint: message.fingerprint || "" });
      }
    },
  };
  elements.set("exp-note-frame", Object.assign(makeElement(), { contentWindow: frameWindow }));

  if (seedStore) {
    const raw = JSON.stringify(seedStore);
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(LOCAL_UPDATED_KEY, String(clock.now));
    localStorage.setItem(USER_EDITED_KEY, String(clock.now));
    app.store = clone(seedStore);
  }

  const windowObject = {
    location: { search: "", origin: ORIGIN, href: `${ORIGIN}/` },
    localStorage,
    sessionStorage,
    document,
    navigator: { onLine: true },
    addEventListener: addTo(winListeners),
    removeEventListener: removeFrom(winListeners),
    ...scheduler,
    supabase: { createClient: () => makeClient(name) },
    fetch: async () => ({ ok: true, json: async () => ({ version: APP_VERSION }) }),
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    indexedDB: makeIndexedDB(),
    Date: FakeDate,
    URL,
    URLSearchParams,
    structuredClone,
    console,
  };
  windowObject.window = windowObject;
  windowObject.globalThis = windowObject;
  windowObject.self = windowObject;
  vm.createContext(windowObject);
  vm.runInContext(SOURCE, windowObject);

  const device = {
    name,
    app,
    localStorage,
    async ready() {
      await settle();
      toShell({ type: "exp-note-ready" });
      await settle();
    },
    // Cursor lands in a text field (the app posts this on focusin).
    focus() {
      toShell({ type: "exp-note-editing", editing: true, raw: "" });
    },
    // What app.html's signalDeleteItem posts right before removing an item.
    signalDelete(entityType, projectId, itemId, experimentId = null) {
      toShell({ type: "exp-note-delete-item", entityType, projectId, itemId, experimentId });
    },
    // Cursor leaves every text field.
    blur() {
      toShell({ type: "exp-note-editing", editing: false, raw: JSON.stringify(app.store) });
    },
    // The user changes content: exactly what the app's save effect does.
    edit(mutate) {
      const next = mutate(clone(app.store));
      const raw = JSON.stringify(next);
      const edited = raw !== localStorage.getItem(STORAGE_KEY);
      app.store = next;
      toShell({ type: "exp-note-local-store", raw });
      localStorage.setItem(STORAGE_KEY, raw);
      localStorage.setItem(LOCAL_UPDATED_KEY, String(clock.now));
      if (edited) localStorage.setItem(USER_EDITED_KEY, String(clock.now));
    },
    // App goes to the background. Its realtime socket dies without telling
    // anyone, which is what mobile browsers do.
    background() {
      for (const channel of server.channels) if (channel.device === name) channel.dead = true;
      document.visibilityState = "hidden";
      fire(docListeners, "visibilitychange");
      fire(winListeners, "pagehide");
    },
    foreground() {
      document.visibilityState = "visible";
      fire(docListeners, "visibilitychange");
      fire(winListeners, "pageshow");
      fire(winListeners, "focus");
    },
    killRealtimeSilently() {
      for (const channel of server.channels) if (channel.device === name) channel.dead = true;
    },
    note(id) {
      for (const project of app.store?.projects || []) {
        for (const item of project.notes || []) if (item.id === id) return item.purpose;
      }
      return undefined;
    },
  };
  return device;
}

const setNote = (id, purpose) => (store) => {
  store.projects.forEach((project) => {
    project.notes = project.notes.map((item) => (item.id === id ? { ...item, purpose } : item));
  });
  return store;
};
const serverNote = (id) => server.rows.get(`project_note::p1:${id}`)?.payload?.item?.purpose;

const SEED = {
  activeProjectId: "p1",
  projects: [
    {
      id: "p1",
      name: "프로젝트",
      experiments: [],
      notes: [
        { id: "n1", title: "노트 1", purpose: "처음 내용 1" },
        { id: "n2", title: "노트 2", purpose: "처음 내용 2" },
      ],
      inventory: [],
      memoSnapshots: [],
      memoScratch: { content: "" },
    },
  ],
};

async function twoDevices() {
  resetClock();
  resetServer();
  const desktop = makeDevice("desktop", { seedStore: SEED });
  await desktop.ready();
  await advance(3000); // desktop uploads its store into the empty account
  const phone = makeDevice("phone");
  await phone.ready();
  await advance(3000);
  assert.strictEqual(phone.note("n1"), "처음 내용 1", "setup: phone should load the account");
  return { desktop, phone };
}

// --- scenarios -------------------------------------------------------------
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario("커서만 올려 둔 기기(입력 없음)도 다른 기기의 수정을 받는다", async () => {
  const { desktop, phone } = await twoDevices();
  desktop.focus(); // cursor parked in a note, nothing typed
  await advance(500);
  phone.edit(setNote("n1", "폰에서 고친 내용"));
  await advance(10000);
  assert.strictEqual(serverNote("n1"), "폰에서 고친 내용", "phone edit reached the server");
  assert.strictEqual(desktop.note("n1"), "폰에서 고친 내용", "desktop shows the phone edit");
});

scenario("앱 복귀 때 커서가 다시 잡혀도 꺼져 있던 동안의 수정을 따라잡는다", async () => {
  const { desktop, phone } = await twoDevices();
  phone.focus();
  await advance(500);
  phone.background();
  await advance(1000);
  desktop.edit(setNote("n1", "폰이 꺼진 동안 컴퓨터가 고침"));
  await advance(5000);
  phone.foreground();
  phone.focus(); // the browser restores focus to the same textarea
  await settle(); // focus restoration arrives before the 220 ms resume timer
  await advance(10000);
  assert.strictEqual(phone.note("n1"), "폰이 꺼진 동안 컴퓨터가 고침");
});

scenario("실시간이 조용히 끊겨도 잠시 뒤 따라잡는다", async () => {
  const { desktop, phone } = await twoDevices();
  phone.killRealtimeSilently();
  desktop.edit(setNote("n1", "실시간 없이 전달돼야 하는 내용"));
  await advance(90000);
  assert.strictEqual(phone.note("n1"), "실시간 없이 전달돼야 하는 내용");
});

scenario("폰을 꺼둔 사이 컴퓨터가 고친 내용이 폰을 켜면 보이고, 폰은 아무것도 덮지 않는다", async () => {
  const { desktop, phone } = await twoDevices();
  phone.background();
  await advance(1000);
  desktop.edit(setNote("n1", "컴퓨터가 나중에 고친 내용"));
  await advance(5000);
  phone.foreground();
  await advance(10000);
  assert.strictEqual(phone.note("n1"), "컴퓨터가 나중에 고친 내용", "phone shows it");
  assert.strictEqual(serverNote("n1"), "컴퓨터가 나중에 고친 내용", "phone did not overwrite");
  assert.strictEqual(desktop.note("n1"), "컴퓨터가 나중에 고친 내용", "desktop keeps it");
});

scenario("입력하는 동안은 화면을 덮지 않고, 멈추면 다른 기기 수정이 반영된다", async () => {
  const { desktop, phone } = await twoDevices();
  desktop.focus();
  desktop.edit(setNote("n2", "컴퓨터 입력 1"));
  await advance(300);
  phone.edit(setNote("n1", "폰에서 고친 내용"));
  await advance(900);
  desktop.edit(setNote("n2", "컴퓨터 입력 2"));
  await advance(900);
  desktop.edit(setNote("n2", "컴퓨터 입력 3"));
  await advance(900);
  assert.strictEqual(desktop.note("n2"), "컴퓨터 입력 3", "typing is never overwritten");
  await advance(10000); // stops typing, cursor still in the field
  assert.strictEqual(desktop.note("n2"), "컴퓨터 입력 3", "typed text survives the apply");
  assert.strictEqual(desktop.note("n1"), "폰에서 고친 내용", "phone edit shows after typing stops");
  assert.strictEqual(serverNote("n2"), "컴퓨터 입력 3");
  assert.strictEqual(phone.note("n2"), "컴퓨터 입력 3", "phone receives the desktop typing");
});

scenario("같은 노트를 양쪽에서 고치면 나중 수정이 양쪽에 남는다", async () => {
  const { desktop, phone } = await twoDevices();
  desktop.edit(setNote("n1", "컴퓨터가 먼저"));
  await advance(3000);
  phone.edit(setNote("n1", "폰이 나중에"));
  await advance(10000);
  assert.strictEqual(serverNote("n1"), "폰이 나중에");
  assert.strictEqual(desktop.note("n1"), "폰이 나중에");
  assert.strictEqual(phone.note("n1"), "폰이 나중에");
});

scenario("아무 변화가 없으면 화면을 다시 그리지 않는다 (5분)", async () => {
  const { desktop, phone } = await twoDevices();
  const before = { desktop: desktop.app.pushes, phone: phone.app.pushes, upserts: server.upserts.length };
  await advance(5 * 60 * 1000);
  assert.strictEqual(desktop.app.pushes, before.desktop, "desktop screen was not redrawn");
  assert.strictEqual(phone.app.pushes, before.phone, "phone screen was not redrawn");
  assert.strictEqual(server.upserts.length, before.upserts, "nothing was uploaded");
});

scenario("다른 기기 수정 1건은 화면 갱신 1번으로 끝난다 (30초마다 반복하지 않음)", async () => {
  const { desktop, phone } = await twoDevices();
  const before = desktop.app.pushes;
  phone.edit(setNote("n1", "한 번만 반영"));
  await advance(5 * 60 * 1000);
  assert.strictEqual(desktop.note("n1"), "한 번만 반영");
  assert.ok(
    desktop.app.pushes - before <= 1,
    `desktop redrawn ${desktop.app.pushes - before} times for one edit`
  );
});

scenario("오래 타자 치는 동안 다른 기기가 같은 노트를 고쳐도 치던 글은 남는다", async () => {
  const { desktop, phone } = await twoDevices();
  desktop.focus();
  for (let i = 1; i <= 20; i += 1) {
    desktop.edit(setNote("n1", `컴퓨터에서 치는 중 ${i}`));
    if (i === 5) phone.edit(setNote("n1", "폰이 중간에 고침"));
    await advance(1000); // one keystroke burst per second, never idle for 3 s
    assert.strictEqual(desktop.note("n1"), `컴퓨터에서 치는 중 ${i}`, `typing clobbered at ${i}`);
  }
  await advance(20000);
  // The desktop typed last, so its text wins everywhere (latest wins).
  assert.strictEqual(desktop.note("n1"), "컴퓨터에서 치는 중 20");
  assert.strictEqual(serverNote("n1"), "컴퓨터에서 치는 중 20");
  assert.strictEqual(phone.note("n1"), "컴퓨터에서 치는 중 20");
});

scenario("실시간이 끊긴 기기는 따라잡은 뒤 실시간 연결을 다시 맺는다", async () => {
  const { desktop, phone } = await twoDevices();
  phone.killRealtimeSilently();
  desktop.edit(setNote("n1", "첫 번째"));
  await advance(40000); // caught up by polling, then reconnects
  assert.strictEqual(phone.note("n1"), "첫 번째");
  desktop.edit(setNote("n1", "두 번째"));
  await advance(3000); // well under the 30 s poll: must come via realtime again
  assert.strictEqual(phone.note("n1"), "두 번째", "realtime was re-established");
});

scenario("한 번에 여러 항목이 바뀌어도 (프로토콜 저장 등) 화면은 한 번만 다시 그린다", async () => {
  const { desktop, phone } = await twoDevices();
  const before = desktop.app.pushes;
  phone.edit((store) => {
    const project = store.projects[0];
    for (let i = 3; i <= 12; i += 1) project.notes.push({ id: `n${i}`, title: `노트 ${i}`, purpose: `새 노트 ${i}` });
    project.notes[0] = { ...project.notes[0], purpose: "같이 고침" };
    return store;
  });
  await advance(10000);
  assert.strictEqual(desktop.note("n12"), "새 노트 12");
  assert.strictEqual(desktop.note("n1"), "같이 고침");
  assert.ok(
    desktop.app.pushes - before <= 1,
    `desktop redrawn ${desktop.app.pushes - before} times for one save of 11 rows`
  );
});

// --- protocol contents -----------------------------------------------------
const PROTOCOL_SEED = {
  activeProjectId: "p1",
  projects: [
    {
      id: "p1",
      name: "프로젝트",
      notes: [{ id: "n1", title: "노트 1", purpose: "처음" }],
      experiments: [
        {
          id: "e1",
          name: "실험",
          memo: "",
          protocols: [
            {
              id: "pr1",
              name: "프로토콜 A",
              summary: "개요",
              beforeStarting: [{ id: "b1", title: "준비물 1" }, { id: "b2", title: "준비물 2" }],
              activeVersionId: "v1",
              versions: [{ id: "v1", label: "v1", stepGroups: [] }],
              draftVersion: {
                id: "v1",
                label: "v1",
                stepGroups: [
                  {
                    id: "s1",
                    title: "1단계 분주",
                    panelRows: [
                      {
                        id: "r1",
                        texts: [{ id: "t1", content: "설명 줄", position: "before" }],
                        panels: [
                          {
                            id: "pa1",
                            type: "reagent",
                            title: "시약",
                            rows: [
                              { id: "rg1", material: "PBS", volume: "100" },
                              { id: "rg2", material: "DMEM", volume: "50" },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  { id: "s2", title: "2단계 배양", panelRows: [] },
                  { id: "s3", title: "3단계 측정", panelRows: [] },
                ],
              },
            },
          ],
        },
      ],
      inventory: [],
      memoSnapshots: [],
      memoScratch: { content: "" },
    },
  ],
};
const protocolOf = (store) => store?.projects?.[0]?.experiments?.[0]?.protocols?.[0];
const serverProtocol = () => server.rows.get("experiment_protocol::p1:e1:pr1")?.payload?.item;
const editProtocol = (fn) => (store) => {
  fn(protocolOf(store));
  return store;
};

async function twoDevicesWithProtocol() {
  resetClock();
  resetServer();
  const desktop = makeDevice("desktop", { seedStore: PROTOCOL_SEED });
  await desktop.ready();
  await advance(3000);
  const phone = makeDevice("phone");
  await phone.ready();
  await advance(3000);
  assert.ok(protocolOf(phone.app.store), "setup: phone should load the protocol");
  return { desktop, phone };
}

// 삭제한 뒤 흔한 동기화 사건들(다른 곳 편집, 앱 전환, 따라잡기 주기)을 거쳐도 남는지 본다.
async function stirAfterDelete(desktop, phone) {
  await advance(5000);
  phone.edit((store) => {
    store.projects[0].notes[0].purpose = "폰에서 다른 곳 수정";
    return store;
  });
  await advance(5000);
  desktop.background();
  await advance(1000);
  desktop.foreground();
  await advance(5000);
  phone.background();
  await advance(1000);
  phone.foreground();
  await advance(65000);
}

const DELETIONS = [
  ["목록의 마지막 시약 행까지 전부 지우기", (pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels[0].rows = []; },
    (pr) => pr?.draftVersion?.stepGroups?.[0]?.panelRows?.[0]?.panels?.[0]?.rows?.length, 0],
  ["유일한 설명 줄 지우기", (pr) => { pr.draftVersion.stepGroups[0].panelRows[0].texts = []; },
    (pr) => pr?.draftVersion?.stepGroups?.[0]?.panelRows?.[0]?.texts?.length, 0],
  ["유일한 패널 지우기", (pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels = []; },
    (pr) => pr?.draftVersion?.stepGroups?.[0]?.panelRows?.[0]?.panels?.length, 0],
  ["단계 제목을 빈칸으로 지우기", (pr) => { pr.draftVersion.stepGroups[0].title = ""; },
    (pr) => pr?.draftVersion?.stepGroups?.[0]?.title, ""],
  ["개요 문구를 빈칸으로 지우기", (pr) => { pr.summary = ""; }, (pr) => pr?.summary, ""],
  ["준비 항목 전부 지우기", (pr) => { pr.beforeStarting = []; }, (pr) => pr?.beforeStarting?.length, 0],
  ["단계 하나 지우기 (여러 개 중)", (pr) => { pr.draftVersion.stepGroups = pr.draftVersion.stepGroups.filter((g) => g.id !== "s3"); },
    (pr) => pr?.draftVersion?.stepGroups?.map((g) => g.id).join(","), "s1,s2"],
];
for (const [label, mutate, pick, expected] of DELETIONS) {
  scenario(`프로토콜에서 지운 것이 되살아나지 않는다: ${label}`, async () => {
    const { desktop, phone } = await twoDevicesWithProtocol();
    desktop.edit(editProtocol(mutate));
    await stirAfterDelete(desktop, phone);
    assert.strictEqual(pick(protocolOf(desktop.app.store)), expected, "컴퓨터");
    assert.strictEqual(pick(serverProtocol()), expected, "서버");
    assert.strictEqual(pick(protocolOf(phone.app.store)), expected, "폰");
  });
}

// --- deleting experiments ----------------------------------------------------
const experimentIds = (store) => (store?.projects?.[0]?.experiments || []).map((e) => e.id);
const serverExperiment = (id) => server.rows.get(`project_experiment::p1:${id}`);
const deleteExperiment = (device, id) => {
  device.signalDelete("experiment", "p1", id);
  device.edit((store) => {
    store.projects[0].experiments = store.projects[0].experiments.filter((e) => e.id !== id);
    return store;
  });
};
const EXPERIMENT_DELETIONS = [
  ["빈 새 실험", { id: "eNew", name: "새 실험", memo: "", protocols: [] }, "desktop", 5000],
  ["프로토콜이 든 새 실험", { id: "eNew", name: "새 실험", memo: "", protocols: [{ id: "prN", name: "새 프로토콜", versions: [], draftVersion: { id: "v1", stepGroups: [{ id: "x1", title: "단계" }] } }] }, "desktop", 5000],
  ["다른 기기가 만든 새 실험", { id: "eNew", name: "새 실험", memo: "", protocols: [] }, "phone", 8000],
  ["만들자마자 (업로드 전) 지운 새 실험", { id: "eNew", name: "새 실험", memo: "", protocols: [] }, "desktop", 100],
];
for (const [label, experiment, deleter, wait] of EXPERIMENT_DELETIONS) {
  scenario(`실험을 지우면 지워진 채로 남는다: ${label}`, async () => {
    const { desktop, phone } = await twoDevicesWithProtocol();
    desktop.edit((store) => {
      store.projects[0].experiments.push(clone(experiment));
      return store;
    });
    await advance(wait);
    deleteExperiment(deleter === "phone" ? phone : desktop, "eNew");
    await stirAfterDelete(desktop, phone);
    assert.deepStrictEqual(experimentIds(desktop.app.store), ["e1"], "컴퓨터");
    assert.deepStrictEqual(experimentIds(phone.app.store), ["e1"], "폰");
    const row = serverExperiment("eNew");
    assert.ok(!row || row.deleted_at, "서버");
  });
}
scenario("프로토콜이 든 기존 실험을 지우면 '새 실험'으로 되살아나지 않는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  deleteExperiment(desktop, "e1");
  await stirAfterDelete(desktop, phone);
  assert.deepStrictEqual(experimentIds(desktop.app.store), [], "컴퓨터");
  assert.deepStrictEqual(experimentIds(phone.app.store), [], "폰");
  assert.ok(serverExperiment("e1")?.deleted_at, "서버 실험 행이 삭제되어야 함");
  assert.ok(serverProtocol() === undefined || server.rows.get("experiment_protocol::p1:e1:pr1").deleted_at, "프로토콜도 삭제");
});

// --- run -------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const { name, fn } of scenarios) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} passed`);
  process.exit(failed ? 1 : 0);
})();
