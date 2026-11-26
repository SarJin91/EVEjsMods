"use strict";

const { LAYERS, TEMPLATES } = require("./data/wingHp");

const WHITE = 0;
const ORANGE = 1;
const RED = 2;
const PCT_DIVISOR = 10;
const STRUCTURE = LAYERS.indexOf("structure");
const ARMOR = LAYERS.indexOf("armor");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isPermille = (v) => Number.isSafeInteger(v) && v >= 0;
const pctOf = (permille) => Math.floor(permille / PCT_DIVISOR);
const langOf = (lang) => (Object.prototype.hasOwnProperty.call(TEMPLATES, lang) ? lang : "en");
const pick = (variants, seed) => variants[Number.isSafeInteger(seed)
  ? ((seed % variants.length) + variants.length) % variants.length : 0];

function bandOf(permille, marks) {
  const pct = pctOf(permille);
  if (pct < marks.criticalPct) return RED;
  if (pct < marks.warnPct) return ORANGE;
  return WHITE;
}

function emptyState() {
  return { copies: new Map(), pending: new Map(), lastLineAt: null, left: new Map() };
}

const cloneCarry = (e) => ({ entityId: e.entityId, armed: e.armed.slice(), saidAt: e.saidAt.slice(), saidBand: e.saidBand.slice(),
  pending: Array.isArray(e.pending) ? e.pending.map((p) => ({ ...p })) : [], at: e.at });

function cloneState(s) {
  const copies = new Map();
  for (const [id, c] of s.copies) {
    copies.set(id, { name: c.name, typeId: c.typeId, carryKey: c.carryKey, pct: (c.pct || []).slice(),
      bands: c.bands.slice(),
      armed: c.armed.slice(), saidAt: c.saidAt.slice(), saidBand: c.saidBand.slice() });
  }
  const left = new Map();
  if (s.left instanceof Map) for (const [k, list] of s.left) left.set(k, list.map(cloneCarry));
  return { copies, pending: new Map(s.pending), lastLineAt: s.lastLineAt, left };
}

const keyOf = (entityId, layer) => `${entityId}:${layer}`;

const carryKeyOf = (c) => `${isId(c.typeId) ? c.typeId : 0}:${typeof c.name === "string" ? c.name.trim() : ""}`;

function pruneLeft(left, nowMs, S) {
  const all = [];
  for (const [k, list] of [...left]) {
    const kept = list.filter((e) => nowMs - e.at <= S.wingHpCarryMs);
    if (kept.length === 0) left.delete(k);
    else left.set(k, kept);
    for (const e of kept) all.push([k, e]);
  }
  if (all.length <= S.wingHpCopiesMax) return;
  all.sort((a, b) => a[1].at - b[1].at);
  for (const [k, e] of all.slice(0, all.length - S.wingHpCopiesMax)) {
    const rest = left.get(k).filter((x) => x !== e);
    if (rest.length === 0) left.delete(k);
    else left.set(k, rest);
  }
}

function namesOf(copies, maxNameChars) {
  const max = isId(maxNameChars) ? maxNameChars : Infinity;
  const seen = new Map();
  const out = new Map();
  for (const c of copies) {
    const base = typeof c.name === "string" && c.name.trim() !== "" ? c.name.trim() : "";
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const suffix = n > 1 ? ` ${n}` : "";
    out.set(c.entityId, `${base.slice(0, Math.max(1, max - suffix.length)).trim()}${suffix}`);
  }
  return out;
}

function rearmedBand(armed, pct, marks, S) {
  const rearm = S.wingHpRearmPct;
  if (pct >= marks.warnPct + rearm) return WHITE;
  if (armed === RED && pct >= marks.criticalPct + rearm) return ORANGE;
  return armed;
}

function planWingHp(state, reading, marks, nowMs, S) {
  const st = state ? cloneState(state) : emptyState();
  let changes = 0;
  let suppressed = 0;
  let dropped = 0;
  let truncated = 0;
  let carried = 0;
  let aged = 0;
  pruneLeft(st.left, nowMs, S);
  if (reading && reading.ok === true && Array.isArray(reading.copies)) {
    const valid = reading.copies.filter((c) => c && isId(c.entityId) && Array.isArray(c.hp)
      && c.hp.length === LAYERS.length && c.hp.every(isPermille)).sort((a, b) => a.entityId - b.entityId);
    const kept = valid.slice(0, S.wingHpCopiesMax);
    truncated = valid.length - kept.length;
    const names = namesOf(kept, S.wingHpMaxNameChars);
    const present = new Set(kept.map((c) => c.entityId));
    for (const [id, c] of [...st.copies]) {
      if (present.has(id)) continue;
      st.copies.delete(id);
      if (S.wingHpCarryMs > 0) {
        const key = c.carryKey || carryKeyOf(c);
        const list = st.left.get(key) || [];
        const pending = [...st.pending.values()].filter((p) => p.entityId === id)
          .map((p) => ({ layer: p.layer, band: p.band, pct: p.pct, at: p.at }));
        list.push({ entityId: id, armed: c.armed.slice(), saidAt: c.saidAt.slice(), saidBand: c.saidBand.slice(),
          pending, at: nowMs });
        st.left.set(key, list);
      }
    }
    for (const [key, p] of [...st.pending]) if (!present.has(p.entityId)) st.pending.delete(key);
    pruneLeft(st.left, nowMs, S);
    for (const c of kept) {
      const name = names.get(c.entityId);
      const bands = c.hp.map((v) => bandOf(v, marks));
      let known = st.copies.get(c.entityId);
      if (!known) {
        const carryKey = carryKeyOf(c);
        const list = st.left.get(carryKey);
        const from = list && list.length > 0 ? list.shift() : null;
        if (list && list.length === 0) st.left.delete(carryKey);
        if (!from) {
          st.copies.set(c.entityId, { name, typeId: isId(c.typeId) ? c.typeId : null, carryKey,
            pct: c.hp.map(pctOf), bands, armed: bands.slice(), saidAt: LAYERS.map(() => null),
            saidBand: LAYERS.map(() => null) });
          continue;
        }
        carried += 1;
        known = { name, typeId: isId(c.typeId) ? c.typeId : null, carryKey, bands: from.armed.slice(),
          armed: from.armed.slice(), saidAt: from.saidAt.slice(), saidBand: from.saidBand.slice() };
        st.copies.set(c.entityId, known);
        for (const p of Array.isArray(from.pending) ? from.pending : []) {
          const nowPct = pctOf(c.hp[p.layer]);
          if (rearmedBand(from.armed[p.layer], nowPct, marks, S) < p.band) continue;
          const pct = bands[p.layer] === p.band || !Number.isSafeInteger(p.pct) ? nowPct : p.pct;
          st.pending.set(keyOf(c.entityId, p.layer), { entityId: c.entityId, name, layer: p.layer, band: p.band,
            pct, at: p.at });
        }
      }
      known.name = name;
      known.pct = c.hp.map(pctOf);
      if (isId(c.typeId)) known.typeId = c.typeId;
      for (let layer = 0; layer < LAYERS.length; layer += 1) {
        const b = bands[layer];
        const pct = pctOf(c.hp[layer]);
        const key = keyOf(c.entityId, layer);
        if (b > known.armed[layer]) {
          known.armed[layer] = b;
          const said = known.saidAt[layer];
          if (known.saidBand[layer] === b && said !== null && nowMs - said < S.wingHpLayerCooldownMs) {
            suppressed += 1;
          } else {
            st.pending.set(key, { entityId: c.entityId, name, layer, band: b, pct, at: nowMs });
            changes += 1;
          }
        } else if (b < known.armed[layer]) {
          const next = rearmedBand(known.armed[layer], pct, marks, S);
          if (next < known.armed[layer]) {
            known.armed[layer] = next;
            const p = st.pending.get(key);
            if (p && p.band > next) {
              st.pending.delete(key);
              dropped += 1;
            }
          }
        }
        known.bands[layer] = b;
      }
      for (const [key, p] of st.pending) {
        if (p.entityId === c.entityId && p.name !== name) st.pending.set(key, { ...p, name });
      }
    }
  }
  for (const [key, p] of [...st.pending]) {
    if (nowMs - p.at > S.wingHpPendingMaxAgeMs) {
      st.pending.delete(key);
      aged += 1;
    }
  }
  return { state: st, changes, suppressed, dropped, truncated, carried, aged };
}

function forgetCopy(state, entityId) {
  if (!state || !isId(entityId)) return 0;
  let removed = 0;
  if (state.copies instanceof Map && state.copies.delete(entityId)) removed += 1;
  if (state.pending instanceof Map) {
    for (const [key, p] of [...state.pending]) {
      if (p.entityId !== entityId) continue;
      state.pending.delete(key);
      removed += 1;
    }
  }
  if (state.left instanceof Map) {
    for (const [k, list] of [...state.left]) {
      const rest = list.filter((e) => e.entityId !== entityId);
      if (rest.length === list.length) continue;
      removed += list.length - rest.length;
      if (rest.length === 0) state.left.delete(k);
      else state.left.set(k, rest);
    }
  }
  return removed;
}

function takeWingLine(state, nowMs, S) {
  if (!state || !(state.pending instanceof Map) || state.pending.size === 0) return null;
  if (state.lastLineAt !== null && nowMs - state.lastLineAt < S.wingHpMinGapMs) return null;
  const st = cloneState(state);
  const byCopy = new Map();
  for (const p of st.pending.values()) {
    const g = byCopy.get(p.entityId) || { entityId: p.entityId, name: p.name, items: [], worst: WHITE, weight: -1 };
    g.items.push(p);
    if (p.band > g.worst) g.worst = p.band;
    byCopy.set(p.entityId, g);
  }
  for (const g of byCopy.values()) {
    g.weight = Math.max(...g.items.filter((p) => p.band === g.worst).map((p) => p.layer));
    g.items.sort((a, b) => a.layer - b.layer);
  }
  const groups = [...byCopy.values()].sort((a, b) => b.worst - a.worst || b.weight - a.weight
    || a.entityId - b.entityId);
  const told = groups.slice(0, S.wingHpMaxPerLine);
  for (const g of told) {
    const c = st.copies.get(g.entityId);
    if (!c) continue;
    for (const p of g.items) {
      c.saidAt[p.layer] = nowMs;
      c.saidBand[p.layer] = p.band;
    }
  }
  st.pending = new Map();
  st.lastLineAt = nowMs;
  return { state: st, more: groups.length - told.length, entries: told.map((g) => ({ entityId: g.entityId,
    name: g.name, layers: g.items.map((p) => ({ layer: LAYERS[p.layer], band: p.band, pct: p.pct })) })) };
}

const cut = (text, max) => (isId(max) ? text.slice(0, max) : text).trim();

function buildWingHpLine(entries, more, lang, seed, opts) {
  const T = TEMPLATES[langOf(lang)];
  const list = Array.isArray(entries) ? entries.filter((e) => e && Array.isArray(e.layers) && e.layers.length > 0) : [];
  if (list.length === 0) return "";
  const maxChars = opts && isId(opts.maxChars) ? opts.maxChars : Infinity;
  const maxName = opts && isId(opts.maxNameChars) ? opts.maxNameChars : Infinity;
  const extra = Number.isSafeInteger(more) && more > 0 ? more : 0;
  const clauseOf = (e) => {
    const name = cut(typeof e.name === "string" && e.name.trim() !== "" ? e.name : T.unnamed, maxName);
    return `${name}: ${e.layers.map((l) => `${T.layers[l.layer] || l.layer} ${l.pct}%`).join(", ")}`;
  };
  const tailOf = (shown) => {
    const red = (layer) => shown.some((e) => e.layers.some((l) => l.layer === layer && l.band === RED));
    if (red(LAYERS[STRUCTURE])) return T.hullCritical;
    if (red(LAYERS[ARMOR])) return T.armorCritical;
    return "";
  };
  const build = (k, withTail) => {
    const shown = list.slice(0, k);
    const n = extra + list.length - k;
    const body = k === 1 ? pick(T.one, seed).replace("{clause}", clauseOf(shown[0]))
      : pick(T.many, seed).replace("{clauses}", shown.map(clauseOf).join("; "));
    return `${body}${n > 0 ? T.more.replace("{n}", String(n)) : ""}${withTail ? tailOf(shown) : ""}`;
  };
  for (let k = list.length; k >= 1; k -= 1) {
    const text = build(k, true);
    if (text.length <= maxChars) return text;
  }
  const bare = build(1, false);
  if (bare.length <= maxChars) return bare;
  return cut(clauseOf(list[0]), maxChars);
}

function buildWingLossLine(names, lang, seed, opts) {
  const T = TEMPLATES[langOf(lang)];
  const maxChars = opts && isId(opts.maxChars) ? opts.maxChars : Infinity;
  const maxName = opts && isId(opts.maxNameChars) ? opts.maxNameChars : Infinity;
  const list = (Array.isArray(names) ? names : []).map((n) => cut(typeof n === "string" && n.trim() !== "" ? n
    : T.unnamed, maxName));
  if (list.length === 0) return "";
  const join = (xs) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")}${T.and}${xs[xs.length - 1]}`);
  for (let k = list.length; k >= 1; k -= 1) {
    const text = k === 1 && list.length === 1 ? pick(T.lossOne, seed).replace("{name}", list[0])
      : pick(T.lossMany, seed).replace("{names}", join(list.slice(0, k)));
    if (text.length <= maxChars) return text;
  }
  return cut(pick(T.lossOne, seed).replace("{name}", list[0]), maxChars);
}

const BAND_NAMES = Object.freeze(["white", "orange", "red"]);
const LAYER_LETTERS = Object.freeze(["S", "A", "H"]);

function wingDiagText(diag, base, maxPerLine) {
  const on = diag ? diag.on : Boolean(base && base.on);
  const marks = diag ? diag.marks : (base ? base.marks : null);
  const muted = diag ? diag.muted : Boolean(base && base.muted);
  const marksText = marks ? `marks ${marks.warnPct}/${marks.criticalPct} ${marks.source}` : "marks not read yet";
  const lines = [`wing alerts ${on ? "on" : "off"} (${marksText}), muted: ${muted ? "yes" : "no"}`];
  if (!diag) {
    lines.push("no copy of yours seen yet");
    return lines;
  }
  const copies = diag.copies.slice(0, isId(maxPerLine) ? maxPerLine : diag.copies.length).map((c) => {
    const armed = LAYER_LETTERS.map((l, i) => (c.armed[i] > WHITE ? `${l} ${BAND_NAMES[c.armed[i]]}` : null))
      .filter((x) => x !== null);
    const pct = LAYER_LETTERS.map((l, i) => `${l} ${c.pct[i]}%`).join(" ");
    return `${c.name}: ${pct}${armed.length > 0 ? ` (armed ${armed.join(", ")})` : ""}`;
  });
  lines.push(copies.length > 0 ? copies.join("; ") : `no copy in space (${diag.left} waiting for a relaunch)`);
  const n = (k) => (Number.isSafeInteger(diag.counters[k]) ? diag.counters[k] : 0);
  lines.push(`reads ${n("wingReads")}, copies ${n("wingCopiesSeen")}, lines ${n("wingHpLines")}, carried `
    + `${n("wingHpCarried")}, suppressed ${n("wingHpSuppressed")}, dropped ${n("wingHpDropped")}, aged `
    + `${n("wingHpAged")}, scan truncated ${n("wingScanTruncated")}, copies capped ${n("wingCopiesCapped")}, `
    + `pending ${diag.pending}`);
  return lines;
}

module.exports = { bandOf, planWingHp, takeWingLine, buildWingHpLine, buildWingLossLine, wingDiagText, emptyState,
  forgetCopy,
  LAYERS, WHITE, ORANGE, RED };
