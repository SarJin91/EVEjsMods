"use strict";

const { isWingCopyShape } = require("./shipAiWing");

const WRAPPED = Symbol.for("livingNewEden.liveLossImport");
const METHODS = Object.freeze(["recordKillmailFromDestruction", "enqueueKillmailFromDestruction"]);
const PRIMARY_METHOD = METHODS[0];

let sink = null;
const listeners = new Set();
let listenerErrors = 0;

function readOwnCallable(value, property) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return null;
  return typeof value[property] === "function" ? value[property] : null;
}

function killerOf(options) {
  if (!options || typeof options !== "object") return { killerCharacterId: null };
  const identity = options.attackerIdentity && typeof options.attackerIdentity === "object"
    ? options.attackerIdentity : null;
  if (identity) return { killerCharacterId: positiveInt(identity.characterID) };
  const attacker = options.attackerEntity && typeof options.attackerEntity === "object" ? options.attackerEntity : null;
  return { killerCharacterId: attacker ? positiveInt(attacker.pilotCharacterID ?? attacker.characterID) : null };
}

function makeWrapper(original, method) {
  const wrapper = function livingNewEdenLiveLoss(targetEntity, destroyResult, options) {
    const result = original.apply(this, arguments);
    const current = sink;
    if (current !== null) {
      try {
        current(targetEntity, destroyResult, killerOf(options));
      } catch (_err) {
      }
    }
    if (listeners.size > 0) {
      for (const fn of [...listeners]) {
        try {
          fn(targetEntity, destroyResult, result);
        } catch (_err) {
          listenerErrors += 1;
        }
      }
    }
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_${method}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== WRAPPED) wrapper[s] = original[s];
  }
  wrapper[WRAPPED] = true;
  return wrapper;
}

function install(killmailExports) {
  if (readOwnCallable(killmailExports, PRIMARY_METHOD) === null) return { ok: false, reason: "PRIMARY_MISSING" };
  const present = METHODS.filter((m) => readOwnCallable(killmailExports, m) !== null);
  if (present.every((m) => killmailExports[m][WRAPPED] === true)) {
    return { ok: true, installed: true, methods: present, alreadyInstalled: true };
  }
  const methods = [];
  for (const m of present) {
    const original = killmailExports[m];
    if (original[WRAPPED] === true) continue;
    killmailExports[m] = makeWrapper(original, m);
    methods.push(m);
  }
  return { ok: true, installed: true, methods };
}

function bindSink(fn) {
  if (typeof fn !== "function") return { ok: false, reason: "SINK_INVALID" };
  if (sink !== null) return { ok: false, reason: "SINK_BOUND" };
  sink = fn;
  return { ok: true, unbind: () => {
    if (sink === fn) sink = null;
  } };
}

function addListener(fn) {
  if (typeof fn !== "function") return { ok: false, reason: "LISTENER_INVALID" };
  listeners.add(fn);
  return { ok: true, remove: () => removeListener(fn) };
}

function removeListener(fn) {
  return listeners.delete(fn);
}

function listenerStats() {
  return { listeners: listeners.size, listenerErrors };
}

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const NOT_A_SHIP_LOSS = new Set(["drone", "fighter", "structure"]);

function isNpcVictimShape(entity) {
  const npcType = String(entity.npcEntityType ?? "").trim().toLowerCase();
  return entity.nativeNpc === true || entity.nativeNpcOccupied === true || npcType === "npc" || npcType === "concord";
}

function ownerVictimOf(entity, opts) {
  const isCharacter = opts && typeof opts.isCharacter === "function" ? opts.isCharacter : null;
  if (isCharacter === null || isNpcVictimShape(entity)) return null;
  const owner = positiveInt(entity.ownerID);
  if (owner === null) return null;
  try {
    return isCharacter(owner) === true ? owner : null;
  } catch (_err) {
    return null;
  }
}

function lossFactsOf(targetEntity, destroyResult, result, opts) {
  if (!targetEntity || typeof targetEntity !== "object" || !destroyResult || destroyResult.success !== true) {
    return null;
  }
  if (NOT_A_SHIP_LOSS.has(String(targetEntity.kind ?? "").toLowerCase())) return null;
  const session = targetEntity.session && typeof targetEntity.session === "object" ? targetEntity.session : null;
  let victim = positiveInt(targetEntity.pilotCharacterID ?? targetEntity.characterID)
    || (session ? positiveInt(session.characterID || session.charID || session.charid) : null);
  if (victim === null) victim = ownerVictimOf(targetEntity, opts);
  if (victim === null) return null;
  const copy = isWingCopyShape(targetEntity);
  const copyName = copy && typeof targetEntity.itemName === "string" && targetEntity.itemName.trim() !== ""
    ? targetEntity.itemName.trim() : null;
  return { victimCharacterId: victim, shipTypeId: positiveInt(targetEntity.typeID),
    itemId: positiveInt(targetEntity.itemID), killId: result && typeof result === "object"
      ? positiveInt(result.killID) : null, systemId: positiveInt(targetEntity.systemID), copy, copyName };
}

function checkHookInstalled(killmailExports) {
  if (!killmailExports) return false;
  return METHODS.every((m) => typeof killmailExports[m] === "function" && killmailExports[m][WRAPPED] === true);
}

module.exports = { install, bindSink, checkHookInstalled, addListener, removeListener, listenerStats, lossFactsOf,
  WRAPPED, METHODS, PRIMARY_METHOD };
