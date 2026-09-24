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
  // 지금 시각에 이미 도착한 메시지·작업부터 처리합니다 (실제 브라우저와 같은 순서).
  await settle();
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
// 기기마다 시계가 다를 수 있습니다 (폰이 몇 분 앞서 가는 흔한 상황).
function makeFakeDate(offsetMs = 0) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now + offsetMs);
      else super(...args);
    }
    static now() {
      return clock.now + offsetMs;
    }
  };
}
const FakeDate = makeFakeDate(0);

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
// version.json 이 알리는 버전. null 이면 각 기기가 자기 버전을 봅니다(업데이트 없음).
let announcedVersion = null;
function resetServer() {
  announcedVersion = null;
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
        owner: null,
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

function makeDevice(name, { seedStore = null, source = SOURCE, persist = null, clockOffsetMs = 0 } = {}) {
  // persist: 같은 기기를 다시 켤 때 이어받는 저장소 (localStorage · IndexedDB).
  const storage = persist?.storage || new Map();
  const sharedIdb = persist?.idb || makeIndexedDB();
  let alive = true;
  const instanceTimers = new Set();
  const never = () => new Promise(() => {});
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const sessionMap = persist?.sessionMap || new Map();
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
  // 앱이 큰 프로토콜을 다시 그리는 동안 응답(ack)이 늦어지는 상황을 흉내 냅니다.
  let ackDelayMs = 0;
  let pushHook = null;
  // Messages from the app to the shell are asynchronous, like postMessage.
  const toShell = (data) =>
    hostImmediate(() => fire(winListeners, "message", { origin: ORIGIN, source: frameWindow, data }));
  const frameWindow = {
    postMessage(message) {
      if (message?.type === "exp-note-cloud-store" && message.store) {
        const before = app.store;
        app.store = clone(message.store);
        app.pushes += 1;
        if (process.env.TRACE) {
          const pr = message.store?.projects?.[0]?.experiments?.[0]?.protocols?.find((x) => x.id === "prNew");
          console.log(`    [${name}] push #${app.pushes} @${clock.now - Date.UTC(2026, 8, 19, 0, 0, 0)}ms: ${(pr?.draftVersion?.stepGroups || []).map((g) => g.id).join(",")}`);
        }
        const ack = () => toShell({ type: "exp-note-cloud-store-applied", fingerprint: message.fingerprint || "" });
        if (pushHook) {
          const hook = pushHook;
          pushHook = null;
          hook(before);
        }
        if (ackDelayMs > 0) instanceScheduler.setTimeout(ack, ackDelayMs);
        else ack();
      }
    },
  };
  elements.set("exp-note-frame", Object.assign(makeElement(), { contentWindow: frameWindow }));

  if (persist && storage.has(STORAGE_KEY)) {
    app.store = JSON.parse(storage.get(STORAGE_KEY));
  }
  if (seedStore) {
    const raw = JSON.stringify(seedStore);
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(LOCAL_UPDATED_KEY, String(clock.now));
    localStorage.setItem(USER_EDITED_KEY, String(clock.now));
    app.store = clone(seedStore);
  }

  const track = (id) => {
    instanceTimers.add(id);
    return id;
  };
  const instanceScheduler = {
    setTimeout: (fn, ms) => (alive ? track(scheduler.setTimeout(() => alive && fn(), ms)) : 0),
    setInterval: (fn, ms) => (alive ? track(scheduler.setInterval(() => alive && fn(), ms)) : 0),
    clearTimeout: (id) => scheduler.clearTimeout(id),
    clearInterval: (id) => scheduler.clearInterval(id),
  };
  // 떠난 페이지는 저장소·네트워크 작업이 끝나지 않습니다 (브라우저가 페이지를 없앰).
  const idbProxy = { open: (...args) => (alive ? sharedIdb.open(...args) : {}) };
  const baseClient = makeClient(name);
  const clientProxy = {
    ...baseClient,
    from: (table) => (alive ? baseClient.from(table) : { select() { return this; }, eq() { return this; }, in() { return this; }, gt() { return this; }, order() { return this; }, range() { return this; }, then() {} }),
    rpc: (...args) => (alive ? baseClient.rpc(...args) : never()),
    channel: (...args) => {
      const channel = baseClient.channel(...args);
      channel.owner = windowObject;
      return channel;
    },
  };
  const navigate = () => {
    hostImmediate(() => {
      if (!alive) return;
      // 브라우저는 페이지를 떠나며 pagehide 를 보내고, 그 뒤의 비동기 작업은 사라집니다.
      fire(winListeners, "pagehide");
      alive = false;
      for (const id of instanceTimers) scheduler.clearTimeout(id);
      for (const channel of [...server.channels]) if (channel.device === name && channel.owner === windowObject) server.channels.delete(channel);
      device.navigated = true;
    });
  };
  const windowObject = {
    location: {
      search: "",
      origin: ORIGIN,
      href: `${ORIGIN}/`,
      replace: navigate,
      reload: navigate,
    },
    localStorage,
    sessionStorage,
    document,
    navigator: { onLine: true },
    addEventListener: addTo(winListeners),
    removeEventListener: removeFrom(winListeners),
    ...instanceScheduler,
    supabase: { createClient: () => clientProxy },
    // 기기가 돌리는 코드의 버전을 알려 줍니다 (옛 버전 기기가 "아직 업데이트 전"인 상태를 흉내).
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: announcedVersion || (source.match(/const APP_VERSION = "([^"]+)"/) || [])[1] || APP_VERSION,
      }),
    }),
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    indexedDB: idbProxy,
    Date: makeFakeDate(clockOffsetMs),
    URL,
    URLSearchParams,
    structuredClone,
    console,
  };
  windowObject.window = windowObject;
  windowObject.globalThis = windowObject;
  windowObject.self = windowObject;
  vm.createContext(windowObject);
  vm.runInContext(source, windowObject);

  const device = {
    name,
    app,
    localStorage,
    navigated: false,
    persist: { storage, idb: sharedIdb, sessionMap },
    isAlive: () => alive,
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
    // 다음 화면 갱신이 앱에 닿는 순간에 끼어듭니다 (실제 경합을 그대로 흉내).
    onNextPush(fn) {
      pushHook = fn;
    },
    // 앱이 보냈지만 화면에는 남지 않는 스냅샷 (갱신에 덮이기 직전에 보낸 것).
    postRaw(raw) {
      toShell({ type: "exp-note-local-store", raw });
    },
    setAckDelay(ms) {
      ackDelayMs = ms;
    },
    // 셸이 화면을 다시 그리는 순간과 겹쳐서, 방금 친 내용이 뒤늦게 도착하는 경우.
    editInFlight(mutate) {
      const next = mutate(clone(app.store));
      const raw = JSON.stringify(next);
      app.store = next;
      // 앱은 조금 뒤에 localStorage 에 쓰고 알립니다 (셸의 화면 갱신이 먼저 일어남).
      hostImmediate(() =>
        hostImmediate(() => {
          localStorage.setItem(STORAGE_KEY, raw);
          localStorage.setItem(LOCAL_UPDATED_KEY, String(clock.now));
          localStorage.setItem(USER_EDITED_KEY, String(clock.now));
          toShell({ type: "exp-note-local-store", raw });
        })
      );
    },
    // 앱이 화면과 localStorage 에는 썼지만 셸이 그 알림을 놓친 경우 (캡처 유실).
    editWithoutPosting(mutate) {
      const next = mutate(clone(app.store));
      const raw = JSON.stringify(next);
      app.store = next;
      localStorage.setItem(STORAGE_KEY, raw);
      localStorage.setItem(LOCAL_UPDATED_KEY, String(clock.now));
      localStorage.setItem(USER_EDITED_KEY, String(clock.now));
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
    goOffline() {
      windowObject.navigator.onLine = false;
      server.offline.add(name);
      for (const channel of server.channels) if (channel.device === name) channel.dead = true;
      fire(winListeners, "offline");
    },
    goOnline() {
      windowObject.navigator.onLine = true;
      server.offline.delete(name);
      fire(winListeners, "online");
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

// --- concurrent edits of different parts of one record -----------------------
const stepsOf = (store) => protocolOf(store)?.draftVersion?.stepGroups || [];
const stepTitle = (store, id) => stepsOf(store).find((g) => g.id === id)?.title;
const stepIds = (store) => stepsOf(store).map((g) => g.id).join(",");
const setStepTitle = (id, title) => editProtocol((pr) => {
  pr.draftVersion.stepGroups = pr.draftVersion.stepGroups.map((g) => (g.id === id ? { ...g, title } : g));
});
const removeStep = (id) => editProtocol((pr) => {
  pr.draftVersion.stepGroups = pr.draftVersion.stepGroups.filter((g) => g.id !== id);
});
const reagentRows = (store) =>
  stepsOf(store)[0]?.panelRows?.[0]?.panels?.[0]?.rows || [];
const noteOf = (store) => store?.projects?.[0]?.notes?.[0];
const editNote = (fn) => (store) => {
  fn(store.projects[0].notes[0]);
  return store;
};
const allThree = (desktop, phone, pick) => [
  pick(desktop.app.store),
  pick(phone.app.store),
  pick({ projects: [{ experiments: [{ protocols: [serverProtocol()] }], notes: [server.rows.get("project_note::p1:n1")?.payload?.item] }] }),
];

scenario("같은 프로토콜: 폰이 1단계를 치는 동안 컴퓨터가 3단계를 지워도 둘 다 남는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  phone.focus();
  for (let i = 1; i <= 3; i += 1) {
    phone.edit(setStepTitle("s1", `폰에서 친 제목 ${i}`));
    await advance(1000);
  }
  desktop.edit(removeStep("s3"));
  await advance(500);
  for (let i = 4; i <= 8; i += 1) {
    phone.edit(setStepTitle("s1", `폰에서 친 제목 ${i}`));
    await advance(1000);
  }
  await advance(20000);
  for (const [where, ids] of allThree(desktop, phone, stepIds).entries()) {
    assert.strictEqual(ids, "s1,s2", `3단계 삭제 유지 (${["컴퓨터", "폰", "서버"][where]})`);
  }
  for (const [where, title] of allThree(desktop, phone, (st) => stepTitle(st, "s1")).entries()) {
    assert.strictEqual(title, "폰에서 친 제목 8", `폰의 1단계 편집 유지 (${["컴퓨터", "폰", "서버"][where]})`);
  }
});

scenario("같은 프로토콜: 폰이 1단계를 고친 직후 컴퓨터가 3단계를 지워도 폰 편집이 덮이지 않는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  phone.edit(setStepTitle("s1", "폰에서 마지막으로 고친 제목"));
  await advance(200); // 컴퓨터는 아직 이 편집을 못 받았다
  desktop.edit(removeStep("s3"));
  await advance(20000);
  for (const pick of [stepIds]) {
    assert.deepStrictEqual(allThree(desktop, phone, pick), ["s1,s2", "s1,s2", "s1,s2"]);
  }
  assert.deepStrictEqual(
    allThree(desktop, phone, (st) => stepTitle(st, "s1")),
    ["폰에서 마지막으로 고친 제목", "폰에서 마지막으로 고친 제목", "폰에서 마지막으로 고친 제목"]
  );
});

scenario("같은 프로토콜의 서로 다른 시약 행을 두 기기가 동시에 고치면 둘 다 남는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(editProtocol((pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels[0].rows[0].volume = "120"; }));
  phone.edit(editProtocol((pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels[0].rows[1].volume = "75"; }));
  await advance(2000);
  desktop.goOnline();
  phone.goOnline();
  await advance(30000);
  const volumes = (st) => reagentRows(st).map((r) => `${r.id}=${r.volume}`).join(",");
  assert.deepStrictEqual(allThree(desktop, phone, volumes), ["rg1=120,rg2=75", "rg1=120,rg2=75", "rg1=120,rg2=75"]);
});

scenario("오프라인에서 한쪽은 시약 행을 지우고 다른 쪽은 다른 행을 고쳐도 둘 다 반영된다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(editProtocol((pr) => {
    const panel = pr.draftVersion.stepGroups[0].panelRows[0].panels[0];
    panel.rows = panel.rows.filter((r) => r.id !== "rg2");
  }));
  await advance(1000);
  phone.edit(editProtocol((pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels[0].rows[0].volume = "300"; }));
  await advance(2000);
  phone.goOnline();
  await advance(10000);
  desktop.goOnline();
  await advance(30000);
  const rows = (st) => reagentRows(st).map((r) => `${r.id}=${r.volume}`).join(",");
  assert.deepStrictEqual(allThree(desktop, phone, rows), ["rg1=300", "rg1=300", "rg1=300"]);
});

scenario("같은 칸을 양쪽에서 고치면 나중 것이 이긴다 (프로토콜 안에서도)", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(setStepTitle("s2", "컴퓨터가 먼저 고침"));
  await advance(3000);
  phone.edit(setStepTitle("s2", "폰이 나중에 고침"));
  await advance(1000);
  desktop.goOnline();
  phone.goOnline();
  await advance(30000);
  assert.deepStrictEqual(
    allThree(desktop, phone, (st) => stepTitle(st, "s2")),
    ["폰이 나중에 고침", "폰이 나중에 고침", "폰이 나중에 고침"]
  );
});

scenario("실험 노트: 한쪽은 목적, 다른 쪽은 결과 요약을 동시에 고치면 둘 다 남는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(editNote((n) => { n.purpose = "컴퓨터가 쓴 목적"; }));
  phone.edit(editNote((n) => { n.resultSummary = "폰이 쓴 결과"; }));
  await advance(2000);
  desktop.goOnline();
  phone.goOnline();
  await advance(30000);
  const pick = (st) => `${noteOf(st)?.purpose} / ${noteOf(st)?.resultSummary}`;
  const expected = "컴퓨터가 쓴 목적 / 폰이 쓴 결과";
  assert.strictEqual(pick(desktop.app.store), expected, "컴퓨터");
  assert.strictEqual(pick(phone.app.store), expected, "폰");
  const serverNote = server.rows.get("project_note::p1:n1")?.payload?.item;
  assert.strictEqual(`${serverNote?.purpose} / ${serverNote?.resultSummary}`, expected, "서버");
});

scenario("실험 노트 실행 기록: 두 기기가 다른 단계를 기록해도 둘 다 남고 같은 단계가 중복되지 않는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.edit(editNote((n) => {
    n.execution = { mode: "fromProtocol", stepGroups: [], stepRuns: [{ stepGroupId: "s1", status: "pending", actual: "" }, { stepGroupId: "s2", status: "pending", actual: "" }] };
  }));
  await advance(10000);
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(editNote((n) => { n.execution.stepRuns = n.execution.stepRuns.map((r) => (r.stepGroupId === "s1" ? { ...r, status: "done", actual: "컴퓨터 기록" } : r)); }));
  phone.edit(editNote((n) => { n.execution.stepRuns = n.execution.stepRuns.map((r) => (r.stepGroupId === "s2" ? { ...r, status: "done", actual: "폰 기록" } : r)); }));
  await advance(2000);
  desktop.goOnline();
  phone.goOnline();
  await advance(30000);
  const runs = (st) => (noteOf(st)?.execution?.stepRuns || []).map((r) => `${r.stepGroupId}:${r.status}:${r.actual}`).join(" | ");
  const expected = "s1:done:컴퓨터 기록 | s2:done:폰 기록";
  assert.strictEqual(runs(desktop.app.store), expected, "컴퓨터");
  assert.strictEqual(runs(phone.app.store), expected, "폰");
});

scenario("옛 형식 기록(부분 시각 없음)에서 시작해도 이후 동시 편집이 부분별로 합쳐진다", async () => {
  resetClock();
  resetServer();
  // 서버에 옛 버전이 쓴 기록을 직접 넣는다 (__sync 없음).
  const seedDevice = makeDevice("seed", { seedStore: PROTOCOL_SEED });
  await seedDevice.ready();
  await advance(3000);
  for (const row of server.rows.values()) {
    if (row.payload && typeof row.payload === "object") delete row.payload.__sync;
  }
  const desktop = makeDevice("desktop");
  await desktop.ready();
  const phone = makeDevice("phone");
  await phone.ready();
  await advance(5000);
  assert.ok(protocolOf(desktop.app.store) && protocolOf(phone.app.store), "setup");
  // 첫 편집: 옛 기록을 새 형식으로 옮긴다.
  desktop.edit(setStepTitle("s2", "첫 편집"));
  await advance(10000);
  // 이후 동시 편집: 다른 부분.
  desktop.goOffline();
  phone.goOffline();
  desktop.edit(setStepTitle("s1", "컴퓨터 1단계"));
  phone.edit(removeStep("s3"));
  await advance(2000);
  desktop.goOnline();
  phone.goOnline();
  await advance(30000);
  const pick = (st) => `${stepIds(st)} | ${stepTitle(st, "s1")} | ${stepTitle(st, "s2")}`;
  const expected = "s1,s2 | 컴퓨터 1단계 | 첫 편집";
  assert.strictEqual(pick(desktop.app.store), expected, "컴퓨터");
  assert.strictEqual(pick(phone.app.store), expected, "폰");
});

// --- transition: a device still on the previous release ---------------------
// 4.4.8 (the last release before per-part clocks) is read from git history. The
// previous release must keep working with the new one until it updates itself.
let PREVIOUS_RELEASE = null;
try {
  PREVIOUS_RELEASE = require("child_process").execSync("git show 342442b:sync-app.js", {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
} catch {
  PREVIOUS_RELEASE = null; // no git checkout: these scenarios are skipped
}
async function newDesktopOldPhone() {
  resetClock();
  resetServer();
  const desktop = makeDevice("desktop", { seedStore: PROTOCOL_SEED });
  await desktop.ready();
  await advance(3000);
  const phone = makeDevice("phone", { source: PREVIOUS_RELEASE });
  await phone.ready();
  await advance(3000);
  return { desktop, phone };
}
const everywhere = (desktop, phone, pick) => [
  pick(desktop.app.store),
  pick(phone.app.store),
  pick({ projects: [{ experiments: [{ protocols: [serverProtocol()] }] }] }),
];
const TRANSITION = [
  ["새 버전이 지운 단계가 옛 버전 기기에서 되살아나지 않는다", async ({ desktop }) => {
    desktop.edit(removeStep("s3"));
    await advance(20000);
  }, stepIds, "s1,s2"],
  ["새 버전이 비운 시약 표가 옛 버전 기기에서 되살아나지 않는다", async ({ desktop }) => {
    desktop.edit(editProtocol((pr) => { pr.draftVersion.stepGroups[0].panelRows[0].panels[0].rows = []; }));
    await advance(20000);
  }, (st) => reagentRows(st).length, 0],
  ["옛 버전 기기의 편집이 새 버전에 반영된다", async ({ phone }) => {
    phone.edit(setStepTitle("s1", "옛 버전이 고침"));
    await advance(20000);
  }, (st) => stepTitle(st, "s1"), "옛 버전이 고침"],
  ["새 버전과 옛 버전이 번갈아 다른 단계를 고치면 둘 다 남는다", async ({ desktop, phone }) => {
    desktop.edit(setStepTitle("s2", "새 버전 2단계"));
    await advance(15000);
    phone.edit(setStepTitle("s1", "옛 버전 1단계"));
    await advance(20000);
  }, (st) => `${stepTitle(st, "s1")} / ${stepTitle(st, "s2")}`, "옛 버전 1단계 / 새 버전 2단계"],
  ["새 버전의 삭제 뒤 옛 버전이 다른 단계를 고쳐도 삭제가 유지된다", async ({ desktop, phone }) => {
    desktop.edit(removeStep("s3"));
    await advance(20000);
    phone.edit(setStepTitle("s1", "옛 버전이 나중에 고침"));
    await advance(30000);
  }, (st) => `${stepIds(st)} / ${stepTitle(st, "s1")}`, "s1,s2 / 옛 버전이 나중에 고침"],
];
for (const [label, act, pick, expected] of TRANSITION) {
  scenario(`전환 기간(한쪽이 4.4.8): ${label}`, async () => {
    if (!PREVIOUS_RELEASE) return; // skipped without git history
    const devices = await newDesktopOldPhone();
    await act(devices);
    assert.deepStrictEqual(everywhere(devices.desktop, devices.phone, pick), [expected, expected, expected]);
  });
}

// --- app updates never interrupt writing ------------------------------------
const writeNewProtocol = (step) => (store) => {
  const experiment = store.projects[0].experiments[0];
  let pr = experiment.protocols.find((item) => item.id === "prNew");
  if (!pr) {
    pr = { id: "prNew", name: "새 프로토콜", draftVersion: { id: "vN", stepGroups: [] }, versions: [] };
    experiment.protocols.push(pr);
  }
  pr.name = "쓰는 중인 프로토콜";
  pr.draftVersion.stepGroups = Array.from({ length: Math.ceil(step / 3) }, (_, k) => ({
    id: `w${k + 1}`,
    title: `${k + 1}단계 ${"내용".repeat(Math.min(step, 5))}`,
  }));
  return store;
};
const writtenTitles = (store) =>
  (store?.projects?.[0]?.experiments?.[0]?.protocols?.find((item) => item.id === "prNew")?.draftVersion?.stepGroups || [])
    .map((group) => group.title)
    .join(" · ");

scenario("쓰는 도중 새 버전이 나와도 새로고침하지 않는다 (창 전환·10분 주기 포함)", async () => {
  const { desktop } = await twoDevicesWithProtocol();
  desktop.focus();
  for (let step = 1; step <= 6; step += 1) {
    desktop.edit(writeNewProtocol(step));
    await advance(step === 3 ? 4000 : 1200);
    if (step === 3) {
      announcedVersion = "9.9.9";
      desktop.background();
      await advance(2000);
      desktop.foreground(); // 잠깐 다른 창에 다녀옴
      await advance(3000);
    }
  }
  await advance(11 * 60 * 1000); // 10분 주기 확인도 지나감 (커서는 입력칸에)
  assert.strictEqual(desktop.navigated, false, "쓰는 중에는 새로고침하면 안 됨");
  assert.strictEqual(writtenTitles(desktop.app.store), writtenTitles(writeNewProtocol(6)(clone(PROTOCOL_SEED))));
});

scenario("오래 떠나 있다 돌아오면 새 버전을 적용하고, 쓰던 것은 그대로 남는다", async () => {
  let { desktop, phone } = await twoDevicesWithProtocol();
  desktop.focus();
  for (let step = 1; step <= 6; step += 1) {
    desktop.edit(writeNewProtocol(step));
    await advance(1200);
  }
  desktop.blur();
  announcedVersion = "9.9.9";
  desktop.background();
  await advance(6 * 60 * 1000);
  desktop.foreground();
  await advance(8000);
  assert.strictEqual(desktop.navigated, true, "오래 떠나 있다 돌아오면 적용");
  desktop = makeDevice("desktop", { persist: desktop.persist });
  await desktop.ready();
  await advance(10000);
  const expected = writtenTitles(writeNewProtocol(6)(clone(PROTOCOL_SEED)));
  assert.strictEqual(writtenTitles(desktop.app.store), expected, "새로고침 뒤 화면");
  assert.strictEqual(writtenTitles({ projects: [{ experiments: [{ protocols: [server.rows.get("experiment_protocol::p1:e1:prNew")?.payload?.item] }] }] }), expected, "서버");
  assert.strictEqual(writtenTitles(phone.app.store), expected, "다른 기기");
});

scenario("앱을 막 열 때 새 버전이 있으면 바로 적용한다", async () => {
  resetClock();
  resetServer();
  announcedVersion = "9.9.9";
  const desktop = makeDevice("desktop", { seedStore: PROTOCOL_SEED });
  await desktop.ready();
  await advance(8000);
  assert.strictEqual(desktop.navigated, true);
});

scenario("셸이 편집 알림을 놓쳐도 다음 화면 갱신이 화면 내용을 지우지 않는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.focus();
  desktop.edit(writeNewProtocol(3));
  await advance(5000);
  // 앱에는 더 썼는데 셸이 그 알림을 놓친 상태 (화면·localStorage 에만 있음)
  desktop.editWithoutPosting((store) => {
    const pr = store.projects[0].experiments[0].protocols.find((item) => item.id === "prNew");
    pr.draftVersion.stepGroups.push({ id: "wLost", title: "셸이 못 받은 단계" });
    return store;
  });
  const expected = writtenTitles(desktop.app.store);
  // 다른 기기의 변경이 도착해 화면을 다시 그리게 됨
  phone.edit((store) => {
    store.projects[0].notes[0].purpose = "폰에서 고침";
    return store;
  });
  await advance(20000);
  assert.strictEqual(writtenTitles(desktop.app.store), expected, "화면에 있던 내용이 남아야 함");
  assert.ok(
    writtenTitles({ projects: [{ experiments: [{ protocols: [server.rows.get("experiment_protocol::p1:e1:prNew")?.payload?.item] }] }] }).includes("셸이 못 받은 단계"),
    "살린 내용이 서버에도 올라가야 함"
  );
  assert.strictEqual(protocolOf(desktop.app.store) && noteOf(desktop.app.store).purpose, "폰에서 고침", "다른 기기 변경도 반영");
});

scenario("화면을 다시 그리는 순간에 친 내용도 화면에 남는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.focus();
  desktop.edit(writeNewProtocol(3));
  await advance(5000);
  // 다른 기기의 변경이 도착해 화면을 다시 그리게 되는 바로 그 순간에 두 단계를 더 쓴다.
  phone.edit((store) => {
    store.projects[0].notes[0].purpose = "폰에서 고침";
    return store;
  });
  desktop.editInFlight((store) => {
    const pr = store.projects[0].experiments[0].protocols.find((item) => item.id === "prNew");
    pr.draftVersion.stepGroups.push({ id: "wA", title: "방금 쓴 단계 1" });
    pr.draftVersion.stepGroups.push({ id: "wB", title: "방금 쓴 단계 2" });
    return store;
  });
  await advance(20000);
  const titles = writtenTitles(desktop.app.store);
  assert.ok(titles.includes("방금 쓴 단계 1") && titles.includes("방금 쓴 단계 2"), `화면: ${titles}`);
  const serverTitles = writtenTitles({
    projects: [{ experiments: [{ protocols: [server.rows.get("experiment_protocol::p1:e1:prNew")?.payload?.item] }] }],
  });
  assert.ok(serverTitles.includes("방금 쓴 단계 2"), `서버: ${serverTitles}`);
  assert.strictEqual(noteOf(desktop.app.store).purpose, "폰에서 고침", "다른 기기 변경도 반영");
});

scenario("화면을 다시 그리는 동안 친 내용이 화면에서 사라지지 않는다", async () => {
  const { desktop, phone } = await twoDevicesWithProtocol();
  desktop.focus();
  desktop.edit(writeNewProtocol(3));
  await advance(8000);
  desktop.blur();
  await advance(5000);
  // 화면 갱신이 앱에 닿는 바로 그 순간: 방금 친 두 단계가 담긴 스냅샷이 뒤늦게
  // 도착하고, 이어서 앱이 받은 내용을 되돌려 보내는 메아리가 도착합니다.
  desktop.setAckDelay(400);
  desktop.onNextPush((before) => {
    const typed = clone(before);
    const pr = typed.projects[0].experiments[0].protocols.find((item) => item.id === "prNew");
    pr.draftVersion.stepGroups.push({ id: "wA", title: "방금 쓴 단계 1" });
    pr.draftVersion.stepGroups.push({ id: "wB", title: "방금 쓴 단계 2" });
    desktop.postRaw(JSON.stringify(typed));
    desktop.postRaw(JSON.stringify(desktop.app.store));
  });
  phone.edit((store) => {
    protocolOf(store).name = "폰에서 고친 이름";
    return store;
  });
  await advance(60000);
  const titles = writtenTitles(desktop.app.store);
  assert.ok(
    titles.includes("방금 쓴 단계 1") && titles.includes("방금 쓴 단계 2"),
    `화면에서 사라졌습니다: ${titles}`
  );
  const server1 = server.rows.get("experiment_protocol::p1:e1:prNew");
  const kept = (server1?.payload?.item?.draftVersion?.stepGroups || []).map((g) => g.title);
  assert.ok(kept.includes("방금 쓴 단계 2"), `클라우드에도 없습니다: ${kept}`);
});

scenario("다른 기기 시계가 앞서 가도 내 편집이 서버에서 밀리지 않는다", async () => {
  resetClock();
  resetServer();
  const desktop = makeDevice("desktop", { seedStore: PROTOCOL_SEED });
  await desktop.ready();
  await advance(3000);
  // 폰 시계가 5분 앞서 갑니다 (자동 시각 맞춤이 꺼진 흔한 상황).
  const phone = makeDevice("phone", { clockOffsetMs: 5 * 60 * 1000 });
  await phone.ready();
  await advance(5000);
  assert.ok(protocolOf(phone.app.store), "준비: 폰도 프로토콜을 받아야 합니다");

  // 같은 프로토콜을 폰이 먼저 고칩니다 (앞선 시각이 서버에 박힙니다).
  phone.edit((store) => {
    protocolOf(store).name = "폰이 먼저 고친 이름";
    return store;
  });
  await advance(10000);

  // 이제 컴퓨터에서 같은 프로토콜에 단계를 씁니다.
  desktop.edit((store) => {
    protocolOf(store).draftVersion.stepGroups.push({ id: "wA", title: "컴퓨터에서 쓴 단계" });
    return store;
  });
  await advance(60000);

  const onScreen = (protocolOf(desktop.app.store)?.draftVersion?.stepGroups || []).map((g) => g.title);
  assert.ok(onScreen.includes("컴퓨터에서 쓴 단계"), `컴퓨터 화면에서 사라졌습니다: ${onScreen}`);
  const row = server.rows.get("experiment_protocol::p1:e1:pr1");
  const stored = (row?.payload?.item?.draftVersion?.stepGroups || []).map((g) => g.title);
  assert.ok(stored.includes("컴퓨터에서 쓴 단계"), `서버에 올라가지 못했습니다: ${stored}`);
  const onPhone = (protocolOf(phone.app.store)?.draftVersion?.stepGroups || []).map((g) => g.title);
  assert.ok(onPhone.includes("컴퓨터에서 쓴 단계"), `폰에 닿지 않았습니다: ${onPhone}`);
});

// --- run -------------------------------------------------------------------
(async () => {
  let failed = 0;
  const only = process.env.ONLY;
  for (const { name, fn } of scenarios.filter((item) => !only || item.name.includes(only))) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${process.env.FULL ? error.message : error.message.split("\n")[0]}`);
    }
  }
  const ran = scenarios.filter((item) => !only || item.name.includes(only)).length;
  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
})();
