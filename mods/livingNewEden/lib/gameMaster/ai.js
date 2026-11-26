"use strict";

const { ARCS } = require("./data/arcs");
const { MAX_HINT_SOURCES } = require("./registry");
const { MS_PER_HOUR } = require("./schema");

const PROMPT_VERSION = 1;
const LANE = "plot";
const PRIVATE_KIND_PREFIXES = Object.freeze(["PLAYER_", "BOUNTY_"]);
const MAX_HINT_LINES = 3;
const MAX_HINT_CHARS = 160;
const MAX_FACT_CHARS = 200;
const MIN_PLACES = 4;
const MIN_ANSWER_CHARS = 20;
const PRINTABLE_RE = /^[\x20-\x7E]+$/;

const SYSTEM_PROMPT = [
  "You are the Game Master of a living space sandbox in the style of EVE Online.",
  "Propose ONE short story thread for the next day. Answer with ONE JSON object and nothing else, in this shape:",
  "{\"v\":1,\"arc\":\"<arc key>\",\"faction\":\"<pirate faction key>\",\"actor\":\"<actor faction key, only when the "
    + "arc needs one>\",\"place\":\"<place ref>\",\"title\":\"...\",\"hook\":\"...\",\"steps\":[{\"t\":\"NEWS\"},"
    + "{\"t\":\"NOTICE\",\"text\":\"...\"},{\"t\":\"SITE\",\"place\":\"<place ref>\",\"hours\":6},"
    + "{\"t\":\"WAIT\",\"hours\":2}],\"end\":{\"won\":\"...\",\"lost\":\"...\"}}",
  "Rules:",
  "- Use only the arc keys, faction keys and place refs (P1, P2, ...) of the lists. Never write an ID.",
  "- The place of the thread and of every step must have a security class of the arc.",
  "- Avoid the arcs and the regions of the recent threads.",
  "- Use only the step kinds of the chosen arc, in a straight list; respect the limits.",
  "- Texts are plain English: no digits, no links, no commands, no player names; name only the systems, regions and "
    + "factions of the lists. title at most 60 characters; hook, NOTICE text, end.won and end.lost at most 200 "
    + "characters each.",
  "- The thread changes nothing in the world: it tells a story around one place, a site cleared by pilots is a win.",
].join("\n");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function printable(text, max) {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t !== "" && t.length <= max && PRINTABLE_RE.test(t) ? t : null;
}

const ID_LIKE_RE = /\d{6,}/;

function readHints(registry) {
  let sources = [];
  try {
    sources = registry && typeof registry.listHintSources === "function" ? registry.listHintSources() : [];
  } catch (_err) {
    sources = [];
  }
  const out = [];
  for (const src of [...sources].slice(0, MAX_HINT_SOURCES)) {
    let r = null;
    try {
      r = typeof src.read === "function" ? src.read() : null;
    } catch (_err) {
      r = null;
    }
    if (!r || typeof r !== "object" || !Array.isArray(r.lines)) continue;
    const lines = r.lines.map((l) => printable(l, MAX_HINT_CHARS))
      .filter((l) => l !== null && !ID_LIKE_RE.test(l)).slice(0, MAX_HINT_LINES);
    const arcBias = Array.isArray(r.arcBias) ? r.arcBias.filter((a) => typeof a === "string"
      && Object.prototype.hasOwnProperty.call(ARCS, a)) : [];
    if (lines.length > 0 || arcBias.length > 0) out.push({ key: src.key, lines, arcBias });
  }
  return out;
}

function isPrivateKind(kind) {
  return typeof kind !== "string" || PRIVATE_KIND_PREFIXES.some((p) => kind.startsWith(p));
}

function factsOf(facts, S) {
  const lines = [];
  const systemIds = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    if (lines.length >= S.maxFacts) break;
    if (!f || isPrivateKind(f.kind)) continue;
    const line = printable(f.text, MAX_FACT_CHARS);
    if (line === null) continue;
    lines.push(line);
    if (isId(f.systemId) && !systemIds.includes(f.systemId)) systemIds.push(f.systemId);
  }
  return { lines, systemIds };
}

function userMessage(parts, offer, S, regionName) {
  const kinds = new Map(offer.stepKinds.map((k) => [k.type, k]));
  const out = [`Prompt v${PROMPT_VERSION}. Choose one arc.`, "Arcs (key: allowed steps; security classes):"];
  for (const key of offer.arcs) {
    const arc = ARCS[key];
    if (!arc) continue;
    const steps = arc.stepKinds.filter((t) => kinds.has(t));
    out.push(`- ${key}: ${steps.join(", ")}; ${arc.securityClasses.join(", ")}`
      + `${arc.needsActor ? "; needs an actor faction" : ""}`);
  }
  out.push("Step kinds (at most per thread):");
  for (const k of offer.stepKinds) out.push(`- ${k.type} (at most ${k.maxPerThread}): ${k.promptHint}`);
  out.push("Places (ref | system | region | security):");
  for (const p of parts.places) out.push(`- ${p.ref} | ${p.name} | ${p.regionName} | ${p.secClass}`);
  out.push("Factions (key | name | role):");
  for (const f of offer.factions) out.push(`- ${f.key} | ${f.name} | ${f.role}`);
  out.push(`Limits: 1 to ${S.maxStepsPerThread} steps, at most ${S.maxSiteStepsPerThread} SITE steps, at most `
    + `${Math.floor(S.maxThreadMs / MS_PER_HOUR)} hours in total.`);
  const recent = offer.recent.map((r) => {
    const region = regionName(r.regionId);
    return region ? `${r.arc} in ${region}` : r.arc;
  });
  if (recent.length > 0) out.push(`Recent threads (avoid): ${[...new Set(recent)].join("; ")}`);
  if (parts.activity.length > 0) {
    out.push("Pilot activity (region: level):");
    for (const a of parts.activity) out.push(`- ${a.region}: ${a.level}`);
  }
  if (parts.facts.length > 0) {
    out.push("News of the last days:");
    for (const f of parts.facts) out.push(`- ${f}`);
  }
  if (parts.hints.length > 0) {
    out.push("Hints:");
    for (const h of parts.hints) out.push(`- ${h.text}`);
  }
  if (offer.arcBias && offer.arcBias.length > 0) out.push(`Preferred arcs: ${offer.arcBias.join(", ")}`);
  out.push("Answer with the JSON object only.");
  return out.join("\n");
}

function buildPlotPrompt(input, S) {
  const { offer } = input;
  const regionName = (id) => {
    try {
      const n = typeof input.regionName === "function" ? input.regionName(id) : null;
      return printable(n, MAX_HINT_CHARS);
    } catch (_err) {
      return null;
    }
  };
  const parts = {
    hints: [...(offer.lines || [])],
    facts: [...(Array.isArray(input.factLines) ? input.factLines : [])],
    activity: offer.activity.map((a) => ({ region: regionName(a.regionId), level: a.level }))
      .filter((a) => a.region !== null),
    places: [...offer.places],
  };
  const cut = { hints: 0, facts: 0, activity: 0, places: 0 };
  const total = () => SYSTEM_PROMPT.length + userMessage(parts, offer, S, regionName).length;
  for (const key of ["hints", "facts", "activity", "places"]) {
    const min = key === "places" ? Math.min(MIN_PLACES, offer.places.length) : 0;
    while (total() > S.promptMaxChars && parts[key].length > min) {
      parts[key].pop();
      cut[key] += 1;
    }
  }
  const user = userMessage(parts, offer, S, regionName);
  if (SYSTEM_PROMPT.length + user.length > S.promptMaxChars) return { ok: false, reason: "PROMPT_TOO_LARGE" };
  return { ok: true, system: SYSTEM_PROMPT, user, cut };
}

function plotSpecOf(prompt, S, onAccepted) {
  return { lane: LANE, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
    minChars: MIN_ANSWER_CHARS, maxChars: S.maxProposalChars, onAccepted };
}

module.exports = { PROMPT_VERSION, SYSTEM_PROMPT, PRIVATE_KIND_PREFIXES, readHints, factsOf, isPrivateKind,
  buildPlotPrompt, plotSpecOf };
