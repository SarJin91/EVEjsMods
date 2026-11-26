"use strict";

const ledgerOps = require("./launchLedger");
const { SKYHOOK_TYPE_ID, pickReagent } = require("./overlay");
const variants = require("./variants");

const CARGO_HOLD_FLAG = 5;

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function sessionContextOf(session, options) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  const corporationID = toInt(session && (session.corporationID || session.corpid), characterID);
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const behalfOwnerID = toInt(options && options.ownerID, 0);
  return { characterID, corporationID, behalfOwnerID, shipID };
}

function resolveSource({ sourceItemID, item, intents, drills, targetTypeID = SKYHOOK_TYPE_ID }) {
  const id = Number(sourceItemID);
  const known = drills || {};
  const own = (Array.isArray(intents) ? intents : [])
    .filter((intent) => intent && intent.sourceItem && Number(intent.sourceItem.itemID) === id);
  const record = [];
  for (const intent of own) {
    const launchedItemID = toInt(intent.launchedItemID, 0);
    if (launchedItemID > 0 && !known[String(launchedItemID)] && !record.includes(launchedItemID)) record.push(launchedItemID);
  }
  if (own.some((intent) => !intent.completed && !(toInt(intent.launchedItemID, 0) > 0))) {
    return { record, action: "HOLD", reason: "SAGA_HOLDS" };
  }
  if (item == null) return { record, action: "DONE", reason: "SOURCE_GONE" };
  if (Number(item.typeID) !== Number(targetTypeID)) return { record, action: "DONE", reason: "SOURCE_NOT_CONVERTED" };
  if (Number(item.flagID) === 0 || known[String(id)] || record.includes(id)) {
    return { record, action: "DONE", reason: "IN_SPACE" };
  }
  return { record, action: "REVERT", reason: "REVERTED" };
}

function checkVariantLaunch({ variant, nearestPlanetID, planet, resourceTypeIDs, qualities, cfg }) {
  const planetID = nearestPlanetID == null ? 0 : toInt(nearestPlanetID, 0);
  const refuse = (reason, planetName = "") => ({
    ok: false,
    reason,
    planetID,
    message: variants.refusalMessage({ variant, planetName, reason }),
  });
  if (nearestPlanetID == null) return refuse("PRECHECK_UNAVAILABLE");
  if (planetID <= 0) return { ok: true };
  if (!planet) return refuse("PRECHECK_UNAVAILABLE");
  const picked = pickReagent({ resourceTypeIDs, qualities, name: "", cfg, preferredTypeID: variant.p0TypeID });
  if (picked.ok && picked.pick === "variant") return { ok: true };
  const planetName = planet.itemName ? String(planet.itemName) : `planet ${planetID}`;
  const p0TypeID = toInt(variant.p0TypeID, 0);
  const onPlanet = (Array.isArray(resourceTypeIDs) ? resourceTypeIDs : []).some((typeID) => toInt(typeID, 0) === p0TypeID);
  return refuse(onPlanet ? "P0_TOO_POOR" : "P0_NOT_ON_PLANET", planetName);
}

function notifyEntryOf(itemID, message) {
  return [itemID, { type: "list", items: [["CustomNotify", { type: "dict", entries: [["notify", message]] }]] }];
}

function createLedgerStore({ ledgerFile, logErrorFn = () => {}, stats = {}, now = Date.now }) {
  let unsaved = null;
  return {
    file: ledgerFile,
    load() {
      return unsaved || ledgerOps.readLedger(ledgerFile, { logErrorFn });
    },
    save(ledger) {
      const written = ledgerOps.writeLedger(ledgerFile, ledger, { nowMs: now() });
      if (written.ok) {
        unsaved = null;
        return written;
      }
      unsaved = ledger;
      stats.ledgerWriteErrors = (stats.ledgerWriteErrors || 0) + 1;
      logErrorFn(`launch ledger write failed (${ledgerFile}) - state kept in memory only`, written.error);
      return written;
    },
  };
}

function guardLog(fn) {
  if (typeof fn !== "function") return () => {};
  return (...args) => {
    try {
      fn(...args);
    } catch (_error) {
    }
  };
}

function bump(stats, key, by = 1) {
  if (stats) stats[key] = (stats[key] || 0) + by;
}

function settleSource({ ledger, sourceItemID, vendor, cfg, intents, orbitalsByID, now, session, logErrorFn, stats }) {
  const key = String(sourceItemID);
  const entry = ledger.pending[key] || { typeID: cfg.launchTypeID };
  const resolved = resolveSource({
    sourceItemID,
    item: vendor.findItem(sourceItemID) || null,
    intents,
    drills: ledger.drills,
    targetTypeID: SKYHOOK_TYPE_ID,
  });
  const decision = orbitalsByID
    ? { ...resolved, record: resolved.record.filter((id) => !shouldPrune(id, orbitalsByID, vendor)) }
    : resolved;
  let next = ledger;
  let changed = false;
  for (const launchedItemID of decision.record) {
    next = ledgerOps.withDrill(next, launchedItemID, {
      atMs: now(),
      sourceItemID: Number(sourceItemID),
      p0TypeID: entry.p0TypeID ?? null,
    });
    changed = true;
    bump(stats, "launchRecorded");
  }
  let reverted = false;
  if (decision.action === "REVERT") {
    const restored = vendor.updateItemType(sourceItemID, toInt(entry.typeID, cfg.launchTypeID));
    if (restored && restored.ok) {
      reverted = true;
      bump(stats, "launchReverted");
      next = ledgerOps.withoutPending(next, sourceItemID);
      changed = true;
      if (session) {
        try {
          vendor.syncItem(session, restored.item, restored.previous);
        } catch (error) {
          logErrorFn(`launch source=${key} client inventory sync failed`, error);
        }
      }
    } else {
      bump(stats, "launchErrors");
      logErrorFn(`launch source=${key} revert to ${entry.typeID} failed (${restored ? restored.reason : "NO_RESULT"}) - kept pending for the next sweep`);
    }
  } else if (decision.action === "DONE") {
    next = ledgerOps.withoutPending(next, sourceItemID);
    changed = true;
  }
  return { ledger: next, decision, reverted, changed };
}

function resultText(settled) {
  const parts = [];
  if (settled.decision.record.length > 0) parts.push(`LAUNCHED ${settled.decision.record.join(",")}`);
  if (settled.reverted) parts.push("REVERTED");
  else if (settled.decision.action === "REVERT") parts.push("REVERT_FAILED");
  if (settled.decision.action === "HOLD") parts.push("HELD");
  if (parts.length === 0) parts.push(`DONE ${settled.decision.reason}`);
  return parts.join(" ");
}

function shouldPrune(launchedItemID, orbitalsByID, vendor) {
  const orbital = orbitalsByID[String(launchedItemID)];
  if (orbital && !orbital.destroyedAtMs) return false;
  return !vendor.findItem(Number(launchedItemID));
}

function sweep({ vendor, cfg, ledgerFile, store = null, now = Date.now, logFn = () => {}, logErrorFn = () => {}, stats = {}, session = null, held = new Set() }) {
  try {
    bump(stats, "sweepRuns");
    const ledgerStore = store || createLedgerStore({ ledgerFile, logErrorFn, stats, now });
    let ledger = ledgerStore.load();
    const orbitalState = vendor.readOrbitalState() || {};
    const intents = Object.values(orbitalState.replacementsByPlanet || {});
    const orbitalsByID = orbitalState.orbitalsByID || {};
    let changed = false;
    let reverted = 0;
    let recorded = 0;
    for (const key of Object.keys(ledger.pending)) {
      const settled = settleSource({ ledger, sourceItemID: Number(key), vendor, cfg, intents, orbitalsByID, now, session, logErrorFn, stats });
      ledger = settled.ledger;
      changed = changed || settled.changed;
      if (settled.reverted) reverted += 1;
      recorded += settled.decision.record.length;
      if (settled.decision.action === "HOLD") {
        if (!held.has(key)) {
          held.add(key);
          bump(stats, "launchHeld");
          logFn(`launch source=${key} sweep result=${resultText(settled)}`);
        }
        continue;
      }
      held.delete(key);
      logFn(`launch source=${key} sweep result=${resultText(settled)}`);
    }
    let pruned = 0;
    for (const key of Object.keys(ledger.drills)) {
      if (!shouldPrune(key, orbitalsByID, vendor)) continue;
      ledger = ledgerOps.withoutDrill(ledger, Number(key));
      pruned += 1;
      changed = true;
    }
    if (changed) ledgerStore.save(ledger);
    return { ok: true, reverted, recorded, pruned };
  } catch (error) {
    bump(stats, "launchErrors");
    logErrorFn("launch sweep failed - ledger left as it was", error);
    return { ok: false, reason: "EXCEPTION" };
  }
}

function createLaunchWrapper({
  original,
  vendor,
  cfg,
  ledgerFile,
  store = null,
  now = Date.now,
  logFn: rawLogFn = () => {},
  logErrorFn: rawLogErrorFn = () => {},
  stats = {},
  isInert = () => false,
  held = new Set(),
}) {
  const logFn = guardLog(rawLogFn);
  const logErrorFn = guardLog(rawLogErrorFn);
  let busy = false;
  let resolvedStore = null;
  const storeOf = () => {
    if (!resolvedStore) {
      resolvedStore = typeof store === "function" ? store()
        : store || createLedgerStore({ ledgerFile, logErrorFn, stats, now });
    }
    return resolvedStore;
  };

  function candidatesOf(session, rawItemIDs, options) {
    const requests = vendor.normalizeLaunchRequests(rawItemIDs);
    const context = sessionContextOf(session, options);
    if (!context.shipID) return [];
    const owners = [context.characterID, context.corporationID, context.behalfOwnerID].filter((id) => id > 0);
    const found = [];
    for (const request of Array.isArray(requests) ? requests : []) {
      const itemID = toInt(request && request.itemID, 0);
      if (itemID <= 0 || found.some((entry) => entry.itemID === itemID)) continue;
      const item = vendor.findItem(itemID);
      if (!item || !variants.isLaunchType(toInt(item.typeID, 0), cfg)) continue;
      if (toInt(item.locationID, 0) !== context.shipID || toInt(item.flagID, 0) !== CARGO_HOLD_FLAG) continue;
      if (!owners.includes(toInt(item.ownerID, 0))) continue;
      found.push({ itemID, typeID: toInt(item.typeID, 0) });
    }
    return found;
  }

  function precheck(session, candidates) {
    if (!candidates.some((candidate) => variants.variantOf(candidate.typeID))) return { allowed: candidates, verdicts: [] };
    let nearestPlanetID = null;
    let planet = null;
    let resourceTypeIDs = [];
    let qualities = {};
    try {
      nearestPlanetID = vendor.nearestPlanetID(session);
      if (nearestPlanetID != null && nearestPlanetID > 0) {
        planet = vendor.getCelestial(nearestPlanetID) || null;
        if (planet) {
          resourceTypeIDs = vendor.resourceTypeIDs(planet);
          qualities = vendor.qualities(planet, resourceTypeIDs);
        }
      }
    } catch (error) {
      logErrorFn("launch variant pre-check: planet read failed - variants refused (PRECHECK_UNAVAILABLE)", error);
      nearestPlanetID = null;
    }
    const allowed = [];
    const verdicts = [];
    for (const candidate of candidates) {
      const variant = variants.variantOf(candidate.typeID);
      if (!variant) {
        allowed.push(candidate);
        continue;
      }
      const verdict = checkVariantLaunch({ variant, nearestPlanetID, planet, resourceTypeIDs, qualities, cfg });
      if (verdict.ok) {
        allowed.push(candidate);
        continue;
      }
      verdicts.push({ candidate, verdict });
    }
    return { allowed, verdicts };
  }

  function safeRefusalMessage(typeID, reason) {
    let variant = null;
    try {
      variant = variants.variantOf(typeID);
    } catch (_error) {
      variant = null;
    }
    return variants.refusalMessage({ variant, planetName: "", reason });
  }

  function fallbackVerdicts(candidates) {
    const allowed = [];
    const verdicts = [];
    const launchTypeID = toInt(cfg.launchTypeID, 0);
    for (const candidate of candidates) {
      if (toInt(candidate.typeID, 0) === launchTypeID) {
        allowed.push(candidate);
        continue;
      }
      const reason = "PRECHECK_UNAVAILABLE";
      verdicts.push({ candidate, verdict: { reason, planetID: 0, message: safeRefusalMessage(candidate.typeID, reason) } });
    }
    return { allowed, verdicts };
  }

  function refuseCandidate(candidate, verdict) {
    bump(stats, "launchRefused");
    logFn(`launch source=${candidate.itemID} type=${candidate.typeID} result=REFUSED reason=${verdict.reason} planet=${verdict.planetID}`);
    return { ...candidate, reason: verdict.reason, message: verdict.message, planetID: verdict.planetID };
  }

  function convert(ledgerStore, candidates) {
    const converted = [];
    const typeOf = new Map(candidates.map((candidate) => [candidate.itemID, candidate.typeID]));
    let ledger = ledgerStore.load();
    try {
      for (const { itemID, typeID } of candidates) {
        const variant = variants.variantOf(typeID);
        ledger = ledgerOps.withPending(ledger, itemID, { atMs: now(), typeID, p0TypeID: variant ? variant.p0TypeID : null });
        ledgerStore.save(ledger);
        const changed = vendor.updateItemType(itemID, SKYHOOK_TYPE_ID);
        if (!changed || !changed.ok) {
          logErrorFn(`launch source=${itemID} conversion to ${SKYHOOK_TYPE_ID} failed (${changed ? changed.reason : "NO_RESULT"}) - launched as ${typeID}`);
          bump(stats, "launchErrors");
          ledger = ledgerOps.withoutPending(ledger, itemID);
          ledgerStore.save(ledger);
          continue;
        }
        converted.push(itemID);
        bump(stats, "launchConverted");
      }
    } catch (error) {
      bump(stats, "launchErrors");
      logErrorFn("launch conversion failed - reverting the converted items, vendor called unchanged", error);
      for (const itemID of converted) {
        try {
          const restored = vendor.updateItemType(itemID, typeOf.get(itemID));
          if (restored && restored.ok) ledger = ledgerOps.withoutPending(ledger, itemID);
        } catch (_error) {
        }
      }
      ledgerStore.save(ledger);
      return { ledger, converted: [] };
    }
    return { ledger, converted };
  }

  function callWithout(self, session, rawItemIDs, options, refused) {
    const refusedIDs = new Set(refused.map((entry) => entry.itemID));
    const requests = (vendor.normalizeLaunchRequests(rawItemIDs) || [])
      .filter((request) => !refusedIDs.has(toInt(request && request.itemID, 0)));
    const result = requests.length === 0
      ? { success: false, errorMsg: "NO_VALID_ORBITALS", launchedItemIDs: [], errors: [], response: { type: "dict", entries: [] } }
      : original.call(self, session, requests.map((request) => [request.itemID, request.quantity]), options);
    const errorsOk = Boolean(result && Array.isArray(result.errors));
    const responseOk = Boolean(result && result.response && Array.isArray(result.response.entries));
    for (const entry of refused) {
      if (errorsOk) result.errors.push({ itemID: entry.itemID, errorMsg: entry.message });
      if (responseOk) result.response.entries.push(notifyEntryOf(entry.itemID, entry.message));
    }
    if (!errorsOk || !responseOk) {
      logFn(`launch refused ${refused.map((entry) => entry.itemID).join(",")} - vendor result without errors/response, refusal not shown to the client`);
    }
    return result;
  }

  function settleAll(ledgerStore, session, converted) {
    try {
      let ledger = ledgerStore.load();
      const orbitalState = vendor.readOrbitalState() || {};
      const intents = Object.values(orbitalState.replacementsByPlanet || {});
      const orbitalsByID = orbitalState.orbitalsByID || {};
      for (const sourceItemID of converted) {
        const entry = ledger.pending[String(sourceItemID)];
        const sourceTypeID = toInt(entry && entry.typeID, cfg.launchTypeID);
        const settled = settleSource({ ledger, sourceItemID, vendor, cfg, intents, orbitalsByID, now, session, logErrorFn, stats });
        ledger = settled.ledger;
        if (settled.decision.action === "HOLD") {
          held.add(String(sourceItemID));
          bump(stats, "launchHeld");
        }
        logFn(`launch source=${sourceItemID} type=${sourceTypeID}->${SKYHOOK_TYPE_ID} result=${resultText(settled)}`);
      }
      ledgerStore.save(ledger);
    } catch (error) {
      bump(stats, "launchErrors");
      logErrorFn("launch settlement failed - pending sources settled by the next sweep", error);
    }
  }

  return function launchOrbitalsFromShip(session, rawItemIDs, options) {
    if (busy || !cfg.launchTypeID) return original.apply(this, arguments);
    let candidates = [];
    let ledgerStore = null;
    try {
      if (!isInert()) candidates = candidatesOf(session, rawItemIDs, options);
      if (candidates.length > 0) ledgerStore = storeOf();
    } catch (error) {
      bump(stats, "launchErrors");
      logErrorFn("launch candidate scan failed - vendor called unchanged", error);
      candidates = [];
    }
    if (candidates.length === 0 || !ledgerStore) return original.apply(this, arguments);

    busy = true;
    try {
      bump(stats, "launchCalls");
      sweep({ vendor, cfg, store: ledgerStore, now, logFn, logErrorFn, stats, held });
      let checked;
      try {
        checked = precheck(session, candidates);
      } catch (error) {
        bump(stats, "launchErrors");
        logErrorFn("launch variant pre-check failed - variants refused (PRECHECK_UNAVAILABLE)", error);
        checked = fallbackVerdicts(candidates);
      }
      const refused = checked.verdicts.map(({ candidate, verdict }) => refuseCandidate(candidate, verdict));
      const { converted } = convert(ledgerStore, checked.allowed);
      try {
        if (refused.length === 0) return original.apply(this, arguments);
        return callWithout(this, session, rawItemIDs, options, refused);
      } finally {
        if (converted.length > 0) settleAll(ledgerStore, session, converted);
      }
    } finally {
      busy = false;
    }
  };
}

module.exports = {
  CARGO_HOLD_FLAG,
  checkVariantLaunch,
  createLaunchWrapper,
  createLedgerStore,
  guardLog,
  resolveSource,
  sessionContextOf,
  settleSource,
  sweep,
};
