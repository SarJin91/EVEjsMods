"use strict";

function line(usage, summary, access = "all") {
  return Object.freeze({ usage, summary, access });
}

function entry(fields) {
  return Object.freeze({ ...fields, aliases: Object.freeze(fields.aliases), lines: Object.freeze(fields.lines),
    details: fields.details ? Object.freeze(fields.details) : undefined });
}

const CATALOG = Object.freeze([
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "front",
    lines: [line("!front", "war state of this system and its region")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "jobs",
    lines: [line("!zlecenia (alias !jobs)", "today's front jobs and your progress")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "war",
    lines: [line("!kontrakty (alias !war)", "war contracts")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "board",
    lines: [line("!board", "jobs + war window")], details: ["!board (alias !tablica)",
      "!board auto on|off - open the window at login"] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "map",
    lines: [line("!map (alias !mapa)", "LNE map at your system (browser)")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "settings",
    lines: [line("!settings", "mod settings panel (allowed characters only)", "gm")],
    details: [
      line("!settings get <mod> <key>", "", "gm"),
      line("!settings set <mod> <key> <value>", "", "gm"),
      line("!settings reset <mod> <key>", "", "gm"),
      line("!settings find <mod> <text>", "", "gm"),
    ] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "npcvoices",
    lines: [line("!npcvoices", "NPC voice sample")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "ai",
    lines: [line("!ai", "chat with your ship AI (allowed pilots only)")],
    details: ["!ai help", "!ai <text>", "!ai auto [on|off|room on|off|voice on|off]", "!ai wing"] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "news",
    lines: [line("!news [off|on]", "newest Scope News; off/on = mails")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "dev",
    hideWhenOff: true, lines: [line("!dev", "development indices of this system")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "invest",
    hideWhenOff: true, lines: [line("!invest <mil|ind|trade> <amount>", "invest ISK in this system (sink)")],
    details: ["!invest yes - confirm within the time shown"] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "trigbridge",
    hideWhenOff: true, lines: [line("!trigbridge status", "Triglavian bridges (diagnostics)", "gm")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "relic",
    hideWhenOff: true, lines: [line("!relic", "your Jove/Drifter archaeology trail")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "season",
    hideWhenOff: true, lines: [line("!season", "galactic season, your points")] }),
  entry({ mod: "livingNewEden", title: "LNE", aliases: ["lne", "livingneweden"], owner: "lne", registryName: "mods",
    lines: [line("!mods [mod]", "this list; !mods lne|wing|aud for one mod")] }),
  entry({ mod: "shipWing", title: "Wing", aliases: ["wing", "shipwing"], owner: "external", dirRe: /^shipWing$/,
    lines: [line("!wing launch|return|status|...", "your ship wing; !mods wing for all")],
    details: [
      "!wing launch|return|hold|mine|attack [name]",
      "!wing drones auto|off [name]",
      "!wing formation [name]",
      "!wing status",
      "!wing ui [auto on|off]",
      "!wing store [name|off]",
      "!wing cargo [name|host]",
      "!wing move <from> to <to|host> [type]",
    ] }),
  entry({ mod: "EveJS-AdvancedUtilityDrones", title: "AUD", aliases: ["aud", "drones"], owner: "external",
    dirRe: /^EveJS-AdvancedUtilityDrones-/,
    lines: [
      line("!aud mi|sa|cp|cl|h", "utility drones (mining/salvage); !aud h for help"),
      line("/aud ...", "same commands as slash", "gm"),
    ],
    details: [
      "!aud mi [command]",
      "!aud sa [command]",
      "!aud cp <name|id>",
      "!aud cl",
      "!aud h",
    ] }),
]);

function resolveCatalog(state) {
  const registered = state && Array.isArray(state.registered) ? state.registered : [];
  const loadedDirs = state && Array.isArray(state.loadedDirs) ? state.loadedDirs : null;
  return CATALOG.map((e) => {
    if (e.owner === "lne") {
      const active = registered.includes(e.registryName);
      return { entry: e, active, shown: e.hideWhenOff === true ? active : true, unknown: false };
    }
    const unknown = loadedDirs === null;
    const shown = unknown || loadedDirs.some((dir) => e.dirRe.test(String(dir)));
    return { entry: e, active: shown, shown, unknown };
  });
}

function findMod(key) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return [];
  return CATALOG.filter((e) => e.aliases.includes(k));
}

function modKeys() {
  return [...new Set(CATALOG.map((e) => e.aliases[0]))];
}

module.exports = { CATALOG, resolveCatalog, findMod, modKeys };
