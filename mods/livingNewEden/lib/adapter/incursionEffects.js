// Port 1:1 of isPlayerShip / isPlayerDrone (incursionSystemEffects.js:22-29, AGPL-3.0-only, see CREDITS.md).

"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");

const EFFECTS_PATH = "services/incursion/incursionSystemEffects";
const CONTRACT_PATH = "services/incursion/incursionSystemEffectContract";
const RUNTIME_PATH = "space/runtime";
const EFFECTS_SHA1 = "3f351a89125124c827b459295f0aa08ff80f1223";
const CONTRACT_SHA1 = "ee6a79c1e6a82e82cc8247d4bb5799be3b661be5";
const SWAPPED = Object.freeze(["shipModifiers", "damageMultiplier", "bountyMultiplier", "blocksCyno"]);
const SCENE_TYPES = Object.freeze([1, 2, 3, 4]);
const CONSUMER = "factionIncursions.effects";
const MARKER = Symbol.for("livingNewEden.incursionEffects");
const MAX_SYSTEMS = 64;
const SOURCE_PREFIX = "lne-incursion";
const RESISTANCE_OPERATION = 6;
const NEUTRAL_DAMAGE = 1;
const NEUTRAL_BOUNTY = 1;
const DETAIL_MAX = 200;

const fit = (text) => {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
};
const lf = (text) => String(text).replace(/\r\n/g, "\n");
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNat = (v) => Number.isSafeInteger(v) && v >= 0;

function isPlayerShip(entity) {
  return entity?.kind === "ship" && entity.nativeNpc !== true &&
    Number(entity.pilotCharacterID || entity.characterID || entity.session?.characterID || entity.session?.charid) > 0;
}
function isPlayerDrone(entity) {
  return entity?.kind === "drone" && entity.nativeNpc !== true &&
    Number(entity.characterID || entity.ownerID) >= 90000000;
}

function isVendorFunction(text, name, fn) {
  if (typeof fn !== "function") return false;
  const at = text.indexOf(`\nfunction ${name}(`);
  return at >= 0 && text.startsWith(lf(String(fn)), at + 1);
}

function policyOf(contract) {
  const version = contract.VERSION;
  const resonances = contract.RESONANCES;
  if (typeof version !== "string" || version === "" || !Array.isArray(resonances) || resonances.length === 0
    || !resonances.every(isId) || typeof contract.policy !== "function") {
    return null;
  }
  const p = contract.policy();
  if (!p || p.version !== version || !p.scenes || !Array.isArray(p.weaponKinds)
    || !Number.isFinite(p.bountyMultiplier)) {
    return null;
  }
  const scenes = {};
  for (const type of SCENE_TYPES) {
    const s = p.scenes[type];
    if (!s || !Number.isFinite(s.resistancePercent) || !Number.isFinite(s.damagePercent)) return null;
    scenes[type] = Object.freeze({ resistancePercent: s.resistancePercent, damagePercent: s.damagePercent });
  }
  return Object.freeze({ version, resonances: Object.freeze([...resonances]), scenes: Object.freeze(scenes),
    weaponKinds: Object.freeze(p.weaponKinds.filter((k) => typeof k === "string")),
    bountyMultiplier: p.bountyMultiplier });
}

function makeWrappers(originals, slot) {
  const vendorTale = (systemId) => originals.blocksCyno(systemId) === true;
  const wrappers = {
    shipModifiers: function lneShipModifiers(entity) {
      const e = slot.map.get(Number(entity && entity.systemID));
      if (e === undefined) return originals.shipModifiers.apply(this, arguments);
      const v = originals.shipModifiers.apply(this, arguments);
      if (!Array.isArray(v) || v.length > 0) {
        slot.vendorWins += 1;
        return v;
      }
      try {
        if (!isPlayerShip(entity)) return v;
        if (vendorTale(entity.systemID)) {
          slot.vendorWins += 1;
          return v;
        }
        const value = slot.policy.scenes[e.sceneType].resistancePercent * e.opposition;
        if (!value) return v;
        slot.hits += 1;
        const sourceKey = `${SOURCE_PREFIX}:${e.incursionId}:${slot.policy.version}`;
        return slot.policy.resonances.map((modifiedAttributeID) => ({ modifiedAttributeID,
          operation: RESISTANCE_OPERATION, value, stackingPenalized: false, modifierSourceKey: sourceKey }));
      } catch (_err) {
        slot.errors += 1;
        return v;
      }
    },
    damageMultiplier: function lneDamageMultiplier(entity, weaponKind, systemID) {
      const e = slot.map.get(Number(systemID === undefined ? entity && entity.systemID : systemID));
      if (e === undefined) return originals.damageMultiplier.apply(this, arguments);
      const v = originals.damageMultiplier.apply(this, arguments);
      if (v !== NEUTRAL_DAMAGE) {
        slot.vendorWins += 1;
        return v;
      }
      try {
        const drone = isPlayerDrone(entity);
        if (!drone && !isPlayerShip(entity)) return v;
        if (!slot.policy.weaponKinds.includes(drone ? "drone" : weaponKind)) return v;
        if (vendorTale(systemID === undefined ? entity.systemID : systemID)) {
          slot.vendorWins += 1;
          return v;
        }
        const multiplier = 1 + slot.policy.scenes[e.sceneType].damagePercent / 100 * e.opposition;
        if (!Number.isFinite(multiplier) || multiplier === NEUTRAL_DAMAGE) return v;
        slot.hits += 1;
        return multiplier;
      } catch (_err) {
        slot.errors += 1;
        return v;
      }
    },
    bountyMultiplier: function lneBountyMultiplier(systemID) {
      const e = slot.map.get(Number(systemID));
      if (e === undefined) return originals.bountyMultiplier.apply(this, arguments);
      const v = originals.bountyMultiplier.apply(this, arguments);
      if (v !== NEUTRAL_BOUNTY) {
        slot.vendorWins += 1;
        return v;
      }
      try {
        if (vendorTale(systemID)) {
          slot.vendorWins += 1;
          return v;
        }
        slot.hits += 1;
        return slot.policy.bountyMultiplier;
      } catch (_err) {
        slot.errors += 1;
        return v;
      }
    },
    blocksCyno: function lneBlocksCyno(systemID) {
      const e = slot.map.get(Number(systemID));
      const v = originals.blocksCyno.apply(this, arguments);
      if (e === undefined) return v;
      if (v === true) {
        slot.vendorWins += 1;
        return v;
      }
      slot.hits += 1;
      return true;
    },
  };
  for (const name of SWAPPED) Object.defineProperty(wrappers[name], MARKER, { value: slot });
  return wrappers;
}

function createIncursionEffects(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  const serverSrc = deps && typeof deps.serverSrc === "function" ? deps.serverSrc : () => null;
  const readFile = deps && typeof deps.readFile === "function" ? deps.readFile : () => null;
  const consumerDrift = deps && typeof deps.consumerDrift === "function" ? deps.consumerDrift : () => null;

  let slot = { map: new Map(), policy: null, hits: 0, vendorWins: 0, errors: 0 };
  let installed = false;
  let driftResult = null;
  let generation = 0;
  const removed = new Set();
  const stamps = new WeakMap();

  function load(rel) {
    if (!requireGame) return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "no requireGame" };
    try {
      const loaded = requireGame(rel);
      if (!loaded || !loaded.ok || !loaded.exports) {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE",
          detail: fit(`${rel} ${(loaded && loaded.reason) || ""}`) };
      }
      return { ok: true, exports: loaded.exports };
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((err && err.message) || err) };
    }
  }

  function readText(srcDir, rel) {
    try {
      const text = readFile(nodePath.join(srcDir, ...`${rel}.js`.split("/")));
      return typeof text === "string" ? lf(text) : null;
    } catch (_err) {
      return null;
    }
  }

  function fingerprintDetail(srcDir, effects, contract) {
    const effectsText = readText(srcDir, EFFECTS_PATH);
    if (effectsText === null) return `${EFFECTS_PATH}.js missing`;
    if (sha1(effectsText) !== EFFECTS_SHA1) return `${EFFECTS_PATH}.js sha1`;
    const contractText = readText(srcDir, CONTRACT_PATH);
    if (contractText === null) return `${CONTRACT_PATH}.js missing`;
    if (sha1(contractText) !== CONTRACT_SHA1) return `${CONTRACT_PATH}.js sha1`;
    if (Object.isFrozen(effects)) return "effects exports frozen";
    for (const name of SWAPPED) {
      const fn = effects[name];
      const d = Object.getOwnPropertyDescriptor(effects, name);
      if (typeof fn !== "function" || !d || d.writable !== true) return `${name} not a writable export`;
      if (!(fn[MARKER] && typeof fn[MARKER] === "object") && !isVendorFunction(effectsText, name, fn)) {
        return `${name} not the vendor function`;
      }
    }
    const marked = SWAPPED.filter((name) => effects[name][MARKER]);
    if (marked.length !== 0 && (marked.length !== SWAPPED.length
      || !SWAPPED.every((name) => effects[name][MARKER] === effects.shipModifiers[MARKER]))) {
      return "partial wrap";
    }
    if (policyOf(contract) === null) return `${CONTRACT_PATH} policy shape`;
    return null;
  }

  function ensureInstalled() {
    if (installed) return { ok: true };
    if (driftResult !== null) return driftResult;
    const effects = load(EFFECTS_PATH);
    if (!effects.ok) return effects;
    const contract = load(CONTRACT_PATH);
    if (!contract.ok) return contract;
    const srcDir = serverSrc();
    if (typeof srcDir !== "string" || srcDir === "") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "server_src_unknown" };
    }
    const detail = fingerprintDetail(srcDir, effects.exports, contract.exports);
    if (detail !== null) {
      driftResult = Object.freeze({ ok: false, reason: "INCURSION_EFFECTS_DRIFT", detail: fit(detail) });
      return driftResult;
    }
    const target = effects.exports;
    const adopted = target.shipModifiers[MARKER];
    if (adopted && typeof adopted === "object") {
      slot = adopted;
    } else {
      slot.policy = policyOf(contract.exports);
      const originals = {};
      for (const name of SWAPPED) originals[name] = target[name];
      const wrappers = makeWrappers(originals, slot);
      for (const name of SWAPPED) target[name] = wrappers[name];
    }
    installed = true;
    return { ok: true };
  }

  function mapOf(entries) {
    if (entries === null) return new Map();
    if (!Array.isArray(entries) || entries.length > MAX_SYSTEMS) return null;
    const out = new Map();
    for (const x of entries) {
      if (!x || !isId(x.systemId) || !isId(x.incursionId) || !isId(x.sceneType) || !Number.isFinite(x.opposition)
        || x.opposition < 0 || x.opposition > 1) {
        return null;
      }
      if (!out.has(x.systemId)) {
        out.set(x.systemId, { incursionId: x.incursionId, sceneType: x.sceneType, opposition: x.opposition });
      }
    }
    return out;
  }

  function setSystems(entries, refreshDelta) {
    try {
      const next = mapOf(entries);
      if (next === null || !Number.isFinite(refreshDelta) || refreshDelta <= 0 || refreshDelta > 1) {
        return { ok: false, reason: "INVALID_ENTRIES" };
      }
      const drift = consumerDrift();
      if (drift) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: fit(`${CONSUMER} ${drift}`) };
      if (!installed) {
        if (next.size === 0) return { ok: true, installed: false, changed: 0 };
        const r = ensureInstalled();
        if (!r.ok) return r;
      }
      const prev = slot.map;
      const map = new Map();
      let changed = 0;
      for (const [systemId, e] of next) {
        const p = prev.get(systemId);
        if (p && p.incursionId === e.incursionId && p.sceneType === e.sceneType
          && Math.abs(p.opposition - e.opposition) < refreshDelta) {
          map.set(systemId, p);
          continue;
        }
        generation += 1;
        map.set(systemId, Object.freeze({ ...e, stamp: generation }));
        removed.delete(systemId);
        changed += 1;
      }
      for (const systemId of prev.keys()) {
        if (map.has(systemId)) continue;
        removed.add(systemId);
        changed += 1;
      }
      slot.map = map;
      return { ok: true, installed: true, changed };
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((err && err.message) || err) };
    }
  }

  function refresh(budget) {
    try {
      if (!isNat(budget)) return { ok: false, reason: "INVALID_ENTRIES" };
      if (!installed || (slot.map.size === 0 && removed.size === 0)) return { ok: true, refreshed: 0, pending: 0 };
      const runtime = load(RUNTIME_PATH);
      if (!runtime.ok) return runtime;
      const scenes = runtime.exports.scenes;
      if (!scenes || typeof scenes.get !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "scenes" };
      }
      const out = { ok: true, refreshed: 0, pending: 0 };
      let attempts = 0;
      const visit = (systemId, stamp) => {
        const scene = scenes.get(systemId);
        if (!scene || !scene.dynamicEntities || typeof scene.dynamicEntities.values !== "function"
          || typeof scene.refreshShipEntityDerivedState !== "function") {
          return 0;
        }
        let left = 0;
        for (const entity of scene.dynamicEntities.values()) {
          if (!isPlayerShip(entity)) continue;
          const had = stamps.get(entity);
          if (stamp === null ? had === undefined : had === stamp) continue;
          if (attempts >= budget) {
            left += 1;
            continue;
          }
          attempts += 1;
          let r;
          try {
            r = scene.refreshShipEntityDerivedState(entity, { notifyDerivedAttributes: true });
          } catch (_err) {
            r = { success: false };
          }
          if (r && r.success === false) {
            slot.errors += 1;
            left += 1;
            continue;
          }
          out.refreshed += 1;
          if (stamp === null) stamps.delete(entity);
          else stamps.set(entity, stamp);
        }
        return left;
      };
      for (const systemId of [...removed]) {
        const left = visit(systemId, null);
        out.pending += left;
        if (left === 0) removed.delete(systemId);
      }
      for (const [systemId, e] of slot.map) out.pending += visit(systemId, e.stamp);
      return out;
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((err && err.message) || err) };
    }
  }

  function stats() {
    return { installed, drift: driftResult !== null, systems: slot.map.size, hits: slot.hits,
      vendorWins: slot.vendorWins, errors: slot.errors };
  }

  return Object.freeze({ setSystems, refresh, stats });
}

module.exports = { CONSUMER, EFFECTS_PATH, CONTRACT_PATH, EFFECTS_SHA1, CONTRACT_SHA1, SWAPPED, MARKER, MAX_SYSTEMS,
  isPlayerShip, isPlayerDrone, createIncursionEffects };
