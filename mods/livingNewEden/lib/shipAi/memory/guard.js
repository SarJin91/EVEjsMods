"use strict";

const INJECTION_PATTERNS = Object.freeze([
  /\b(?:ignore|disregard|forget|override|bypass|drop)\b.{0,40}\b(?:instructions?|rules?|prompts?|guidelines?|directives?|orders?)\b/,
  /\bsystem\s*prompt\b/,
  /\byou\s+are\s+now\b/,
  /\bact\s+as\b/,
  /\bdeveloper\s+mode\b/,
  /\bjailbreak/,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/,
  /\bnew\s+instructions?\b/,
  /(?:^|[^\p{L}])(?:zignoruj|ignoruj|zapomnij|pomiń|pomin|olej)\p{L}*.{0,40}(?:zasad|instrukcj|reguł|regul|polece)/u,
  /(?:^|[^\p{L}])jeste[śs]\s+teraz(?:$|[^\p{L}])/u,
  /(?:^|[^\p{L}])udawaj/u,
  /(?:^|[^\p{L}])tryb\s+(?:dewelopera|developera)/u,
  /(?:^|[^\p{L}])prompt\s+systemow/u,
  /(?:^|[^\p{L}])nowe\s+instrukcj/u,
]);

const ROLE_COMMAND_PATTERNS = Object.freeze([
  /^(?:you\s+(?:must|shall|will\s+now|have\s+to|should\s+always|should\s+never)|always\s+(?:answer|reply|respond|obey)|never\s+(?:refuse|answer|reply|mention))\b/,
  /^(?:musisz|zawsze\s+(?:odpowiadaj|słuchaj|sluchaj)|nigdy\s+nie\s+(?:odmawiaj|odpowiadaj))(?:$|[^\p{L}])/u,
]);

const ROLE_MARKER_RE = /(?:^|["'`\s(\[])(?:system|assistant|developer|tool)\s*:/;

function prepare(text) {
  return String(text ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").toLowerCase().replace(/\s+/g, " ").trim();
}

function checkInjection(text) {
  const t = prepare(text);
  if (t === "") return { ok: true };
  if (INJECTION_PATTERNS.some((re) => re.test(t))) return { ok: false, reason: "INJECTION" };
  if (ROLE_COMMAND_PATTERNS.some((re) => re.test(t))) return { ok: false, reason: "INJECTION" };
  if (ROLE_MARKER_RE.test(t)) return { ok: false, reason: "INJECTION" };
  return { ok: true };
}

module.exports = { checkInjection, INJECTION_PATTERNS, ROLE_COMMAND_PATTERNS, ROLE_MARKER_RE };
