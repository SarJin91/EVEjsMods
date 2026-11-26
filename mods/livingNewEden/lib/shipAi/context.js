"use strict";

const MAX_FIELD_CHARS = 60;
const MAX_STATION_CHARS = 100;
const OFFLINE_JSON = JSON.stringify({ sensors: "offline" });

function sanitizeGameText(s, max) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : MAX_FIELD_CHARS;
  return String(s ?? "").replace(/[\p{Cc}\p{Cf}<>{}`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function createContextState() {
  return { cache: new Map(), statics: { index: null, tried: false } };
}

function staticIndexOf(deps) {
  const st = deps.state.statics;
  if (st.tried) return st.index;
  st.tried = true;
  const a = deps.adapter;
  if (!a || typeof a.readStaticMap !== "function") return null;
  const res = a.readStaticMap();
  if (!res || !res.ok || !res.map || !Array.isArray(res.map.systems)) return null;
  const regions = res.map.regionNames instanceof Map ? res.map.regionNames : new Map();
  const index = new Map();
  for (const s of res.map.systems) {
    if (!s || !Number.isSafeInteger(s.id) || s.id <= 0) continue;
    index.set(s.id, Object.freeze({ name: sanitizeGameText(s.name, MAX_FIELD_CHARS),
      security: typeof s.secClass === "string" ? sanitizeGameText(s.secClass, MAX_FIELD_CHARS) : null,
      regionId: Number.isSafeInteger(s.regionId) ? s.regionId : null,
      region: regions.has(s.regionId) ? sanitizeGameText(regions.get(s.regionId), MAX_FIELD_CHARS) : null }));
  }
  st.index = index;
  return index;
}

function presenceOf(adapter, playerId) {
  if (!adapter || typeof adapter.readPresence !== "function") return null;
  const res = adapter.readPresence();
  if (!res || !res.ok || !Array.isArray(res.characters)) return null;
  return res.characters.find((r) => r && r.characterId === playerId) || null;
}

function whereOf(adapter, rec) {
  if (rec.state !== "docked") return rec.state === "space" ? "space" : "transit";
  if (!adapter || typeof adapter.listNpcStationsInSystem !== "function") return "docked";
  const res = adapter.listNpcStationsInSystem(rec.systemId);
  if (!res || !res.ok || !Array.isArray(res.stations) || res.stations.length !== 1) return "docked";
  const name = sanitizeGameText(res.stations[0].name, MAX_STATION_CHARS);
  return name === "" ? "docked" : `docked:${name}`;
}

function sensorFields(extra) {
  const out = {};
  if (!extra || typeof extra !== "object") return out;
  const s = extra.ship;
  if (s && typeof s === "object") {
    const ship = {};
    if (typeof s.type === "string" && s.type !== "") ship.type = sanitizeGameText(s.type, MAX_FIELD_CHARS);
    for (const k of ["shieldPct", "armorPct", "structurePct", "capacitorPct"]) {
      if (Number.isSafeInteger(s[k])) ship[k] = s[k];
    }
    if (Object.keys(ship).length > 0) out.ship = ship;
  }
  const t = extra.threats;
  if (t && Number.isSafeInteger(t.here) && Number.isSafeInteger(t.near)) out.threats = { here: t.here, near: t.near };
  if (Number.isSafeInteger(extra.localCount)) out.localCount = extra.localCount;
  const e = extra.lastEvent;
  if (e && typeof e.kind === "string" && Number.isSafeInteger(e.minutesAgo)) {
    const ev = { kind: sanitizeGameText(e.kind, MAX_FIELD_CHARS), minutesAgo: e.minutesAgo };
    for (const k of ["system", "region", "ship", "class", "security"]) {
      if (typeof e[k] === "string" && e[k] !== "") ev[k] = sanitizeGameText(e[k], MAX_FIELD_CHARS);
    }
    out.lastEvent = ev;
  }
  return out;
}

function fit(value, max) {
  let json = JSON.stringify(value);
  if (json.length <= max) return json;
  const lean = { ...value };
  if (typeof lean.where === "string" && lean.where.startsWith("docked:")) lean.where = "docked";
  for (const key of ["lastEvent", "threats", "localCount", "ship", "where", "region", "security", "system"]) {
    json = JSON.stringify(lean);
    if (json.length <= max) return json;
    delete lean[key];
  }
  json = JSON.stringify(lean);
  return json.length <= max ? json : "{}";
}

function buildSnapshot(deps, playerId) {
  try {
    const now = deps.nowMs();
    const hit = deps.state.cache.get(playerId);
    if (hit && now - hit.at < deps.S.contextCacheMs) return hit.value;
    for (const [id, entry] of deps.state.cache) {
      if (now - entry.at >= deps.S.contextCacheMs) deps.state.cache.delete(id);
    }
    const rec = presenceOf(deps.adapter, playerId);
    let json = OFFLINE_JSON;
    if (rec) {
      const index = staticIndexOf(deps);
      const sys = index ? index.get(rec.systemId) : null;
      const snap = {};
      if (sys && sys.name) snap.system = sys.name;
      if (sys && sys.security) snap.security = sys.security;
      if (sys && sys.region) snap.region = sys.region;
      snap.where = whereOf(deps.adapter, rec);
      if (typeof deps.sensors === "function") {
        try {
          Object.assign(snap, sensorFields(deps.sensors(playerId, rec)));
        } catch (_err) {
          snap.sensors = "offline";
        }
      }
      json = fit(snap, deps.S.contextMaxChars);
    }
    const value = Object.freeze({ ok: true, json, presence: rec });
    deps.state.cache.set(playerId, { at: now, value });
    return value;
  } catch (_err) {
    return { ok: true, json: OFFLINE_JSON, presence: null };
  }
}

module.exports = { buildSnapshot, createContextState, sanitizeGameText, presenceOf, OFFLINE_JSON, staticIndexOf };
