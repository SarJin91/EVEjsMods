"use strict";

const { STATE, TIER } = require("./schema");
const { kindLabelOf, asciiCut, daysUntil, isRunningSeason, namerOf } = require("./hint");

const COMMAND_NAME = "season";
const COMMAND_RE = /^!\s*(?:season|sezon)(?:\s+[\s\S]*)?$/i;
const MAX_TITLES = 3;
const TIER_LABEL = Object.freeze({ [TIER.CHAMPION]: "Champion", [TIER.HERO]: "Hero", [TIER.VETERAN]: "Veteran",
  [TIER.PARTICIPANT]: "Participant" });
const TEXT = Object.freeze({
  en: Object.freeze({ none: "LNE Season: none.", failed: "LNE Season unavailable.",
    planned: (d) => `LNE Season: no season running. Next season starts in ${d} d.`,
    head: (s, faction, kind, d) => `Season ${s.seasonNo}: ${faction} ${kind} | stage ${s.stage + 1}/${s.stageCount}`
      + ` | ${d} d left | defense ${s.meterDefense} vs crisis ${s.meterCrisis}`,
    you: (points, rank) => (points > 0 ? `You: ${points} pts, rank ${rank === null ? "unranked" : rank}`
      : "You: 0 pts"),
    titles: "titles" }),
  pl: Object.freeze({ none: "Sezon LNE: brak.", failed: "Sezon LNE niedostepny.",
    planned: (d) => `Sezon LNE: brak trwajacego sezonu. Nastepny za ${d} d.`,
    head: (s, faction, kind, d) => `Sezon ${s.seasonNo}: ${faction} ${kind} | etap ${s.stage + 1}/${s.stageCount}`
      + ` | ${d} d do konca | obrona ${s.meterDefense} vs kryzys ${s.meterCrisis}`,
    you: (points, rank) => (points > 0 ? `Ty: ${points} pkt, miejsce ${rank === null ? "brak" : rank}`
      : "Ty: 0 pkt"),
    titles: "tytuly" }),
});

function matchSeasonCommand(text) {
  return COMMAND_RE.test(String(text).trim());
}

function createSeasonChat(deps) {
  const { seasons, clock, isRunning, bump } = deps;
  const P = deps.settings || {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const t = TEXT[P.language === "pl" ? "pl" : "en"];
  const max = Number.isSafeInteger(P.maxReplyChars) ? P.maxReplyChars : 1000;
  const br = typeof P.lineBreak === "string" ? (P.lineBreak === "\\n" ? "\n" : P.lineBreak) : "<br>";
  const n = namerOf(deps.names || null);

  function reply(rec) {
    const cur = seasons.current();
    if (!cur || cur.ok !== true) return null;
    const s = cur.season;
    const now = clock.now();
    if (s && s.state === STATE.PLANNED) return t.planned(daysUntil(s.startsAt, now));
    if (!isRunningSeason(s)) return t.none;
    const head = t.head(s, n.faction(s.factionId), kindLabelOf(s.crisisKind), daysUntil(s.endsAt, now));
    if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) return head;
    const score = seasons.scoreOf(rec.characterId);
    if (!score || score.ok !== true) return null;
    const titles = (Array.isArray(score.titles) ? score.titles : []).slice(0, MAX_TITLES)
      .map((x) => `S${x.seasonNo} ${TIER_LABEL[x.tier] || x.tier}`);
    const you = t.you(score.points, score.rank) + (titles.length > 0 ? ` | ${t.titles}: ${titles.join(", ")}` : "");
    return `${head}${br}${you}`;
  }

  function handle(rec, _text) {
    try {
      if (!isRunning()) return t.failed;
      const r = reply(rec);
      if (r === null) {
        bump("commandErrors");
        return t.failed;
      }
      bump("commandReplies");
      return asciiCut(r, max);
    } catch (err) {
      bump("commandErrors");
      log(`!season failed - ${String((err && err.message) || err).slice(0, 120)}`);
      return t.failed;
    }
  }

  return Object.freeze({ handle, failReply: t.failed });
}

function installSeasonCommand(adapter, chat) {
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "NO_CHAT_SEAM" };
  let r;
  try {
    r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchSeasonCommand, handle: chat.handle,
      failReply: chat.failReply });
  } catch (err) {
    return { ok: false, reason: "INSTALL_THREW", detail: String((err && err.message) || err) };
  }
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  return { ok: true, uninstall: () => {
    if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
  } };
}

module.exports = { COMMAND_NAME, COMMAND_RE, TEXT, matchSeasonCommand, createSeasonChat, installSeasonCommand };
