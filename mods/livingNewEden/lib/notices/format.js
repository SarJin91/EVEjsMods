"use strict";

const { STRUCTURE_TYPE_IDS } = require("../stations/data/structureTypes");
const { UNKNOWN } = require("../names/fallback");

const TITLE_PREFIX = "LNE: ";
const ELLIPSIS = "...";
const FOOTER = "-- Living New Eden front report. This mail is sent automatically; replies are not read.";
const DEFAULTS = Object.freeze({ lineBreak: "<br>", maxBodyChars: 8000, maxTitleChars: 150 });

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function cut(text, max) {
  if (text.length <= max) return text;
  if (max <= ELLIPSIS.length) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

function titleOf(lines, maxTitleChars) {
  if (lines.length === 1) {
    const one = oneLine(lines[0]);
    return cut(one ? `${TITLE_PREFIX}${one}` : "LNE front report", maxTitleChars);
  }
  return cut(`LNE front report: ${lines.length} events`, maxTitleChars);
}

function formatMail(lines, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const list = (Array.isArray(lines) ? lines : []).map((l) => oneLine(l)).filter((l) => l.length > 0);
  const title = titleOf(list.length > 0 ? list : [""], o.maxTitleChars);
  const br = String(o.lineBreak);
  const tail = `${br}${br}${FOOTER}`;
  const body = list.map(escapeHtml);
  let kept = body.length;
  const build = (n) => {
    const head = body.slice(0, n).join(br);
    const more = n < body.length ? `${n > 0 ? br : ""}${ELLIPSIS} ${body.length - n} more` : "";
    return `${head}${more}${tail}`;
  };
  let text = build(kept);
  while (text.length > o.maxBodyChars && kept > 0) {
    kept -= 1;
    text = build(kept);
  }
  return { title, body: cut(text, o.maxBodyChars) };
}

const MAX_NOTICE_LINE = 400;
const END_REASON_NATIVE = "NATIVE_DESTROYED";

function factionOf(names, id) {
  if (id === null || id === undefined) return null;
  const name = names && typeof names.get === "function" ? names.get(id) : undefined;
  return name ? oneLine(name) : UNKNOWN.faction;
}

function possessive(name) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function clockOf(at) {
  const d = new Date(Number.isFinite(at) ? at : 0);
  return Number.isNaN(d.getTime()) ? "--:--" : d.toISOString().slice(11, 16);
}

const SIEGE_END_TEXT = Object.freeze({
  REPELLED: (a, d) => `${d || "the owner"} repelled ${a || "the attackers"}.`,
  DESTROYED: (a) => `station destroyed by ${a || "the attackers"}.`,
  CAPTURED: (a) => `station captured by ${a || "the attackers"}.`,
  SACKED: (a) => `station sacked by ${a || "the attackers"}.`,
  ABORTED: (a) => `${a || "the attackers"} called off the siege.`,
});

const STRUCTURE_NAMES = new Map(Object.entries(STRUCTURE_TYPE_IDS)
  .map(([name, typeId]) => [typeId, `${name.charAt(0).toUpperCase()}${name.slice(1)}`]));
const STRUCTURE_SIEGE_END_TEXT = Object.freeze({
  DESTROYED: (a) => `destroyed by ${a || "the attackers"}`,
  REPELLED: (a) => `held, ${a || "the attackers"} withdrew`,
  HALTED: (a) => `${a || "the attackers"} halted the siege`,
  ABORTED: (a) => `${a || "the attackers"} called off the siege`,
});
const STRUCTURE_SIEGE_REASON_TEXT = Object.freeze({
  DESTROYED: null,
  REPAIRED: "the structure was repaired",
  ATTACKER_GONE: "the attacking fleet left",
  INSUFFICIENT_FORCE: "the attacking fleet was too weak",
  CONTESTED_TIMEOUT: "the system stayed contested",
  OWNER_OFFLINE: "no member of the owner corporation was active recently",
  OWNER_UNKNOWN: "the activity of the owner corporation could not be read",
  FINAL_DISABLED: "final assaults are disabled on this server",
  NO_ASSET_SAFETY: "the structure has no asset safety",
  STRUCTURE_GONE: "the structure is gone",
  OWNER_CHANGED: "the structure changed owner",
  STATE_CHANGED: "the structure state changed",
  VENDOR_STUCK: "the structure timer did not move",
  VENDOR_REFUSED: "the structure refused the damage",
  HIT_NO_EFFECT: "the damage had no effect",
  STEP_LOST: "the siege lost track of its next step",
});

function structureOf(typeId) {
  const name = STRUCTURE_NAMES.get(typeId);
  if (name) return name;
  return "structure";
}

function structureSiegeEnd(event, a) {
  const head = STRUCTURE_SIEGE_END_TEXT[event.outcome] ? STRUCTURE_SIEGE_END_TEXT[event.outcome](a)
    : String(event.outcome);
  const code = typeof event.endReason === "string" ? event.endReason : null;
  const why = code === null ? null : (Object.prototype.hasOwnProperty.call(STRUCTURE_SIEGE_REASON_TEXT, code)
    ? STRUCTURE_SIEGE_REASON_TEXT[code] : code);
  return why ? `${head} (${why}).` : `${head}.`;
}

function allianceOf(event) {
  if (typeof event.allianceName === "string" && event.allianceName !== "") return oneLine(event.allianceName);
  return UNKNOWN.alliance;
}

const MS_PER_HOUR = 3600000;

const HEAVY_EVENT_LABEL = Object.freeze({ redoubt: "Redoubt", foundry: "Field Foundry", defense: "Outpost Defense" });
const HEAVY_TIER_LABEL = Object.freeze(["I", "II", "III"]);

const MS_PER_MINUTE = 60000;
const MAX_LOSS_ITEMS_IN_LINE = 6;
const HARVEST_TARGET_NAME = Object.freeze({ metenox: "Metenox Moon Drill", skyhook: "Orbital Skyhook" });
const HARVEST_RAID_END_TEXT = Object.freeze({
  REPELLED: (a) => `the ${a || "hostile"} raiders left or were destroyed. Nothing was taken.`,
  EXPIRED: (a) => `the ${a || "hostile"} raiders ran out of time. Nothing was taken.`,
});
const HARVEST_RAID_REASON_TEXT = Object.freeze({
  TARGET_GONE: "the structure is gone",
  TARGET_DESTROYED: "the structure was destroyed",
  OWNER_CHANGED: "the structure changed owner",
  SIEGE_OPEN: "a siege of the structure started",
  STEP_LOST: "the raid lost track of its next step",
  NOTHING_TAKEN: "the moon material was moved out",
  WALL_DEADLINE: null,
  NO_HOLD: null,
  TAKEN: null,
});

function harvestTargetOf(event) {
  return Object.prototype.hasOwnProperty.call(HARVEST_TARGET_NAME, event.targetKind)
    ? HARVEST_TARGET_NAME[event.targetKind] : "structure";
}

function harvestReasonOf(event) {
  const code = typeof event.endReason === "string" ? event.endReason : null;
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(HARVEST_RAID_REASON_TEXT, code) ? HARVEST_RAID_REASON_TEXT[code] : code;
}

function lossText(loss) {
  const list = (Array.isArray(loss) ? loss : []).slice()
    .sort((x, y) => y.units - x.units || x.typeId - y.typeId);
  const shown = list.slice(0, MAX_LOSS_ITEMS_IN_LINE).map((l) => `${typeof l.name === "string" && l.name !== ""
    ? oneLine(l.name) : "moon material"} x ${l.units}`);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more types` : shown.join(", ");
}

function harvestRaidWarned(event, a, place) {
  const minutes = Number.isSafeInteger(event.leadMs) && event.leadMs >= 0
    ? Math.round(event.leadMs / MS_PER_MINUTE) : null;
  const when = minutes === null ? "Soon they take part of the moon material."
    : `In about ${minutes} minutes of online time they take part of the moon material.`;
  return `Raid warning: ${a || "hostile"} raiders are at your ${harvestTargetOf(event)} in ${place}. ${when} The `
    + "time counts only while a member of your corporation is online. To stop it: move the moon material out of the "
    + "structure, or destroy their fleet.";
}

function harvestRaidEnded(event, a, place) {
  const head = `Raid over in ${place}: your ${harvestTargetOf(event)} - `;
  const why = harvestReasonOf(event);
  if (Object.prototype.hasOwnProperty.call(HARVEST_RAID_END_TEXT, event.outcome)) {
    return `${head}${HARVEST_RAID_END_TEXT[event.outcome](a)}`;
  }
  if (event.outcome === "ABORTED") {
    return `${head}the raid was called off${why ? ` (${why})` : ""}. Nothing was taken.`;
  }
  if (event.outcome === "SETTLED") {
    const loss = Array.isArray(event.loss) ? event.loss : [];
    if (loss.length > 0) return `${head}${a || "the raiders"} took ${lossText(loss)}.`;
    return `${head}nothing was taken${why ? ` (${why})` : ""}.`;
  }
  return `${head}${String(event.outcome)}.`;
}

function reinforceSentence(event) {
  const hours = Number.isSafeInteger(event.reinforceMs) ? Math.round((event.reinforceMs / MS_PER_HOUR) * 10) / 10
    : null;
  const until = Number.isSafeInteger(event.reinforcedUntil) ? new Date(event.reinforcedUntil) : null;
  const end = until && !Number.isNaN(until.getTime())
    ? `${until.toISOString().slice(0, 10)} ${until.toISOString().slice(11, 16)} UTC` : "unknown";
  return `The reinforcement timer (${hours === null ? "?" : hours} h) runs only while a member of your corporation `
    + `is online; earliest end ${end}.`;
}

function formatNoticeLine(event, opts) {
  const o = opts || {};
  const sys = o.systemName ? oneLine(o.systemName) : UNKNOWN.system;
  const place = o.regionName ? `${sys} (${oneLine(o.regionName)})` : sys;
  const a = factionOf(o.names, event.attacker);
  const d = factionOf(o.names, event.defender);
  let text;
  switch (event.kind) {
    case "ATTACK_STARTED":
      text = d ? `Invasion: ${a || "unknown forces"} attack ${d} in ${place}.`
        : `Invasion: ${a || "unknown forces"} attack ${place}.`;
      break;
    case "SYSTEM_CAPTURED":
      text = `Captured: ${place} is now held by ${a || "unknown forces"}${d ? ` (was ${d})` : ""}.`;
      break;
    case "SYSTEM_RELEASED":
      text = `Released: ${d || "the holder"} lost control of ${place}.${o.personal ? " Your kills helped." : ""}`;
      break;
    case "ATTACK_REPELLED":
      text = a ? `Repelled: ${d || "the holder"} held ${place} against ${a}.`
        : `Repelled: ${d || "the holder"} held ${place}.`;
      break;
    case "SIEGE_STARTED":
      text = `Siege: ${a || "unknown forces"} besiege ${d === UNKNOWN.faction ? d : `a ${d || "local"}`} station in ${place}.`;
      break;
    case "SIEGE_ENDED": {
      const end = event.endReason === END_REASON_NATIVE ? "station destroyed by capsuleers."
        : (SIEGE_END_TEXT[event.outcome] ? SIEGE_END_TEXT[event.outcome](a, d) : `${String(event.outcome)}.`);
      text = `Siege over in ${place}: ${end}`;
      break;
    }
    case "PLAYER_IMPACT":
      text = `Your kills weakened ${d ? `${possessive(d)} hold on` : "the hold on"} ${place}.`;
      break;
    case "STRUCTURE_SIEGE_STARTED":
      text = `Structure siege: ${a || "unknown forces"} attack your ${structureOf(event.structureTypeId)} in ${place}.`
        + " The shield assault has begun.";
      break;
    case "STRUCTURE_SIEGE_ENDED":
      text = `Structure siege over in ${place}: your ${structureOf(event.structureTypeId)} - `
        + structureSiegeEnd(event, a);
      break;
    case "PLAYER_SOV_SIEGE":
      text = `Sovereignty siege: ${a || "unknown forces"} besiege the sovereignty hub of ${allianceOf(event)} in `
        + `${place}. The siege advances only while a member of your corporation is online.`;
      break;
    case "PLAYER_SOV_REINFORCED":
      text = `Sovereignty reinforced: ${a || "unknown forces"} reinforced the sovereignty hub of ${allianceOf(event)} `
        + `in ${place}. ${reinforceSentence(event)}`;
      break;
    case "PLAYER_SOV_LOST":
      text = `Sovereignty lost: ${a || "unknown forces"} retook ${place} from ${allianceOf(event)}.`;
      break;
    case "HEAVY_EVENT_STARTED": {
      const label = HEAVY_EVENT_LABEL[event.eventType] || "Heavy event";
      const tier = HEAVY_TIER_LABEL[event.tier - 1] || "?";
      text = event.eventType === "defense"
        ? `${label} (tier ${tier}): ${a || "hostile forces"} move against ${d === UNKNOWN.faction ? d : (d ? `a ${d}` : "an")} outpost in ${place}.`
          + " Defend it until the last wave."
        : `${label} (tier ${tier}): ${a || "hostile forces"} have set up in ${place}. Find the beacon on the scanner.`;
      break;
    }
    case "HUNT_WARNING":
      text = `Scout report: ${a === UNKNOWN.faction ? a : `a ${a || "hostile"}`} scout spotted you in ${place}. `
        + "Hunters are on their way.";
      break;
    case "HARVEST_RAID_WARNED":
      text = harvestRaidWarned(event, a, place);
      break;
    case "HARVEST_RAID_ENDED":
      text = harvestRaidEnded(event, a, place);
      break;
    case "NATIVE_INCURSION_STARTED":
      text = `Sansha's Nation incursion: the Nation has moved on ${place}. Its forces push the claim on this system.`;
      break;
    case "NATIVE_INCURSION_ENDED":
      text = event.outcome === "defeated"
        ? `Sansha's Nation incursion in ${place} was defeated. The Nation's claim is weakened.`
        : `Sansha's Nation incursion in ${place} has ended. The Nation holds its ground.`;
      break;
    default:
      text = `Event in ${place}.`;
  }
  return cut(oneLine(`[${clockOf(event.at)} UTC] ${text}`), MAX_NOTICE_LINE);
}

module.exports = { formatMail, formatNoticeLine, FOOTER, TITLE_PREFIX, MAX_LOSS_ITEMS_IN_LINE };
