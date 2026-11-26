"use strict";

const { FACTION_REGISTRY_VERSION, FACTIONS_V1 } = require("./data/factions");
const { DOCTRINES_VERSION, DOCTRINES_V1, OWN_SPACE_SEC_CLASSES, OWN_SPACE_SOVEREIGNTY, BORDER_REACH_KEYS,
  CAPTURE_TARGETS, TARGET_SEC_CLASSES, DEFAULT_TARGET_SEC_CLASSES } = require("./data/doctrines");
const { CAMPAIGNS_VERSION, CAMPAIGNS_V1 } = require("./data/campaigns");
const { FACTION_CATALOG_VERSION, FACTION_CATALOG } = require("./data/factionCatalog");
const { MAX_GROUPS_PER_TAKE } = require("./reviewRows");
const { strengthOf } = require("./ai/strength");

const FACTION_KINDS = Object.freeze(["pirate", "empire", "police", "neutral", "invader", "hive"]);
const ACTIVE_KINDS = Object.freeze(["pirate", "empire", "police", "invader", "hive", "neutral"]);
const STATIONLESS_KINDS = Object.freeze(["invader", "hive"]);
const FLAGS = Object.freeze(["hive", "drifters"]);
const ACTIVITIES = Object.freeze(["active", "passive"]);
const ACTIVE = "active";
const PASSIVE = "passive";
const REGISTRY_ACTIVE = "registry";
const STATION_KINDS = Object.freeze(["npc", "upwell"]);
const STATION_ROLE = "station";
const STRUCTURE_FAMILIES = Object.freeze(["astrahus", "fortizar", "keepstar"]);
const MAX_FRONTS = 16;
const CAMPAIGN_ID_RE = /^[a-z0-9-]{1,32}$/;
const RESERVED_CAMPAIGN_IDS = Object.freeze(["none"]);
const DOCTRINE_ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_ORIGIN_LENGTH = 1000;
const MAX_LIST = 1000;
const BATTLESHIP_DOCTRINE_MODES = Object.freeze(["off", "stock", "on"]);
const BATTLESHIP_GROUP = "battleship";

const REGISTRY_DATA_V1 = Object.freeze({
  versions: Object.freeze({ factions: FACTION_REGISTRY_VERSION, doctrines: DOCTRINES_VERSION,
    campaigns: CAMPAIGNS_VERSION, catalog: FACTION_CATALOG_VERSION }),
  factions: FACTIONS_V1,
  doctrines: DOCTRINES_V1,
  campaigns: CAMPAIGNS_V1,
  catalog: FACTION_CATALOG,
});

class Invalid extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

const fail = (path) => {
  throw new Invalid(path);
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function id(v, path) {
  if (!isId(v)) fail(path);
}

function text(re) {
  return (v, path) => {
    if (typeof v !== "string" || !re.test(v)) fail(path);
  };
}

function oneOf(list) {
  return (v, path) => {
    if (!list.includes(v)) fail(path);
  };
}

function intRange(min, maxOf) {
  return (v, path, ctx) => {
    const max = typeof maxOf === "function" ? maxOf(ctx) : maxOf;
    if (!Number.isSafeInteger(v) || v < min || v > max) fail(path);
  };
}

function bool(v, path) {
  if (typeof v !== "boolean") fail(path);
}

function origin(v, path) {
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_ORIGIN_LENGTH) fail(path);
}

function list(item, { min = 0, unique = false } = {}) {
  return (v, path, ctx) => {
    if (!Array.isArray(v) || v.length < min || v.length > MAX_LIST) fail(path);
    v.forEach((x, i) => item(x, `${path}[${i}]`, ctx));
    if (unique && new Set(v).size !== v.length) fail(`${path}.duplicate`);
  };
}

function record(fields) {
  return (v, path, ctx) => {
    if (!isPlainObject(v)) fail(path);
    for (const key of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`${path}.${key}`);
    for (const [key, spec] of Object.entries(fields)) {
      if (v[key] === undefined) {
        if (spec.optional) continue;
        fail(`${path}.${key}`);
      }
      spec.check(v[key], `${path}.${key}`, ctx);
    }
  };
}

const req = (check) => Object.freeze({ check, optional: false });
const opt = (check) => Object.freeze({ check, optional: true });
const nullable = (check) => (v, path, ctx) => {
  if (v !== null) check(v, path, ctx);
};

const NPC_STATION_FIELDS = Object.freeze({
  kind: req(oneOf(["npc"])), stationId: req(id), systemId: req(id), corporationId: req(id),
});
const UPWELL_STATION_FIELDS = Object.freeze({
  kind: req(oneOf(["upwell"])), systemId: req(id), structureFamily: req(oneOf(STRUCTURE_FAMILIES)),
});

function station(v, path, ctx) {
  if (!isPlainObject(v) || !STATION_KINDS.includes(v.kind)) fail(`${path}.kind`);
  record(v.kind === "npc" ? NPC_STATION_FIELDS : UPWELL_STATION_FIELDS)(v, path, ctx);
}

function corporationRoles(v, path, ctx) {
  if (!isPlainObject(v)) fail(path);
  for (const [role, corporationId] of Object.entries(v)) {
    if (role !== STATION_ROLE && !ctx.fleetRoles.includes(role)) fail(`${path}.${role}`);
    id(corporationId, `${path}.${role}`);
  }
}

const FACTION_FIELDS = Object.freeze({
  factionId: req(id),
  kind: req(oneOf(FACTION_KINDS)),
  activity: opt(oneOf(ACTIVITIES)),
  ownerCorporationId: opt(nullable(id)),
  hqSystemId: opt(nullable(id)),
  homeRegionIds: opt(list(id, { min: 0, unique: true })),
  doctrineId: opt(text(DOCTRINE_ID_RE)),
  maxActiveFronts: opt(intRange(0, MAX_FRONTS)),
  initialResourceUnits: opt(intRange(0, (ctx) => ctx.maxResourceUnits)),
  initialReserveUnits: opt(intRange(0, (ctx) => ctx.maxResourceUnits)),
  allies: opt(list(id, { unique: true })),
  startStations: opt(list(station)),
  corporationRoles: opt(corporationRoles),
  tributeTo: opt(id),
  requiresFlag: opt(oneOf(FLAGS)),
  origin: req(origin),
});
const ACTIVE_REQUIRED = Object.freeze(["ownerCorporationId", "hqSystemId", "homeRegionIds", "doctrineId",
  "maxActiveFronts", "initialResourceUnits", "initialReserveUnits", "allies", "startStations"]);

const activityOf = (f) => (f.activity === undefined ? ACTIVE : f.activity);

function factionInvariants(f, path) {
  if (activityOf(f) === ACTIVE) {
    if (STATIONLESS_KINDS.includes(f.kind)) {
      if (f.startStations === undefined || f.startStations.length !== 0) fail(`${path}.startStations`);
      if (f.ownerCorporationId !== undefined && f.ownerCorporationId !== null && !isId(f.ownerCorporationId)) fail(`${path}.ownerCorporationId`);
      if (f.hqSystemId !== undefined && f.hqSystemId !== null && !isId(f.hqSystemId)) fail(`${path}.hqSystemId`);
      if (f.homeRegionIds !== undefined && !Array.isArray(f.homeRegionIds)) fail(`${path}.homeRegionIds`);
      if (f.doctrineId === undefined) fail(`${path}.doctrineId`);
      if (f.maxActiveFronts === undefined) fail(`${path}.maxActiveFronts`);
      if (f.initialResourceUnits === undefined) fail(`${path}.initialResourceUnits`);
      if (f.initialReserveUnits === undefined) fail(`${path}.initialReserveUnits`);
      if (f.allies === undefined) fail(`${path}.allies`);
    } else {
      for (const key of ACTIVE_REQUIRED) if (f[key] === undefined) fail(`${path}.${key}`);
    }
    if (!ACTIVE_KINDS.includes(f.kind)) fail(`${path}.kind`);
    return;
  }
  if (f.doctrineId !== undefined) fail(`${path}.doctrineId`);
  if (f.startStations !== undefined && f.startStations.length > 0) fail(`${path}.startStations`);
  if (f.maxActiveFronts !== undefined && f.maxActiveFronts > 0) fail(`${path}.maxActiveFronts`);
}

function builtFaction(f, catalogEntry) {
  if (activityOf(f) === ACTIVE) return clone({ ...f, activity: ACTIVE });
  const or = (v, fallback) => (v === undefined ? fallback : v);
  return clone({
    factionId: f.factionId, kind: f.kind, activity: PASSIVE,
    ownerCorporationId: or(f.ownerCorporationId, null),
    hqSystemId: or(f.hqSystemId, catalogEntry && catalogEntry.sdeHqSystemId ? catalogEntry.sdeHqSystemId : null),
    homeRegionIds: or(f.homeRegionIds, []), doctrineId: null, maxActiveFronts: 0,
    initialResourceUnits: or(f.initialResourceUnits, 0), initialReserveUnits: or(f.initialReserveUnits, 0),
    allies: or(f.allies, []), startStations: [],
    ...(f.corporationRoles === undefined ? {} : { corporationRoles: f.corporationRoles }),
    ...(f.tributeTo === undefined ? {} : { tributeTo: f.tributeTo }), origin: f.origin,
  });
}

function tributeInvariants(f, at, factions) {
  if (f.tributeTo === undefined) return;
  const path = `${at}.tributeTo`;
  if (f.tributeTo === f.factionId) fail(path);
  const receiver = factions.get(f.tributeTo);
  if (!receiver || activityOf(receiver) !== ACTIVE) fail(path);
  if (!Array.isArray(receiver.startStations) || receiver.startStations.length < 1) fail(path);
  if (!Array.isArray(receiver.allies) || !receiver.allies.includes(f.factionId)) fail(path);
}

function compositionEntry(v, path, ctx) {
  record({ hullGroup: req(oneOf(ctx.hullGroups)), count: req(intRange(1, Number.MAX_SAFE_INTEGER)) })(v, path, ctx);
}

function templates(v, path, ctx) {
  if (!isPlainObject(v)) fail(path);
  for (const [role, entries] of Object.entries(v)) {
    const at = `${path}.${role}`;
    if (!ctx.fleetRoles.includes(role)) fail(at);
    list(compositionEntry, { min: 1 })(entries, at, ctx);
    if (entries.length > ctx.maxCompositionEntries) fail(`${at}.length`);
    if (entries.reduce((sum, e) => sum + e.count, 0) > ctx.maxShipsPerFleet) fail(`${at}.ships`);
    if (new Set(entries.map((e) => e.hullGroup)).size > MAX_GROUPS_PER_TAKE - 1) fail(`${at}.groups`);
  }
}

const DOCTRINE_FIELDS = Object.freeze({
  doctrineId: req(text(DOCTRINE_ID_RE)),
  kind: req(oneOf(ACTIVE_KINDS)),
  canOccupy: req(bool),
  expandsBeyondTheatre: req(bool),
  operationTypes: req(list((v, p, ctx) => oneOf(ctx.operationTypes)(v, p), { min: 1, unique: true })),
  reachJumps: req(intRange(0, Number.MAX_SAFE_INTEGER)),
  templates: req(templates),
  origin: req(origin),
  ownSpace: opt(nullable(record({
    secClasses: req(list(oneOf(OWN_SPACE_SEC_CLASSES), { min: 1, unique: true })),
    sovereignty: req(oneOf(OWN_SPACE_SOVEREIGNTY)),
  }))),
  borderReachKey: opt(nullable(oneOf(BORDER_REACH_KEYS))),
  borderTargets: opt(bool),
  borderCaptures: opt(bool),
  captureTargets: opt(list(oneOf(CAPTURE_TARGETS), { unique: true })),
  targetSecClasses: opt(list(oneOf(TARGET_SEC_CLASSES), { min: 1, unique: true })),
  confinedToBelt: opt(bool),
  hullsRequired: opt(bool),
  returnToBase: opt(bool),
  buildsStations: opt(bool),
  capturesStations: opt(bool),
  consolidates: opt(bool),
  ownSpaceMaxJumps: opt(intRange(0, Number.MAX_SAFE_INTEGER)),
  fieldsHunters: opt(bool),
  hunterTemplate: opt(list(compositionEntry, { min: 0 })),
  hunterComposition: opt(list(compositionEntry, { min: 0 })),
  fieldsDefense: opt(bool),
  hoardCapped: opt(bool),
  raidsBeyondTheatre: opt(bool),
  hive: opt(bool),
  battleshipTemplates: opt(templates),
  calibratedBattleshipTemplates: opt(templates),
});

function withDoctrineDefaults(d) {
  return {
    ...d,
    ownSpace: d.ownSpace === undefined ? null : d.ownSpace,
    borderReachKey: d.borderReachKey === undefined ? null : d.borderReachKey,
    borderTargets: d.borderTargets === undefined ? false : d.borderTargets,
    borderCaptures: d.borderCaptures === undefined ? false : d.borderCaptures,
    captureTargets: d.captureTargets === undefined ? (d.canOccupy === true ? [...CAPTURE_TARGETS] : [])
      : d.captureTargets,
    targetSecClasses: d.targetSecClasses === undefined ? [...DEFAULT_TARGET_SEC_CLASSES] : d.targetSecClasses,
    confinedToBelt: d.confinedToBelt === undefined ? false : d.confinedToBelt,
    hullsRequired: d.hullsRequired === undefined ? true : d.hullsRequired,
    returnToBase: d.returnToBase === undefined ? false : d.returnToBase,
    buildsStations: d.buildsStations === undefined ? true : d.buildsStations,
    capturesStations: d.capturesStations === undefined ? true : d.capturesStations,
    consolidates: d.consolidates === undefined ? true : d.consolidates,
    ownSpaceMaxJumps: d.ownSpaceMaxJumps === undefined ? null : d.ownSpaceMaxJumps,
    fieldsHunters: d.fieldsHunters === undefined ? false : d.fieldsHunters,
    hunterTemplate: d.hunterTemplate === undefined ? [] : d.hunterTemplate,
    hunterComposition: d.hunterComposition === undefined ? [] : d.hunterComposition,
    fieldsDefense: d.fieldsDefense === undefined ? (d.kind === "pirate" || d.kind === "empire") : d.fieldsDefense,
    hoardCapped: d.hoardCapped === undefined ? false : d.hoardCapped,
    raidsBeyondTheatre: d.raidsBeyondTheatre === undefined ? false : d.raidsBeyondTheatre,
    hive: d.hive === undefined ? false : d.hive,
    stockTemplates: d.stockTemplates === undefined ? d.templates : d.stockTemplates,
  };
}

function withBattleshipMode(d, mode, cal) {
  const calOverlay = cal === true && d.calibratedBattleshipTemplates !== undefined ? d.calibratedBattleshipTemplates
    : null;
  if (d.battleshipTemplates === undefined && calOverlay === null) return d;
  const merged = { ...d.templates, ...(d.battleshipTemplates || {}), ...(calOverlay || {}) };
  return { ...d, templates: mode === "on" ? merged : d.templates, stockTemplates: mode === "off" ? d.templates : merged };
}

function calibratedOverlayFits(d, powerTable) {
  if (!isPlainObject(powerTable)) return false;
  return Object.entries(d.calibratedBattleshipTemplates)
    .every(([role, entries]) => strengthOf(entries, powerTable) <= strengthOf(d.templates[role], powerTable));
}

function doctrineInvariants(d, path) {
  if (d.borderTargets === true || d.borderCaptures === true) {
    if (d.ownSpace === null) fail(`${path}.ownSpace`);
    if (d.borderReachKey === null) fail(`${path}.borderReachKey`);
  }
  if (d.borderCaptures === true && d.canOccupy !== true) fail(`${path}.borderCaptures`);
  if (d.captureTargets.length > 0 && d.canOccupy !== true) fail(`${path}.captureTargets`);
  if (d.kind === "police") {
    if (d.canOccupy === true) fail(`${path}.canOccupy`);
    if (d.captureTargets.length > 0) fail(`${path}.captureTargets`);
    if (d.borderCaptures === true) fail(`${path}.borderCaptures`);
    if (d.confinedToBelt !== true) fail(`${path}.confinedToBelt`);
  }
  if (d.kind === "invader" || d.kind === "police") {
    if (d.hoardCapped !== false) fail(`${path}.hoardCapped`);
    if (d.raidsBeyondTheatre !== false) fail(`${path}.raidsBeyondTheatre`);
  }
  if (d.kind === "invader") {
    if (d.buildsStations !== false) fail(`${path}.buildsStations`);
    if (d.capturesStations !== false) fail(`${path}.capturesStations`);
    if (d.borderTargets !== false) fail(`${path}.borderTargets`);
    if (d.borderCaptures !== false) fail(`${path}.borderCaptures`);
    if (d.ownSpace !== null) fail(`${path}.ownSpace`);
    if (d.returnToBase !== false) fail(`${path}.returnToBase`);
    if (d.confinedToBelt !== false) fail(`${path}.confinedToBelt`);
  }
  if (d.kind === "hive") {
    if (d.hive !== true) fail(`${path}.hive`);
    if (d.buildsStations !== false) fail(`${path}.buildsStations`);
    if (d.capturesStations !== false) fail(`${path}.capturesStations`);
    if (d.ownSpace !== null) fail(`${path}.ownSpace`);
    if (d.borderTargets !== false) fail(`${path}.borderTargets`);
    if (d.borderCaptures !== false) fail(`${path}.borderCaptures`);
    if (d.confinedToBelt !== false) fail(`${path}.confinedToBelt`);
    if (d.hullsRequired !== false) fail(`${path}.hullsRequired`);
    if (d.returnToBase !== true) fail(`${path}.returnToBase`);
    if (d.captureTargets.length !== 1 || d.captureTargets[0] !== "home") fail(`${path}.captureTargets`);
  } else if (d.hive === true) fail(`${path}.hive`);
  for (const field of ["battleshipTemplates", "calibratedBattleshipTemplates"]) {
    if (d[field] === undefined) continue;
    for (const [role, entries] of Object.entries(d[field])) {
      const at = `${path}.${field}.${role}`;
      if (!Object.prototype.hasOwnProperty.call(d.templates, role)) fail(at);
      if (!entries.some((e) => e.hullGroup === BATTLESHIP_GROUP)) fail(at);
    }
  }
}

const DEFENDER_FIELDS = Object.freeze({ factionId: req(id), stagingSystemId: req(id), entrySystemId: req(id) });

const CAMPAIGN_FIELDS = Object.freeze({
  campaignId: req(text(CAMPAIGN_ID_RE)),
  regionId: req(id),
  ownerFactionId: req(id),
  baseSystemId: req(id),
  constellationIds: req(list(id, { min: 1, unique: true })),
  systemIds: req((v, path, ctx) => {
    list(id, { min: 1, unique: true })(v, path, ctx);
    if (v.length > ctx.maxCampaignSystems) fail(`${path}.length`);
  }),
  defenders: req(list(record(DEFENDER_FIELDS))),
  origin: req(origin),
});

function validateCtx(ctx) {
  if (!isPlainObject(ctx)) return "ctx";
  for (const name of ["hullGroups", "fleetRoles", "operationTypes"]) {
    if (!Array.isArray(ctx[name]) || ctx[name].length === 0) return `ctx.${name}`;
  }
  if (typeof ctx.hostility !== "function") return "ctx.hostility";
  for (const name of ["maxFactions", "maxCampaignSystems", "maxShipsPerFleet", "maxCompositionEntries",
    "maxResourceUnits"]) {
    if (!isId(ctx[name])) return `ctx.${name}`;
  }
  if (ctx.activeCampaignIds !== undefined && !Array.isArray(ctx.activeCampaignIds)) return "ctx.activeCampaignIds";
  if (ctx.activeFactionIds !== undefined && ctx.activeFactionIds !== REGISTRY_ACTIVE
    && !Array.isArray(ctx.activeFactionIds)) return "ctx.activeFactionIds";
  if (ctx.enabledFlags !== undefined && (!Array.isArray(ctx.enabledFlags)
    || !ctx.enabledFlags.every((x) => FLAGS.includes(x)))) return "ctx.enabledFlags";
  if (ctx.battleshipDoctrines !== undefined && !BATTLESHIP_DOCTRINE_MODES.includes(ctx.battleshipDoctrines)) {
    return "ctx.battleshipDoctrines";
  }
  if (ctx.battleshipPowerCalibrated !== undefined && typeof ctx.battleshipPowerCalibrated !== "boolean") {
    return "ctx.battleshipPowerCalibrated";
  }
  if (ctx.powerTable !== undefined && !isPlainObject(ctx.powerTable)) return "ctx.powerTable";
  return null;
}

function indexBy(entries, key, path) {
  const map = new Map();
  entries.forEach((e, i) => {
    if (map.has(e[key])) fail(`${path}[${i}].${key}`);
    map.set(e[key], e);
  });
  return map;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function build(data, ctx) {
  if (!isPlainObject(data)) fail("data");
  const versions = data.versions;
  record({ factions: req(intRange(1, Number.MAX_SAFE_INTEGER)), doctrines: req(intRange(1, Number.MAX_SAFE_INTEGER)),
    campaigns: req(intRange(1, Number.MAX_SAFE_INTEGER)), catalog: opt(intRange(1, Number.MAX_SAFE_INTEGER)) })(
    versions, "versions", ctx);
  for (const name of ["factions", "doctrines", "campaigns"]) if (!Array.isArray(data[name])) fail(name);
  if (data.factions.length > ctx.maxFactions) fail("factions.length");
  data.factions.forEach((f, i) => {
    record(FACTION_FIELDS)(f, `factions[${i}]`, ctx);
    factionInvariants(f, `factions[${i}]`);
  });
  const catalog = data.catalog === undefined ? null : catalogIndex(data.catalog, versions);
  data.doctrines.forEach((d, i) => {
    record(DOCTRINE_FIELDS)(d, `doctrines[${i}]`, ctx);
    doctrineInvariants(withDoctrineDefaults(d), `doctrines[${i}]`);
  });
  data.campaigns.forEach((c, i) => record(CAMPAIGN_FIELDS)(c, `campaigns[${i}]`, ctx));
  const factions = indexBy(data.factions, "factionId", "factions");
  const doctrines = indexBy(data.doctrines, "doctrineId", "doctrines");
  const campaigns = indexBy(data.campaigns, "campaignId", "campaigns");

  const stationIds = new Set();
  data.factions.forEach((f, i) => {
    const at = `factions[${i}]`;
    if (activityOf(f) === ACTIVE) {
      const doctrine = doctrines.get(f.doctrineId);
      if (!doctrine || doctrine.kind !== f.kind) fail(`${at}.doctrineId`);
    }
    (f.allies || []).forEach((ally, j) => {
      if (ally === f.factionId || ctx.hostility(f.factionId, ally) !== false) fail(`${at}.allies[${j}]`);
    });
    (f.startStations || []).forEach((s, j) => {
      if (s.kind !== "npc") return;
      if (stationIds.has(s.stationId)) fail(`${at}.startStations[${j}].stationId`);
      stationIds.add(s.stationId);
    });
    tributeInvariants(f, at, factions);
    if (catalog !== null) crossCheck(f, at, catalog);
  });

  const active = ctx.activeCampaignIds === undefined ? [...campaigns.keys()] : ctx.activeCampaignIds;
  data.campaigns.forEach((c, i) => {
    const at = `campaigns[${i}]`;
    if (RESERVED_CAMPAIGN_IDS.includes(c.campaignId)) fail(`${at}.campaignId`);
    if (!factions.has(c.ownerFactionId)) fail(`${at}.ownerFactionId`);
    if (!c.systemIds.includes(c.baseSystemId)) fail(`${at}.baseSystemId`);
    c.defenders.forEach((d, j) => {
      if (!factions.has(d.factionId) || d.factionId === c.ownerFactionId) fail(`${at}.defenders[${j}].factionId`);
      if (!c.systemIds.includes(d.entrySystemId)) fail(`${at}.defenders[${j}].entrySystemId`);
    });
    if (!active.includes(c.campaignId)) return;
    for (const factionId of [c.ownerFactionId, ...c.defenders.map((d) => d.factionId)]) {
      if ((factions.get(factionId).startStations || []).length === 0) {
        fail(`factions[${data.factions.indexOf(factions.get(factionId))}].startStations`);
      }
    }
  });

  const sortedFactions = deepFreeze([...data.factions].sort((a, b) => a.factionId - b.factionId)
    .map((f) => builtFaction(f, catalog === null ? null : catalog.byFaction.get(f.factionId))));
  const factionById = new Map(sortedFactions.map((f) => [f.factionId, f]));
  const activeIds = activeSet(sortedFactions, factionById, ctx.activeFactionIds,
    ctx.enabledFlags === undefined ? [] : ctx.enabledFlags);
  const activeFactions = Object.freeze(sortedFactions.filter((f) => activeIds.has(f.factionId)));
  const battleshipMode = ctx.battleshipDoctrines === undefined ? "off" : ctx.battleshipDoctrines;
  const calibrated = ctx.battleshipPowerCalibrated === true && battleshipMode !== "off";
  const garrisonApplied = [];
  const garrisonDropped = [];
  const doctrineById = new Map([...doctrines].map(([k, v]) => {
    let cal = false;
    if (calibrated && v.calibratedBattleshipTemplates !== undefined) {
      cal = calibratedOverlayFits(v, ctx.powerTable);
      (cal ? garrisonApplied : garrisonDropped).push(k);
    }
    return [k, deepFreeze(clone(withDoctrineDefaults(withBattleshipMode(v, battleshipMode, cal))))];
  }));
  const battleshipGarrison = deepFreeze({ applied: garrisonApplied.sort(), dropped: garrisonDropped.sort() });
  const sortedCampaigns = deepFreeze([...data.campaigns].sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1))
    .map(clone));
  const campaignById = new Map(sortedCampaigns.map((c) => [c.campaignId, c]));
  const theatre = new Map(sortedCampaigns.map((c) => [c.campaignId, new Set(c.systemIds)]));
  const byFaction = new Map();
  for (const c of sortedCampaigns) {
    for (const factionId of new Set([c.ownerFactionId, ...c.defenders.map((d) => d.factionId)])) {
      if (!byFaction.has(factionId)) byFaction.set(factionId, []);
      byFaction.get(factionId).push(c);
    }
  }
  for (const [k, v] of byFaction) byFaction.set(k, Object.freeze(v));
  const EMPTY = Object.freeze([]);
  const tributeReceivers = new Set(sortedFactions
    .filter((f) => f.tributeTo !== undefined && activeIds.has(f.factionId) && activeIds.has(f.tributeTo))
    .map((f) => f.tributeTo));

  return Object.freeze({
    version: Object.freeze({ factions: versions.factions, doctrines: versions.doctrines,
      campaigns: versions.campaigns, catalog: catalog === null ? null : versions.catalog,
      activeCount: activeFactions.length }),
    battleshipGarrison,
    getFaction: (factionId) => factionById.get(Number(factionId)) || null,
    listFactions: () => sortedFactions,
    listActiveFactions: () => activeFactions,
    isActive: (factionId) => activeIds.has(Number(factionId)),
    getCorporation: (corporationId) => (catalog === null ? null
      : catalog.corporations.get(Number(corporationId)) || null),
    corporationFor: (factionId, role) => {
      const f = factionById.get(Number(factionId));
      if (!f) return null;
      const roles = f.corporationRoles;
      if (roles && typeof role === "string" && Object.prototype.hasOwnProperty.call(roles, role)) return roles[role];
      return f.ownerCorporationId === undefined ? null : f.ownerCorporationId;
    },
    tributeRecipientOf: (factionId) => {
      const f = factionById.get(Number(factionId));
      return f && f.tributeTo !== undefined ? f.tributeTo : null;
    },
    isTributeRecipient: (factionId) => tributeReceivers.has(Number(factionId)),
    getDoctrine: (doctrineId) => doctrineById.get(String(doctrineId)) || null,
    getCampaign: (campaignId) => campaignById.get(String(campaignId)) || null,
    listCampaigns: () => sortedCampaigns,
    getCampaignsForFaction: (factionId) => byFaction.get(Number(factionId)) || EMPTY,
    isTheatreSystem: (campaignId, systemId) => {
      const set = theatre.get(String(campaignId));
      return Boolean(set && set.has(Number(systemId)));
    },
  });
}

function catalogIndex(entries, versions) {
  if (!Array.isArray(entries)) fail("catalog");
  if (versions.catalog === undefined) fail("versions.catalog");
  const byFaction = new Map();
  const corporations = new Map();
  entries.forEach((e, i) => {
    if (!isPlainObject(e) || !isId(e.factionId) || byFaction.has(e.factionId)) fail(`catalog[${i}].factionId`);
    if (!Array.isArray(e.corporations) || !Array.isArray(e.stations)) fail(`catalog[${i}]`);
    byFaction.set(e.factionId, e);
    for (const c of e.corporations) {
      corporations.set(c.corporationId, Object.freeze({ corporationId: c.corporationId, factionId: e.factionId,
        name: c.name, ticker: c.ticker, ceoId: c.ceoId === undefined ? null : c.ceoId }));
    }
  });
  return { byFaction, corporations, stations: new Map() };
}

function crossCheck(f, at, catalog) {
  const entry = catalog.byFaction.get(f.factionId);
  if (!entry) fail(`${at}.factionId`);
  if (f.ownerCorporationId !== undefined && f.ownerCorporationId !== null) {
    const corp = catalog.corporations.get(f.ownerCorporationId);
    if (!corp || corp.factionId !== f.factionId) fail(`${at}.ownerCorporationId`);
  }
  for (const [role, corporationId] of Object.entries(f.corporationRoles || {})) {
    const corp = catalog.corporations.get(corporationId);
    if (!corp || corp.factionId !== f.factionId) fail(`${at}.corporationRoles.${role}`);
  }
  if (activityOf(f) === ACTIVE && !STATIONLESS_KINDS.includes(f.kind) && f.startStations.length === 0) {
    fail(`${at}.startStations`);
  }
  const npc = (f.startStations || []).filter((s) => s.kind === "npc");
  if (npc.length === 0) return;
  if (!catalog.stations.has(f.factionId)) {
    catalog.stations.set(f.factionId, new Map(entry.stations.map((row) => [row[0], row])));
  }
  const rows = catalog.stations.get(f.factionId);
  f.startStations.forEach((s, j) => {
    if (s.kind !== "npc") return;
    const row = rows.get(s.stationId);
    if (!row) fail(`${at}.startStations[${j}].stationId`);
    if (row[1] !== s.systemId) fail(`${at}.startStations[${j}].systemId`);
    if (row[2] !== s.corporationId) fail(`${at}.startStations[${j}].corporationId`);
  });
}

function activeSet(sortedFactions, factionById, wanted, enabledFlags) {
  const flagged = (f) => f.requiresFlag === undefined || enabledFlags.includes(f.requiresFlag);
  if (wanted === undefined || wanted === REGISTRY_ACTIVE) {
    return new Set(sortedFactions.filter((f) => f.activity === ACTIVE && flagged(f)).map((f) => f.factionId));
  }
  const out = new Set();
  wanted.forEach((factionId, i) => {
    const f = factionById.get(factionId);
    if (!f || f.activity !== ACTIVE || !flagged(f) || out.has(factionId)) fail(`ctx.activeFactionIds[${i}]`);
    out.add(factionId);
  });
  return out;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}

function createFactionRegistry(data, ctx) {
  try {
    const bad = validateCtx(ctx);
    if (bad !== null) return { ok: false, reason: "REGISTRY_INVALID", detail: bad };
    return { ok: true, registry: build(data, ctx) };
  } catch (err) {
    const detail = err instanceof Invalid ? err.detail : `internal: ${String((err && err.message) || err)}`;
    return { ok: false, reason: "REGISTRY_INVALID", detail };
  }
}

module.exports = {
  FACTION_KINDS,
  ACTIVE_KINDS,
  ACTIVITIES,
  STATION_KINDS,
  STRUCTURE_FAMILIES,
  MAX_FRONTS,
  CAMPAIGN_ID_RE,
  RESERVED_CAMPAIGN_IDS,
  REGISTRY_DATA_V1,
  BORDER_REACH_KEYS,
  CAPTURE_TARGETS,
  OWN_SPACE_SEC_CLASSES,
  TARGET_SEC_CLASSES,
  BATTLESHIP_DOCTRINE_MODES,
  createFactionRegistry,
};
