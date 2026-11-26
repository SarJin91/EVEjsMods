"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { BACKGROUND, BACKGROUND_CATEGORIES, RUMOURS, ITEMS } = require("./data/chatterLines");

const PERMILLE = 1000;
const WINDOW_MS = 60000;
const TRADE_MAX_HUB_JUMPS = 1;
const PLACEHOLDERS = Object.freeze(["system", "region", "item", "attacker", "defender", "place", "placeRegion",
  "losses"]);
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
const AI_ID_PREFIX = "ai-";

function chatterIntervalMs(civilians, systemId, slot, seed, C) {
  const n = Number.isSafeInteger(civilians) && civilians > 0 ? civilians : 1;
  const floor = C.minIntervalFloorMs;
  const base = Math.max(floor, C.minIntervalMs * Math.min(1, C.intervalRefCivilians / n));
  const rng = createRng(deriveSeed(seed >>> 0, "hs-chat-gap", systemId, slot));
  const j = C.jitterPermille > 0 ? rng.nextInt(-C.jitterPermille, C.jitterPermille) : 0;
  return Math.max(floor, Math.round(base * (PERMILLE + j) / PERMILLE));
}

function fillTemplate(template, values) {
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

function firstFitting(list, start, values, maxChars, skip) {
  for (let k = 0; k < list.length; k += 1) {
    const t = list[(start + k) % list.length];
    if (skip && skip.has(t.id)) continue;
    const text = fillTemplate(t.text, values);
    if (text !== null && text.length <= maxChars) return { id: t.id, text };
  }
  return null;
}

function pickLine(input) {
  const speakers = Array.isArray(input.speakers) ? input.speakers : [];
  if (speakers.length === 0) return { ok: false, reason: "NO_SPEAKER" };
  const C = input.C;
  const place = input.place || {};
  const rng = createRng(deriveSeed(input.seed >>> 0, "hs-chat", input.systemId, input.slot));
  const rumourRoll = rng.nextInt(0, PERMILLE - 1);
  const rumourIdx = rng.nextUint32();
  const templateIdx = rng.nextUint32();
  const categoryIdx = rng.nextUint32();
  const lineIdx = rng.nextUint32();
  const speakerIdx = rng.nextUint32();
  const itemIdx = rng.nextUint32();

  const aiRoll = rng.nextInt(0, PERMILLE - 1);
  const aiIdx = rng.nextUint32();

  const values = { system: place.systemName, region: place.regionName, item: ITEMS[itemIdx % ITEMS.length] };
  let chosen = null;
  let rumourKey = null;
  let bucket = null;
  let bucketValues = values;
  const rumours = Array.isArray(input.rumours) ? input.rumours : [];
  if (rumourRoll < C.rumourPermille && rumours.length > 0) {
    const r = rumours[rumourIdx % rumours.length];
    const templates = RUMOURS[r.kind] || [];
    if (templates.length > 0) {
      const rumourValues = { ...values, attacker: r.attackerName, defender: r.defenderName, place: r.systemName,
        placeRegion: r.regionName, losses: r.losses === null || r.losses === undefined ? null : String(r.losses) };
      chosen = firstFitting(templates, templateIdx % templates.length, rumourValues, C.maxLineChars, null);
      if (chosen) {
        bucket = `hs.rumour.${r.kind}`;
        bucketValues = rumourValues;
      }
    }
    if (chosen) rumourKey = r.key;
  }
  const recent = new Set(Array.isArray(input.recentLineIds) ? input.recentLineIds : []);
  if (!chosen) {
    const trade = place.isHub === true || (Number.isSafeInteger(place.hubJumps) && place.hubJumps <= TRADE_MAX_HUB_JUMPS);
    const categories = BACKGROUND_CATEGORIES.filter((c) => c !== "TRADE" || trade);
    const first = categoryIdx % categories.length;
    for (let k = 0; k < categories.length && !chosen; k += 1) {
      const category = categories[(first + k) % categories.length];
      const list = BACKGROUND[category];
      chosen = firstFitting(list, lineIdx % list.length, values, C.maxLineChars, recent);
      if (chosen) bucket = `hs.bg.${category}`;
    }
  }
  if (!chosen) return { ok: false, reason: "NO_LINE" };
  let source = "static";
  const ai = input.ai;
  if (ai && Number.isSafeInteger(ai.permille) && aiRoll < ai.permille) {
    const list = safeLinesOf(ai, bucket);
    const aiChosen = list.length > 0 ? firstFitting(list, aiIdx % list.length, bucketValues, C.maxLineChars, recent)
      : null;
    if (aiChosen) {
      chosen = aiChosen;
      source = "ai";
    }
  }
  let idx = speakerIdx % speakers.length;
  if (speakers[idx] === input.lastSpeaker && speakers.length > 1) idx = (idx + 1) % speakers.length;
  return { ok: true, characterId: speakers[idx], text: chosen.text, lineId: chosen.id, rumourKey, source };
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

function createLineLimiter(maxLinesPerMinute) {
  const max = Number.isSafeInteger(maxLinesPerMinute) && maxLinesPerMinute > 0 ? maxLinesPerMinute : 0;
  const times = [];
  const expire = (now) => {
    while (times.length > 0 && times[0] + WINDOW_MS <= now) times.shift();
  };
  return Object.freeze({
    tryTake(now) {
      expire(now);
      if (times.length >= max) return false;
      times.push(now);
      return true;
    },
    inWindow(now) {
      expire(now);
      return times.length;
    },
  });
}

module.exports = { chatterIntervalMs, pickLine, fillTemplate, createLineLimiter, PLACEHOLDERS, WINDOW_MS };
