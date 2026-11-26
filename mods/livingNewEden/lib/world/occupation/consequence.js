"use strict";

const { battleInfluence, stableDrift, driftHours } = require("./influenceRules");
const { STABLE } = require("./schema");

const CONSEQUENCE_NAME = "occupation";

function messageOf(err) {
  return String((err && err.message) || err);
}

function createOccupationConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createOccupationConsequence: deps missing");
  const { service, repository, settings } = deps;
  for (const fn of ["getSystem", "isApplied", "applyChange"]) {
    if (!repository || typeof repository[fn] !== "function") {
      throw new TypeError(`createOccupationConsequence: repository.${fn} required`);
    }
  }
  if (!service || typeof service.enqueueBattleInTx !== "function") {
    throw new TypeError("createOccupationConsequence: service.enqueueBattleInTx required");
  }
  for (const name of ["battleWinPoints", "battleLossPoints", "maxFactionsPerSystem"]) {
    if (!settings || typeof settings[name] !== "number" || !(settings[name] >= 0)) {
      throw new TypeError(`createOccupationConsequence: settings.${name}`);
    }
  }
  const onCount = typeof deps.onCount === "function" ? deps.onCount : () => {};

  function applyInner(tx, settled, ck) {
    const got = repository.getSystem(tx, settled.systemId, { includeInfluence: true });
    if (!got.ok) return got;
    const sys = got.system;
    if (!sys) {
      onCount("battleNoRow");
      return { ok: true, outcome: "NO_ROW" };
    }
    const worldKey = `${ck}:world:${sys.systemId}`;
    const applied = repository.isApplied(tx, worldKey);
    if (!applied.ok) return applied;
    if (applied.applied) return { ok: true, outcome: "DUPLICATE" };
    const rows = new Map((sys.influence || []).map((i) => [i.factionId, i.influenceScore]));
    const stable = sys.occupationState === STABLE;
    if (settings.bastionBattleInfluenceFrozen === true && typeof settings.bastionOwnerOf === "function"
      && settings.bastionOwnerOf(sys.systemId) !== null) {
      if (!stable) {
        const frozen = battleInfluence(settled, rows, settings);
        const e = service.enqueueBattleInTx(tx, sys, settled, frozen.winnerFactionId, frozen.loserFactionId);
        if (!e.ok) return e;
      }
      onCount("battleBastionFrozen");
      return { ok: true, outcome: "BASTION_FROZEN", state: sys.occupationState };
    }
    const anchor = sys.influenceEvaluatedAt === undefined ? null : sys.influenceEvaluatedAt;
    const drift = stable && settings.drift ? stableDrift(rows, sys.controllerFactionId,
      driftHours(anchor, settled.at), settings.drift) : [];
    for (const d of drift) rows.set(d.factionId, d.influenceScore);
    const bi = battleInfluence(settled, rows, settings);
    if (bi.changed) {
      const merged = new Map(drift.map((d) => [d.factionId, d.influenceScore]));
      for (const e of bi.influence) merged.set(e.factionId, e.influenceScore);
      const influence = [...merged.entries()].sort((a, b) => a[0] - b[0])
        .map(([factionId, influenceScore]) => ({ factionId, influenceScore }));
      const change = { systemId: sys.systemId, expectedVersion: sys.version, reason: "OCCUPATION_BATTLE", influence };
      if (stable) change.state = { influenceEvaluatedAt: Math.max(anchor === null ? settled.at : anchor, settled.at) };
      const r = repository.applyChange(tx, change, worldKey);
      if (!r.ok) return r;
      if (r.duplicate) return { ok: true, outcome: "DUPLICATE" };
    }
    if (sys.occupationState !== STABLE) {
      const e = service.enqueueBattleInTx(tx, sys, settled, bi.winnerFactionId, bi.loserFactionId);
      if (!e.ok) return e;
    }
    onCount("battleApplied");
    if (bi.changed && drift.length > 0) onCount("stableDrift");
    if (bi.winnerFactionId === null && (settled.winnerSide === "A" || settled.winnerSide === "B")
      && settings.nonOccupierFactionIds instanceof Set && settings.nonOccupierFactionIds.has(settled.winnerFactionId)) {
      onCount("battleNonOccupierWinner");
    }
    return { ok: true, outcome: bi.changed ? "INFLUENCE" : "NO_CHANGE", state: sys.occupationState,
      influence: bi.influence };
  }

  function apply(tx, settled, ck) {
    if (typeof ck !== "string" || ck === "") return { ok: false, reason: "OCCUPATION_KEY_MISSING" };
    if (!settled || !Number.isSafeInteger(settled.systemId) || typeof settled.battleId !== "string"
      || !Number.isSafeInteger(settled.at)) return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
    try {
      return applyInner(tx, settled, ck);
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ name: CONSEQUENCE_NAME, apply });
}

module.exports = { createOccupationConsequence, CONSEQUENCE_NAME };
