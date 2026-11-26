"use strict";

const S = require("./schema");

const BLOCKED = "PLAYER_SOV_DEPLOY_BLOCKED";
const TX_FAILED = "PLAYER_SOV_TX_FAILED";
const MAX_NAME = 60;
const FALLBACK_NAME = "An NPC faction";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const asciiOf = (text) => String(text).replace(/[^\x20-\x7e]/g, "").trim().slice(0, MAX_NAME);

function blockedNotify(factionName) {
  const name = factionName ? asciiOf(factionName) : "";
  return `${name || FALLBACK_NAME} holds a sovereignty structure in this system. `
    + "Destroy it before deploying a Sovereignty Hub.";
}

function createDeployGate(deps) {
  const { store, repository, sovRepository, clock } = deps;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const atOf = (at) => (Number.isSafeInteger(at) && at > 0 ? at : clock.now());

  function run(name, fn) {
    try {
      const tx = store.transaction(name, fn);
      return tx && tx.ok ? tx.value : { ok: false, reason: (tx && tx.reason) || TX_FAILED };
    } catch (err) {
      return { ok: false, reason: TX_FAILED, detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  function checkDeploy(input) {
    const systemId = input && input.systemId;
    if (!isId(systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
    return run("playerSov.deployCheck", (db) => {
      const r = sovRepository.listLiveInSystem(db, systemId);
      if (!r.ok) return r;
      const live = r.structures[0];
      if (!live) return { ok: true };
      return { ok: false, reason: BLOCKED, factionId: live.factionId, notify: blockedNotify(names.get(live.factionId)) };
    });
  }

  function registerDeploy(input) {
    const p = input || {};
    const at = atOf(p.at);
    return run("playerSov.deployRegister", (db) => repository.insertClaim(db, { systemId: p.systemId,
      allianceId: p.allianceId, corpId: p.corpId, hubItemId: p.hubItemId, origin: S.ORIGIN.GATE, state: S.CAPTURING,
      at }));
  }

  return Object.freeze({ checkDeploy, registerDeploy });
}

module.exports = { createDeployGate, blockedNotify, BLOCKED };
