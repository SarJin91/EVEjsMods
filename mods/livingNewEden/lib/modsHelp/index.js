"use strict";

const { createLiveRateLimiter } = require("../frontChat/rateLimit");
const { resolveCatalog, findMod, modKeys } = require("./catalog");

const COMMAND_RE = /^!\s*mods(?:\s[\s\S]*)?$/i;
const COMMAND_PREFIX_RE = /^!\s*mods/i;
const COMMAND_NAME = "mods";
const FAIL_REPLY = "LNE: !mods unavailable (HANDLER_FAILED)";
const HEADER = "Mod commands (type in Local):";
const HEADER_PAGE = "Mod commands, page";
const FOOTER_EXTERNAL = "other mods: works when enabled in that mod's settings";
const CLI_LINE = "CLI tools: mods/livingNewEden/README.md, section \"Operator tools\"";
const PAGE_RE = /^[1-9]\d{0,2}$/;
const MAX_KEY_ECHO = 32;
const MAX_DETAIL = 120;
const MS_PER_SECOND = 1000;
const COUNTER_NAMES = Object.freeze(["replies", "rateLimited", "errors"]);
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function matchModsCommand(text) {
  return COMMAND_RE.test(String(text));
}

function argsOf(text) {
  const words = String(text ?? "").trim().replace(COMMAND_PREFIX_RE, "").trim().split(/\s+/).filter(Boolean)
    .map((w) => w.toLowerCase());
  const pageOf = (w) => (w && PAGE_RE.test(w) ? Number(w) : null);
  if (words.length > 0 && pageOf(words[0]) !== null) return { filter: "", page: pageOf(words[0]) };
  return { filter: words[0] || "", page: pageOf(words[1]) || 1 };
}

function flagOf(row) {
  if (row.entry.owner === "lne") return row.active ? "" : " (off)";
  if (row.unknown) return " (?)";
  return row.shown ? "" : " (not loaded)";
}

function lineOf(row, usage, summary, access) {
  const gm = access === "gm" ? "[GM] " : "";
  return `${gm}[${row.entry.title}] ${usage}${summary ? ` - ${summary}` : ""}${flagOf(row)}`;
}

function rowLines(row, detailed) {
  const e = row.entry;
  if (!detailed || !e.details) return e.lines.map((l) => lineOf(row, l.usage, l.summary, l.access));
  return [...e.details.map((d) => (typeof d === "string" ? lineOf(row, d, "", "all")
    : lineOf(row, d.usage, d.summary, d.access))),
    ...e.lines.filter((l) => l.access === "gm").map((l) => lineOf(row, l.usage, l.summary, l.access))];
}

function joinedLength(lines, lineBreak) {
  return lines.reduce((sum, l) => sum + l.length, 0) + Math.max(0, lines.length - 1) * lineBreak.length;
}

function paginate(all, lineBreak, maxChars, moreOf, headOf) {
  const pages = [];
  let i = 0;
  while (i < all.length) {
    const k = pages.length + 1;
    const page = k === 1 ? [] : [headOf(k)];
    const first = page.length;
    while (i < all.length) {
      const cand = [...page, all[i]];
      const need = i === all.length - 1 ? cand : [...cand, moreOf(k + 1)];
      if (page.length > first && joinedLength(need, lineBreak) > maxChars) break;
      page.push(all[i]);
      i += 1;
    }
    if (i < all.length) page.push(moreOf(k + 1));
    pages.push(page.join(lineBreak).slice(0, maxChars));
  }
  return pages;
}

function formatModsReply(rows, opts) {
  const lineBreak = String(opts && opts.lineBreak != null ? opts.lineBreak : "\n");
  const maxChars = Number.isSafeInteger(opts && opts.maxReplyChars) && opts.maxReplyChars > 0
    ? opts.maxReplyChars : Number.MAX_SAFE_INTEGER;
  const filter = String((opts && opts.filter) || "").trim().toLowerCase();
  const page = Number.isSafeInteger(opts && opts.page) && opts.page > 0 ? opts.page : 1;
  let picked;
  if (filter) {
    const known = new Set(findMod(filter));
    if (known.size === 0) {
      return `Unknown mod ${filter.slice(0, MAX_KEY_ECHO)}. Mods: ${modKeys().join(", ")}.`;
    }
    picked = rows.filter((r) => known.has(r.entry));
  } else {
    picked = rows.filter((r) => r.shown);
  }
  const body = picked.flatMap((r) => rowLines(r, Boolean(filter)));
  const tail = [];
  if (picked.some((r) => r.entry.owner === "external")) tail.push(FOOTER_EXTERNAL);
  tail.push(CLI_LINE);
  const all = [HEADER, ...body, ...tail];
  if (page === 1 && joinedLength(all, lineBreak) <= maxChars) return all.join(lineBreak);
  const cmd = filter ? `!mods ${filter}` : "!mods";
  const pages = paginate(all, lineBreak, maxChars, (k) => `... ${cmd} ${k} for more`,
    (k) => `${HEADER_PAGE} ${k}:`);
  if (page > pages.length) {
    return `LNE mods: no page ${page} of ${cmd} (${pages.length} page${pages.length === 1 ? "" : "s"})`;
  }
  return pages[page - 1];
}

function startModsHelp(deps) {
  const config = deps && deps.config;
  const settings = config && config.modsHelp;
  if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const adapter = deps.adapter || null;
  if (!adapter || typeof adapter.installChatCommand !== "function" || typeof adapter.listChatCommands !== "function") {
    return { ok: false, reason: "adapter_unavailable" };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const fc = config.frontChat || {};
  const liveConfig = deps.liveConfig && typeof deps.liveConfig.get === "function" ? deps.liveConfig : null;
  const live = () => {
    const c = liveConfig ? liveConfig.get() : null;
    return c && c.modsHelp ? c.modsHelp : settings;
  };
  const limiter = createLiveRateLimiter(() => ({ cooldownMs: live().cooldownMs, maxPerMinute: fc.maxRepliesPerMinute,
    maxTracked: fc.maxTrackedCharacters }), () => (liveConfig ? liveConfig.version : 0));
  const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");
  let state = STATE.STARTING;
  let anonymous = 0;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`modsHelp: ${line}`);
    } catch (_err) {
    }
  }

  let loadedDirs = null;
  try {
    const r = typeof adapter.listLoadedModDirs === "function" ? adapter.listLoadedModDirs() : null;
    if (r && r.ok === true && Array.isArray(r.dirs)) loadedDirs = r.dirs;
    else log(`loaded mods unknown - ${(r && r.reason) || "no_seam"}${r && r.detail ? `:${r.detail}` : ""}`);
  } catch (err) {
    log(`loaded mods unknown - ${messageOf(err)}`);
  }

  function limiterKey(rec) {
    if (rec && Number.isSafeInteger(rec.characterId) && rec.characterId > 0) return rec.characterId;
    anonymous += 1;
    return `anon:${anonymous}`;
  }

  function handle(rec, text) {
    try {
      if (state !== STATE.RUNNING) return `LNE: !mods unavailable (${state.toUpperCase()})`;
      const taken = limiter.take(limiterKey(rec), clock.now());
      if (!taken.ok) {
        counters.rateLimited += 1;
        return `LNE mods: wait ${Math.max(1, Math.ceil(taken.waitMs / MS_PER_SECOND))}s before the next !mods`;
      }
      const rows = resolveCatalog({ registered: adapter.listChatCommands(), loadedDirs });
      const { filter, page } = argsOf(text);
      const reply = formatModsReply(rows, { filter, page, lineBreak, maxReplyChars: live().maxReplyChars });
      counters.replies += 1;
      return reply;
    } catch (err) {
      counters.errors += 1;
      log(`reply failed - ${messageOf(err)}`);
      return FAIL_REPLY;
    }
  }

  let installed;
  try {
    installed = adapter.installChatCommand({ name: COMMAND_NAME, match: matchModsCommand, handle,
      failReply: FAIL_REPLY });
  } catch (err) {
    installed = { ok: false, reason: "THREW", detail: messageOf(err) };
  }
  if (!installed || installed.ok !== true) {
    return { ok: false, reason: "MODS_HELP_SEAM_UNAVAILABLE",
      detail: installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result" };
  }
  state = STATE.RUNNING;

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    try {
      if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
    } catch (err) {
      log(`uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  return { ok: true, modsHelp: Object.freeze({
    getStatus: () => ({ state, ...counters, loadedMods: loadedDirs === null ? null : loadedDirs.length,
      tracked: limiter.size() }),
    stop,
    handle,
  }) };
}

module.exports = { COMMAND_RE, COMMAND_NAME, FAIL_REPLY, matchModsCommand, formatModsReply, startModsHelp };
