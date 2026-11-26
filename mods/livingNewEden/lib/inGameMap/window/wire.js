"use strict";

const crypto = require("node:crypto");

const WIRE_VERSION = 1;
const KEY_CHARS = 12;
const NAME_CHARS = 32;
const LABEL_CHARS = 16;

function keyOf(parts) {
  return crypto.createHash("sha1").update(JSON.stringify(parts.map((p) => String(p)))).digest("hex")
    .slice(0, KEY_CHARS);
}

function asciiName(text, max = NAME_CHARS) {
  const out = String(text ?? "").replace(/[^\x20-\x7e]/g, "?");
  return out.length > max ? out.slice(0, max) : out;
}

function refusal(reason, retryMs) {
  const out = { v: WIRE_VERSION, ok: false, reason: String(reason) };
  if (Number.isSafeInteger(retryMs) && retryMs >= 0) out.retryMs = retryMs;
  return out;
}

function toAnswer(built, known) {
  const out = { v: WIRE_VERSION, ok: true, scope: built.scope, id: built.id, at: built.at, sk: built.sk, st: built.st,
    ui: { ...built.ui } };
  if (!known || known.knownStatic !== built.sk) out.static = built.static;
  if (!known || known.knownState !== built.st) out.state = built.state;
  out.trunc = { sys: built.trunc.sys, mk: built.trunc.mk };
  return out;
}

module.exports = { WIRE_VERSION, KEY_CHARS, NAME_CHARS, LABEL_CHARS, keyOf, asciiName, refusal, toAnswer };
