"use strict";

const DEFAULT_WINDOW_MINUTES = 10;
const MAX_THROTTLE_KEYS = 1000;
const MAX_LIST_ENTRIES = 40;
const MAX_ERROR_TEXT = 160;

const ACTIVITY_KEY_BY_ID = Object.freeze({
  1: "manufacturing", 3: "research_time", 4: "research_material", 5: "copying", 8: "invention", 11: "reaction",
});

function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function dictEntries(payload) {
  if (!payload || payload.type !== "dict" || !Array.isArray(payload.entries)) return null;
  return payload.entries
    .filter((entry) => Array.isArray(entry) && entry.length >= 2)
    .map(([typeID, quantity]) => [int(typeID), int(quantity)]);
}

function listText(pairs) {
  if (!pairs || pairs.length === 0) return "none";
  const shown = pairs.slice(0, MAX_LIST_ENTRIES).map(([typeID, quantity]) => `${typeID}x${quantity}`).join(",");
  return pairs.length > MAX_LIST_ENTRIES ? `${shown},+${pairs.length - MAX_LIST_ENTRIES}` : shown;
}

function definitionMaterials(definition, activityID) {
  const key = ACTIVITY_KEY_BY_ID[activityID];
  const activity = key && definition && definition.activities ? definition.activities[key] : null;
  if (!activity || !Array.isArray(activity.materials)) return null;
  return activity.materials.map((entry) => [int(entry && entry.typeID), int(entry && entry.quantity)]);
}

function createConnectJobTrace({ deps, windowMinutes = DEFAULT_WINDOW_MINUTES, now = Date.now, logFn, onFailure }) {
  const windowMs = Math.max(1, int(windowMinutes)) * 60 * 1000;
  const lastAt = new Map();
  const stats = { calls: 0, traced: 0, throttled: 0, failures: 0 };

  function throttled(key, at) {
    const previous = lastAt.get(key);
    if (previous !== undefined && at - previous < windowMs) return true;
    if (lastAt.size >= MAX_THROTTLE_KEYS) {
      for (const [entryKey, entryAt] of lastAt) if (at - entryAt >= windowMs) lastAt.delete(entryKey);
      if (lastAt.size >= MAX_THROTTLE_KEYS) lastAt.clear();
    }
    lastAt.set(key, at);
    return false;
  }

  function inspect(args, session) {
    const ids = deps.blueprintTypeIDs();
    if (!ids || ids.size === 0) return null;
    const request = (deps.parseRequest && deps.parseRequest(Array.isArray(args) && args.length > 0 ? args[0] : null)) || {};
    const blueprintItemID = int(request.blueprintID);
    let blueprintTypeID = int(request.blueprintTypeID);
    if (blueprintTypeID > 0 && !ids.has(blueprintTypeID)) return null;
    const blueprint = blueprintItemID > 0 && deps.getBlueprint ? deps.getBlueprint(blueprintItemID) : null;
    if (blueprint && int(blueprint.typeID) > 0) blueprintTypeID = int(blueprint.typeID);
    if (!ids.has(blueprintTypeID)) return null;
    const activityID = int(request.activityID);
    const definition = deps.getDefinition ? deps.getDefinition(blueprintTypeID) : null;
    const input = request.inputLocation || {};
    const characterID = int(session && (session.characterID || session.charid));
    return {
      key: `${characterID}:${blueprintItemID}:${activityID}`,
      head: [
        `char=${characterID}`,
        `bpItem=${blueprintItemID}`,
        `bpType=${blueprintTypeID}`,
        `activity=${activityID}`,
        `facility=${int(request.facilityID)}`,
        `input=${int(input.itemID)}/${int(input.flagID)}/${int(input.ownerID)}`,
        `bpOwner=${int(blueprint && blueprint.ownerID)}`,
        `bpFacility=${int(blueprint && blueprint.facilityID)}`,
        `bpLocation=${int(blueprint && blueprint.locationID)}`,
        `bpFlag=${int(blueprint && blueprint.flagID)}`,
        `bpOriginal=${blueprint ? String(blueprint.original === true) : "none"}`,
        `bpJob=${int(blueprint && blueprint.jobID)}`,
        `runs=${int(request.runs)}`,
      ],
      materials: definition ? definitionMaterials(definition, activityID) : null,
      definitionFound: Boolean(definition),
    };
  }

  function emit(fields, result, error) {
    const avail = error ? null : dictEntries(Array.isArray(result) ? result[1] : null);
    const have = new Map(avail || []);
    const short = (fields.materials || []).filter(([typeID, quantity]) => (have.get(typeID) || 0) < quantity)
      .map(([typeID]) => typeID);
    const outcome = error
      ? `error:${String((error && error.name) || "Error")}:${String((error && error.message) || "").slice(0, MAX_ERROR_TEXT)}`
      : "ok";
    logFn(`CONNECTJOB_TRACE ${fields.head.join(" ")}`
      + ` def=${fields.definitionFound ? listText(fields.materials) : "no-definition"}`
      + ` avail=${avail ? listText(avail) : (error ? "none" : "bad-shape")}`
      + ` short=${short.length > 0 ? short.join(",") : "none"}`
      + ` monitor=${Array.isArray(result) ? int(result[0]) : 0} result=${outcome}`);
  }

  function failure(error) {
    stats.failures += 1;
    if (onFailure) {
      try {
        onFailure(error);
      } catch (_ignored) {}
    }
  }

  function observe(args, session, result, error) {
    stats.calls += 1;
    try {
      const fields = inspect(args, session);
      if (!fields) return;
      if (throttled(fields.key, now())) {
        stats.throttled += 1;
        return;
      }
      emit(fields, result, error);
      stats.traced += 1;
    } catch (traceError) {
      failure(traceError);
    }
  }

  function wrap(original) {
    return function Handle_ConnectJob(args, session) {
      let result;
      try {
        result = original.apply(this, arguments);
      } catch (error) {
        observe(args, session, undefined, error);
        throw error;
      }
      observe(args, session, result, null);
      return result;
    };
  }

  return { wrap, stats };
}

module.exports = { DEFAULT_WINDOW_MINUTES, MAX_THROTTLE_KEYS, createConnectJobTrace, dictEntries };
