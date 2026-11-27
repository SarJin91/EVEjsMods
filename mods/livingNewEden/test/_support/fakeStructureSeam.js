"use strict";

const { STATION_SEAM_METHODS: SEAM_METHODS, FC_SEAM_METHODS, REASONS, isTag, isFcTag, isVector, validCreateInput,
  validPatch } = require("../../lib/adapter/structures");

const DEFAULT_STATES = Object.freeze({ ANCHOR_VULNERABLE: 115, SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111,
  ARMOR_VULNERABLE: 112, HULL_REINFORCE: 113, HULL_VULNERABLE: 114 });
const DEFAULT_UPKEEP = Object.freeze({ FULL_POWER: 1 });
const FIRST_ID = 1030000000000;
const VIEW_FIELDS = Object.freeze(["structureId", "tag", "typeId", "systemId", "ownerCorpId", "allianceId", "state",
  "stateEndsAt", "upkeepState", "hasQuantumCore", "docking", "tethering", "destroyedAt", "modDestroyed", "position", "name"]);

const clone = (v) => JSON.parse(JSON.stringify(v));
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: REASONS.INVALID_INPUT, detail });

function createFakeStructureSeam(opts = {}) {
  const options = {
    knownTypes: new Set(opts.knownTypes || [35832]),
    anchors: opts.anchors || {},
    throwOn: new Set(opts.throwOn || []),
    flushFails: opts.flushFails === true,
    loseUnflushed: opts.loseUnflushed !== false,
    notEmpty: new Set(opts.notEmpty || []),
    invalidPosition: typeof opts.invalidPosition === "function" ? opts.invalidPosition : () => false,
    unavailable: opts.unavailable === true,
    createRefusal: typeof opts.createRefusal === "string" ? opts.createRefusal : null,
    markFailed: opts.markFailed === true,
    states: opts.states || DEFAULT_STATES,
  };
  let live = new Map();
  let durable = new Map();
  let nextId = FIRST_ID;
  let evacuated = 0;
  const subscribers = new Set();
  const calls = Object.fromEntries([...SEAM_METHODS, ...FC_SEAM_METHODS].map((m) => [m, 0]));

  const matches = (s, t) => s.tag && s.tag.stationId === t.stationId && s.tag.world === t.world;
  const fcMatches = (s, t) => s.fcTag && s.fcTag.fcKey === t.fcKey && s.fcTag.world === t.world;
  const fcView = (s) => Object.freeze({ ...view(s), tag: s.fcTag ? clone(s.fcTag) : null });
  function fcOwn(id, tag) {
    const s = live.get(id);
    if (!s) return { ok: false, reason: REASONS.NOT_FOUND };
    if (!fcMatches(s, tag)) return { ok: false, reason: REASONS.TAG_MISMATCH };
    return { ok: true, s };
  }
  const view = (s) => Object.freeze(Object.fromEntries(VIEW_FIELDS.map((k) => [k, clone(s[k] === undefined
    ? null : s[k])])));
  const notify = (ids) => {
    for (const fn of [...subscribers]) {
      try { fn({ stationIds: [...ids].sort() }); } catch (err) {}
    }
  };

  function enter(method) {
    calls[method] += 1;
    if (options.unavailable) return { ok: false, reason: REASONS.UNAVAILABLE, detail: "fake" };
    if (options.throwOn.has(method)) return { ok: false, reason: REASONS.SEAM_ERROR, detail: "injected" };
    return null;
  }

  function own(id, tag) {
    const s = live.get(id);
    if (!s) return { ok: false, reason: REASONS.NOT_FOUND };
    if (!matches(s, tag)) return { ok: false, reason: REASONS.TAG_MISMATCH };
    return { ok: true, s };
  }

  const seam = {
    checkStructureSeams() { return enter("checkStructureSeams") || { ok: true }; },
    readStructureStates() {
      return enter("readStructureStates") || { ok: true, states: options.states, upkeep: DEFAULT_UPKEEP };
    },
    listTaggedStructures() {
      return enter("listTaggedStructures") || { ok: true, rows: [...live.values()].filter((s) => s.tag).map(view) };
    },
    getStructure(id) {
      const e = enter("getStructure");
      if (e) return e;
      if (!isId(id)) return invalid("structureId");
      return { ok: true, row: live.has(id) ? view(live.get(id)) : null };
    },
    isStructureTypeKnown(typeId) {
      const e = enter("isStructureTypeKnown");
      if (e) return e;
      if (!isId(typeId)) return invalid("typeId");
      return { ok: true, known: options.knownTypes.has(typeId) };
    },
    listPlacementAnchors(systemId) {
      const e = enter("listPlacementAnchors");
      if (e) return e;
      if (!isId(systemId)) return invalid("systemId");
      return { ok: true, anchors: clone(options.anchors[systemId] || []) };
    },
    validatePlacement(input) {
      const e = enter("validatePlacement");
      if (e) return e;
      const { systemId, typeId, position } = input || {};
      if (!isId(systemId) || !isId(typeId) || !isVector(position)) return invalid("placement");
      return options.invalidPosition(input) ? { ok: true, valid: false, conflict: "DEPLOYMENT_CONFLICT:fake" }
        : { ok: true, valid: true };
    },
    createTaggedStructure(input) {
      const e = enter("createTaggedStructure");
      if (e) return e;
      if (!input || !isTag(input.tag)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      const bad = validCreateInput(input);
      if (bad !== null) return invalid(bad);
      if (!options.knownTypes.has(input.typeId)) return { ok: false, reason: REASONS.TYPE_UNKNOWN };
      const existing = [...live.values()].find((s) => s.destroyedAt === null && matches(s, input.tag));
      if (existing) return { ok: false, reason: REASONS.ALREADY_TAGGED, structureId: existing.structureId };
      if (options.createRefusal !== null) return { ok: false, reason: options.createRefusal, detail: "injected" };
      const structureId = nextId;
      nextId += 1;
      live.set(structureId, { structureId, tag: { ...input.tag }, typeId: input.typeId, systemId: input.systemId,
        ownerCorpId: input.ownerCorpId, allianceId: null, state: input.state, stateEndsAt: input.stateEndsAt,
        upkeepState: DEFAULT_UPKEEP.FULL_POWER, hasQuantumCore: input.quantumCore, docking: input.docking,
        tethering: "none",
        destroyedAt: null, modDestroyed: false, position: { ...input.position }, name: input.name || "Astrahus",
        condition: clone(input.condition), stateStartedAt: input.at });
      return { ok: true, structureId };
    },
    updateTaggedStructure(id, tag, patch) {
      const e = enter("updateTaggedStructure");
      if (e) return e;
      if (!isTag(tag)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      const bad = validPatch(patch);
      if (bad !== null) return invalid(bad);
      const o = own(id, tag);
      if (!o.ok) return o;
      if (o.s.destroyedAt !== null) return { ok: false, reason: REASONS.DESTROYED };
      const s = o.s;
      if ("state" in patch && patch.state !== s.state) { s.state = patch.state; s.stateStartedAt = patch.at; }
      if ("stateEndsAt" in patch) s.stateEndsAt = patch.stateEndsAt;
      if ("condition" in patch) s.condition = clone(patch.condition);
      if ("ownerCorpId" in patch) s.ownerCorpId = patch.ownerCorpId;
      if ("allianceId" in patch) s.allianceId = patch.allianceId;
      if ("upkeepState" in patch) s.upkeepState = patch.upkeepState;
      if ("docking" in patch) s.docking = patch.docking;
      if ("quantumCore" in patch) s.hasQuantumCore = patch.quantumCore;
      return { ok: true };
    },
    destroyTaggedStructure(id, tag, at) {
      const e = enter("destroyTaggedStructure");
      if (e) return e;
      if (!isTag(tag, true)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      if (!isTime(at)) return invalid("at");
      const o = own(id, tag);
      if (!o.ok) return o;
      if (o.s.destroyedAt !== null) return { ok: true, alreadyDestroyed: true };
      o.s.destroyedAt = at;
      if (options.markFailed) return { ok: true, alreadyDestroyed: false, markFailed: true };
      o.s.modDestroyed = true;
      return { ok: true, alreadyDestroyed: false };
    },
    removeTaggedStructure(id, tag) {
      const e = enter("removeTaggedStructure");
      if (e) return e;
      if (!isTag(tag, true)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      const o = own(id, tag);
      if (!o.ok) return o;
      if (options.notEmpty.has(id)) {
        evacuated += 1;
        return { ok: false, reason: REASONS.NOT_EMPTY };
      }
      live.delete(id);
      return { ok: true };
    },
    flushStructures() {
      calls.flushStructures += 1;
      if (options.unavailable || options.flushFails || options.throwOn.has("flushStructures")) {
        return { ok: false, reason: REASONS.FLUSH_FAILED, ambiguous: true, detail: "injected" };
      }
      durable = new Map([...live].map(([k, v]) => [k, clone(v)]));
      return { ok: true };
    },
    subscribeStructureChanges(fn) {
      if (typeof fn !== "function") return invalid("listener");
      const e = enter("subscribeStructureChanges");
      if (e) return e;
      const entry = (evt) => fn(evt);
      subscribers.add(entry);
      let active = true;
      return { ok: true, unsubscribe() {
        if (!active) return;
        active = false;
        subscribers.delete(entry);
      } };
    },
    listFcTaggedStructures() {
      return enter("listFcTaggedStructures") || { ok: true,
        rows: [...live.values()].filter((s) => s.fcTag).map(fcView) };
    },
    getFcStructure(id) {
      const e = enter("getFcStructure");
      if (e) return e;
      if (!isId(id)) return invalid("structureId");
      return { ok: true, row: live.has(id) ? fcView(live.get(id)) : null };
    },
    createFcTaggedStructure(input) {
      const e = enter("createFcTaggedStructure");
      if (e) return e;
      if (!input || !isFcTag(input.tag)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      const bad = validCreateInput(input);
      if (bad !== null) return invalid(bad);
      if (!options.knownTypes.has(input.typeId)) return { ok: false, reason: REASONS.TYPE_UNKNOWN };
      const existing = [...live.values()].find((s) => s.destroyedAt === null && fcMatches(s, input.tag));
      if (existing) return { ok: false, reason: REASONS.ALREADY_TAGGED, structureId: existing.structureId };
      if (options.createRefusal !== null) return { ok: false, reason: options.createRefusal, detail: "injected" };
      const structureId = nextId;
      nextId += 1;
      live.set(structureId, { structureId, tag: null, fcTag: { ...input.tag }, typeId: input.typeId,
        systemId: input.systemId, ownerCorpId: input.ownerCorpId, allianceId: null, state: input.state,
        stateEndsAt: input.stateEndsAt, upkeepState: DEFAULT_UPKEEP.FULL_POWER, hasQuantumCore: input.quantumCore,
        docking: input.docking, tethering: "none", destroyedAt: null, modDestroyed: false,
        position: { ...input.position }, name: input.name || "Astrahus", condition: clone(input.condition),
        stateStartedAt: input.at });
      return { ok: true, structureId };
    },
    updateFcTaggedStructure(id, tag, patch) {
      const e = enter("updateFcTaggedStructure");
      if (e) return e;
      if (!isFcTag(tag)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      const bad = validPatch(patch);
      if (bad !== null) return invalid(bad);
      const o = fcOwn(id, tag);
      if (!o.ok) return o;
      if (o.s.destroyedAt !== null) return { ok: false, reason: REASONS.DESTROYED };
      const s = o.s;
      if ("state" in patch && patch.state !== s.state) { s.state = patch.state; s.stateStartedAt = patch.at; }
      if ("stateEndsAt" in patch) s.stateEndsAt = patch.stateEndsAt;
      if ("condition" in patch) s.condition = clone(patch.condition);
      if ("ownerCorpId" in patch) s.ownerCorpId = patch.ownerCorpId;
      if ("upkeepState" in patch) s.upkeepState = patch.upkeepState;
      if ("docking" in patch) s.docking = patch.docking;
      if ("quantumCore" in patch) s.hasQuantumCore = patch.quantumCore;
      return { ok: true };
    },
    destroyFcTaggedStructure(id, tag, at) {
      const e = enter("destroyFcTaggedStructure");
      if (e) return e;
      if (!isFcTag(tag, true)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      if (!isTime(at)) return invalid("at");
      const o = fcOwn(id, tag);
      if (!o.ok) return o;
      if (o.s.destroyedAt !== null) return { ok: true, alreadyDestroyed: true };
      o.s.destroyedAt = at;
      o.s.modDestroyed = true;
      return { ok: true, alreadyDestroyed: false };
    },
    removeFcTaggedStructure(id, tag) {
      const e = enter("removeFcTaggedStructure");
      if (e) return e;
      if (!isFcTag(tag, true)) return { ok: false, reason: REASONS.TAG_REQUIRED };
      if (!isId(id)) return invalid("structureId");
      const o = fcOwn(id, tag);
      if (!o.ok) return o;
      if (options.notEmpty.has(id)) {
        evacuated += 1;
        return { ok: false, reason: REASONS.NOT_EMPTY };
      }
      live.delete(id);
      return { ok: true };
    },
  };

  return {
    seam: Object.freeze(seam),
    options,
    calls,
    rows: () => [...live.values()].map((s) => clone(view(s))),
    fcRows: () => [...live.values()].filter((s) => s.fcTag).map((s) => clone(fcView(s))),
    patch(id, patch) {
      const s = live.get(id);
      if (!s) return false;
      Object.assign(s, clone(patch));
      return true;
    },
    drop: (id) => live.delete(id),
    evacuated: () => evacuated,
    seed(row) {
      const structureId = row.structureId || nextId;
      nextId = Math.max(nextId, structureId + 1);
      const s = { allianceId: null, upkeepState: DEFAULT_UPKEEP.FULL_POWER, hasQuantumCore: false, docking: "public",
        tethering: "none",
        destroyedAt: null, modDestroyed: false, position: { x: 0, y: 0, z: 0 }, name: "Astrahus", ...clone(row),
        structureId };
      live.set(structureId, s);
      durable.set(structureId, clone(s));
      return structureId;
    },
    foreignChange(id, patch) {
      const s = live.get(id);
      if (!s) return false;
      Object.assign(s, clone(patch));
      if (s.tag) notify([s.tag.stationId]);
      return true;
    },
    restart(restartOpts = {}) {
      const lose = typeof restartOpts.loseUnflushed === "boolean" ? restartOpts.loseUnflushed : options.loseUnflushed;
      if (lose) live = new Map([...durable].map(([k, v]) => [k, clone(v)]));
      subscribers.clear();
    },
    subscriberCount: () => subscribers.size,
  };
}

module.exports = { createFakeStructureSeam, DEFAULT_STATES, DEFAULT_UPKEEP, VIEW_FIELDS };
