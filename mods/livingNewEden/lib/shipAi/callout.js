"use strict";

const { LEVELS, TEMPLATES, CLASSES, GENERIC_CLASS, WORDS } = require("./data/callout");

const RANK = Object.freeze(Object.fromEntries(LEVELS.map((l, i) => [l, i])));
const PILOTS_KEY = "pilots";
const STANDING_TENTHS = 10;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v > 0;

function plPlural(n, forms) {
  if (n === 1) return forms[0];
  const ten = n % 10;
  const hundred = n % 100;
  return ten >= 2 && ten <= 4 && !(hundred >= 12 && hundred <= 14) ? forms[1] : forms[2];
}

function classKeyOf(groupName) {
  if (typeof groupName !== "string" || groupName === "") return null;
  const words = groupName.toLowerCase().split(/[^a-z]+/);
  const hit = CLASSES.find((c) => words.includes(c.word));
  return hit ? hit.key : null;
}

function hostileStandingOf(S) {
  return S.calloutHostileStandingTenths / STANDING_TENTHS;
}

const ALWAYS_MEMO = new Map();
const ALWAYS_MEMO_MAX = 8;

function alwaysHostileOf(S) {
  const text = S && typeof S.calloutHostileFactionIds === "string" ? S.calloutHostileFactionIds : "";
  let set = ALWAYS_MEMO.get(text);
  if (set) return set;
  set = new Set(text.split(",").map((p) => Number(p.trim())).filter(isId));
  if (ALWAYS_MEMO.size >= ALWAYS_MEMO_MAX) ALWAYS_MEMO.clear();
  ALWAYS_MEMO.set(text, set);
  return set;
}

function isHostileFaction(factionId, ctx, S) {
  if (!isId(factionId)) return false;
  if (alwaysHostileOf(S).has(factionId)) return true;
  const c = ctx || {};
  if (c.pirates instanceof Set && c.pirates.has(factionId)) return true;
  if (c.invaders instanceof Set && c.invaders.has(factionId)) return true;
  const standing = typeof c.standing === "function" ? c.standing(factionId) : c.standing;
  return typeof standing === "number" && Number.isFinite(standing) && standing <= hostileStandingOf(S);
}

function cooldownOf(level, S) {
  if (level === "attack") return S.calloutAttackCooldownMs;
  if (level === "grid") return S.calloutGridCooldownMs;
  if (level === "scan") return S.calloutScanCooldownMs;
  return S.calloutSystemCooldownMs;
}

function stampedLevels(level) {
  return isLocal(level) ? LEVELS.filter((l) => RANK[l] <= RANK[level]) : [level];
}

const isLocal = (level) => level === "grid" || level === "attack";
const isPoint = (p) => Boolean(p) && [p.x, p.y, p.z].every((v) => typeof v === "number" && Number.isFinite(v));

function emptyState(systemId) {
  return { systemId: isId(systemId) ? systemId : null, lastAt: null, levelAt: {}, nearest: null, groups: new Map(),
    anchor: null, waveAt: null };
}

function cloneState(s) {
  const groups = new Map();
  for (const [k, g] of s.groups) {
    groups.set(k, { ...g, levels: [...g.levels], gridIds: g.gridIds instanceof Set ? new Set(g.gridIds) : null });
  }
  return { systemId: s.systemId, lastAt: s.lastAt, levelAt: { ...s.levelAt }, nearest: s.nearest, groups,
    anchor: isPoint(s.anchor) ? { ...s.anchor } : null, waveAt: Number.isSafeInteger(s.waveAt) ? s.waveAt : null };
}

function resetSector(st) {
  for (const [key, g] of [...st.groups]) if (g.levels.some(isLocal)) st.groups.delete(key);
  delete st.levelAt.grid;
  delete st.levelAt.attack;
  st.nearest = null;
}

function isWave(g, s, S) {
  if (s.gridGone === true) return true;
  if (!Array.isArray(g.ids) || !(s.gridIds instanceof Set) || s.gridIds.size === 0) return false;
  const fresh = g.ids.filter((id) => isId(id) && !s.gridIds.has(id)).length;
  return fresh > 0 && fresh >= Math.min(S.calloutGrowthMin, g.ships);
}

const validGroup = (g) => Boolean(g) && typeof g.key === "string" && g.key !== "" && isCount(g.ships);
const validReading = (r) => Boolean(r) && Object.prototype.hasOwnProperty.call(RANK, r.level)
  && Array.isArray(r.groups);

function planCallout(state, pass, nowMs, S) {
  const p = pass || {};
  const st = state && state.systemId === p.systemId && state.groups instanceof Map ? cloneState(state)
    : emptyState(p.systemId);
  const readings = (Array.isArray(p.readings) ? p.readings : []).filter(validReading)
    .map((r) => ({ level: r.level, groups: r.groups.filter(validGroup),
      nearest: typeof r.nearest === "number" && Number.isFinite(r.nearest) ? r.nearest : null }))
    .sort((a, b) => RANK[b.level] - RANK[a.level]);
  const position = isPoint(p.position) ? { x: p.position.x, y: p.position.y, z: p.position.z } : null;
  const moved = position !== null && st.anchor !== null && Math.hypot(position.x - st.anchor.x,
    position.y - st.anchor.y, position.z - st.anchor.z) > S.calloutGridRangeMeters;
  if (p.reset === true || moved) resetSector(st);
  if (position !== null) st.anchor = position;
  else if (p.reset === true) st.anchor = null;
  const read = new Set(readings.map((r) => r.level));
  const present = new Map();
  for (const r of readings) {
    for (const g of r.groups) {
      const levels = present.get(g.key) || new Set();
      levels.add(r.level);
      present.set(g.key, levels);
    }
  }
  for (const [key, g] of [...st.groups]) {
    const levels = present.get(key);
    if (levels) {
      if (g.goneSince !== null && nowMs - g.goneSince >= S.calloutClearMs) {
        st.groups.delete(key);
        continue;
      }
      g.goneSince = null;
      for (const l of levels) if (!g.levels.includes(l)) g.levels.push(l);
    } else if (g.levels.every((l) => read.has(l))) {
      if (g.goneSince === null) g.goneSince = nowMs;
      if (nowMs - g.goneSince >= S.calloutClearMs) st.groups.delete(key);
    }
  }
  let line = null;
  let suppressed = 0;
  const held = new Set();
  for (const r of readings) {
    if (r.groups.length === 0) continue;
    if (line) {
      suppressed += 1;
      continue;
    }
    const rank = RANK[r.level];
    let fresh = false;
    const waves = [];
    for (const g of r.groups) {
      const s = st.groups.get(g.key);
      if (!s || rank > s.rank || g.ships >= s.count + S.calloutGrowthMin) fresh = true;
      else if (isLocal(r.level) && isWave(g, s, S)) waves.push(g.key);
    }
    const at = st.levelAt[r.level];
    const cooled = !Number.isSafeInteger(at) || nowMs - at >= cooldownOf(r.level, S);
    const waveCooled = !Number.isSafeInteger(st.waveAt) || nowMs - st.waveAt >= S.calloutWaveCooldownMs;
    const regular = fresh && cooled;
    const wave = !regular && waves.length > 0 && waveCooled;
    const gapped = r.level === "attack" || st.lastAt === null || nowMs - st.lastAt >= S.calloutMinGapMs;
    if (!(regular || wave) || !gapped) {
      if ((regular || wave) && !gapped) for (const k of waves) held.add(k);
      suppressed += 1;
      continue;
    }
    const ships = r.groups.filter((g) => g.key !== PILOTS_KEY);
    const pilots = r.groups.filter((g) => g.key === PILOTS_KEY).reduce((n, g) => n + g.ships, 0);
    const closing = r.level === "grid" && r.nearest !== null && st.nearest !== null
      && r.nearest <= st.nearest - S.calloutClosingMeters;
    line = { level: r.level, ships: ships.reduce((n, g) => n + g.ships, 0), pilots,
      groups: ships.map((g) => ({ key: g.key, faction: g.faction || null, ships: g.ships, cls: g.cls || null })),
      closing, wave };
    for (const g of r.groups) {
      const s = st.groups.get(g.key) || { count: 0, rank, at: nowMs, goneSince: null, levels: [], gridIds: null,
        gridGone: false };
      s.count = wave && waves.includes(g.key) ? g.ships : Math.max(s.count, g.ships);
      s.rank = Math.max(s.rank, rank);
      s.at = nowMs;
      s.goneSince = null;
      if (!s.levels.includes(r.level)) s.levels.push(r.level);
      st.groups.set(g.key, s);
    }
    for (const l of stampedLevels(r.level)) st.levelAt[l] = nowMs;
    if (wave) st.waveAt = nowMs;
    st.lastAt = nowMs;
  }
  rememberSector(st, readings, read, held);
  const grid = readings.find((r) => r.level === "grid");
  if (grid) st.nearest = grid.groups.length > 0 ? grid.nearest : null;
  return { state: st, line, suppressed };
}

function rememberSector(st, readings, read, held) {
  if (!read.has("grid") && !read.has("attack")) return;
  const ids = new Map();
  for (const r of readings) {
    if (!isLocal(r.level)) continue;
    for (const g of r.groups) {
      const set = ids.get(g.key) || new Set();
      if (Array.isArray(g.ids)) for (const id of g.ids) if (isId(id)) set.add(id);
      ids.set(g.key, set);
    }
  }
  for (const [key, s] of st.groups) {
    if (!s.levels.some(isLocal) || held.has(key)) continue;
    const now = ids.get(key);
    s.gridIds = now || new Set();
    s.gridGone = !now;
  }
}

function classOfGroups(groups) {
  const keys = new Set(groups.map((g) => classKeyOf(g.cls)));
  const key = keys.size === 1 ? [...keys][0] : null;
  return CLASSES.find((c) => c.key === key) || GENERIC_CLASS;
}

function whoOf(names, words, withOthers) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2 || !withOthers) return names.slice(0, 2).join(words.and);
  return `${names[0]}, ${names[1]}${words.others}`;
}

function render(template, values) {
  const text = template.replace(/\{(\w+)\}/g, (_m, k) => (Object.prototype.hasOwnProperty.call(values, k)
    ? values[k] : ""));
  return text.replace(/\s+/g, " ").replace(/\s+([,.!])/g, "$1").trim();
}

function buildCallout(spec, language, seed, limits) {
  const s = spec || {};
  const lang = Object.prototype.hasOwnProperty.call(TEMPLATES, language) ? language : "en";
  const T = TEMPLATES[lang][s.level];
  if (!T) return "";
  const W = WORDS[lang];
  const n = isCount(s.ships) ? s.ships : 0;
  const groups = Array.isArray(s.groups) ? s.groups : [];
  const cls = classOfGroups(groups);
  const maxName = limits && isCount(limits.maxNameChars) ? limits.maxNameChars : Infinity;
  const maxChars = limits && isCount(limits.maxChars) ? limits.maxChars : Infinity;
  const names = [];
  for (const g of groups) {
    const name = typeof g.faction === "string" ? g.faction.trim().slice(0, maxName).trim() : "";
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  const pilots = isCount(s.pilots) ? s.pilots : 0;
  const pick = (variants) => variants[Number.isSafeInteger(seed)
    ? ((seed % variants.length) + variants.length) % variants.length : 0];
  if (n === 0 && pilots > 0 && T.pilotsOnly) {
    const only = render(pick(pilots === 1 ? T.pilotsOnly.one : T.pilotsOnly.many),
      { count: String(pilots), pilotsWord: plPlural(pilots, W.pilots) });
    return only.slice(0, maxChars);
  }
  const list = s.wave === true && T.wave ? T.wave : (n === 1 && T.one ? T.one : T.many);
  const template = pick(list);
  const build = (who, tails) => {
    const clsText = lang === "pl" ? plPlural(n, cls.pl) : (n === 1 ? cls.en[0] : cls.en[1]);
    let group;
    if (lang === "pl") group = `${n === 1 ? clsText : `${n} ${clsText}`}${who ? ` ${who}` : ""}`;
    else group = `${n}${who ? ` ${who}` : ""} ${clsText}`;
    return render(template, { group, verb: T.verb ? plPlural(n, T.verb) : "",
      closing: tails && s.closing === true && T.closing ? plPlural(n, T.closing) : "",
      pilots: tails && pilots > 0 ? `${W.and}${pilots} ${plPlural(pilots, W.pilots)}` : "",
      hostile: W.hostile[cls.gender] || W.hostile.m });
  };
  const attempts = [[whoOf(names, W, true), true], [whoOf(names.slice(0, 1), W, false), true], ["", true],
    ["", false]];
  let text = "";
  for (const [who, tails] of attempts) {
    text = build(who, tails);
    if (text.length <= maxChars) return text;
  }
  return text.slice(0, maxChars);
}

module.exports = { planCallout, buildCallout, isHostileFaction, plPlural, classKeyOf, hostileStandingOf,
  emptyState, cooldownOf, RANK, PILOTS_KEY };
