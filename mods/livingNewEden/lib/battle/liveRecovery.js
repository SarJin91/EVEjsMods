"use strict";

const { structureOf } = require("./structureOutcome");

const LIVE_RECOVER_EVENT = "BATTLE_LIVE_RECOVER";
const LIVE_MODE = "LIVE_EVEJS";
const RESTART = "RESTART";
const TERMINAL = Object.freeze(["COMPLETED", "FAILED", "QUARANTINED"]);
const RACE_REASONS = Object.freeze(["NOT_MATERIALIZING", "ALREADY_SETTLED", "BATTLE_TERMINAL", "MODE_MISMATCH",
  "SETTLE_NOT_LIVE"]);
const PERMANENT_REASONS = Object.freeze(["LIVE_INVALID_INPUT", "IDEMPOTENCY_CONFLICT", "NESTED_KEY_REUSED",
  "BATTLE_NOT_FOUND"]);
const MAX_ID_LENGTH = 64;

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createLiveRecovery(deps) {
  const { store, battleRepository, live, bump, logger } = deps;
  const getStructureSeam = typeof deps.getStructureSeam === "function" ? deps.getStructureSeam : () => null;

  function structureDestroyed(structureId) {
    try {
      const seam = getStructureSeam();
      if (!seam || typeof seam.getStructure !== "function") return false;
      const v = seam.getStructure(structureId);
      return Boolean(v && v.ok === true && v.row && v.row.destroyedAt);
    } catch (_err) {
      return false;
    }
  }

  function classify(r, battleId) {
    if (RACE_REASONS.includes(r.reason)) return { ok: true, kind: "stale", battleId };
    if (r.permanent === true || PERMANENT_REASONS.includes(r.reason)) {
      return { ok: true, kind: "refused", battleId, reason: String(r.reason) };
    }
    return { ok: false, reason: r.reason || "LIVE_RECOVER_FAILED", permanent: false };
  }

  function onCommitted(value) {
    if (!value) return;
    if (value.kind === "reverted") {
      bump("liveRecover.reverted");
      logger.log(`battle: live recover ${value.battleId} reverted`);
    } else if (value.kind === "exited") {
      bump("liveRecover.exited");
      logger.log(`battle: live recover ${value.battleId} exited outcome=${value.outcome} destroyed=${value.destroyed}`);
    } else if (value.kind === "refused") {
      bump("liveRecover.refused");
      logger.log(`battle: live recover refused ${value.battleId} - ${value.reason}`);
    }
  }

  function onLiveRecover(ev) {
    try {
      const p = ev.payload;
      if (!p || typeof p.battleId !== "string" || p.battleId === "" || p.battleId.length > MAX_ID_LENGTH
        || !isTime(p.bootAt) || !isTime(ev.dueAt)) {
        return { ok: false, reason: "LIVE_RECOVER_PAYLOAD_INVALID", permanent: true };
      }
      const battleId = p.battleId;
      const at = ev.dueAt;
      const tx = store.transaction("battle.liveRecoverRead", (db) => battleRepository.getBattle(db, battleId));
      const read = tx.ok ? tx.value : tx;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "TX_FAILED" };
      const b = read.battle;
      if (!b) return { ok: false, reason: "BATTLE_NOT_FOUND", permanent: true };
      if (TERMINAL.includes(b.state) || b.mode !== LIVE_MODE) return { ok: true, outcome: "STALE" };
      if (Number(b.updatedAt) >= p.bootAt) {
        bump("liveRecover.staleOwned");
        return { ok: true, outcome: "STALE" };
      }
      if (b.state === "CLAIMED") {
        return { ok: true, outcome: "REVERTED", onCommitted, effect: (etx) => {
          const r = live.revertLiveClaimInTx(etx, { battleId, expectedVersion: b.version, claimSeq: b.claimSeq, at,
            reason: RESTART });
          if (!r || r.ok !== true) return classify(r || {}, battleId);
          return { ok: true, kind: r.duplicate ? "stale" : "reverted", battleId };
        } };
      }
      if (b.state === "LIVE" || b.state === "SETTLING") {
        const s = structureOf(b.input);
        const req = s === null ? { battleId, at, reason: RESTART }
          : { battleId, at, reason: RESTART, structure: { destroyed: structureDestroyed(s.structureId) } };
        return { ok: true, outcome: "EXITED", onCommitted, effect: (etx) => {
          const r = live.exitLiveInTx(etx, req);
          if (!r || r.ok !== true) return classify(r || {}, battleId);
          if (r.duplicate) return { ok: true, kind: "stale", battleId };
          if (r.outcome !== "COMPLETED") return { ok: true, kind: "refused", battleId, reason: String(r.outcome) };
          const destroyed = (Array.isArray(r.fleets) ? r.fleets : []).reduce((n, f) => n + (Number(f.lost) || 0), 0);
          return { ok: true, kind: "exited", battleId, outcome: r.outcome, destroyed };
        } };
      }
      return { ok: true, outcome: "STALE" };
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({ onLiveRecover });
}

module.exports = { createLiveRecovery, LIVE_RECOVER_EVENT };
