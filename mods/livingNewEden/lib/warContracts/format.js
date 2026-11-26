"use strict";

const { groupDigits } = require("../frontJobs/format");
const { MAX_LINE } = require("../notices/schema");
const S = require("./schema");
const { UNKNOWN } = require("../names/fallback");

const COMMAND_RE = /^!\s*(kontrakty|war)(?:\s[\s\S]*)?$/i;
const WAR_COMMAND = "!war";
const ELLIPSIS = "...";
const MICRO = 1e6;
const STANDING_DECIMALS = 3;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const HOURS_SHOWN_BELOW_MS = 2 * MS_PER_DAY;
const GROUP_PREFIX = "group:";
const CORP_TEXT = "accepted by a corporation, no reward";
const ANNOUNCE_MAX_ITEMS = 5;

function matchWarCommand(text) {
  return COMMAND_RE.test(String(text));
}

const call = (fn, arg) => {
  try {
    return typeof fn === "function" ? fn(arg) || null : null;
  } catch (_err) {
    return null;
  }
};

const factionOf = (row, names) => call(names && names.faction, row.factionId) || UNKNOWN.faction;
const typeOf = (row, names) => call(names && names.type, row.typeId) || UNKNOWN.item;
const systemOf = (id, names) => call(names && names.system, id) || UNKNOWN.system;

function stockLabelOf(row, names) {
  const key = String(row.itemKey || "");
  return key.startsWith(GROUP_PREFIX) && key.length > GROUP_PREFIX.length ? key.slice(GROUP_PREFIX.length)
    : typeOf(row, names);
}

function ageText(ms) {
  const age = Math.max(0, Number(ms) || 0);
  if (age < MS_PER_HOUR) return `${Math.floor(age / MS_PER_MINUTE)}m`;
  if (age < HOURS_SHOWN_BELOW_MS) return `${Math.floor(age / MS_PER_HOUR)}h`;
  return `${Math.floor(age / MS_PER_DAY)}d`;
}

function rewardText(row) {
  const parts = [];
  if (Number(row.lpAmount) > 0) parts.push(`+${groupDigits(row.lpAmount)} LP`);
  if (Number(row.iskAmount) > 0) parts.push(`+${groupDigits(row.iskAmount)} ISK`);
  if (Number(row.standingMicro) > 0) parts.push(`+${(row.standingMicro / MICRO).toFixed(STANDING_DECIMALS)} standing`);
  return parts.length > 0 ? parts.join(", ") : "no reward";
}

const isCorpRow = (row) => row.state === S.STATE.LAPSED && row.endReason === S.END_REASON_NO_CHARACTER;

function cutJoined(lines, maxChars, lineBreak) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const sep = out.length > 0 ? lineBreak.length : 0;
    if (used + sep + line.length <= maxChars) {
      out.push(line);
      used += sep + line.length;
      continue;
    }
    const room = maxChars - used - sep - ELLIPSIS.length;
    if (room > 0) out.push(`${line.slice(0, room)}${ELLIPSIS}`);
    else if (out.length > 0) {
      const last = out[out.length - 1];
      out[out.length - 1] = `${last.slice(0, Math.max(0, last.length - ELLIPSIS.length))}${ELLIPSIS}`;
    }
    break;
  }
  return out.join(lineBreak);
}

const cutLine = (text, maxLine) => (text.length <= maxLine ? text
  : `${text.slice(0, Math.max(0, maxLine - ELLIPSIS.length))}${ELLIPSIS}`);

function lineOf(row, v) {
  const region = call(v.regionOf, row.systemId);
  const regionName = region === null ? null : call(v.names && v.names.region, region);
  const where = `${systemOf(row.systemId, v.names)}${regionName ? ` (${regionName})` : ""}`;
  const head = `${factionOf(row, v.names)}: ${row.quantity} x ${typeOf(row, v.names)} -> ${where}`;
  if (isCorpRow(row)) return `${head}: ${CORP_TEXT}`;
  const front = call(v.frontOf, row.factionId);
  return `${head}, ${rewardText(row)}, listed ${ageText(v.now - row.adoptedAt)} ago`
    + `${front !== null ? `, front: ${systemOf(front, v.names)}` : ""}`;
}

function formatWarReply(v) {
  const lineBreak = String(v.lineBreak);
  const rows = Array.isArray(v.rows) ? v.rows : [];
  if (rows.length === 0) return cutJoined(["LNE war contracts: none open"], v.maxChars, lineBreak);
  const home = Number.isSafeInteger(v.playerRegionId) ? v.playerRegionId : null;
  const rank = (row) => (home !== null && call(v.regionOf, row.systemId) === home ? 0 : 1);
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b)
    || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0));
  const lines = ["LNE war contracts:", ...sorted.slice(0, Math.max(1, v.maxLines)).map((row) => lineOf(row, v))];
  return cutJoined(lines, v.maxChars, lineBreak);
}

function formatWarRefusal(code, o = {}) {
  switch (code) {
    case "RATE_LIMITED":
      return `LNE war contracts: wait ${Math.max(1, Math.ceil((Number(o.waitMs) || 0) / MS_PER_SECOND))} s before `
        + `the next ${WAR_COMMAND}`;
    case "BUSY":
      return "LNE war contracts: server busy, try again later";
    default:
      return `LNE war contracts unavailable (${String(o.detail || code)})`;
  }
}

function formatAwardLine(row, o, names) {
  const faction = factionOf(row, names);
  const what = `${row.quantity} x ${typeOf(row, names)} for ${faction} at ${systemOf(row.systemId, names)}`;
  let text;
  if (o.outcome === "CORP") text = `War contract delivered: ${what}, ${CORP_TEXT}.`;
  else if (o.outcome === "CAPPED") text = `War contract delivered: ${what}, daily cap reached, no reward.`;
  else text = `War contract done: ${what}. Reward ${rewardText(row)} (paid shortly).`;
  if (Number.isSafeInteger(o.stockQuantity) && o.stockQuantity >= 0) {
    const at = o.stationName || systemOf(row.systemId, names);
    text += ` ${faction} now holds ${groupDigits(o.stockQuantity)} x ${stockLabelOf(row, names)} at ${at}.`;
  }
  return cutLine(text, Number.isSafeInteger(o.maxLine) ? o.maxLine : MAX_LINE);
}

function formatAnnounceLine(rows, names, maxLine = MAX_LINE) {
  const list = Array.isArray(rows) ? rows : [];
  const items = list.slice(0, ANNOUNCE_MAX_ITEMS).map((row) => `${row.quantity} x ${typeOf(row, names)} -> `
    + `${systemOf(row.systemId, names)} for ${factionOf(row, names)} (${rewardText(row)})`);
  const more = list.length > ANNOUNCE_MAX_ITEMS ? `; +${list.length - ANNOUNCE_MAX_ITEMS} more` : "";
  return cutLine(`New war contracts in your region, type ${WAR_COMMAND} in local: ${items.join("; ")}${more}`,
    maxLine);
}

module.exports = { COMMAND_RE, matchWarCommand, formatWarReply, formatWarRefusal, formatAwardLine,
  formatAnnounceLine, ageText, CORP_TEXT, rewardText };
