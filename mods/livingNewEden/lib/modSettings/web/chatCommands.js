"use strict";

const { findMod } = require("../../modsHelp/catalog");
const { escapeChatText } = require("../../inGameMap/format");

const PREFIX = "LNE settings:";
const PREFIX_RE = /^!\s*settings/i;
const MAX_FIND_KEYS = 10;
const MAX_ECHO_CHARS = 64;
const ELLIPSIS = "...";
const PARTIAL_ENTITY_RE = /&[#a-z0-9]*$/i;
const APPLY_TEXT = Object.freeze({ live: "live", restart: "restart needed" });
const HELP = `${PREFIX} !settings = panel link | !settings get <mod> <key> | !settings set <mod> <key> <value> | `
  + "!settings reset <mod> <key> | !settings find <mod> <text> (mod: lne, wing or a mod id)";

function modIdOf(word) {
  const hit = findMod(word);
  return hit.length > 0 ? hit[0].mod : String(word);
}

function parseSettingsCommand(text) {
  const out = (cmd, mod = null, key = null, value = null) => ({ cmd, mod, key, value });
  const rest = String(text ?? "").trim().replace(PREFIX_RE, "").trim();
  if (rest === "") return out("link");
  const words = /^(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(rest);
  if (!words) return out("help");
  const sub = words[1].toLowerCase();
  const [mod, key, tail] = [words[2], words[3], words[4] === undefined ? "" : words[4].trim()];
  if (!mod || !key) return out("help");
  if ((sub === "get" || sub === "reset") && tail === "") return out(sub, modIdOf(mod), key);
  if (sub === "set" && tail !== "") return out("set", modIdOf(mod), key, tail);
  if (sub === "find") return out("find", modIdOf(mod), tail === "" ? key : `${key} ${tail}`);
  return out("help");
}

function valueText(value) {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "string") return value === "" ? "\"\"" : value;
  return JSON.stringify(value);
}

function echo(text) {
  return escapeChatText(String(text ?? "").slice(0, MAX_ECHO_CHARS));
}

function fit(text, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).replace(PARTIAL_ENTITY_RE, "")}${ELLIPSIS}`;
}

function rangeOf(row) {
  const hasMin = typeof row.min === "number";
  const hasMax = typeof row.max === "number";
  if (hasMin && hasMax) return `, range ${row.min}-${row.max}`;
  if (hasMin) return `, range >= ${row.min}`;
  if (hasMax) return `, range <= ${row.max}`;
  if (Array.isArray(row.values)) return `, values ${row.values.join("|")}`;
  return "";
}

function formatGetReply(row, opts) {
  const lock = row.locked ? `, locked ${row.lockReason || "?"}` : "";
  const text = `${row.key} = ${valueText(row.next)} (running ${valueText(row.running)}, source ${row.source || "-"}, `
    + `default ${valueText(row.default)}${rangeOf(row)}${lock})`;
  return fit(escapeChatText(text), opts.maxReplyChars);
}

function formatFindReply(page, fragment, opts) {
  const lineBreak = String(opts.lineBreak);
  const head = `${escapeChatText(page.modId)}: `;
  if (page.total === 0) return fit(`${head}no key matches "${echo(fragment)}"`, opts.maxReplyChars);
  const lines = [`${head}${page.total} keys match "${echo(fragment)}"`,
    ...page.rows.slice(0, MAX_FIND_KEYS).map((r) => escapeChatText(`${r.key} = ${valueText(r.next)}`))];
  let more = page.total - (lines.length - 1);
  const joined = () => [...lines, ...(more > 0 ? [`${ELLIPSIS} ${more} more`] : [])].join(lineBreak);
  while (lines.length > 1 && joined().length > opts.maxReplyChars) {
    lines.pop();
    more += 1;
  }
  return fit(joined(), opts.maxReplyChars);
}

function formatWriteReply(key, result, opts) {
  const r = result && typeof result === "object" ? result : { ok: false, reason: "NO_RESULT" };
  const name = escapeChatText(key);
  if (r.ok !== true) {
    const detail = typeof r.detail === "string" && r.detail !== "" ? ` (${escapeChatText(r.detail)})` : "";
    return fit(`${name}: refused: ${escapeChatText(r.reason || "UNKNOWN")}${detail}`, opts.maxReplyChars);
  }
  const apply = APPLY_TEXT[r.apply] || escapeChatText(r.apply || "restart");
  const warning = Array.isArray(r.warnings) && r.warnings.length > 0 ? ` - ${escapeChatText(r.warnings[0])}` : "";
  return fit(`${name}: ok (${apply})${r.changed === false ? ", no change" : ""}${warning}`, opts.maxReplyChars);
}

function formatCommandRefusal(command, reason, opts) {
  const what = `${echo(command.mod)}${command.key && command.cmd !== "find" ? ` ${echo(command.key)}` : ""}`;
  if (reason === "UNKNOWN_KEY") {
    return fit(`${PREFIX} no key ${what} (try !settings find)`, opts.maxReplyChars);
  }
  if (reason === "NOT_ENABLED") {
    return fit(`${PREFIX} mod ${echo(command.mod)} is not in modSettings.mods`, opts.maxReplyChars);
  }
  return fit(`${PREFIX} ${what}: refused: ${escapeChatText(reason)}`, opts.maxReplyChars);
}

module.exports = { HELP, MAX_FIND_KEYS, parseSettingsCommand, valueText, formatGetReply, formatFindReply,
  formatWriteReply, formatCommandRefusal };
