"use strict";

const ELLIPSIS = "...";
const FOOTER = Object.freeze({
  en: "Scope News is an automatic service of Living New Eden. Type !news off in local chat to stop these mails.",
  pl: "Scope News to automatyczny serwis Living New Eden. Wpisz !news off w czacie lokalnym, aby wyłączyć te maile.",
});
const FOLD = Object.freeze([["ł", "l"], ["Ł", "L"], ["–", "-"], ["—", "-"], ["„", "\""], ["”", "\""], ["“", "\""],
  ["’", "'"], ["‘", "'"], ["…", "..."], ["ß", "ss"], ["ø", "o"], ["Ø", "O"], ["đ", "d"], ["Đ", "D"]]);
const COMBINING_RE = /\p{M}/gu;
const NON_PRINTABLE_RE = /[^\x20-\x7E]/g;

function asciiFold(text) {
  let out = String(text);
  for (const [from, to] of FOLD) out = out.split(from).join(to);
  return out.normalize("NFD").replace(COMBINING_RE, "").replace(NON_PRINTABLE_RE, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

function formatEditionMail(edition, opts) {
  const e = edition || {};
  const lang = opts && opts.language === "pl" ? "pl" : "en";
  const br = typeof opts.lineBreak === "string" ? opts.lineBreak : "<br>";
  const sep = `${br}${br}`;
  const headline = e.title !== null && e.title !== undefined ? e.title : e.fallbackTitle;
  const title = cut(asciiFold(`Scope News #${e.seq}: ${headline || ""}`), opts.maxTitleChars);
  const paragraphs = Array.isArray(e.paragraphs) && e.paragraphs.length > 0 ? e.paragraphs
    : (Array.isArray(e.fallbackParagraphs) ? e.fallbackParagraphs : []);
  const footer = escapeHtml(FOOTER[lang]);
  const kept = [];
  let used = footer.length;
  for (const p of paragraphs) {
    const text = escapeHtml(String(p).replace(/\s+/g, " ").trim());
    if (text === "") continue;
    if (used + sep.length + text.length > opts.maxBodyChars) break;
    kept.push(text);
    used += sep.length + text.length;
  }
  return { title, body: [...kept, footer].join(sep) };
}

module.exports = { formatEditionMail, asciiFold, FOOTER };
