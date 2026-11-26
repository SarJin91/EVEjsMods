"use strict";

const { COMMAND_RE } = require("./schema");

const MAX_TEXT_CHARS = 1000;

function parseAiCommand(line) {
  const text = String(line ?? "").trim();
  if (!COMMAND_RE.test(text)) return null;
  const rest = text.replace(/^!\s*ai/i, "").trim();
  const word = rest.toLowerCase();
  if (word === "" || word === "open") return { kind: "open" };
  if (word === "help" || word === "?") return { kind: "help" };
  const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  const verb = head ? head[1].toLowerCase() : "";
  const arg = head && head[2] ? head[2].trim().slice(0, MAX_TEXT_CHARS) : "";
  if (verb === "memory" && arg === "") return { kind: "memory" };
  if (verb === "remember") return { kind: "remember", text: arg };
  if (verb === "forget") {
    const lower = arg.toLowerCase().replace(/\s+/g, " ");
    if (lower === "all") return { kind: "forgetAll" };
    if (lower === "all confirm") return { kind: "forgetAllConfirm" };
    const id = /^#(\d{1,15})$/.exec(arg);
    if (id) return { kind: "forget", id: Number(id[1]) };
    return { kind: "forget", text: arg };
  }
  if (verb === "name") return { kind: "name", name: arg };
  if (word === "quiet") return { kind: "quiet" };
  if (word === "talk") return { kind: "talk" };
  if (verb === "mail") {
    const lower = arg.toLowerCase();
    if (lower === "on" || lower === "off" || lower === "quiet") return { kind: "mailMode", mode: lower };
    const ask = /^(\d{1,2})(?:\s+([\s\S]*))?$/.exec(arg);
    if (ask && Number(ask[1]) >= 1) return { kind: "mailAsk", n: Number(ask[1]), text: (ask[2] || "").trim() };
    return { kind: "mail" };
  }
  if (verb === "voice") {
    const lower = arg.toLowerCase();
    if (lower === "" || lower === "on") return { kind: "voice", action: "on" };
    if (lower === "off" || lower === "status") return { kind: "voice", action: lower };
    return { kind: "help" };
  }
  if (verb === "persona") {
    const lower = arg.toLowerCase();
    if (lower === "") return { kind: "persona", action: "show" };
    if (lower === "list" || lower === "reset") return { kind: "persona", action: lower };
    const custom = /^custom(?:\s+([\s\S]*))?$/i.exec(arg);
    if (custom) return { kind: "persona", action: "custom", text: (custom[1] || "").trim() };
    return { kind: "persona", action: "set", preset: lower };
  }
  if (verb === "alerts" || verb === "scan") {
    const lower = arg.toLowerCase();
    if (lower === "on" || lower === "off") return { kind: `${verb}Mode`, mode: lower };
    return { kind: verb };
  }
  if (verb === "wing") return { kind: "wing" };
  if (verb === "mute" || verb === "unmute") {
    const target = arg.split(/\s+/)[0].toUpperCase();
    if (target === "") return { kind: "muteList" };
    return { kind: verb, target };
  }
  if (verb === "auto") {
    const words = arg.toLowerCase().split(/\s+/).filter((w) => w !== "");
    const isOnOff = (w) => w === "on" || w === "off";
    if (words.length === 1 && isOnOff(words[0])) return { kind: "autoMode", target: "all", on: words[0] === "on" };
    if (words.length === 2 && (words[0] === "room" || words[0] === "voice") && isOnOff(words[1])) {
      return { kind: "autoMode", target: words[0], on: words[1] === "on" };
    }
    return { kind: "auto" };
  }
  return { kind: "say", text: rest.slice(0, MAX_TEXT_CHARS) };
}

const MEMORY_KINDS = Object.freeze(["memory", "remember", "forget", "forgetAll", "forgetAllConfirm", "name"]);
const QUIET_KINDS = Object.freeze(["quiet", "talk"]);
const MAIL_KINDS = Object.freeze(["mail", "mailMode", "mailAsk"]);
const PERSONA_KINDS = Object.freeze(["persona"]);
const ALERT_KINDS = Object.freeze(["alerts", "alertsMode", "scan", "scanMode", "wing"]);
const MUTE_KINDS_CMD = Object.freeze(["muteList", "mute", "unmute"]);
const AUTO_KINDS = Object.freeze(["auto", "autoMode"]);

module.exports = { parseAiCommand, MAX_TEXT_CHARS, MEMORY_KINDS, QUIET_KINDS, MAIL_KINDS, PERSONA_KINDS,
  ALERT_KINDS, MUTE_KINDS_CMD, AUTO_KINDS };
