"use strict";

const { VALIDATOR_REASONS, TEXT_MAX, MAX_PARAMS_BYTES, MS_PER_HOUR, SOURCES } = require("./schema");
const { arcOf, fillTemplate } = require("./data/arcs");
const { ROLES } = require("./data/factions");
const { arcsInCooldown, systemsInCooldown } = require("./digest");
const { arcFitsFaction } = require("./siteTemplates");
const { filterPlotField } = require("../chatterAi/filter");

const TOP_KEYS = Object.freeze(["v", "arc", "faction", "actor", "place", "title", "hook", "steps", "end"]);
const END_KEYS = Object.freeze(["won", "lost"]);
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;
const ASCII_RE = /^[\x20-\x7E]+$/;
const LINK_RE = /https?:|www\.|[<>]/i;
const DIGIT_RE = /\d/;
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const NAME_EDGE = "A-Za-z0-9";

const R = Object.freeze(Object.fromEntries(VALIDATOR_REASONS.map((r) => [r, r])));

const refuse = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function offerNamesOf(offer) {
  const out = new Set();
  for (const p of offer.places || []) {
    out.add(p.name);
    out.add(p.regionName);
  }
  for (const f of offer.factions || []) out.add(f.name);
  return [...out].filter((n) => typeof n === "string" && n !== "").sort((a, b) => b.length - a.length || (a < b ? -1
    : 1));
}

function checkField(text, opts, offer, fieldS) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "EMPTY" };
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length > opts.maxChars) return { ok: false, reason: "LENGTH" };
  if (!ASCII_RE.test(t)) return { ok: false, reason: "CHARSET" };
  if (LINK_RE.test(t)) return { ok: false, reason: "LINK" };
  const filtered = filterPlotField(t, { maxChars: opts.maxChars }, fieldS || null);
  if (!filtered.ok) return { ok: false, reason: filtered.reason };
  let rest = t;
  for (const name of offerNamesOf(offer || {})) {
    const re = new RegExp(`(?<![${NAME_EDGE}])${escapeRe(name)}(?![${NAME_EDGE}])`, "g");
    rest = rest.replace(re, " ");
  }
  if (DIGIT_RE.test(rest)) return { ok: false, reason: "DIGITS" };
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(rest)) !== null) {
    if (!/^[A-Z]/.test(m[0])) continue;
    const before = rest.slice(0, m.index).trimEnd();
    if (before === "" || /[.!?]$/.test(before)) continue;
    return { ok: false, reason: "NAME_UNSOURCED" };
  }
  return { ok: true, text: t };
}

function parseRaw(rawText) {
  const fenced = FENCE_RE.exec(rawText);
  const body = fenced ? fenced[1] : rawText;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(body.slice(start, end + 1));
    return isPlainObject(value) ? value : null;
  } catch (_err) {
    return null;
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function durationOf(kind, params) {
  const hours = params && Number.isFinite(params.hours) ? params.hours : null;
  const ms = hours === null ? kind.duration.minMs : Math.round(hours * MS_PER_HOUR);
  return clamp(ms, kind.duration.minMs, kind.duration.maxMs);
}

function paramsBytes(params) {
  try {
    return Buffer.byteLength(JSON.stringify(params), "utf8");
  } catch (_err) {
    return Infinity;
  }
}

function validateProposal(rawText, offer, registry, S, source, fieldS) {
  if (typeof rawText !== "string" || rawText.length > S.maxProposalChars) return refuse(R.TOO_LARGE);
  const p = parseRaw(rawText);
  if (!p) return refuse(R.NOT_JSON);
  if (Object.keys(p).some((k) => !TOP_KEYS.includes(k))) return refuse(R.UNKNOWN_KEY);
  if (p.end !== undefined && isPlainObject(p.end) && Object.keys(p.end).some((k) => !END_KEYS.includes(k))) {
    return refuse(R.UNKNOWN_KEY);
  }
  if (p.v !== 1) return refuse(R.BAD_VERSION);
  const arc = arcOf(p.arc);
  if (!arc || !S.arcs.includes(arc.key)) return refuse(R.ARC_UNKNOWN);
  if (!offer.arcs.includes(arc.key)) {
    return refuse(arcsInCooldown(offer.recent, offer.cycleAt, S).has(arc.key) ? R.ARC_COOLDOWN : R.ARC_UNKNOWN);
  }
  const faction = offer.factions.find((f) => f.key === p.faction && f.role === ROLES.PIRATE);
  if (!faction || !arcFitsFaction(arc, faction.factionId)) return refuse(R.FACTION_UNKNOWN);
  let actor = null;
  if (p.actor !== undefined && p.actor !== null) {
    actor = offer.factions.find((f) => f.key === p.actor && f.role === ROLES.ACTOR) || null;
    if (!actor) return refuse(R.ACTOR_UNKNOWN);
  }
  if (arc.needsActor && !actor) return refuse(R.ACTOR_UNKNOWN);
  const blocked = systemsInCooldown(offer.recent, offer.cycleAt, S);
  const placeOf = (ref) => offer.places.find((x) => x.ref === ref) || null;
  const checkPlace = (ref) => {
    const place = typeof ref === "string" ? placeOf(ref) : null;
    if (!place) return R.PLACE_UNKNOWN;
    if (!arc.securityClasses.includes(place.secClass)) return R.PLACE_SEC;
    if (blocked.has(place.systemId)) return R.PLACE_COOLDOWN;
    return null;
  };
  const mainMiss = checkPlace(p.place);
  if (mainMiss) return refuse(mainMiss);
  const place = placeOf(p.place);
  const rawSteps = Array.isArray(p.steps) ? p.steps : null;
  for (const s of rawSteps || []) {
    if (isPlainObject(s) && s.place !== undefined) {
      const miss = checkPlace(s.place);
      if (miss) return refuse(miss);
    }
  }
  if (!rawSteps || rawSteps.length < 1 || rawSteps.length > S.maxStepsPerThread) return refuse(R.STEPS_COUNT);
  const counts = new Map();
  const steps = [];
  for (const s of rawSteps) {
    if (!isPlainObject(s) || typeof s.t !== "string" || !arc.stepKinds.includes(s.t)) return refuse(R.STEP_KIND);
    const kind = registry.get(s.t);
    if (!kind) return refuse(R.STEP_KIND);
    const raw = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "t"));
    let checked;
    try {
      checked = kind.validate(raw, { offer, arc });
    } catch (_err) {
      checked = { ok: false, reason: "THROW" };
    }
    if (!checked || checked.ok !== true || !isPlainObject(checked.params)) {
      return refuse(`STEP_PARAMS:${String((checked && checked.reason) || "INVALID")}`);
    }
    if (paramsBytes(checked.params) > MAX_PARAMS_BYTES) return refuse("STEP_PARAMS:TOO_LARGE");
    const n = (counts.get(kind.type) || 0) + 1;
    counts.set(kind.type, n);
    if (n > kind.maxPerThread) return refuse(R.STEP_LIMIT);
    steps.push({ kind: kind.type, version: kind.version, params: checked.params,
      durationMs: durationOf(kind, checked.params) });
  }
  if ((counts.get("SITE") || 0) > S.maxSiteStepsPerThread) return refuse(R.STEP_LIMIT);
  if (steps.reduce((sum, s) => sum + s.durationMs, 0) > S.maxThreadMs) return refuse(R.TOO_LONG);
  const names = { system: place.name, region: place.regionName, faction: faction.name, actor: actor ? actor.name : "" };
  const en = arc.texts.en;
  const textFallback = [];
  const fieldOf = (field, value) => {
    const r = checkField(value, { maxChars: TEXT_MAX[field] }, offer, fieldS);
    if (r.ok) return r.text;
    textFallback.push(field);
    return fillTemplate(en[field], names);
  };
  const title = fieldOf("title", p.title);
  const hook = fieldOf("hook", p.hook);
  const end = isPlainObject(p.end) ? p.end : {};
  const won = fieldOf("won", end.won);
  const lost = fieldOf("lost", end.lost);
  let noticeFallback = false;
  const frozenSteps = steps.map((s) => {
    let params = s.params;
    if (s.kind === "NOTICE") {
      const r = checkField(params.text, { maxChars: TEXT_MAX.notice }, offer, fieldS);
      if (!r.ok) noticeFallback = true;
      params = { ...params, text: r.ok ? r.text : fillTemplate(en.notice, names) };
    }
    return Object.freeze({ kind: s.kind, version: s.version, params: Object.freeze({ ...params }),
      durationMs: s.durationMs });
  });
  if (noticeFallback) textFallback.push("notice");
  const plan = Object.freeze({ v: 1, arc: arc.key, source: source === SOURCES.TEMPLATE ? SOURCES.TEMPLATE : SOURCES.AI,
    factionId: faction.factionId, actorFactionId: actor ? actor.factionId : null, systemId: place.systemId,
    regionId: place.regionId, title, hook, end: Object.freeze({ won, lost }), steps: Object.freeze(frozenSteps),
    textFallback: Object.freeze(textFallback) });
  return { ok: true, plan };
}

module.exports = { validateProposal, checkField, parseRaw };
