"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");
const { METHOD } = require("./method");

const SHIP_CATEGORY_ID = 6;

const fail = (reason, detail) => ({ ok: false, reason, detail });
const round = (value, digits) => Number(value.toFixed(digits));
const mean = (values) => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weaponLayout(hiSlots, turretSlots, launcherSlots) {
  if (turretSlots >= launcherSlots) {
    const turrets = Math.min(hiSlots, turretSlots);
    return { turrets, launchers: Math.min(hiSlots - turrets, launcherSlots) };
  }
  const launchers = Math.min(hiSlots, launcherSlots);
  return { turrets: Math.min(hiSlots - launchers, turretSlots), launchers };
}

function speedClassOf(velocity, bounds) {
  let cls = 1;
  for (const bound of bounds) if (velocity >= bound) cls += 1;
  return cls;
}

function referenceUnits(dogma, method, sizes) {
  const A = method.attributes;
  const attr = (typeId, id) => {
    const row = dogma[String(typeId)];
    return row && Number.isFinite(row[id]) ? row[id] : undefined;
  };
  const positive = (typeId, id, label) => {
    const value = attr(typeId, id);
    if (value === undefined || !(value > 0)) throw fail("REFERENCE_MISSING", `${label} type ${typeId} attribute ${id}`);
    return value;
  };
  const damageSum = (typeId, label, ids = A.damage) => {
    if (!dogma[String(typeId)]) throw fail("REFERENCE_MISSING", `${label} type ${typeId} not in dogma`);
    const sum = ids.reduce((s, id) => s + (attr(typeId, id) || 0), 0);
    if (!(sum > 0)) throw fail("REFERENCE_MISSING", `${label} type ${typeId} has no damage`);
    return sum;
  };
  const units = {};
  for (const size of sizes) {
    const ref = method.references[size];
    if (!ref) throw fail("REFERENCE_MISSING", `no references for weapon size ${size}`);
    const turretMult = positive(ref.turret, A.damageMultiplier, `size ${size} turret`);
    const turretCycle = positive(ref.turret, A.cycleMs, `size ${size} turret`) / 1000;
    const ammo = damageSum(ref.turretAmmo, `size ${size} ammo`);
    const launcherCycle = positive(ref.launcher, A.cycleMs, `size ${size} launcher`) / 1000;
    const missile = damageSum(ref.missile, `size ${size} missile`);
    const armorRep = positive(ref.armorRep, A.armorDamageAmount, `size ${size} armor rep`)
      / (positive(ref.armorRep, A.durationMs, `size ${size} armor rep`) / 1000);
    const shieldRep = positive(ref.shieldRep, A.shieldBonus, `size ${size} shield rep`)
      / (positive(ref.shieldRep, A.durationMs, `size ${size} shield rep`) / 1000);
    units[size] = {
      turretDps: (turretMult * ammo) / turretCycle,
      turretAlpha: turretMult * ammo,
      launcherDps: missile / launcherCycle,
      launcherAlpha: missile,
      remoteRep: mean([armorRep, shieldRep]),
    };
  }
  const perMbitDps = [];
  const perMbitAlpha = [];
  for (const drone of method.referenceDrones) {
    const volley = positive(drone, A.damageMultiplier, "drone") * damageSum(drone, "drone");
    const bandwidth = positive(drone, A.droneBandwidthUsed, "drone");
    perMbitDps.push(volley / (positive(drone, A.cycleMs, "drone") / 1000) / bandwidth);
    perMbitAlpha.push(volley / bandwidth);
  }
  units.drones = { dpsPerMbit: mean(perMbitDps), alphaPerMbit: mean(perMbitAlpha) };
  units.fighters = {};
  for (const [size, list] of Object.entries(method.referenceFighters || {})) {
    const volleys = [];
    const dps = [];
    const squadron = [];
    for (const fighter of list) {
      const label = `${size} fighter`;
      const volley = positive(fighter, A.fighterDamageMultiplier, label) * damageSum(fighter, label, A.fighterDamage);
      volleys.push(volley);
      dps.push(volley / (positive(fighter, A.fighterDurationMs, label) / 1000));
      squadron.push(positive(fighter, A.fighterSquadronMaxSize, label));
    }
    if (list.length === 0) throw fail("REFERENCE_MISSING", `no ${size} fighter references`);
    units.fighters[size] = { dpsPerSquadron: mean(dps) * mean(squadron), alphaPerSquadron: mean(volleys) * mean(squadron) };
  }
  return units;
}

function fighterSquadrons(hull) {
  if (!(hull.fighterTubes > 0)) return { heavy: 0, light: 0 };
  const heavy = Math.min(hull.fighterHeavySlots, hull.fighterTubes);
  return { heavy, light: Math.min(hull.fighterLightSlots, hull.fighterTubes - heavy) };
}

function hullValues(typeId, attrs, method) {
  const A = method.attributes;
  for (const id of method.requiredHullAttributes) {
    if (!Number.isFinite(attrs[id])) throw fail("ATTRIBUTE_MISSING", `type ${typeId} attribute ${id}`);
  }
  const qty = (id) => (Number.isFinite(attrs[id]) ? attrs[id] : 0);
  const resonance = (ids) => mean(ids.map((id) => (Number.isFinite(attrs[id]) ? attrs[id] : method.defaultResonance)));
  const layer = (hp, ids) => {
    const r = resonance(ids);
    return r > 0 ? hp / r : 0;
  };
  const recharge = qty(A.shieldRechargeRate);
  return {
    ehp: layer(attrs[A.shieldCapacity], A.shieldResonance) + layer(attrs[A.armorHP], A.armorResonance)
      + layer(attrs[A.hp], A.structureResonance),
    passiveRegen: recharge > 0 ? (method.shieldPeakRegenFactor * attrs[A.shieldCapacity]) / (recharge / 1000) : 0,
    hiSlots: attrs[A.hiSlots],
    turretSlots: qty(A.turretSlotsLeft),
    launcherSlots: qty(A.launcherSlotsLeft),
    droneBandwidth: qty(A.droneBandwidth),
    fighterTubes: qty(A.fighterTubes),
    fighterLightSlots: qty(A.fighterLightSlots),
    fighterHeavySlots: qty(A.fighterHeavySlots),
    signatureRadius: attrs[A.signatureRadius],
    maxVelocity: attrs[A.maxVelocity],
  };
}

function serialize(header, groups, types) {
  const out = [];
  out.push("\"use strict\";");
  out.push("");
  out.push("function deepFreeze(value) {");
  out.push("  if (value && typeof value === \"object\" && !Object.isFrozen(value)) {");
  out.push("    for (const key of Object.keys(value)) deepFreeze(value[key]);");
  out.push("    Object.freeze(value);");
  out.push("  }");
  out.push("  return value;");
  out.push("}");
  out.push("");
  out.push(`const HEADER = ${JSON.stringify(header, null, 2)};`);
  out.push("");
  out.push("const GROUPS = {");
  for (const [name, row] of Object.entries(groups)) out.push(`  ${JSON.stringify(name)}: ${JSON.stringify(row)},`);
  out.push("};");
  out.push("");
  out.push("const TYPES = {");
  for (const [key, row] of Object.entries(types)) out.push(`  ${JSON.stringify(key)}: ${JSON.stringify(row)},`);
  out.push("};");
  out.push("");
  out.push("module.exports = deepFreeze({ HEADER, GROUPS, TYPES });");
  out.push("");
  return out.join("\n");
}

function build(inputs, method) {
  const { attributes: A, groupMap, fields, roundDigits, requiredPositive } = method;
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const dogma = inputs.dogma || {};

  const shipGroups = (inputs.groups || []).filter((row) => row.categoryId === SHIP_CATEGORY_ID)
    .sort((a, b) => a.groupId - b.groupId);
  for (const row of shipGroups) {
    if (!has(groupMap, String(row.groupId))) throw fail("UNMAPPED_SHIP_GROUP", `group ${row.groupId}`);
  }
  const shipGroupIds = new Set(shipGroups.map((row) => row.groupId));
  const mapped = (inputs.types || [])
    .filter((t) => t.published === true && shipGroupIds.has(t.groupId) && groupMap[String(t.groupId)])
    .sort((a, b) => a.typeId - b.typeId);
  for (const name of method.hullGroups) {
    if (!mapped.some((t) => groupMap[String(t.groupId)].hullGroup === name)) throw fail("HULL_GROUP_EMPTY", name);
  }

  const rows = mapped.map((t) => {
    const entry = groupMap[String(t.groupId)];
    return { t, entry, hull: hullValues(t.typeId, dogma[String(t.typeId)] || {}, method) };
  });
  const sizes = [...new Set(rows.map((r) => r.entry.weaponSize))].sort((a, b) => a - b);
  const units = referenceUnits(dogma, method, sizes);

  const sigBySizeRaw = {};
  for (const size of [...new Set(rows.map((r) => r.entry.hullSize))].sort((a, b) => a - b)) {
    sigBySizeRaw[size] = median(rows.filter((r) => r.entry.hullSize === size).map((r) => r.hull.signatureRadius));
  }
  for (const size of [1, ...sizes]) {
    if (!(sigBySizeRaw[size] > 0)) throw fail("REFERENCE_MISSING", `no hull of size ${size} for its signature`);
  }
  const refTargetSig = median(rows.map((r) => r.hull.signatureRadius));
  const appOf = (designSig) => Math.max(method.applicationMin, Math.min(1, refTargetSig / designSig));

  const velocities = rows.map((r) => r.hull.maxVelocity).sort((a, b) => a - b);
  const speedClassBounds = [];
  for (let k = 1; k < method.speedClasses; k += 1) {
    speedClassBounds.push(round(velocities[Math.floor((k * velocities.length) / method.speedClasses)],
      roundDigits.maxVelocity));
  }

  const types = {};
  const byGroup = new Map(method.hullGroups.map((name) => [name, []]));
  for (const { t, entry, hull } of rows) {
    const unit = units[entry.weaponSize];
    const layout = entry.remoteRepair ? { turrets: 0, launchers: 0 }
      : weaponLayout(hull.hiSlots, hull.turretSlots, hull.launcherSlots);
    const weaponDps = layout.turrets * unit.turretDps + layout.launchers * unit.launcherDps;
    const droneDps = hull.droneBandwidth * units.drones.dpsPerMbit;
    const squadrons = fighterSquadrons(hull);
    const sources = [[weaponDps, sigBySizeRaw[entry.weaponSize]], [droneDps, sigBySizeRaw[1]]];
    let fighterAlpha = 0;
    for (const size of Object.keys(squadrons)) {
      if (squadrons[size] === 0) continue;
      const fighter = units.fighters[size];
      if (!fighter) throw fail("REFERENCE_MISSING", `no ${size} fighter references for type ${t.typeId}`);
      const sig = sigBySizeRaw[method.fighterDesignSigSize[size]];
      if (!(sig > 0)) throw fail("REFERENCE_MISSING", `no hull of size ${method.fighterDesignSigSize[size]} for its signature`);
      sources.push([squadrons[size] * fighter.dpsPerSquadron, sig]);
      fighterAlpha += squadrons[size] * fighter.alphaPerSquadron;
    }
    const active = sources.filter(([value]) => value > 0);
    const dps = active.reduce((s, [value]) => s + value, 0);
    const alpha = layout.turrets * unit.turretAlpha + layout.launchers * unit.launcherAlpha
      + hull.droneBandwidth * units.drones.alphaPerMbit + fighterAlpha;
    const designSig = dps > 0 ? active.reduce((s, [value, sig]) => s + value * sig, 0) / dps : refTargetSig;
    const applicationFactor = dps > 0 ? active.reduce((s, [value, sig]) => s + value * appOf(sig), 0) / dps : 1;
    const remoteRepPerSec = entry.remoteRepair ? hull.hiSlots * unit.remoteRep : 0;
    const raw = {
      dps,
      alpha,
      ehp: hull.ehp,
      repPerSec: hull.passiveRegen + remoteRepPerSec,
      remoteRepPerSec,
      applicationFactor,
      ewarFactor: entry.ewar,
      tackleFactor: entry.tackle,
      speedClass: speedClassOf(hull.maxVelocity, speedClassBounds),
      signatureRadius: hull.signatureRadius,
      maxVelocity: hull.maxVelocity,
      designSig,
    };
    const row = { typeId: t.typeId, groupId: t.groupId, hullGroup: entry.hullGroup };
    for (const field of fields) row[field] = round(raw[field], roundDigits[field]);
    types[String(t.typeId)] = row;
    byGroup.get(entry.hullGroup).push(row);
  }

  const groups = {};
  for (const [name, members] of byGroup) {
    const row = {};
    for (const field of fields) {
      if (field === "speedClass") continue;
      const values = members.map((m) => m[field]);
      let value = round(median(values), roundDigits[field]);
      if (value === 0 && requiredPositive.includes(field)) value = round(mean(values), roundDigits[field]);
      if (!(value > 0) && requiredPositive.includes(field)) {
        throw fail("CATALOG_FIELD_ZERO", JSON.stringify({ hullGroup: name, field }));
      }
      row[field] = value;
    }
    row.speedClass = speedClassOf(row.maxVelocity, speedClassBounds);
    const ordered = {};
    for (const field of fields) ordered[field] = row[field];
    ordered.sampleSize = members.length;
    groups[name] = ordered;
  }

  const attributeIds = [...new Set(Object.values(A).flat())].sort((a, b) => a - b);
  const pick = (typeId) => {
    const src = dogma[String(typeId)] || {};
    const out = {};
    for (const id of attributeIds) if (Number.isFinite(src[id])) out[id] = src[id];
    return out;
  };
  const referenceIds = new Set(method.referenceDrones);
  for (const list of Object.values(method.referenceFighters || {})) for (const id of list) referenceIds.add(id);
  for (const size of sizes) for (const id of Object.values(method.references[size])) referenceIds.add(id);
  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    evejsVersion: inputs.evejsVersion,
    method,
    shipGroups: shipGroups.map((row) => row.groupId),
    types: mapped.map((t) => ({ typeId: t.typeId, groupId: t.groupId, attributes: pick(t.typeId) })),
    references: [...referenceIds].sort((a, b) => a - b).map((id) => ({ typeId: id, attributes: pick(id) })),
  });

  const sigBySize = {};
  for (const size of Object.keys(sigBySizeRaw)) sigBySize[size] = round(sigBySizeRaw[size], roundDigits.signatureRadius);
  const header = {
    catalogVersion: method.catalogVersion,
    methodVersion: method.methodVersion,
    evejsVersion: inputs.evejsVersion,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    sourceHash,
    method: method.description,
    fields: [...fields],
    sigBySize,
    refTargetSig: round(refTargetSig, roundDigits.signatureRadius),
    speedClassBounds,
    typeCount: mapped.length,
  };
  const catalog = { HEADER: header, GROUPS: groups, TYPES: types };
  return { ok: true, catalog, source: serialize(header, groups, types) };
}

function buildCatalog(inputs, method = METHOD) {
  if (!inputs || typeof inputs !== "object" || !inputs.sde || typeof inputs.evejsVersion !== "string") {
    return fail("INPUT_INVALID", "inputs need sde, evejsVersion, groups, types, dogma");
  }
  try {
    return build(inputs, method);
  } catch (err) {
    if (err && err.ok === false) return err;
    throw err;
  }
}

module.exports = { buildCatalog, weaponLayout, speedClassOf, median, fighterSquadrons };
