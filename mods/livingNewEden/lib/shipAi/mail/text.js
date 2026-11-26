"use strict";

const { sanitizeGameText } = require("../context");

const BREAK_RE = /<\s*(?:br\s*\/?|\/\s*p|\/\s*div)\s*>/gi;
const TAG_RE = /<[^>]*>/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S*/gi;
const ENTITIES = Object.freeze({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'",
  "&apos;": "'", "&nbsp;": " " });
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi;

function mailText(body, max) {
  const text = String(body ?? "").replace(BREAK_RE, " ").replace(TAG_RE, " ")
    .replace(ENTITY_RE, (e) => ENTITIES[e.toLowerCase()] || " ")
    .replace(TAG_RE, " ").replace(URL_RE, " ");
  return sanitizeGameText(text, max);
}

function mailTitle(title, max) {
  return mailText(title, max);
}

module.exports = { mailText, mailTitle };
