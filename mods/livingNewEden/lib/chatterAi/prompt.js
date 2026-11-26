"use strict";

const { LANGUAGES } = require("./data/languages");
const { effectiveProfanity } = require("./filter");

const MILLI = 1000;
const BASE_LANGUAGE = "en";
const SWEARING_TEXT = Object.freeze({
  off: "Swearing: none, keep it clean.",
  mild: "Swearing: mild words at most, no strong swearing.",
  full: "Swearing: strong swearing is fine, never slurs or insults about race, sex or religion.",
});

function languageOf(S) {
  const code = S && typeof S.language === "string" && Object.prototype.hasOwnProperty.call(LANGUAGES, S.language)
    ? S.language : BASE_LANGUAGE;
  return { code, name: LANGUAGES[code].name };
}

function systemText(S) {
  const lang = languageOf(S);
  return [
    "You write short lines spoken by NPC pilots in the Local chat channel of a science fiction game in the style of",
    `EVE Online. Casual tone, ${lang.name} only. Write one line per row, with no numbering, no quotes, no emoji and no`,
    "links. Never mention AI, prompts, real people or real brands.",
    `Every line has at most ${S.maxTemplateChars} characters.`,
    "Placeholders are words in curly braces, written exactly like {name}, and only from the given list; a line may",
    "use none of them.",
  ].join(" ");
}

function userText(bucket, S) {
  const placeholders = bucket.placeholders.length > 0
    ? bucket.placeholders.map((p) => `{${p}}`).join(" ") : "none";
  const rows = [`Topic: ${bucket.hint}`];
  if (typeof bucket.style === "string" && bucket.style !== "") rows.push(`Style: ${bucket.style}`);
  if (bucket.profanityCap !== undefined && bucket.profanityCap !== null) {
    rows.push(SWEARING_TEXT[effectiveProfanity(S.profanity, bucket.profanityCap)]);
  }
  rows.push(`Placeholders: ${placeholders}`);
  const examples = bucket.examples.slice(0, S.promptExamples);
  if (examples.length > 0) rows.push("Examples:", ...examples.map((t) => `- ${t}`));
  const lang = languageOf(S);
  if (lang.code !== BASE_LANGUAGE) rows.push(`Write the lines in ${lang.name}; the examples are in English.`);
  rows.push(`Write ${S.linesPerRequest} new varied lines.`);
  return rows.join("\n");
}

function buildMessages(bucket, S) {
  return [
    { role: "system", content: systemText(S) },
    { role: "user", content: userText(bucket, S) },
  ];
}

function buildRequestBody(bucket, S) {
  const body = {
    model: S.model,
    messages: buildMessages(bucket, S),
    temperature: S.temperatureMilli / MILLI,
    top_p: S.topPMilli / MILLI,
    max_tokens: S.maxTokens,
    stream: false,
  };
  if (S.reasoningOff === true) body.chat_template_kwargs = { enable_thinking: false };
  return JSON.stringify(body);
}

function buildTalkBody(messages, S) {
  const body = {
    model: S.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: S.temperatureMilli / MILLI,
    top_p: S.topPMilli / MILLI,
    max_tokens: S.talkMaxTokens,
    stream: false,
  };
  if (S.reasoningOff === true) body.chat_template_kwargs = { enable_thinking: false };
  return JSON.stringify(body);
}

function buildNewsBody(messages, S) {
  const body = {
    model: S.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: S.temperatureMilli / MILLI,
    top_p: S.topPMilli / MILLI,
    max_tokens: S.newsMaxTokens,
    stream: false,
  };
  if (S.reasoningOff === true) body.chat_template_kwargs = { enable_thinking: false };
  return JSON.stringify(body);
}

function buildPlotBody(messages, S) {
  const body = {
    model: S.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: S.temperatureMilli / MILLI,
    top_p: S.topPMilli / MILLI,
    max_tokens: S.plotMaxTokens,
    stream: false,
  };
  if (S.reasoningOff === true) body.chat_template_kwargs = { enable_thinking: false };
  return JSON.stringify(body);
}

module.exports = { buildMessages, buildRequestBody, buildTalkBody, buildNewsBody, buildPlotBody };
