"use strict";

const { isHostileFaction, hostileStandingOf } = require("../callout");

const AU_METERS = 149597870700;
const DSCAN_MIN_M = 10000;
const DSCAN_MAX_M = 14.3 * AU_METERS;
const KM = 1000;
const AU_DECIMALS = 10;
const RANGE_RE = /^(\d+(?:\.\d+)?)\s*(km|au)?$/;
const MAX_WORD = "max";

const CATEGORY_OF_KIND = Object.freeze({ structure: "structure", station: "structure", wreck: "wreck", probe: "probe",
  drone: "drone", container: "container" });

function parseRange(text) {
  if (typeof text !== "string") return { ok: false, reason: "BAD_RANGE" };
  const t = text.trim().toLowerCase().replace(",", ".");
  if (t === MAX_WORD) return { ok: true, meters: null };
  const m = RANGE_RE.exec(t);
  const value = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "BAD_RANGE" };
  const meters = value * (m[2] === "au" ? AU_METERS : KM);
  return { ok: true, meters: Math.min(DSCAN_MAX_M, Math.max(DSCAN_MIN_M, meters)) };
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function lowestContact(entry, contacts) {
  let low = null;
  for (const id of [entry.characterId, entry.corporationId, entry.allianceId]) {
    const v = isId(id) ? contacts.get(id) : undefined;
    if (typeof v === "number" && Number.isFinite(v) && (low === null || v < low)) low = v;
  }
  return low;
}

function hostilePilot(entry, c, S) {
  if (isId(c.ownCorporationId) && entry.corporationId === c.ownCorporationId) return false;
  if (isId(c.ownAllianceId) && entry.allianceId === c.ownAllianceId) return false;
  if (!(c.contacts instanceof Map)) return false;
  const low = lowestContact(entry, c.contacts);
  return low !== null && low <= hostileStandingOf(S);
}

function classifyEntries(entries, ctx, S) {
  const c = ctx || {};
  const classOf = (typeId) => {
    if (typeof c.classOf !== "function" || !isId(typeId)) return null;
    const k = c.classOf(typeId);
    return typeof k === "string" && k !== "" ? k : null;
  };
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "ship") {
      const pilot = entry.isPlayer === true;
      out.push({ cat: pilot ? "pilot" : "npc", entry, cls: classOf(entry.typeId),
        hostile: pilot ? hostilePilot(entry, c, S) : isHostileFaction(entry.factionId, c, S) });
      continue;
    }
    out.push({ cat: CATEGORY_OF_KIND[entry.kind] || "other", entry, cls: null, hostile: false });
  }
  return out;
}

const byCountThenName = (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function summarizeScan(classified, scan, ctx, S) {
  const c = ctx || {};
  const list = Array.isArray(classified) ? classified : [];
  const rows = S.toolMaxRows;
  const factionOf = (id) => {
    if (!isId(id) || typeof c.factionName !== "function") return null;
    const n = c.factionName(id);
    return typeof n === "string" && n !== "" ? n : null;
  };
  const counts = { structure: 0, wreck: 0, probe: 0, drone: 0, container: 0, other: 0 };
  const ships = new Map();
  const pilotClasses = new Map();
  let pilots = 0;
  let hostilePilots = 0;
  for (const x of list) {
    if (x.cat === "npc") {
      const faction = factionOf(x.entry.factionId);
      const key = JSON.stringify([faction, x.cls]);
      const g = ships.get(key)
        || { faction, cls: x.cls, count: 0, hostile: false, name: `${faction || ""} ${x.cls || ""}` };
      g.count += 1;
      g.hostile = g.hostile || x.hostile === true;
      ships.set(key, g);
    } else if (x.cat === "pilot") {
      pilots += 1;
      if (x.hostile === true) hostilePilots += 1;
      const key = String(x.cls);
      const g = pilotClasses.get(key) || { cls: x.cls, count: 0, name: x.cls || "" };
      g.count += 1;
      pilotClasses.set(key, g);
    } else if (Object.prototype.hasOwnProperty.call(counts, x.cat)) {
      counts[x.cat] += 1;
    }
  }
  const range = scan && typeof scan.rangeMeters === "number" && Number.isFinite(scan.rangeMeters)
    ? Math.round((scan.rangeMeters / AU_METERS) * AU_DECIMALS) / AU_DECIMALS : null;
  return { rangeAu: range, total: list.length,
    ships: [...ships.values()].sort(byCountThenName).slice(0, rows)
      .map((g) => ({ faction: g.faction, cls: g.cls, count: g.count, hostile: g.hostile })),
    pilots: { total: pilots, hostile: c.contacts instanceof Map ? hostilePilots : null,
      classes: [...pilotClasses.values()].sort(byCountThenName).slice(0, rows)
        .map((g) => ({ cls: g.cls, count: g.count })) },
    structures: counts.structure, wrecks: counts.wreck, probes: counts.probe, drones: counts.drone,
    containers: counts.container, other: counts.other, truncated: Boolean(scan && scan.truncated) };
}

module.exports = { parseRange, classifyEntries, summarizeScan, AU_METERS, DSCAN_MIN_M, DSCAN_MAX_M };
