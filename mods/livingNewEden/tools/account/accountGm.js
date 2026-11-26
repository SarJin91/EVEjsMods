"use strict";

const COMMANDS = Object.freeze(["on", "off", "status"]);
const DRY_RUN_FLAG = "--dry-run";
const USER_NAME_MAX_LENGTH = 64;
const SIMILAR_MAX = 5;

const usage = (message) => ({ ok: false, reason: "USAGE", message });

function userNameProblem(userName) {
  if (typeof userName !== "string" || userName === "") return "account name is empty";
  if (userName.length > USER_NAME_MAX_LENGTH) return `account name longer than ${USER_NAME_MAX_LENGTH} characters`;
  if (userName.includes("/")) return "account name must not contain '/'";
  if (userName.trim() !== userName) return "account name must not start or end with whitespace";
  return null;
}

function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const positional = [];
  let dryRun = false;
  for (const arg of list) {
    const text = String(arg);
    if (text === DRY_RUN_FLAG) dryRun = true;
    else if (text.startsWith("--")) return usage(`unknown flag ${text}`);
    else positional.push(text);
  }
  if (positional.length === 0) return usage("missing command (on | off | status)");
  const cmd = positional[0];
  if (!COMMANDS.includes(cmd)) return usage(`unknown command ${cmd}`);
  if (positional.length > 2) return usage(`too many arguments: ${positional.slice(2).join(" ")}`);
  const userName = positional.length === 2 ? positional[1] : null;
  if (cmd === "status" && dryRun) return usage(`${DRY_RUN_FLAG} only with on | off`);
  if (cmd !== "status" && userName === null) return usage(`${cmd} needs an account name`);
  if (userName !== null) {
    const problem = userNameProblem(userName);
    if (problem) return usage(problem);
  }
  return { ok: true, cmd, userName, dryRun };
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function summarize(record, buildRecord) {
  const source = record && typeof record === "object" ? record : {};
  const normalized = buildRecord({ ...source });
  return {
    isGM: normalized.isGM === true,
    role: String(source.role != null ? source.role : normalized.role),
    chatRole: String(source.chatRole != null ? source.chatRole : normalized.chatRole),
    banned: Boolean(source.banned),
  };
}

function planGmChange(accounts, userName, wantGm, buildRecord) {
  const map = accounts && typeof accounts === "object" ? accounts : {};
  const name = String(userName);
  if (!hasOwn(map, name)) {
    const lower = name.toLowerCase();
    const similar = Object.keys(map).filter((key) => key.toLowerCase() === lower).sort().slice(0, SIMILAR_MAX);
    return { ok: false, reason: "NOT_FOUND", similar };
  }
  const current = map[name] && typeof map[name] === "object" ? map[name] : {};
  const record = buildRecord({ ...current, isGM: wantGm === true });
  const changed = JSON.stringify(current) !== JSON.stringify(record);
  return {
    ok: true,
    changed,
    before: summarize(current, buildRecord),
    after: summarize(record, buildRecord),
    record,
  };
}

function listAccounts(accounts, buildRecord) {
  const map = accounts && typeof accounts === "object" ? accounts : {};
  return Object.keys(map)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((userName) => ({ userName, ...summarize(map[userName], buildRecord) }));
}

module.exports = {
  COMMANDS,
  DRY_RUN_FLAG,
  USER_NAME_MAX_LENGTH,
  parseArgs,
  planGmChange,
  summarize,
  listAccounts,
};
