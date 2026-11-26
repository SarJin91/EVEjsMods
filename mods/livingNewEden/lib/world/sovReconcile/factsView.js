"use strict";

const { FACT_KEY_PREFIX, FACT_KEY_RANGE_END, FACT_EVENT_TYPES, ENTRIES_PER_FACT, TABLE_NAME: RECONCILE_TABLE } = require("./schema");
const { TX_REQUIRED } = require("./repository");
const { toBind } = require("../../persistence/repository");
const { WORK_CLASS } = require("../../telemetry/loadGovernor");

function invalid(detail) {
  return { ok: false, reason: "REPO_INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function isStoreOpen(store) {
  return store && typeof store.isOpen === "function" && store.isOpen() === true;
}

function buildSovFactsView({ store, journal, config, getGovernor }) {
  const observer = config?.observer || {};
  const maxRows = Number.isSafeInteger(observer.stationsPanelMaxRows) && observer.stationsPanelMaxRows > 0
    ? observer.stationsPanelMaxRows
    : 200;
  const factLimit = maxRows * ENTRIES_PER_FACT;

  function checkGovernor() {
    let gov = null;
    try {
      gov = getGovernor?.();
    } catch (_err) {
      gov = null;
    }
    if (!gov || typeof gov.admits !== "function") return true;
    try {
      return gov.admits(WORK_CLASS.MAINTENANCE) !== false;
    } catch (_err) {
      return true;
    }
  }

  function getData() {
    if (!checkGovernor()) {
      return { available: false, reason: "GOVERNOR_BELOW_MIN" };
    }

    if (!store || typeof store.transaction !== "function") {
      return { available: false, reason: "STORE_UNAVAILABLE" };
    }
    if (!journal || typeof journal.scanKeyRange !== "function" || typeof journal.findByKey !== "function") {
      return { available: false, reason: "JOURNAL_UNAVAILABLE" };
    }

    let episodes = [];
    try {
      const epRes = store.transaction("sovFactsView.readEpisodes", (tx) => {
        if (txMissing(tx)) return [];
        const stmt = tx.prepare(`
          SELECT r.id, r.fact_key, r.kind, r.system_id, r.bound_seq, r.foreign_at, r.alliance_id,
                 r.controller_faction_id, r.world_row_id, r.action, r.points, r.at_ms, r.until_ms,
                 r.version, r.created_at,
                 s.controller_faction_id as system_controller_faction_id,
                 s.occupation_state,
                 s.phase_seq
          FROM "${RECONCILE_TABLE}" r
          LEFT JOIN "world_system_state" s ON s.system_id = r.system_id
          WHERE r.action = 'FOREIGN'
          ORDER BY r.foreign_at DESC
        `);
        return stmt.all().map((row) => ({
          id: Number(row.id),
          factKey: row.fact_key,
          kind: row.kind,
          systemId: Number(row.system_id),
          boundSeq: Number(row.bound_seq),
          foreignAt: Number(row.foreign_at),
          allianceId: Number(row.alliance_id),
          controllerFactionId: row.controller_faction_id === null ? null : Number(row.controller_faction_id),
          worldRowId: row.world_row_id === null ? null : Number(row.world_row_id),
          action: row.action,
          points: Number(row.points),
          atMs: Number(row.at_ms),
          untilMs: row.until_ms === null ? null : Number(row.until_ms),
          version: Number(row.version),
          createdAt: row.created_at,
          system: row.system_controller_faction_id !== null
            ? {
                controllerFactionId: Number(row.system_controller_faction_id),
                occupationState: row.occupation_state,
                phaseSeq: Number(row.phase_seq),
              }
            : null,
        }));
      });
      if (epRes.ok) episodes = epRes.value || [];
    } catch (_e) {
      episodes = [];
    }

    let facts = [];
    try {
      const factRes = store.transaction("sovFactsView.scanAndFindFacts", (tx) => {
        if (txMissing(tx)) return { ok: true, facts: [] };
        const scannedRes = journal.scanKeyRange(tx, FACT_KEY_PREFIX, FACT_KEY_RANGE_END, factLimit, { order: "recent" });
        if (!scannedRes.ok) return { ok: true, facts: [] };
        const scanned = scannedRes.rows;

        const filtered = scanned.filter((row) => FACT_EVENT_TYPES.includes(row.eventType));

        const facts = [];
        for (const row of filtered.slice(0, factLimit)) {
          const payloadRes = journal.findByKey(tx, row.key);
          if (payloadRes?.ok && payloadRes.found && payloadRes.entry) {
            facts.push({
              key: row.key,
              eventType: row.eventType,
              appliedAt: row.appliedAt,
              payload: payloadRes.entry.payload,
            });
          }
        }

        facts.sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));

        if (facts.length > maxRows) facts.splice(maxRows);

        return { ok: true, facts };
      });
      if (factRes.ok) facts = factRes.value?.facts || [];
    } catch (_e) {
      facts = [];
    }

    return {
      available: true,
      episodes,
      facts,
      limit: maxRows,
    };
  }

  function cacheKey() {
    // Return null if store closed or governor doesn't admit (pattern from logisticsView.js:88-92)
    if (!isStoreOpen(store) || !checkGovernor()) return null;
    try {
      const keyRes = store.transaction("sovFactsView.cacheKey", (tx) => {
        if (txMissing(tx)) return null;
        const latestRes = journal.scanKeyRange(tx, FACT_KEY_PREFIX, FACT_KEY_RANGE_END, 1, { order: "recent" });
        const latestJournalId = (latestRes?.ok && latestRes.rows?.[0]?.journalId) || 0;
        const stmt = tx.prepare(`SELECT COUNT(*) AS cnt, MAX(version) AS maxVer FROM "${RECONCILE_TABLE}"`);
        const agg = stmt.get() || { cnt: 0, maxVer: 0 };
        return { latestJournalId, episodeCount: agg.cnt || 0, maxVersion: agg.maxVer || 0 };
      });
      if (keyRes?.ok && keyRes.value) {
        const v = keyRes.value;
        return `sov-facts:${v.latestJournalId}|${v.episodeCount}|${v.maxVersion}`;
      }
    } catch (_e) {
    }
    return null;
  }

  return {
    title: "SOV Facts",
    order: 61,
    getData,
    cacheKey,
  };
}

module.exports = { buildSovFactsView };