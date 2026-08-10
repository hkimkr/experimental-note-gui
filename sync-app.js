// Experimental Note GUI v4.1.0 — enhanced memo board (tags, colors, pinch zoom).
(() => {
  "use strict";

  const STORAGE_KEY = "hamin-exp-note-v1";
  const LOCAL_UPDATED_KEY = "hamin-exp-note-v1-local-updated-at";
  const LEGACY_PENDING_KEY = "hamin-exp-note-v1-pending-sync";
  const CLIENT_ID_KEY = "exp-note-sync-client-id";
  const TAB_CHANNEL_NAME = "exp-note-sync-tabs-v1";
  const DB_NAME = "exp-note-sync-v1";
  const DB_VERSION = 2;
  const RECORDS_STORE = "records";
  const OUTBOX_STORE = "outbox";
  const SHARED_RECORDS_STORE = "shared_records";
  const SHARED_OUTBOX_STORE = "shared_outbox";
  const INTENT_CLIENT_PREFIX = "intent-v3:";
  const DELETE_INTENT_CLIENT_PREFIX = "delete-v3:";
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

  const deviceId = (() => {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const created =
      globalThis.crypto?.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  })();
  const tabId =
    globalThis.crypto?.randomUUID?.() ||
    `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // A device id shared by every tab made one tab ignore another tab's
  // realtime updates as its own. Keep the device identity for diagnostics,
  // but make every browser tab a distinct sync writer.
  const clientId = `${deviceId}:tab:${tabId}`;
  const intentClientId = `${INTENT_CLIENT_PREFIX}${clientId}`;
  const deleteIntentClientId = `${DELETE_INTENT_CLIENT_PREFIX}${clientId}`;
  const tabChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(TAB_CHANNEL_NAME)
    : null;

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
  let uploadAfterEditing = false;
  let reconnectAfterEditing = false;
  let deferredRemoteRecords = new Map();
  let deferredRemoteMessage = "";
  let localCaptureChain = Promise.resolve();
  let latestQueuedLocalRaw = "";
  let localCaptureRunning = false;
  let pendingLocalRaw = "";
  let incomingProtocolTimer = null;
  let incomingProtocolLoading = false;
  let resumeSyncTimer = null;
  let sharedMemberships = new Map();
  let sharedChannel = null;
  let sharedUploadRunning = false;
  let incomingInviteTimer = null;
  let sharedRefreshTimer = null;

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

  const EMPTY_PLACEHOLDERS = new Set([
    "기본 프로젝트",
    "새 프로젝트",
    "새 실험",
    "새 프로토콜",
    "프로토콜",
    "제목 없음",
    "제목 없는 메모",
    "v1",
    "시약",
    "반응 조건",
    "실험 방법",
    "freeform",
    "pending",
    "uL",
  ]);
  const STRUCTURAL_KEYS = new Set([
    "id",
    "parent_id",
    "parent_project_id",
    "parent_experiment_id",
    "item_order",
    "order",
    "version",
    "createdAt",
    "savedAt",
    "updatedAt",
    "completedAt",
    "date",
    "color",
    "activeVersionId",
    "linkedProtocolId",
    "linkedProtocolVersionId",
    "linkedExperimentId",
    "sourceStepGroupId",
    "sourceProtocolId",
  ]);

  const isPlainObject = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function hasMeaningfulValue(value, key = "") {
    if (STRUCTURAL_KEYS.has(key)) return false;
    if (value == null) return false;
    if (typeof value === "string") {
      const text = value.trim();
      return Boolean(text) && !EMPTY_PLACEHOLDERS.has(text);
    }
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) {
      return value.some((item) => hasMeaningfulValue(item));
    }
    if (isPlainObject(value)) {
      return Object.entries(value).some(
        ([childKey, childValue]) =>
          !STRUCTURAL_KEYS.has(childKey) &&
          hasMeaningfulValue(childValue, childKey)
      );
    }
    return Boolean(value);
  }

  const arrayItemKey = (item) =>
    isPlainObject(item) && item.id != null ? String(item.id) : "";

  function mergeContentValues(
    olderValue,
    preferredValue,
    preferredIntent = false
  ) {
    const olderMeaningful = hasMeaningfulValue(olderValue);
    const preferredMeaningful = hasMeaningfulValue(preferredValue);
    if (!preferredMeaningful && olderMeaningful) return clone(olderValue);
    if (!olderMeaningful) return clone(preferredValue);

    if (Array.isArray(olderValue) && Array.isArray(preferredValue)) {
      const keyed = [...olderValue, ...preferredValue].every(
        (item) => !isPlainObject(item) || Boolean(arrayItemKey(item))
      );
      if (keyed && [...olderValue, ...preferredValue].some(isPlainObject)) {
        const olderById = new Map(
          olderValue
            .map((item) => [arrayItemKey(item), item])
            .filter(([id]) => id)
        );
        const merged = preferredValue.map((item) => {
          const id = arrayItemKey(item);
          return id && olderById.has(id)
            ? mergeContentValues(olderById.get(id), item, preferredIntent)
            : clone(item);
        });
        const preferredIds = new Set(
          preferredValue.map(arrayItemKey).filter(Boolean)
        );
        if (!preferredIntent) {
          olderValue.forEach((item) => {
            const id = arrayItemKey(item);
            if (!id || !preferredIds.has(id)) merged.push(clone(item));
          });
        }
        return merged;
      }
      const seen = new Set();
      return [...preferredValue, ...olderValue]
        .filter((item) => {
          const fingerprint = fingerprintValue(item);
          if (seen.has(fingerprint)) return false;
          seen.add(fingerprint);
          return true;
        })
        .map(clone);
    }

    if (isPlainObject(olderValue) && isPlainObject(preferredValue)) {
      const merged = {};
      new Set([...Object.keys(olderValue), ...Object.keys(preferredValue)])
        .forEach((childKey) => {
          if (!(childKey in preferredValue)) {
            merged[childKey] = clone(olderValue[childKey]);
          } else if (!(childKey in olderValue)) {
            merged[childKey] = clone(preferredValue[childKey]);
          } else {
            merged[childKey] = mergeContentValues(
              olderValue[childKey],
              preferredValue[childKey],
              preferredIntent
            );
          }
        });
      return merged;
    }

    return clone(preferredValue);
  }

  function contentAwareRecord(left, right) {
    if (!left) return clone(right);
    if (!right) return clone(left);
    const preferred = compareRecords(left, right) >= 0 ? left : right;
    const older = preferred === left ? right : left;
    const preferredActive = !preferred.deleted_at && preferred.payload != null;
    const olderActive = !older.deleted_at && older.payload != null;

    if (
      preferred.deleted_at &&
      String(preferred.client_id || "").startsWith(
        DELETE_INTENT_CLIENT_PREFIX
      )
    ) {
      return clone(preferred);
    }
    if (!preferredActive && olderActive && hasMeaningfulValue(older.payload)) {
      return clone(older);
    }
    if (!olderActive || !preferredActive) return clone(preferred);
    if (
      !hasMeaningfulValue(preferred.payload) &&
      hasMeaningfulValue(older.payload)
    ) {
      return { ...clone(preferred), payload: clone(older.payload), deleted_at: null };
    }
    return {
      ...clone(preferred),
      payload: mergeContentValues(
        older.payload,
        preferred.payload,
        isIntentRecord(preferred)
      ),
      deleted_at: null,
    };
  }

  const sameRecordContent = (left, right) =>
    Boolean(left) === Boolean(right) &&
    (!left ||
      (Boolean(left.deleted_at) === Boolean(right.deleted_at) &&
        fingerprintValue(left.payload) === fingerprintValue(right.payload)));

  function expandedRecords(record) {
    if (
      record?.entity_type !== "project_experiment" ||
      record.deleted_at ||
      !Array.isArray(record.payload?.item?.protocols)
    ) {
      return [record];
    }
    const projectId = String(record.payload.parent_id || "");
    const experimentId = String(
      record.payload.item.id ||
        record.entity_id.split(":").slice(1).join(":")
    );
    const { protocols, ...experimentBase } = record.payload.item;
    const expanded = [{
      ...clone(record),
      payload: { ...clone(record.payload), item: experimentBase },
    }];
    protocols.forEach((protocol, index) => {
      const protocolId = stableItemId(
        protocol,
        experimentId,
        index,
        "experiment_protocol"
      );
      expanded.push({
        ...clone(record),
        entity_type: "experiment_protocol",
        entity_id: `${projectId}:${experimentId}:${protocolId}`,
        payload: {
          parent_id: projectId,
          experiment_id: experimentId,
          item_order: index,
          item: { ...(protocol || {}), id: protocolId },
        },
      });
    });
    return expanded;
  }

  const isIntentRecord = (record) =>
    record?.local_intent === true ||
    String(record?.client_id || "").startsWith(INTENT_CLIENT_PREFIX) ||
    String(record?.client_id || "").startsWith(
      DELETE_INTENT_CLIENT_PREFIX
    );

  const isOwnRecord = (record) =>
    record?.client_id === clientId ||
    record?.client_id === intentClientId ||
    record?.client_id === deleteIntentClientId;

  const activeRecordCount = (records, type) =>
    [...(records?.values?.() || [])].filter(
      (record) => record.entity_type === type && !record.deleted_at
    ).length;

  function storeContentScore(store) {
    if (!store || typeof store !== "object") return 0;
    let score = 0;
    const projects = Array.isArray(store.projects) ? store.projects : [];
    projects.forEach((project) => {
      const projectName = String(project?.name || "").trim();
      if (
        projectName &&
        !["기본 프로젝트", "새 프로젝트"].includes(projectName)
      ) {
        score += 1;
      }
      score += (Array.isArray(project?.experiments)
        ? project.experiments.length
        : 0) * 8;
      score += (Array.isArray(project?.notes) ? project.notes.length : 0) * 8;
      score += (Array.isArray(project?.inventory)
        ? project.inventory.length
        : 0) * 4;
      score += (Array.isArray(project?.memoSnapshots)
        ? project.memoSnapshots.length
        : 0) * 4;
      if (String(project?.memoScratch?.content || "").trim()) score += 3;
    });
    return score;
  }

  const recordsContentScore = (records, fallbackStore = {}) => {
    if (!records?.size) return 0;
    const childScore =
      activeRecordCount(records, "project_experiment") * 8 +
      activeRecordCount(records, "experiment_protocol") * 6 +
      activeRecordCount(records, "project_note") * 8 +
      activeRecordCount(records, "project_inventory") * 4 +
      activeRecordCount(records, "project_memo") * 4;
    return Math.max(
      childScore,
      storeContentScore(recordsToStore(records, fallbackStore))
    );
  };

  const intentRecordsFromStore = (store, timestamp = Date.now()) => {
    const base = storeToRecords(
      store,
      new Date(timestamp).toISOString(),
      intentClientId
    );
    const marked = new Map();
    let sequence = 0;
    base.forEach((record, key) => {
      sequence += 1;
      marked.set(key, {
        ...record,
        updated_at: new Date(timestamp + sequence).toISOString(),
        client_id: intentClientId,
        local_intent: true,
      });
    });
    return marked;
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
    const add = (type, id, payload, projectId = null) => {
      const record = makeRecord(
        type,
        id,
        payload,
        updatedAt,
        sourceClientId
      );
      if (projectId) record.__projectId = projectId;
      result.set(recordKey(record), record);
    };

    const { projects = [], ...root } = store;
    const projectList = Array.isArray(projects) ? projects : [];

    add("root", "main", {
      ...root,
      projectOrder: projectList.map((project, index) =>
        stableItemId(project, "root", index, "project")
      ),
    });
    projectList.forEach((project, index) => {
      const id = stableItemId(project, "root", index, "project");
      const sharedProjectId = sharedMemberships.has(id) ? id : null;
      const {
        experiments = [],
        notes = [],
        inventory = [],
        memoSnapshots = [],
        memoScratch = { content: "", updatedAt: null },
        ...projectBase
      } = project || {};
      add("project", id, { ...projectBase, id, order: index }, sharedProjectId);

      (Array.isArray(experiments) ? experiments : []).forEach(
        (experiment, experimentIndex) => {
          const experimentId = stableItemId(
            experiment,
            id,
            experimentIndex,
            "project_experiment"
          );
          const { protocols = [], ...experimentBase } = experiment || {};
          add("project_experiment", `${id}:${experimentId}`, {
            parent_id: id,
            item_order: experimentIndex,
            item: { ...experimentBase, id: experimentId },
          }, sharedProjectId);
          (Array.isArray(protocols) ? protocols : []).forEach(
            (protocol, protocolIndex) => {
              const protocolId = stableItemId(
                protocol,
                experimentId,
                protocolIndex,
                "experiment_protocol"
              );
              add(
                "experiment_protocol",
                `${id}:${experimentId}:${protocolId}`,
                {
                  parent_id: id,
                  experiment_id: experimentId,
                  item_order: protocolIndex,
                  item: { ...(protocol || {}), id: protocolId },
                },
                sharedProjectId
              );
            }
          );
        }
      );

      [
        ["project_note", notes],
        ["project_inventory", inventory],
        ["project_memo", memoSnapshots],
      ].forEach(([type, items]) => {
        (Array.isArray(items) ? items : []).forEach((item, itemIndex) => {
          const itemId = stableItemId(item, id, itemIndex, type);
          add(type, `${id}:${itemId}`, {
            parent_id: id,
            item_order: itemIndex,
            item: { ...(item || {}), id: itemId },
          }, sharedProjectId);
        });
      });
      add("project_scratch", id, {
        parent_id: id,
        value: memoScratch || { content: "", updatedAt: null },
      }, sharedProjectId);
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

    const projects = new Map();
    const childOrder = new Map();
    const protocolOrder = new Map();
    activeRecordsOfType(records, "project").forEach((record) => {
      const payload = clone(record.payload) || {};
      const project = {
        ...payload,
        id: payload.id || record.entity_id,
        experiments: Array.isArray(payload.experiments) ? payload.experiments : [],
        notes: Array.isArray(payload.notes) ? payload.notes : [],
        inventory: Array.isArray(payload.inventory) ? payload.inventory : [],
        memoSnapshots: Array.isArray(payload.memoSnapshots) ? payload.memoSnapshots : [],
        memoScratch: payload.memoScratch || { content: "", updatedAt: null },
      };
      ["experiments", "notes", "inventory", "memoSnapshots"].forEach(
        (field) => project[field].forEach((item, index) => {
          childOrder.set(`${record.entity_id}|${field}|${item?.id || ""}`, index);
        })
      );
      projects.set(record.entity_id, project);
    });

    [
      ["project_experiment", "experiments"],
      ["project_note", "notes"],
      ["project_inventory", "inventory"],
      ["project_memo", "memoSnapshots"],
    ].forEach(([type, field]) => {
      [...records.values()]
        .filter((record) => record.entity_type === type)
        .sort(compareRecords)
        .forEach((record) => {
          const payload = record.payload || {};
          const project = projects.get(payload.parent_id);
          if (!project) return;
          const itemId = String(
            payload.item?.id || record.entity_id.split(":").slice(1).join(":")
          );
          project[field] = (project[field] || []).filter(
            (item) => String(item?.id || "") !== itemId
          );
          if (!record.deleted_at && payload.item) {
            project[field].push(clone(payload.item));
            childOrder.set(
              `${payload.parent_id}|${field}|${itemId}`,
              Number.isFinite(payload.item_order)
                ? payload.item_order
                : project[field].length - 1
            );
          }
        });
    });

    [...records.values()]
      .filter((record) => record.entity_type === "experiment_protocol")
      .sort(compareRecords)
      .forEach((record) => {
        const payload = record.payload || {};
        const project = projects.get(payload.parent_id);
        const experiment = project?.experiments?.find(
          (item) => String(item?.id || "") === String(payload.experiment_id || "")
        );
        if (!experiment) return;
        const protocolId = String(
          payload.item?.id || record.entity_id.split(":").slice(2).join(":")
        );
        experiment.protocols = (experiment.protocols || []).filter(
          (item) => String(item?.id || "") !== protocolId
        );
        if (!record.deleted_at && payload.item) {
          experiment.protocols.push(clone(payload.item));
          protocolOrder.set(
            `${payload.parent_id}|${payload.experiment_id}|${protocolId}`,
            Number.isFinite(payload.item_order)
              ? payload.item_order
              : experiment.protocols.length - 1
          );
        }
      });

    [...records.values()]
      .filter((record) => record.entity_type === "project_scratch")
      .sort(compareRecords)
      .forEach((record) => {
        const payload = record.payload || {};
        const project = projects.get(payload.parent_id || record.entity_id);
        if (!project) return;
        project.memoScratch = record.deleted_at
          ? { content: "", updatedAt: null }
          : clone(payload.value || { content: "", updatedAt: null });
      });

    const sortChildren = (projectId, field, items) =>
      [...items].sort((left, right) => {
        const leftOrder = childOrder.get(`${projectId}|${field}|${left?.id || ""}`);
        const rightOrder = childOrder.get(`${projectId}|${field}|${right?.id || ""}`);
        if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return leftOrder - rightOrder;
        if (Number.isFinite(leftOrder)) return -1;
        if (Number.isFinite(rightOrder)) return 1;
        return itemSort(left, right);
      });

    const projectOrder = Array.isArray(root.projectOrder)
      ? root.projectOrder.map(String)
      : [];
    const projectRank = (id) => {
      const index = projectOrder.indexOf(String(id));
      return index >= 0 ? index : Number.POSITIVE_INFINITY;
    };

    store.projects = [...projects.values()]
      .map((project) => ({
        ...project,
        experiments: sortChildren(project.id, "experiments", project.experiments || [])
          .map((experiment) => ({
            ...experiment,
            protocols: [...(experiment.protocols || [])].sort((left, right) => {
              const leftOrder = protocolOrder.get(
                `${project.id}|${experiment.id}|${left?.id || ""}`
              );
              const rightOrder = protocolOrder.get(
                `${project.id}|${experiment.id}|${right?.id || ""}`
              );
              if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) {
                return leftOrder - rightOrder;
              }
              if (Number.isFinite(leftOrder)) return -1;
              if (Number.isFinite(rightOrder)) return 1;
              return itemSort(left, right);
            }),
          })),
        notes: sortChildren(project.id, "notes", project.notes || []),
        inventory: sortChildren(project.id, "inventory", project.inventory || []),
        memoSnapshots: sortChildren(project.id, "memoSnapshots", project.memoSnapshots || []),
      }))
      .sort((left, right) => {
        const bySavedOrder = projectRank(left.id) - projectRank(right.id);
        if (bySavedOrder !== 0) return bySavedOrder;
        return itemSort(left, right);
      });
    store.projectOrder = store.projects.map((project) => project.id);
    return store;
  }

  function mergeRecordMaps(...maps) {
    const merged = new Map();
    maps.forEach((records) => {
      records?.forEach((record, key) => {
        expandedRecords(record).forEach((expanded) => {
          const expandedKey = recordKey(expanded);
          merged.set(
            expandedKey,
            contentAwareRecord(merged.get(expandedKey), expanded)
          );
        });
      });
    });
    return merged;
  }

  function repairRecordsAgainstRemote(records, remoteRecords) {
    const repairs = new Map();
    let sequence = 0;
    const now = Date.now();
    records.forEach((record, key) => {
      const remote = remoteRecords.get(key);
      if (
        sameRecordContent(record, remote) ||
        (!remote && !hasMeaningfulValue(record.payload))
      ) {
        return;
      }
      sequence += 1;
      repairs.set(key, {
        ...clone(record),
        updated_at: new Date(now + sequence).toISOString(),
        client_id: record.deleted_at
          ? deleteIntentClientId
          : intentClientId,
        local_intent: true,
      });
    });
    return repairs;
  }

  function resolveInitialRecordState({
    remote,
    cached,
    outbox,
    localRecords,
    pendingRecords,
    remoteFetched,
    localStore,
  }) {
    const trustedOutbox = new Map();
    const legacyOutbox = new Map();
    outbox.forEach((record, key) =>
      (isIntentRecord(record) ? trustedOutbox : legacyOutbox).set(key, record)
    );

    if (!remoteFetched) {
      const offlineRecords = mergeRecordMaps(
        cached,
        localRecords,
        outbox,
        pendingRecords
      );
      if (offlineRecords.size || storeContentScore(localStore) === 0) {
        return {
          records: offlineRecords,
          outbox: new Map(outbox),
          reason: "offline-local",
        };
      }
      const recovered = intentRecordsFromStore(localStore);
      return {
        records: recovered,
        outbox: recovered,
        reason: "offline-recovery",
      };
    }

    const merged = mergeRecordMaps(
      remote,
      cached,
      localRecords,
      legacyOutbox,
      pendingRecords,
      trustedOutbox
    );
    if (!recordsContentScore(merged) && storeContentScore(localStore) === 0) {
      return {
        records: mergeRecordMaps(remote),
        outbox: new Map(),
        reason: "empty-account",
      };
    }

    const repairs = repairRecordsAgainstRemote(merged, remote);
    const nextOutbox = mergeRecordMaps(trustedOutbox, repairs);
    return {
      records: mergeRecordMaps(merged, repairs),
      outbox: nextOutbox,
      reason: repairs.size
        ? recordsContentScore(remote) > 0
          ? "content-aware-merge"
          : "meaningful-local-recovery"
        : "cloud-authoritative",
    };
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
        if (!db.objectStoreNames.contains(SHARED_RECORDS_STORE)) {
          db.createObjectStore(SHARED_RECORDS_STORE, { keyPath: "local_key" });
        }
        if (!db.objectStoreNames.contains(SHARED_OUTBOX_STORE)) {
          db.createObjectStore(SHARED_OUTBOX_STORE, { keyPath: "local_key" });
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

  async function replaceStoredRecords(storeName, userId, records) {
    const db = await openSyncDb();
    const existingEntries = await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      existingEntries
        .filter((entry) => entry.user_id === userId)
        .forEach((entry) => objectStore.delete(entry.local_key));
      (records || []).forEach((record) => {
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

  // --- Shared (multi-user, project-scoped) record storage ---------------
  // Mirrors the personal record helpers above, but keyed by project id
  // instead of user id, since shared records are jointly owned by every
  // member of a project rather than a single account.
  const sharedLocalKey = (userId, record) =>
    `${userId}|shared|${record.__projectId}|${recordKey(record)}`;

  async function getStoredSharedRecords(storeName, userId) {
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

  async function putStoredSharedRecords(storeName, userId, records) {
    if (!records?.length) return;
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      records.forEach((record) => {
        objectStore.put({
          ...clone(record),
          user_id: userId,
          local_key: sharedLocalKey(userId, record),
        });
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function replaceStoredSharedRecords(storeName, userId, records) {
    const db = await openSyncDb();
    const existingEntries = await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      existingEntries
        .filter((entry) => entry.user_id === userId)
        .forEach((entry) => objectStore.delete(entry.local_key));
      (records || []).forEach((record) => {
        objectStore.put({
          ...clone(record),
          user_id: userId,
          local_key: sharedLocalKey(userId, record),
        });
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function deleteSharedOutboxRecords(userId, uploadedRecords) {
    if (!uploadedRecords?.length) return;
    const latestOutbox = await getStoredSharedRecords(
      SHARED_OUTBOX_STORE,
      userId
    );
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SHARED_OUTBOX_STORE, "readwrite");
      const objectStore = transaction.objectStore(SHARED_OUTBOX_STORE);
      uploadedRecords.forEach((record) => {
        const latest = latestOutbox.get(recordKey(record));
        if (
          latest &&
          latest.updated_at === record.updated_at &&
          latest.client_id === record.client_id
        ) {
          objectStore.delete(sharedLocalKey(userId, record));
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

  const appliedStatus = () => {
    const time = new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
    setStatus(`이 기기 반영됨 · ${time}`);
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

  // --- Project sharing (multi-user co-editing) ---------------------------

  async function fetchSharedMemberships() {
    if (!currentSession?.user) return sharedMemberships;
    const { data, error } = await client.rpc("list_exp_note_shared_projects");
    if (error || !Array.isArray(data)) return sharedMemberships;
    const next = new Map();
    data.forEach((row) => {
      if (!row?.project_id) return;
      next.set(String(row.project_id), {
        role: row.role,
        projectName: row.project_name || "",
      });
    });
    sharedMemberships = next;
    return sharedMemberships;
  }

  async function fetchSharedRemoteRecords(projectIds) {
    if (!projectIds?.length) return new Map();
    const { data, error } = await client
      .from("exp_note_shared_records")
      .select(
        "project_id,entity_type,entity_id,payload,updated_at,deleted_at,client_id"
      )
      .in("project_id", projectIds);
    if (error) throw error;
    const records = new Map();
    (data || []).forEach((row) => {
      const record = {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        payload: row.payload,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
        client_id: row.client_id,
        __projectId: String(row.project_id),
      };
      records.set(recordKey(record), record);
    });
    return records;
  }

  function postSharedRolesToApp() {
    frame?.contentWindow?.postMessage(
      {
        type: "exp-note-shared-roles",
        roles: [...sharedMemberships.entries()].map(([projectId, info]) => ({
          projectId,
          role: info.role,
          projectName: info.projectName,
        })),
      },
      window.location.origin
    );
  }

  async function migrateProjectToShared(projectId) {
    const userId = currentSession?.user?.id;
    if (!userId) return;
    const prefix = `${projectId}:`;
    const now = Date.now();
    let sequence = 0;
    const sharedPush = [];
    const personalTombstones = [];
    currentRecords.forEach((record) => {
      if (record.__projectId || record.entity_type === "root") return;
      const belongs =
        record.entity_id === projectId || record.entity_id.startsWith(prefix);
      if (!belongs) return;
      sequence += 1;
      const timestamp = new Date(now + sequence).toISOString();
      sharedPush.push({
        ...clone(record),
        updated_at: timestamp,
        client_id: intentClientId,
        local_intent: true,
        __projectId: projectId,
      });
      personalTombstones.push({
        entity_type: record.entity_type,
        entity_id: record.entity_id,
        payload: null,
        updated_at: timestamp,
        deleted_at: timestamp,
        client_id: deleteIntentClientId,
        local_intent: true,
      });
    });
    if (!sharedPush.length) return;
    sharedPush.forEach((record) => currentRecords.set(recordKey(record), record));
    await Promise.all([
      putStoredSharedRecords(SHARED_RECORDS_STORE, userId, sharedPush),
      putStoredSharedRecords(SHARED_OUTBOX_STORE, userId, sharedPush),
      putStoredRecords(OUTBOX_STORE, userId, personalTombstones),
    ]);
    scheduleUpload();
  }

  async function refreshSharedProjects() {
    if (!currentSession?.user || navigator.onLine === false) return;
    const userId = currentSession.user.id;
    const previousIds = new Set(sharedMemberships.keys());
    const next = await fetchSharedMemberships();
    const nextIds = new Set(next.keys());
    const added = [...nextIds].filter((id) => !previousIds.has(id));
    const removed = [...previousIds].filter((id) => !nextIds.has(id));
    if (added.length) {
      try {
        const records = await fetchSharedRemoteRecords(added);
        if (records.size) {
          await mergeIncomingRecords(
            userId,
            [...records.values()],
            "공유 프로젝트를 불러왔습니다"
          );
        }
        await Promise.all(added.map((projectId) => migrateProjectToShared(projectId)));
      } catch {
        // The shared-sharing SQL may not be applied yet; retry next cycle.
      }
    }
    if (added.length || removed.length) {
      await subscribeSharedRealtime([...nextIds], syncGeneration);
    }
    postSharedRolesToApp();
  }

  const scheduleSharedProjectsRefresh = () => {
    if (sharedRefreshTimer) window.clearInterval(sharedRefreshTimer);
    sharedRefreshTimer = window.setInterval(refreshSharedProjects, 15000);
  };

  async function fetchIncomingProjectInvites() {
    if (!currentSession?.user || navigator.onLine === false) return;
    const { data, error } = await client.rpc(
      "list_exp_note_incoming_project_invites"
    );
    if (error || !Array.isArray(data)) return;
    frame?.contentWindow?.postMessage(
      {
        type: "exp-note-incoming-project-invites",
        invites: data.map((item) => ({
          projectId: item.project_id,
          projectName: item.project_name,
          ownerEmail: item.owner_email,
          role: item.role,
          createdAt: item.created_at,
        })),
      },
      window.location.origin
    );
  }

  const scheduleIncomingInviteCheck = () => {
    if (incomingInviteTimer) window.clearInterval(incomingInviteTimer);
    incomingInviteTimer = window.setInterval(fetchIncomingProjectInvites, 15000);
  };

  const postToApp = (type, requestId, result) => {
    frame?.contentWindow?.postMessage(
      { type, requestId, ...result },
      window.location.origin
    );
  };

  async function inviteProjectMember(message) {
    if (!message?.requestId) return;
    if (!currentSession?.user) {
      postToApp("exp-note-invite-project-member-result", message.requestId, {
        ok: false,
        message: "먼저 클라우드에 로그인해주세요.",
      });
      return;
    }
    const { error } = await client.rpc("invite_exp_note_project_member", {
      p_project_id: message.projectId,
      p_project_name: message.projectName || "",
      p_recipient_email: message.email,
      p_role: message.role || "editor",
    });
    if (error) {
      const databaseMissing = /invite_exp_note_project_member|schema cache|function/i.test(
        error.message || ""
      );
      postToApp("exp-note-invite-project-member-result", message.requestId, {
        ok: false,
        message: databaseMissing
          ? "Supabase 프로젝트 공유 SQL 설정이 필요합니다."
          : error.message || "초대하지 못했습니다.",
      });
      return;
    }
    postToApp("exp-note-invite-project-member-result", message.requestId, {
      ok: true,
    });
    refreshSharedProjects();
  }

  async function listProjectMembers(message) {
    if (!message?.requestId) return;
    if (!currentSession?.user) {
      postToApp("exp-note-project-members-result", message.requestId, {
        ok: false,
        message: "먼저 클라우드에 로그인해주세요.",
      });
      return;
    }
    const { data, error } = await client.rpc("list_exp_note_project_members", {
      p_project_id: message.projectId,
    });
    if (error) {
      postToApp("exp-note-project-members-result", message.requestId, {
        ok: false,
        message: error.message || "멤버 목록을 불러오지 못했습니다.",
      });
      return;
    }
    postToApp("exp-note-project-members-result", message.requestId, {
      ok: true,
      members: (data || []).map((member) => ({
        userId: member.user_id,
        email: member.email,
        role: member.role,
        status: member.status,
        createdAt: member.created_at,
      })),
    });
  }

  async function respondProjectInvite(message) {
    if (!message?.requestId) return;
    if (!currentSession?.user) return;
    const { error } = await client.rpc("respond_exp_note_project_invite", {
      p_project_id: message.projectId,
      p_accept: Boolean(message.accept),
    });
    postToApp(
      "exp-note-respond-project-invite-result",
      message.requestId,
      error
        ? { ok: false, message: error.message || "처리하지 못했습니다." }
        : { ok: true }
    );
    if (!error) await refreshSharedProjects();
  }

  async function removeProjectMember(message) {
    if (!message?.requestId) return;
    if (!currentSession?.user) return;
    const { error } = await client.rpc("remove_exp_note_project_member", {
      p_project_id: message.projectId,
      p_user_id: message.userId,
    });
    postToApp(
      "exp-note-remove-project-member-result",
      message.requestId,
      error
        ? { ok: false, message: error.message || "제거하지 못했습니다." }
        : { ok: true }
    );
    if (!error) await refreshSharedProjects();
  }

  const postShareResult = (requestId, result) => {
    frame?.contentWindow?.postMessage(
      { type: "exp-note-share-protocol-result", requestId, ...result },
      window.location.origin
    );
  };

  async function shareProtocol(message) {
    if (!message?.requestId) return;
    if (!currentSession?.user) {
      postShareResult(message.requestId, { ok: false, message: "먼저 클라우드에 로그인해주세요." });
      return;
    }
    if (!message.email || !message.protocol || !["copy", "move"].includes(message.mode)) {
      postShareResult(message.requestId, { ok: false, message: "공유 정보가 올바르지 않습니다." });
      return;
    }
    const { data, error } = await client.rpc("share_exp_note_protocol", {
      p_recipient_email: message.email,
      p_protocol: message.protocol,
      p_source_project: message.projectName || "",
      p_source_experiment: message.experimentName || "",
      p_transfer_mode: message.mode,
    });
    if (error) {
      const databaseMissing = /share_exp_note_protocol|schema cache|function/i.test(error.message || "");
      postShareResult(message.requestId, { ok: false, message: databaseMissing ? "Supabase 공유 기능 SQL 설정이 필요합니다." : (error.message || "프로토콜을 공유하지 못했습니다.") });
      return;
    }
    postShareResult(message.requestId, { ok: true, transferId: data });
  }

  async function fetchIncomingProtocols() {
    if (!currentSession?.user || incomingProtocolLoading || navigator.onLine === false) return;
    incomingProtocolLoading = true;
    const { data, error } = await client.rpc("list_received_exp_note_protocols");
    incomingProtocolLoading = false;
    if (error || !Array.isArray(data) || !data.length) return;
    frame?.contentWindow?.postMessage(
      {
        type: "exp-note-incoming-protocols",
        transfers: data.map(item => ({
          id: item.id,
          protocol: item.protocol_payload,
          sourceProject: item.source_project,
          sourceExperiment: item.source_experiment,
          senderEmail: item.sender_email,
          mode: item.transfer_mode,
          createdAt: item.created_at,
        })),
      },
      window.location.origin
    );
  }

  async function markIncomingProtocolsReceived(transferIds) {
    if (!currentSession?.user || !Array.isArray(transferIds) || !transferIds.length) return;
    await client.rpc("mark_exp_note_protocols_received", { p_transfer_ids: transferIds });
  }

  const scheduleIncomingProtocolCheck = () => {
    if (incomingProtocolTimer) window.clearInterval(incomingProtocolTimer);
    incomingProtocolTimer = window.setInterval(fetchIncomingProtocols, 12000);
  };

  const rpcPayload = (records) =>
    records.map((record) => ({
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      payload: record.payload,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at,
      client_id: record.client_id,
    }));

  const announceTabRecords = (userId, records) => {
    if (!tabChannel || !userId || !records?.length) return;
    tabChannel.postMessage({
      type: "exp-note-tab-records",
      sender: clientId,
      userId,
      records: records.map(clone),
    });
  };

  async function uploadOutbox() {
    if (
      uploadRunning ||
      !currentSession?.user ||
      navigator.onLine === false
    ) {
      return false;
    }
    if (appEditing) {
      uploadAfterEditing = true;
      setStatus("입력 완료 후 변경사항 저장");
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

  async function uploadSharedOutbox() {
    if (
      sharedUploadRunning ||
      !currentSession?.user ||
      navigator.onLine === false
    ) {
      return false;
    }
    if (appEditing) {
      uploadAfterEditing = true;
      return false;
    }
    const userId = currentSession.user.id;
    const outbox = await getStoredSharedRecords(SHARED_OUTBOX_STORE, userId);
    const records = [...outbox.values()];
    if (!records.length) return true;

    const byProject = new Map();
    records.forEach((record) => {
      const projectId = record.__projectId;
      if (!projectId) return;
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId).push(record);
    });

    sharedUploadRunning = true;
    let ok = true;
    const uploaded = [];
    for (const [projectId, list] of byProject) {
      let result;
      try {
        result = await client.rpc("upsert_exp_note_shared_records", {
          p_project_id: projectId,
          p_records: rpcPayload(list),
        });
      } catch (error) {
        result = { error };
      }
      if (result.error) {
        ok = false;
      } else {
        uploaded.push(...list);
      }
    }
    sharedUploadRunning = false;
    if (uploaded.length) await deleteSharedOutboxRecords(userId, uploaded);
    if (!ok) scheduleReconnect();
    return ok;
  }

  async function uploadAll() {
    const results = await Promise.all([uploadOutbox(), uploadSharedOutbox()]);
    return results.every(Boolean);
  }

  const scheduleUpload = (delay = 350) => {
    if (uploadTimer) window.clearTimeout(uploadTimer);
    if (appEditing) {
      uploadTimer = null;
      uploadAfterEditing = true;
      setStatus("입력 완료 후 변경사항 저장");
      return;
    }
    uploadTimer = window.setTimeout(() => {
      uploadTimer = null;
      uploadAll();
    }, delay);
  };

  async function queueRecords(records) {
    if (!currentSession?.user || !records.length) return;
    const userId = currentSession.user.id;
    records.forEach((record) =>
      currentRecords.set(recordKey(record), record)
    );
    const personal = records.filter((record) => !record.__projectId);
    const shared = records.filter((record) => record.__projectId);
    await Promise.all([
      personal.length
        ? Promise.all([
            putStoredRecords(RECORDS_STORE, userId, personal),
            putStoredRecords(OUTBOX_STORE, userId, personal),
          ])
        : Promise.resolve(),
      shared.length
        ? Promise.all([
            putStoredSharedRecords(SHARED_RECORDS_STORE, userId, shared),
            putStoredSharedRecords(SHARED_OUTBOX_STORE, userId, shared),
          ])
        : Promise.resolve(),
    ]);
    announceTabRecords(userId, records);
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
        const localCandidate = {
          ...candidate,
          updated_at: new Date(now + sequence).toISOString(),
          client_id: intentClientId,
          deleted_at: null,
          local_intent: true,
        };
        const mergedCandidate = contentAwareRecord(
          existing,
          localCandidate
        );
        if (!sameRecordContent(existing, mergedCandidate)) {
          changed.push(mergedCandidate);
        }
      }
    });

    const blankSnapshot =
      storeContentScore(store) === 0 && recordsContentScore(currentRecords) > 0;
    currentRecords.forEach((existing, key) => {
      if (!existing.deleted_at && !desired.has(key) && !blankSnapshot) {
        sequence += 1;
        changed.push({
          ...existing,
          payload: null,
          updated_at: new Date(now + sequence).toISOString(),
          deleted_at: new Date(now + sequence).toISOString(),
          client_id: deleteIntentClientId,
          local_intent: true,
        });
      }
    });

    const writable = changed.filter((record) => {
      if (!record.__projectId) return true;
      const membership = sharedMemberships.get(record.__projectId);
      return !membership || membership.role !== "viewer";
    });
    if (writable.length) await queueRecords(writable);
  }

  const queueLocalCapture = (raw) => {
    if (!raw) return localCaptureChain;
    lastObservedFingerprint = fingerprintRaw(raw);
    if (!initializedUserId) {
      pendingLocalRaw = raw;
      return localCaptureChain;
    }
    // While typing, keep only the newest complete snapshot. Processing every
    // intermediate keystroke serially made large notebooks several seconds late.
    latestQueuedLocalRaw = raw;
    if (localCaptureRunning) return localCaptureChain;
    localCaptureRunning = true;
    localCaptureChain = (async () => {
      while (latestQueuedLocalRaw) {
        const newestRaw = latestQueuedLocalRaw;
        latestQueuedLocalRaw = "";
        try {
          await captureLocalChanges(newestRaw);
        } catch {
          // IndexedDB/network retries are handled by the outbox and reconnect path.
        }
      }
    })().finally(() => {
      localCaptureRunning = false;
    });
    return localCaptureChain;
  };

  const deferRemoteRecord = (record, message = "") => {
    expandedRecords(record).forEach((expanded) => {
      const key = recordKey(expanded);
      deferredRemoteRecords.set(
        key,
        contentAwareRecord(deferredRemoteRecords.get(key), expanded)
      );
    });
    if (message) deferredRemoteMessage = message;
  };

  async function mergeIncomingRecords(userId, incomingRecords, message = "") {
    const updates = [];
    const repairs = [];
    let sequence = 0;
    const now = Date.now();
    incomingRecords.forEach((incoming) => {
      expandedRecords(incoming).forEach((expanded) => {
        const key = recordKey(expanded);
        const existing = currentRecords.get(key);
        const merged = contentAwareRecord(existing, expanded);
        merged.__projectId =
          merged.__projectId || expanded.__projectId || existing?.__projectId || null;
        if (!merged.__projectId) delete merged.__projectId;
        currentRecords.set(key, merged);
        updates.push(merged);
        if (!sameRecordContent(merged, expanded)) {
          sequence += 1;
          repairs.push({
            ...clone(merged),
            updated_at: new Date(now + sequence).toISOString(),
            client_id: merged.deleted_at
              ? deleteIntentClientId
              : intentClientId,
            local_intent: true,
          });
        }
      });
    });
    const personalUpdates = updates.filter((record) => !record.__projectId);
    const sharedUpdates = updates.filter((record) => record.__projectId);
    await Promise.all([
      personalUpdates.length
        ? putStoredRecords(RECORDS_STORE, userId, personalUpdates)
        : Promise.resolve(),
      sharedUpdates.length
        ? putStoredSharedRecords(SHARED_RECORDS_STORE, userId, sharedUpdates)
        : Promise.resolve(),
    ]);
    if (repairs.length) {
      setStatus("내용이 있는 항목 우선 병합 · 클라우드 복구 중");
      await queueRecords(repairs);
    }
    applyRecordsToApp(currentRecords, message);
  }

  async function flushDeferredRemote(raw = "") {
    if (raw) await queueLocalCapture(raw);
    else await localCaptureChain.catch(() => undefined);

    if (deferredRemoteRecords.size && initializedUserId) {
      const records = [...deferredRemoteRecords.values()];
      deferredRemoteRecords = new Map();
      const message =
        deferredRemoteMessage || "다른 기기의 변경사항을 받았습니다";
      deferredRemoteMessage = "";
      await mergeIncomingRecords(initializedUserId, records, message);
    }
    if (reconnectAfterEditing && currentSession?.user) {
      reconnectAfterEditing = false;
      uploadAfterEditing = false;
      await connectSync();
      return;
    }
    if (uploadAfterEditing) {
      uploadAfterEditing = false;
      scheduleUpload(0);
    }
  }

  tabChannel?.addEventListener("message", async (event) => {
    const message = event.data;
    if (
      message?.type !== "exp-note-tab-records" ||
      message.sender === clientId ||
      !initializedUserId ||
      message.userId !== initializedUserId ||
      !Array.isArray(message.records) ||
      !message.records.length
    ) {
      return;
    }
    await localCaptureChain.catch(() => undefined);
    if (appEditing) {
      message.records.forEach((record) =>
        deferRemoteRecord(
          record,
          "다른 창의 변경사항을 입력 완료 후 병합합니다"
        )
      );
      setStatus("입력 완료 후 다른 창 변경사항 병합");
      return;
    }
    await mergeIncomingRecords(
      initializedUserId,
      message.records,
      "다른 창의 변경사항을 병합했습니다"
    );
  });

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
          if (isOwnRecord(incoming)) return;
          await localCaptureChain.catch(() => undefined);
          if (appEditing) {
            deferRemoteRecord(
              incoming,
              "입력 중 받은 다른 기기의 변경사항을 병합했습니다"
            );
            setStatus("입력 완료 후 다른 기기 변경사항 병합");
            return;
          }
          await mergeIncomingRecords(
            userId,
            [incoming],
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

  async function disconnectSharedRealtime() {
    if (!sharedChannel) return;
    await client.removeChannel(sharedChannel);
    sharedChannel = null;
  }

  async function subscribeSharedRealtime(projectIds, generation) {
    await disconnectSharedRealtime();
    if (generation !== syncGeneration || !projectIds?.length) return;
    const userId = currentSession?.user?.id;
    if (!userId) return;
    sharedChannel = client
      .channel(`exp-note-shared-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "exp_note_shared_records",
          filter: `project_id=in.(${projectIds.join(",")})`,
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
            __projectId: String(payload.new.project_id),
          };
          if (isOwnRecord(incoming)) return;
          await localCaptureChain.catch(() => undefined);
          if (appEditing) {
            deferRemoteRecord(
              incoming,
              "입력 중 받은 공유 프로젝트 변경사항을 병합했습니다"
            );
            setStatus("입력 완료 후 공유 프로젝트 변경사항 병합");
            return;
          }
          await mergeIncomingRecords(
            userId,
            [incoming],
            "공유 프로젝트의 변경사항을 받았습니다"
          );
        }
      )
      .subscribe();
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
    const reconnectingUserId = currentSession?.user?.id || "";
    const reconnectingSameUser = Boolean(
      reconnectingUserId && initializedUserId === reconnectingUserId
    );
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
    let sharedCached = new Map();
    let sharedOutbox = new Map();
    try {
      [cached, outbox, sharedCached, sharedOutbox] = await Promise.all([
        getStoredRecords(RECORDS_STORE, userId),
        getStoredRecords(OUTBOX_STORE, userId),
        getStoredSharedRecords(SHARED_RECORDS_STORE, userId),
        getStoredSharedRecords(SHARED_OUTBOX_STORE, userId),
      ]);
    } catch {
      setStatus("이 기기의 저장소를 확인할 수 없습니다");
      return;
    }

    let remote = new Map();
    let remoteFetched = false;
    if (navigator.onLine !== false) {
      try {
        remote = await fetchRemoteRecords(userId);
        remoteFetched = true;
      } catch (error) {
        if (!cached.size && !outbox.size) {
          setStatus("새 동기화 구조 설정이 필요합니다");
          errorBox.textContent =
            "Supabase에 항목별 동기화 테이블을 먼저 설정해주세요.";
          return;
        }
      }
    }
    let sharedRemote = new Map();
    if (remoteFetched) {
      try {
        await fetchSharedMemberships();
        sharedRemote = await fetchSharedRemoteRecords([
          ...sharedMemberships.keys(),
        ]);
      } catch {
        // Project-sharing SQL may not be applied yet; personal sync still works.
        sharedRemote = new Map();
      }
    }
    if (generation !== syncGeneration) return;
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let localStore = null;
    try {
      localStore = localRaw ? JSON.parse(localRaw) : null;
    } catch {
      localStore = null;
    }
    const localUpdatedAt =
      Number(localStorage.getItem(LOCAL_UPDATED_KEY)) || Date.now();
    const localRecords = localStore
      ? storeToRecords(
          localStore,
          new Date(localUpdatedAt).toISOString(),
          "legacy-local"
        )
      : new Map();
    const legacyPending = readLegacyPending();
    let pendingRecords = new Map();
    if (legacyPending?.raw) {
      try {
        pendingRecords = storeToRecords(
          JSON.parse(legacyPending.raw),
          new Date(
            Number(legacyPending.updatedAt) || Date.now()
          ).toISOString(),
          "legacy-pending"
        );
      } catch {
        pendingRecords = new Map();
      }
    }

    const initialState = resolveInitialRecordState({
      remote: mergeRecordMaps(remote, sharedRemote),
      cached: mergeRecordMaps(cached, sharedCached),
      outbox: mergeRecordMaps(outbox, sharedOutbox),
      localRecords,
      pendingRecords,
      remoteFetched,
      localStore,
    });
    currentRecords = initialState.records;
    if (initialState.reason === "meaningful-local-recovery") {
      setStatus("이 기기의 작업본으로 빈 클라우드 복구 중…");
    } else if (initialState.reason === "content-aware-merge") {
      setStatus("내용이 있는 항목 우선 병합 중…");
    }
    const outboxPersonal = [...initialState.outbox.values()].filter(
      (record) => !record.__projectId
    );
    const outboxShared = [...initialState.outbox.values()].filter(
      (record) => record.__projectId
    );
    if (remoteFetched) {
      await Promise.all([
        replaceStoredRecords(OUTBOX_STORE, userId, outboxPersonal),
        replaceStoredSharedRecords(SHARED_OUTBOX_STORE, userId, outboxShared),
      ]);
      localStorage.removeItem(LEGACY_PENDING_KEY);
    } else if (initialState.reason === "offline-recovery") {
      await Promise.all([
        replaceStoredRecords(OUTBOX_STORE, userId, outboxPersonal),
        replaceStoredSharedRecords(SHARED_OUTBOX_STORE, userId, outboxShared),
      ]);
    }

    const recordsPersonal = [...currentRecords.values()].filter(
      (record) => !record.__projectId
    );
    const recordsShared = [...currentRecords.values()].filter(
      (record) => record.__projectId
    );
    await Promise.all([
      replaceStoredRecords(RECORDS_STORE, userId, recordsPersonal),
      replaceStoredSharedRecords(SHARED_RECORDS_STORE, userId, recordsShared),
    ]);
    initializedUserId = userId;
    // On first boot, discard the iframe's default snapshot. During a reconnect,
    // however, keep edits that arrived while the remote fetch was in flight.
    const reconnectRaw = reconnectingSameUser ? pendingLocalRaw : "";
    pendingLocalRaw = "";
    if (reconnectRaw) {
      await queueLocalCapture(reconnectRaw).catch(() => undefined);
    }
    applyRecordsToApp(currentRecords);
    if (navigator.onLine === false) {
      setStatus("오프라인 · 이 기기에 안전하게 저장됨");
    } else {
      await uploadAll();
      if (generation !== syncGeneration) return;
      await subscribeRealtime(userId, generation);
      await subscribeSharedRealtime([...sharedMemberships.keys()], generation);
      postSharedRolesToApp();
      await fetchIncomingProtocols();
      scheduleIncomingProtocolCheck();
      await fetchIncomingProjectInvites();
      scheduleIncomingInviteCheck();
      scheduleSharedProjectsRefresh();
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
      uploadAfterEditing = false;
      reconnectAfterEditing = false;
      pendingLocalRaw = "";
      if (incomingProtocolTimer) window.clearInterval(incomingProtocolTimer);
      incomingProtocolTimer = null;
      if (incomingInviteTimer) window.clearInterval(incomingInviteTimer);
      incomingInviteTimer = null;
      if (sharedRefreshTimer) window.clearInterval(sharedRefreshTimer);
      sharedRefreshTimer = null;
      sharedMemberships = new Map();
      await disconnectRealtime();
      await disconnectSharedRealtime();
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
      fetchIncomingProtocols();
      fetchIncomingProjectInvites();
      postSharedRolesToApp();
      return;
    }
    if (event.data?.type === "exp-note-share-protocol") {
      await shareProtocol(event.data);
      return;
    }
    if (event.data?.type === "exp-note-protocols-received") {
      await markIncomingProtocolsReceived(event.data.transferIds);
      return;
    }
    if (event.data?.type === "exp-note-invite-project-member") {
      await inviteProjectMember(event.data);
      return;
    }
    if (event.data?.type === "exp-note-list-project-members") {
      await listProjectMembers(event.data);
      return;
    }
    if (event.data?.type === "exp-note-respond-project-invite") {
      await respondProjectInvite(event.data);
      return;
    }
    if (event.data?.type === "exp-note-remove-project-member") {
      await removeProjectMember(event.data);
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
      if (new URLSearchParams(window.location.search).has("sync-test")) {
        document.documentElement.dataset.syncEditing = String(appEditing);
      }
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
      appliedStatus();
    }
  });

  frame?.addEventListener("load", () => {
    if (pendingAppStore) postStoreToApp(pendingAppStore);
  });

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

  const syncAfterResume = () => {
    if (document.visibilityState === "hidden" || !currentSession?.user) return;
    if (resumeSyncTimer) window.clearTimeout(resumeSyncTimer);
    resumeSyncTimer = window.setTimeout(() => {
      resumeSyncTimer = null;
      if (!currentSession?.user || navigator.onLine === false) return;
      if (appEditing) {
        reconnectAfterEditing = true;
        setStatus("입력 완료 후 최신 변경사항 확인");
        return;
      }
      setStatus("앱 복귀 · 최신 변경사항 확인 중…");
      connectSync();
    }, 220);
  };

  document.addEventListener("visibilitychange", syncAfterResume);
  window.addEventListener("pageshow", syncAfterResume);
  window.addEventListener("focus", syncAfterResume);

  if (new URLSearchParams(window.location.search).has("sync-test")) {
    window.__expNoteSyncDiagnostics = Object.freeze({
      simulate({
        remoteStore = null,
        cachedStore = null,
        outboxStore = null,
        outboxIntent = false,
        localStore = null,
        remoteFetched = true,
      } = {}) {
        const recordsFor = (store, time, source) =>
          store
            ? storeToRecords(store, new Date(time).toISOString(), source)
            : new Map();
        const remote = recordsFor(remoteStore, 1000, "cloud-device");
        const cached = recordsFor(cachedStore, 2000, "cached-device");
        const outbox = outboxIntent
          ? intentRecordsFromStore(outboxStore, 4000)
          : recordsFor(outboxStore, 4000, "legacy-phone");
        const localRecords = recordsFor(
          localStore,
          3000,
          "legacy-local"
        );
        const resolved = resolveInitialRecordState({
          remote,
          cached,
          outbox,
          localRecords,
          pendingRecords: new Map(),
          remoteFetched,
          localStore,
        });
        return {
          reason: resolved.reason,
          contentScore: recordsContentScore(resolved.records),
          outboxCount: resolved.outbox.size,
          intentOnly: [...resolved.outbox.values()].every(isIntentRecord),
        };
      },
      mergeStores(olderStore, newerStore) {
        const older = storeToRecords(
          olderStore,
          new Date(1000).toISOString(),
          "older-device"
        );
        const newer = storeToRecords(
          newerStore,
          new Date(2000).toISOString(),
          "newer-device"
        );
        return recordsToStore(mergeRecordMaps(older, newer), olderStore);
      },
      state() {
        return {
          clientId,
          tabId,
          appEditing,
          uploadAfterEditing,
          reconnectAfterEditing,
          deferredCount: deferredRemoteRecords.size,
        };
      },
    });
    const blankTestStore = {
      projects: [{
        id: "default",
        name: "기본 프로젝트",
        experiments: [],
        notes: [],
        inventory: [],
        memoSnapshots: [],
        memoScratch: { content: "" },
      }],
    };
    const richTestStore = {
      projects: [{
        ...blankTestStore.projects[0],
        experiments: [{ id: "experiment-1", name: "실험", protocols: [] }],
      }],
    };
    const mergeBaseStore = {
      projects: [{
        id: "project-1",
        name: "동기화 프로젝트",
        experiments: [{
          id: "experiment-1",
          name: "실험 A",
          memo: "",
          protocols: [{
            id: "protocol-1",
            name: "PCR",
            summary: "기본 프로토콜",
            versions: [],
            beforeStarting: [],
          }],
        }],
        notes: [{
          id: "note-1",
          title: "실험 노트",
          purpose: "기존 목적",
          resultSummary: "",
        }],
        inventory: [],
        memoSnapshots: [],
        memoScratch: { content: "" },
      }],
      activeProjectId: "project-1",
    };
    const desktopEditedStore = clone(mergeBaseStore);
    desktopEditedStore.projects[0].notes[0].resultSummary = "데스크톱 결과";
    const phoneEditedStore = clone(mergeBaseStore);
    phoneEditedStore.projects[0].experiments[0].protocols[0].summary =
      "휴대폰 프로토콜 수정";
    const baseMergeRecords = storeToRecords(
      mergeBaseStore,
      new Date(1000).toISOString(),
      "base"
    );
    const desktopNoteRecords = new Map(
      [...storeToRecords(
        desktopEditedStore,
        new Date(2000).toISOString(),
        "desktop"
      )].filter(([, record]) => record.entity_type === "project_note")
    );
    const phoneProtocolRecords = new Map(
      [...storeToRecords(
        phoneEditedStore,
        new Date(3000).toISOString(),
        "phone"
      )].filter(([, record]) => record.entity_type === "experiment_protocol")
    );
    const independentMergedStore = recordsToStore(
      mergeRecordMaps(
        baseMergeRecords,
        desktopNoteRecords,
        phoneProtocolRecords
      ),
      mergeBaseStore
    );
    const blankSameNoteStore = clone(mergeBaseStore);
    blankSameNoteStore.projects[0].notes[0].purpose = "";
    const conflictingNoteStore = clone(mergeBaseStore);
    conflictingNoteStore.projects[0].notes[0].purpose = "최신 목적";
    const legacyExperimentRecord = makeRecord(
      "project_experiment",
      "project-1:experiment-1",
      {
        parent_id: "project-1",
        item_order: 0,
        item: clone(mergeBaseStore.projects[0].experiments[0]),
      },
      new Date(1000).toISOString(),
      "legacy-device"
    );
    const legacyProtocolMap = new Map([
      [recordKey(legacyExperimentRecord), legacyExperimentRecord],
    ]);
    const expandedLegacyProtocols = mergeRecordMaps(legacyProtocolMap);
    const legacyProtocolRepairs = repairRecordsAgainstRemote(
      expandedLegacyProtocols,
      legacyProtocolMap
    );
    const noteRecordForDelete = [...baseMergeRecords.values()].find(
      (record) => record.entity_type === "project_note"
    );
    const blankPhoneDelete = {
      ...clone(noteRecordForDelete),
      payload: null,
      updated_at: new Date(4000).toISOString(),
      deleted_at: new Date(4000).toISOString(),
      client_id: "legacy-empty-phone",
    };
    const explicitUserDelete = {
      ...clone(blankPhoneDelete),
      updated_at: new Date(5000).toISOString(),
      deleted_at: new Date(5000).toISOString(),
      client_id: deleteIntentClientId,
      local_intent: true,
    };
    document.documentElement.dataset.syncDiagnostics = JSON.stringify({
      tabWriter: { clientId, tabId },
      richCloudVsBlankLegacyPhone:
        window.__expNoteSyncDiagnostics.simulate({
          remoteStore: richTestStore,
          cachedStore: blankTestStore,
          outboxStore: blankTestStore,
          localStore: blankTestStore,
        }),
      blankCloudVsRichDesktop:
        window.__expNoteSyncDiagnostics.simulate({
          remoteStore: blankTestStore,
          cachedStore: richTestStore,
          outboxStore: blankTestStore,
          localStore: richTestStore,
        }),
      intentionalOfflineEdit:
        window.__expNoteSyncDiagnostics.simulate({
          remoteStore: richTestStore,
          outboxStore: richTestStore,
          outboxIntent: true,
          localStore: richTestStore,
        }),
      blankFieldKeepsContent:
        window.__expNoteSyncDiagnostics.mergeStores(
          mergeBaseStore,
          blankSameNoteStore
        ).projects[0].notes[0].purpose,
      newerContentWinsSameField:
        window.__expNoteSyncDiagnostics.mergeStores(
          mergeBaseStore,
          conflictingNoteStore
        ).projects[0].notes[0].purpose,
      independentAreasMerge: {
        note:
          independentMergedStore.projects[0].notes[0].resultSummary,
        protocol:
          independentMergedStore.projects[0].experiments[0].protocols[0]
            .summary,
        protocolRecords: phoneProtocolRecords.size,
      },
      legacyProtocolMigration: {
        experimentRecords: activeRecordCount(
          expandedLegacyProtocols,
          "project_experiment"
        ),
        protocolRecords: activeRecordCount(
          expandedLegacyProtocols,
          "experiment_protocol"
        ),
        repairRecords: legacyProtocolRepairs.size,
      },
      deletionPolicy: {
        blankPhoneBlocked: !contentAwareRecord(
          noteRecordForDelete,
          blankPhoneDelete
        ).deleted_at,
        explicitDeleteApplied: Boolean(
          contentAwareRecord(noteRecordForDelete, explicitUserDelete)
            .deleted_at
        ),
      },
    });
  }

  client.auth.getSession().then(({ data }) => applySession(data.session));
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
})();
