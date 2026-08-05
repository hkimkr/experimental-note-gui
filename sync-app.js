(() => {
  "use strict";

  const STORAGE_KEY = "hamin-exp-note-v1";
  const LOCAL_UPDATED_KEY = "hamin-exp-note-v1-local-updated-at";
  const LEGACY_PENDING_KEY = "hamin-exp-note-v1-pending-sync";
  const CLIENT_ID_KEY = "exp-note-sync-client-id";
  const DB_NAME = "exp-note-sync-v1";
  const DB_VERSION = 1;
  const RECORDS_STORE = "records";
  const OUTBOX_STORE = "outbox";
  const SUPABASE_URL = "https://wajhlnpyxcnhoybwtdqe.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_Kp3KAxlyT1eXot9vHE1wlQ_h4C0BVeJ";

  const client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );
  const frame = document.getElementById("exp-note-frame");
  const launcher = document.getElementById("cloud-sync-launcher");
  const label = document.getElementById("cloud-sync-label");
  const dot = document.getElementById("cloud-sync-dot");
  const backdrop = document.getElementById("cloud-auth-backdrop");
  const closeButton = document.getElementById("cloud-auth-close");
  const signedOut = document.getElementById("cloud-signed-out");
  const signedIn = document.getElementById("cloud-signed-in");
  const emailInput = document.getElementById("cloud-email");
  const passwordInput = document.getElementById("cloud-password");
  const errorBox = document.getElementById("cloud-auth-error");
  const statusBox = document.getElementById("cloud-status");
  const accountEmail = document.getElementById("cloud-account-email");
  const signInButton = document.getElementById("cloud-signin");
  const signUpButton = document.getElementById("cloud-signup");
  const signOutButton = document.getElementById("cloud-signout");

  const clientId = (() => {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const created =
      globalThis.crypto?.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  })();

  let currentSession = null;
  let channel = null;
  let reconnectTimer = null;
  let uploadTimer = null;
  let uploadRunning = false;
  let initializedUserId = "";
  let syncGeneration = 0;
  let currentRecords = new Map();
  let lastObservedFingerprint = "";
  let pendingAppStore = null;
  let pendingAppFingerprint = "";
  let appEditing = false;
  let reconnectAfterEditing = false;
  let deferredRemoteRecords = new Map();
  let deferredRemoteMessage = "";
  let localCaptureChain = Promise.resolve();
  let pendingLocalRaw = "";

  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = canonicalize(value[key]);
          return result;
        }, {});
    }
    return value;
  };

  const fingerprintValue = (value) =>
    JSON.stringify(canonicalize(value));

  const fingerprintRaw = (raw) => {
    if (!raw) return "";
    try {
      return fingerprintValue(JSON.parse(raw));
    } catch {
      return raw;
    }
  };

  const clone = (value) =>
    value == null ? value : JSON.parse(JSON.stringify(value));

  const recordKey = (record) =>
    `${record.entity_type}::${record.entity_id}`;

  const localRecordKey = (userId, record) =>
    `${userId}|${recordKey(record)}`;

  const timestampOf = (record) =>
    Date.parse(record?.updated_at || "") || 0;

  const compareRecords = (left, right) => {
    const timeDifference = timestampOf(left) - timestampOf(right);
    if (timeDifference) return timeDifference;
    return String(left?.client_id || "").localeCompare(
      String(right?.client_id || "")
    );
  };

  const newerRecord = (left, right) => {
    if (!left) return right;
    if (!right) return left;
    return compareRecords(left, right) >= 0 ? left : right;
  };

  const hashText = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  const stableItemId = (item, parentId, index, kind) => {
    if (item && typeof item === "object" && item.id) return String(item.id);
    return `legacy-${hashText(
      `${kind}|${parentId}|${index}|${fingerprintValue(item)}`
    )}`;
  };

  const makeRecord = (
    entityType,
    entityId,
    payload,
    updatedAt,
    sourceClientId = clientId,
    deletedAt = null
  ) => ({
    entity_type: entityType,
    entity_id: String(entityId),
    payload: payload == null ? null : clone(payload),
    updated_at: updatedAt,
    deleted_at: deletedAt,
    client_id: sourceClientId,
  });

  function storeToRecords(
    store,
    updatedAt = new Date().toISOString(),
    sourceClientId = clientId
  ) {
    const result = new Map();
    if (!store || typeof store !== "object") return result;
    const add = (type, id, payload) => {
      const record = makeRecord(
        type,
        id,
        payload,
        updatedAt,
        sourceClientId
      );
      result.set(recordKey(record), record);
    };

    const { projects = [], ...root } = store;

    add("root", "main", root);
    (Array.isArray(projects) ? projects : []).forEach((project, index) => {
      const id = stableItemId(project, "root", index, "project");
      add("project", id, { ...project, id });
    });
    return result;
  }

  const activeRecordsOfType = (records, type) =>
    [...records.values()].filter(
      (record) => record.entity_type === type && !record.deleted_at
    );

  const itemSort = (left, right) =>
    (left?.order ?? 0) - (right?.order ?? 0) ||
    (left?.createdAt ?? left?.savedAt ?? 0) -
      (right?.createdAt ?? right?.savedAt ?? 0) ||
    String(left?.id || "").localeCompare(String(right?.id || ""));

  function recordsToStore(records, fallbackStore = {}) {
    const rootRecord = records.get("root::main");
    const root =
      rootRecord && !rootRecord.deleted_at ? clone(rootRecord.payload) : {};
    const store = {
      ...clone(fallbackStore || {}),
      ...root,
      projects: [],
    };

    store.projects = activeRecordsOfType(records, "project")
      .map((record) => clone(record.payload))
      .sort(itemSort);
    return store;
  }

  function mergeRecordMaps(...maps) {
    const merged = new Map();
    maps.forEach((records) => {
      records?.forEach((record, key) => {
        merged.set(key, newerRecord(merged.get(key), record));
      });
    });
    return merged;
  }

  function openSyncDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS_STORE)) {
          db.createObjectStore(RECORDS_STORE, { keyPath: "local_key" });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: "local_key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStoredRecords(storeName, userId) {
    const db = await openSyncDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => {
        const records = new Map();
        (request.result || [])
          .filter((entry) => entry.user_id === userId)
          .forEach((entry) => {
            const { local_key: _localKey, user_id: _userId, ...record } =
              entry;
            records.set(recordKey(record), record);
          });
        resolve(records);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }

  async function putStoredRecords(storeName, userId, records) {
    if (!records?.length) return;
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      records.forEach((record) => {
        objectStore.put({
          ...clone(record),
          user_id: userId,
          local_key: localRecordKey(userId, record),
        });
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function deleteOutboxRecords(userId, uploadedRecords) {
    if (!uploadedRecords?.length) return;
    const latestOutbox = await getStoredRecords(OUTBOX_STORE, userId);
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const objectStore = transaction.objectStore(OUTBOX_STORE);
      uploadedRecords.forEach((record) => {
        const latest = latestOutbox.get(recordKey(record));
        if (
          latest &&
          latest.updated_at === record.updated_at &&
          latest.client_id === record.client_id
        ) {
          objectStore.delete(localRecordKey(userId, record));
        }
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  const setBusy = (busy) => {
    signInButton.disabled = busy;
    signUpButton.disabled = busy;
    signOutButton.disabled = busy;
  };

  const setStatus = (message) => {
    statusBox.textContent = message;
    if (currentSession) label.textContent = message;
  };

  const postStoreToApp = (store) => {
    if (!frame?.contentWindow || !store) return;
    const fingerprint = fingerprintValue(store);
    pendingAppStore = store;
    pendingAppFingerprint = fingerprint;
    frame.contentWindow.postMessage(
      {
        type: "exp-note-cloud-store",
        store,
        fingerprint,
      },
      window.location.origin
    );
  };

  function applyRecordsToApp(records, message = "") {
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let fallback = {};
    try {
      fallback = localRaw ? JSON.parse(localRaw) : {};
    } catch {
      fallback = {};
    }
    const store = recordsToStore(records, fallback);
    const raw = JSON.stringify(store);
    lastObservedFingerprint = fingerprintValue(store);
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(LOCAL_UPDATED_KEY, String(Date.now()));
    postStoreToApp(store);
    if (message) setStatus(message);
  }

  async function fetchRemoteRecords(userId) {
    const { data, error } = await client
      .from("exp_note_records")
      .select(
        "entity_type,entity_id,payload,updated_at,deleted_at,client_id"
      )
      .eq("user_id", userId);
    if (error) throw error;
    const records = new Map();
    (data || []).forEach((record) => records.set(recordKey(record), record));
    return records;
  }

  async function fetchLegacyStore() {
    return null;
  }

  const rpcPayload = (records) =>
    records.map((record) => ({
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      payload: record.payload,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at,
      client_id: record.client_id,
    }));

  async function uploadOutbox() {
    if (
      uploadRunning ||
      !currentSession?.user ||
      navigator.onLine === false
    ) {
      return false;
    }
    const userId = currentSession.user.id;
    const outbox = await getStoredRecords(OUTBOX_STORE, userId);
    const records = [...outbox.values()];
    if (!records.length) {
      setStatus("클라우드 저장됨");
      return true;
    }

    uploadRunning = true;
    setStatus(`${records.length}개 변경사항 저장 중…`);
    let result;
    try {
      result = await client.rpc("upsert_exp_note_records", {
        p_records: rpcPayload(records),
      });
    } catch (error) {
      result = { error };
    }
    uploadRunning = false;
    if (result.error) {
      setStatus(
        navigator.onLine === false
          ? "오프라인 · 이 기기에 안전하게 저장됨"
          : "동기화 대기 중"
      );
      scheduleReconnect();
      return false;
    }

    await deleteOutboxRecords(userId, records);
    localStorage.removeItem(LEGACY_PENDING_KEY);
    const remaining = await getStoredRecords(OUTBOX_STORE, userId);
    if (remaining.size) {
      setStatus("변경사항 저장 대기 중");
      scheduleUpload(80);
    } else {
      setStatus("클라우드 저장됨");
    }
    return true;
  }

  const scheduleUpload = (delay = 650) => {
    if (uploadTimer) window.clearTimeout(uploadTimer);
    uploadTimer = window.setTimeout(() => {
      uploadTimer = null;
      uploadOutbox();
    }, delay);
  };

  async function queueRecords(records) {
    if (!currentSession?.user || !records.length) return;
    const userId = currentSession.user.id;
    records.forEach((record) =>
      currentRecords.set(recordKey(record), record)
    );
    await Promise.all([
      putStoredRecords(RECORDS_STORE, userId, records),
      putStoredRecords(OUTBOX_STORE, userId, records),
    ]);
    setStatus(
      navigator.onLine === false
        ? "오프라인 · 이 기기에 안전하게 저장됨"
        : "변경사항 저장 대기 중"
    );
    scheduleUpload();
  }

  async function captureLocalChanges(raw) {
    if (!initializedUserId || !raw) return;
    let store;
    try {
      store = JSON.parse(raw);
    } catch {
      return;
    }
    const desired = storeToRecords(store);
    const changed = [];
    const now = Date.now();
    let sequence = 0;

    desired.forEach((candidate, key) => {
      const existing = currentRecords.get(key);
      if (
        !existing ||
        existing.deleted_at ||
        fingerprintValue(existing.payload) !==
          fingerprintValue(candidate.payload)
      ) {
        sequence += 1;
        changed.push({
          ...candidate,
          updated_at: new Date(now + sequence).toISOString(),
          client_id: clientId,
          deleted_at: null,
        });
      }
    });

    currentRecords.forEach((existing, key) => {
      if (!existing.deleted_at && !desired.has(key)) {
        sequence += 1;
        changed.push({
          ...existing,
          payload: null,
          updated_at: new Date(now + sequence).toISOString(),
          deleted_at: new Date(now + sequence).toISOString(),
          client_id: clientId,
        });
      }
    });

    if (changed.length) await queueRecords(changed);
  }

  const queueLocalCapture = (raw) => {
    if (!raw) return localCaptureChain;
    lastObservedFingerprint = fingerprintRaw(raw);
    if (!initializedUserId) {
      pendingLocalRaw = raw;
      return localCaptureChain;
    }
    localCaptureChain = localCaptureChain
      .catch(() => undefined)
      .then(() => captureLocalChanges(raw));
    return localCaptureChain;
  };

  const deferRemoteRecord = (record, message = "") => {
    const key = recordKey(record);
    deferredRemoteRecords.set(
      key,
      newerRecord(deferredRemoteRecords.get(key), record)
    );
    if (message) deferredRemoteMessage = message;
  };

  async function flushDeferredRemote(raw = "") {
    if (raw) await queueLocalCapture(raw);
    else await localCaptureChain.catch(() => undefined);

    if (deferredRemoteRecords.size && initializedUserId) {
      currentRecords = mergeRecordMaps(currentRecords, deferredRemoteRecords);
      await putStoredRecords(
        RECORDS_STORE,
        initializedUserId,
        [...currentRecords.values()]
      );
      deferredRemoteRecords = new Map();
      const message =
        deferredRemoteMessage || "다른 기기의 변경사항을 받았습니다";
      deferredRemoteMessage = "";
      applyRecordsToApp(currentRecords, message);
    }

    if (reconnectAfterEditing && currentSession?.user) {
      reconnectAfterEditing = false;
      await connectSync();
    }
  }

  function readLegacyPending() {
    try {
      const pending = JSON.parse(
        localStorage.getItem(LEGACY_PENDING_KEY) || "null"
      );
      return pending?.raw ? pending : null;
    } catch {
      return null;
    }
  }

  async function migrateIfNeeded(userId, remoteRecords) {
    if (remoteRecords.size) return remoteRecords;
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let localStore = null;
    try {
      localStore = localRaw ? JSON.parse(localRaw) : null;
    } catch {
      localStore = null;
    }
    const legacy = await fetchLegacyStore(userId);
    const localUpdatedAt =
      Number(localStorage.getItem(LOCAL_UPDATED_KEY)) || Date.now();
    const localRecords = localStore
      ? storeToRecords(
          localStore,
          new Date(localUpdatedAt).toISOString(),
          clientId
        )
      : new Map();
    const legacyRecords = legacy?.store
      ? storeToRecords(
          legacy.store,
          legacy.updated_at || new Date(0).toISOString(),
          "legacy-cloud"
        )
      : new Map();
    const migrated = mergeRecordMaps(legacyRecords, localRecords);
    if (migrated.size) {
      await Promise.all([
        putStoredRecords(
          RECORDS_STORE,
          userId,
          [...migrated.values()]
        ),
        putStoredRecords(
          OUTBOX_STORE,
          userId,
          [...migrated.values()]
        ),
      ]);
    }
    return migrated;
  }

  async function subscribeRealtime(userId, generation) {
    channel = client
      .channel(`exp-note-records-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "exp_note_records",
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          if (generation !== syncGeneration || !payload.new?.entity_type)
            return;
          const incoming = {
            entity_type: payload.new.entity_type,
            entity_id: payload.new.entity_id,
            payload: payload.new.payload,
            updated_at: payload.new.updated_at,
            deleted_at: payload.new.deleted_at,
            client_id: payload.new.client_id,
          };
          if (incoming.client_id === clientId) return;
          await localCaptureChain.catch(() => undefined);
          const key = recordKey(incoming);
          const existing = appEditing
            ? newerRecord(
                currentRecords.get(key),
                deferredRemoteRecords.get(key)
              )
            : currentRecords.get(key);
          if (existing && compareRecords(existing, incoming) >= 0) return;
          await putStoredRecords(RECORDS_STORE, userId, [incoming]);
          if (appEditing) {
            deferRemoteRecord(
              incoming,
              "다른 기기의 변경사항을 받았습니다"
            );
            setStatus("입력 완료 후 다른 기기 변경사항 병합");
            return;
          }
          currentRecords.set(key, incoming);
          applyRecordsToApp(
            currentRecords,
            "다른 기기의 변경사항을 받았습니다"
          );
        }
      )
      .subscribe((state) => {
        if (generation !== syncGeneration) return;
        if (state === "SUBSCRIBED") {
          setStatus("클라우드 저장됨");
        } else if (
          ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(state)
        ) {
          setStatus(
            navigator.onLine === false
              ? "오프라인 · 이 기기에 안전하게 저장됨"
              : "연결 재시도 중…"
          );
          scheduleReconnect();
        }
      });
  }

  async function disconnectRealtime() {
    if (!channel) return;
    await client.removeChannel(channel);
    channel = null;
  }

  const scheduleReconnect = () => {
    if (reconnectTimer || !currentSession?.user) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (!currentSession?.user) return;
      if (appEditing) {
        reconnectAfterEditing = true;
        return;
      }
      connectSync();
    }, 4000);
  };

  async function connectSync() {
    if (appEditing) {
      reconnectAfterEditing = true;
      setStatus("입력 완료 후 클라우드 연결 재개");
      return;
    }
    await localCaptureChain.catch(() => undefined);
    const generation = ++syncGeneration;
    initializedUserId = "";
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await disconnectRealtime();
    if (generation !== syncGeneration || !currentSession?.user) return;

    const userId = currentSession.user.id;
    setStatus("클라우드 확인 중…");
    let cached = new Map();
    let outbox = new Map();
    try {
      [cached, outbox] = await Promise.all([
        getStoredRecords(RECORDS_STORE, userId),
        getStoredRecords(OUTBOX_STORE, userId),
      ]);
    } catch {
      setStatus("이 기기의 저장소를 확인할 수 없습니다");
      return;
    }

    let remote = new Map();
    if (navigator.onLine !== false) {
      try {
        remote = await fetchRemoteRecords(userId);
        remote = await migrateIfNeeded(userId, remote);
      } catch (error) {
        if (!cached.size && !outbox.size) {
          setStatus("새 동기화 구조 설정이 필요합니다");
          errorBox.textContent =
            "Supabase에 항목별 동기화 테이블을 먼저 설정해주세요.";
          return;
        }
      }
    }
    if (generation !== syncGeneration) return;

    currentRecords = mergeRecordMaps(cached, remote, outbox);

    const legacyPending = readLegacyPending();
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    if (
      legacyPending?.raw &&
      fingerprintRaw(legacyPending.raw) === fingerprintRaw(localRaw)
    ) {
      const pendingRecords = storeToRecords(
        JSON.parse(legacyPending.raw),
        new Date(
          Number(legacyPending.updatedAt) || Date.now()
        ).toISOString(),
        clientId
      );
      const changed = [];
      pendingRecords.forEach((record, key) => {
        const winner = newerRecord(currentRecords.get(key), record);
        if (winner === record) changed.push(record);
      });
      if (changed.length) {
        await Promise.all([
          putStoredRecords(RECORDS_STORE, userId, changed),
          putStoredRecords(OUTBOX_STORE, userId, changed),
        ]);
        currentRecords = mergeRecordMaps(currentRecords, pendingRecords);
      }
    }

    if (!currentRecords.size && localRaw) {
      const seeded = storeToRecords(
        JSON.parse(localRaw),
        new Date().toISOString(),
        clientId
      );
      currentRecords = seeded;
      await Promise.all([
        putStoredRecords(RECORDS_STORE, userId, [...seeded.values()]),
        putStoredRecords(OUTBOX_STORE, userId, [...seeded.values()]),
      ]);
    }

    await putStoredRecords(
      RECORDS_STORE,
      userId,
      [...currentRecords.values()]
    );
    initializedUserId = userId;
    if (pendingLocalRaw) {
      const raw = pendingLocalRaw;
      pendingLocalRaw = "";
      await queueLocalCapture(raw);
    }
    applyRecordsToApp(currentRecords);
    if (navigator.onLine === false) {
      setStatus("오프라인 · 이 기기에 안전하게 저장됨");
    } else {
      await uploadOutbox();
      if (generation !== syncGeneration) return;
      await subscribeRealtime(userId, generation);
    }
  }

  async function applySession(session) {
    const previousUserId = currentSession?.user?.id || "";
    const sameInitializedUser = Boolean(
      session?.user &&
        initializedUserId === session.user.id &&
        previousUserId === session.user.id
    );
    currentSession = session;
    const loggedIn = Boolean(session?.user);
    dot.classList.toggle("on", loggedIn);
    signedOut.hidden = loggedIn;
    signedIn.hidden = !loggedIn;
    accountEmail.textContent = session?.user?.email || "";
    if (!loggedIn) label.textContent = "클라우드 로그인";
    else if (!sameInitializedUser) label.textContent = "클라우드 확인 중…";
    if (!loggedIn) {
      initializedUserId = "";
      currentRecords = new Map();
      deferredRemoteRecords = new Map();
      deferredRemoteMessage = "";
      reconnectAfterEditing = false;
      pendingLocalRaw = "";
      await disconnectRealtime();
      return;
    }
    if (sameInitializedUser) return;
    await connectSync();
  }

  async function authenticate(mode) {
    errorBox.textContent = "";
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || password.length < 6) {
      errorBox.textContent =
        "이메일과 6자 이상의 비밀번호를 입력해주세요.";
      return;
    }
    setBusy(true);
    const result =
      mode === "signup"
        ? await client.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.href },
          })
        : await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) {
      errorBox.textContent = result.error.message;
      return;
    }
    if (mode === "signup" && !result.data.session) {
      errorBox.textContent =
        "인증 이메일을 보냈습니다. 인증 링크를 누른 뒤 로그인해주세요.";
      return;
    }
    closeDialog();
  }

  const openDialog = () => {
    errorBox.textContent = "";
    backdrop.hidden = false;
    window.setTimeout(
      () => (currentSession ? closeButton : emailInput).focus(),
      0
    );
  };
  const closeDialog = () => {
    backdrop.hidden = true;
  };

  launcher.addEventListener("click", openDialog);
  closeButton.addEventListener("click", closeDialog);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) closeDialog();
  });
  signInButton.addEventListener("click", () => authenticate("signin"));
  signUpButton.addEventListener("click", () => authenticate("signup"));
  signOutButton.addEventListener("click", async () => {
    setBusy(true);
    await client.auth.signOut();
    setBusy(false);
    closeDialog();
  });

  window.addEventListener("message", async (event) => {
    if (
      event.origin !== window.location.origin ||
      event.source !== frame?.contentWindow
    ) {
      return;
    }
    if (event.data?.type === "exp-note-ready") {
      if (pendingAppStore) postStoreToApp(pendingAppStore);
      return;
    }
    if (
      event.data?.type === "exp-note-local-store" &&
      typeof event.data.raw === "string"
    ) {
      queueLocalCapture(event.data.raw);
      return;
    }
    if (event.data?.type === "exp-note-editing") {
      appEditing = Boolean(event.data.editing);
      if (appEditing) return;
      await flushDeferredRemote(
        typeof event.data.raw === "string" ? event.data.raw : ""
      );
      return;
    }
    if (
      event.data?.type === "exp-note-cloud-store-applied" &&
      event.data.fingerprint === pendingAppFingerprint
    ) {
      pendingAppStore = null;
      pendingAppFingerprint = "";
    }
  });

  frame?.addEventListener("load", () => {
    if (pendingAppStore) postStoreToApp(pendingAppStore);
  });

  window.setInterval(() => {
    if (!initializedUserId) return;
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    const fingerprint = fingerprintRaw(raw);
    if (!raw || fingerprint === lastObservedFingerprint) return;
    queueLocalCapture(raw);
  }, 500);

  window.addEventListener("offline", () => {
    setStatus("오프라인 · 이 기기에 안전하게 저장됨");
  });
  window.addEventListener("online", () => {
    setStatus("연결됨 · 변경사항 병합 중…");
    if (appEditing) {
      reconnectAfterEditing = true;
      setStatus("입력 완료 후 변경사항 병합");
      return;
    }
    connectSync();
  });

  client.auth.getSession().then(({ data }) => applySession(data.session));
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
})();
