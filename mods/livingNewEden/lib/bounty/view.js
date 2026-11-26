"use strict";

const MS_PER_SECOND = 1000;
const LEVEL_COUNT = 6;
const BLUR = Object.freeze({ SYSTEM: "system", CONSTELLATION: "constellation", REGION: "region" });

const byWantedId = (a, b) => (a.wantedId < b.wantedId ? -1 : a.wantedId > b.wantedId ? 1 : 0);

function safe(fn) {
  try {
    return fn();
  } catch (_err) {
    return null;
  }
}

const textOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

function traceOf(t, now, levels, graph) {
  const data = levels ? levels[t.level] : null;
  if (!data || !Number.isSafeInteger(t.traceSystemId) || !Number.isFinite(t.traceAt)) return null;
  if (!Number.isFinite(data.traceDelayMs) || now < t.traceAt + data.traceDelayMs) return null;
  const sys = graph && typeof graph.getSystem === "function" ? safe(() => graph.getSystem(t.traceSystemId)) : null;
  let name = null;
  if (sys && data.traceBlur === BLUR.SYSTEM) name = textOrNull(sys.name);
  else if (sys && data.traceBlur === BLUR.CONSTELLATION && typeof graph.getConstellationName === "function") {
    name = textOrNull(safe(() => graph.getConstellationName(sys.constellationId)));
  } else if (sys && data.traceBlur === BLUR.REGION && typeof graph.getRegionName === "function") {
    name = textOrNull(safe(() => graph.getRegionName(sys.regionId)));
  }
  return { systemId: t.traceSystemId, at: t.traceAt, blur: data.traceBlur,
    seen: name === null ? null : { kind: data.traceBlur, name } };
}

function rowOf(t, o, jumps) {
  const nick = textOrNull(safe(() => o.nickOf(t)));
  if (nick === null) return null;
  const tr = traceOf(t, o.now, o.levels, o.graph);
  const seen = tr ? tr.seen : null;
  return { wantedId: t.wantedId, nick, level: t.level, rewardIsk: t.rewardIsk, smuggler: t.smuggler === 1,
    seen, ageS: seen ? Math.max(0, Math.floor((o.now - tr.at) / MS_PER_SECOND)) : null,
    jumps: seen && tr.blur === BLUR.SYSTEM && Number.isSafeInteger(jumps) ? jumps : null,
    ...(seen ? { systemId: tr.systemId } : {}) };
}

const byReward = (a, b) => b.rewardIsk - a.rewardIsk || byWantedId(a, b);

function rankBoard(rows, o) {
  const byLevel = new Array(LEVEL_COUNT).fill(0);
  const list = Array.isArray(rows) ? rows : [];
  for (const t of list) if (t.level >= 1 && t.level <= LEVEL_COUNT) byLevel[t.level - 1] += 1;
  const ordered = list.slice().sort(byReward);
  const ranked = [];
  const keep = Math.max(0, o.keep);
  for (const t of ordered) {
    if (ranked.length >= keep) break;
    const r = rowOf(t, o, null);
    if (r) ranked.push(r);
  }
  return { summary: { total: list.length, byLevel }, ranked };
}

function nearOf(candidates, o) {
  if (!(o.distances instanceof Map) || o.nearRows <= 0) return [];
  const found = [];
  for (const t of Array.isArray(candidates) ? candidates : []) {
    const tr = traceOf(t, o.now, o.levels, o.graph);
    if (!tr || tr.seen === null) continue;
    const jumps = o.distances.get(tr.systemId);
    if (!Number.isSafeInteger(jumps) || jumps > o.nearJumps) continue;
    found.push({ t, jumps });
  }
  found.sort((a, b) => a.jumps - b.jumps || byReward(a.t, b.t));
  const out = [];
  for (const f of found) {
    if (out.length >= o.nearRows) break;
    const r = rowOf(f.t, o, f.jumps);
    if (r) out.push(r);
  }
  return out;
}

const strip = ({ wantedId: _w, ...rest }) => rest;

function compose(board, near, topRows) {
  const shown = new Set(near.map((r) => r.wantedId));
  const top = board.ranked.filter((r) => !shown.has(r.wantedId)).slice(0, Math.max(0, topRows));
  return { summary: { total: board.summary.total, byLevel: board.summary.byLevel.slice() }, near: near.map(strip),
    top: top.map(strip), more: Math.max(0, board.summary.total - near.length - top.length) };
}

function buildBoardRows(rows, o) {
  const board = rankBoard(rows, { ...o, keep: o.topRows + o.nearRows });
  return compose(board, nearOf(rows, o), o.topRows);
}

module.exports = { BLUR, traceOf, rankBoard, nearOf, compose, buildBoardRows };
