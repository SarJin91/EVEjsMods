"use strict";

const VIEW_QUARANTINE_ROWS = 20;
const VIEW_ORDER = 40;

function storeOpen(store) {
  try {
    return Boolean(store && typeof store.isOpen === "function" && store.isOpen());
  } catch (_err) {
    return false;
  }
}

function buildSchedulerView(deps) {
  const { store, eventStore, getStatus } = deps;

  function getData() {
    const status = getStatus();
    if (!storeOpen(store)) return { available: false, reason: "store_closed", status };
    const read = store.transaction("observer.scheduler", (tx) => {
      const counted = eventStore.countQuarantined(tx);
      if (!counted.ok) return counted;
      const listed = eventStore.listQuarantined(tx, VIEW_QUARANTINE_ROWS);
      if (!listed.ok) return listed;
      return { ok: true, count: counted.count, events: listed.events };
    });
    const value = read && read.ok ? read.value : read;
    if (!value || !value.ok) return { available: false, reason: (value && value.reason) || "read_failed", status };
    return {
      available: true,
      status,
      quarantined: {
        count: value.count,
        recent: value.events.map((e) => ({ eventId: e.eventId, eventType: e.eventType, aggregateId: e.aggregateId,
          attempts: e.attempts, lastError: e.lastError, finishedAt: e.finishedAt })),
      },
    };
  }

  return {
    title: "Scheduler",
    order: VIEW_ORDER,
    getData,
    cacheKey: () => `${getStatus().seq}:${storeOpen(store)}`,
  };
}

module.exports = { buildSchedulerView, VIEW_QUARANTINE_ROWS };
