"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { CONTEXTS, PLACEHOLDERS, LINES } = require("./data/chatterLines");

const PERMILLE = 1000;
const ISK_PER_M = 1000000;
const ISK_PER_TENTH_M = 100000;
const ONE_DECIMAL_BELOW_M = 10;
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
const GENERIC = "GENERIC";
const AI_ID_PREFIX = "ai-";

function residentGapMs(residents, systemId, slot, seed, C) {
  const n = Number.isSafeInteger(residents) && residents > 0 ? residents : 1;
  const floor = C.minIntervalFloorMs;
  const base = Math.max(floor, C.minIntervalMs * Math.min(1, C.intervalRefCivilians / n));
  const rng = createRng(deriveSeed(seed >>> 0, "fc-chat-gap", systemId, slot));
  const j = C.jitterPermille > 0 ? rng.nextInt(-C.jitterPermille, C.jitterPermille) : 0;
  return Math.max(floor, Math.round(base * (PERMILLE + j) / PERMILLE));
}

const known = (ctx) => (CONTEXTS.includes(ctx) ? ctx : GENERIC);

function contextOf(speaker, minRichIsk) {
  if (!speaker || typeof speaker !== "object") return GENERIC;
  const v = speaker.venture;
  if (speaker.role === "CREW" && v) {
    if (v.state === "STRANDED") return GENERIC;
    if (v.state === "WORKING") return known(`WORK_${v.kind === "EXPLORE_WH" ? "EXPLORE" : v.kind}`);
    if (v.state === "HELD") return "HELD";
    if (v.state === "TRAVEL") return "TRAVEL";
    if (v.state === "RETURNING") return v.yieldIsk > 0 ? "RETURN_FULL" : "RETURN_EMPTY";
  }
  const last = speaker.last;
  if (speaker.role === "HOME" && last) {
    if (last.outcome === "LOST") return "LAST_LOST";
    if (last.outcome === "DONE") {
      return last.kind !== "BUILD" && last.yieldIsk >= minRichIsk ? "LAST_RICH" : "LAST_DONE";
    }
  }
  if (speaker.role === "HOME" && typeof speaker.archetype === "string") return known(`IDLE_${speaker.archetype}`);
  return GENERIC;
}

function fillResidentTemplate(template, values) {
  if (typeof template !== "string") return null;
  let bad = false;
  const out = template.replace(PLACEHOLDER_RE, (_m, name) => {
    const v = PLACEHOLDERS.includes(name) && values ? values[name] : undefined;
    if (v === null || v === undefined || v === "") {
      bad = true;
      return "";
    }
    return String(v);
  });
  return bad || out.includes("{") ? null : out;
}

function formatIsk(isk) {
  const n = Number.isFinite(isk) && isk > 0 ? isk : 0;
  if (n >= ONE_DECIMAL_BELOW_M * ISK_PER_M) return `${Math.round(n / ISK_PER_M)}M`;
  return `${(Math.round(n / ISK_PER_TENTH_M) / 10).toFixed(1)}M`;
}

function firstFitting(list, start, values, maxChars, skip) {
  for (let k = 0; k < list.length; k += 1) {
    const t = list[(start + k) % list.length];
    if (skip.has(t.id)) continue;
    const text = fillResidentTemplate(t.text, values);
    if (text !== null && text.length <= maxChars) return { id: t.id, text };
  }
  return null;
}

const nameOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

function pickResidentLine(input) {
  const speakers = input && Array.isArray(input.speakers) ? input.speakers : [];
  if (speakers.length === 0) return { ok: false, reason: "NO_SPEAKER" };
  const rng = createRng(deriveSeed(input.seed >>> 0, "fc-chat", input.systemId, input.slot));
  const speakerIdx = rng.nextUint32();
  const lineIdx = rng.nextUint32();
  const aiRoll = rng.nextInt(0, PERMILLE - 1);
  const aiIdx = rng.nextUint32();
  let idx = speakerIdx % speakers.length;
  if (speakers[idx].characterId === input.lastSpeaker && speakers.length > 1) idx = (idx + 1) % speakers.length;
  const s = speakers[idx];
  const context = contextOf(s, input.minRichIsk);
  const nameOf = (id) => {
    if (!Number.isSafeInteger(id) || typeof input.nameOf !== "function") return null;
    try {
      return nameOrNull(input.nameOf(id));
    } catch (_err) {
      return null;
    }
  };
  const v = s.venture || null;
  const last = s.last || null;
  const placeId = s.role === "CREW" && v ? v.systemId : last ? last.systemId : null;
  const yieldIsk = s.role === "CREW" && v ? v.yieldIsk : last ? last.yieldIsk : 0;
  const values = { system: nameOrNull(input.listenerName), home: nameOf(s.homeSystemId), place: nameOf(placeId),
    corp: nameOrNull(s.corpName), ticker: nameOrNull(s.ticker),
    lost: last && Number.isSafeInteger(last.crewLost) && last.crewLost > 0 ? String(last.crewLost) : null,
    isk: Number.isFinite(yieldIsk) && yieldIsk > 0 ? formatIsk(yieldIsk) : null };
  const recent = new Set(Array.isArray(input.recentLineIds) ? input.recentLineIds : []);
  let chosen = null;
  let bucket = null;
  for (const ctx of context === GENERIC ? [GENERIC] : [context, GENERIC]) {
    const list = LINES[ctx];
    chosen = list && list.length > 0 ? firstFitting(list, lineIdx % list.length, values, input.maxLineChars, recent) : null;
    if (chosen) {
      bucket = `fc.${ctx}`;
      break;
    }
  }
  if (!chosen) return { ok: false, reason: "NO_LINE" };
  let source = "static";
  const ai = input.ai;
  if (ai && Number.isSafeInteger(ai.permille) && aiRoll < ai.permille) {
    const list = safeLinesOf(ai, bucket);
    const aiChosen = list.length > 0 ? firstFitting(list, aiIdx % list.length, values, input.maxLineChars, recent)
      : null;
    if (aiChosen) {
      chosen = aiChosen;
      source = "ai";
    }
  }
  return { ok: true, characterId: s.characterId, text: chosen.text, lineId: chosen.id, context, source };
}

function safeLinesOf(ai, bucketKey) {
  let list = null;
  try {
    list = typeof ai.linesOf === "function" ? ai.linesOf(bucketKey) : null;
  } catch (_err) {
    list = null;
  }
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t && typeof t.id === "string" && t.id.startsWith(AI_ID_PREFIX)
    && typeof t.text === "string");
}

module.exports = { residentGapMs, contextOf, fillResidentTemplate, formatIsk, pickResidentLine };
