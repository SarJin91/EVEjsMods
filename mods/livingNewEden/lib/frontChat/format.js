"use strict";

const { UNKNOWN } = require("../names/fallback");

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PERCENT_PER_MILLE = 10;
const STABLE = "STABLE";
const ELLIPSIS = "...";
const UNKNOWN_REGION = "unknown region";

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / MS_PER_SECOND));
  if (totalSeconds < SECONDS_PER_MINUTE) return `~${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) return `~${totalMinutes} min`;
  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  if (totalHours < HOURS_PER_DAY) {
    const minutes = totalMinutes % MINUTES_PER_HOUR;
    return minutes > 0 ? `~${totalHours} h ${minutes} min` : `~${totalHours} h`;
  }
  const days = Math.floor(totalHours / HOURS_PER_DAY);
  const hours = totalHours % HOURS_PER_DAY;
  return hours > 0 ? `~${days} d ${hours} h` : `~${days} d`;
}

function formatRefusal(reason, opts = {}) {
  switch (reason) {
    case "RATE_LIMITED":
      return `LNE front: wait ${formatDuration(opts.waitMs)} before the next !front`;
    case "BUSY":
      return "LNE front: server busy, try again later";
    case "NO_SYSTEM":
      return "LNE front: no current solar system";
    case "UNAVAILABLE":
      return `LNE front unavailable (${opts.detail ? String(opts.detail) : "UNKNOWN"})`;
    default:
      return `LNE front unavailable (${String(reason)})`;
  }
}

function nameOf(names, factionId) {
  if (!Number.isSafeInteger(factionId) || factionId <= 0) return "nobody";
  const n = names instanceof Map ? names.get(factionId) : null;
  return n ? String(n) : UNKNOWN.faction;
}

const percentOf = (ratioPerMille) => Math.round((Number(ratioPerMille) || 0) / PERCENT_PER_MILLE);

function systemLines(card, fleets, names) {
  if (!card || card.inWorld !== true || !card.system) return ["System: no LNE front here"];
  const sys = card.system;
  const progress = card.progress || null;
  const attacker = progress ? progress.attacker : null;
  let head = `System: ${sys.state}, held by ${nameOf(names, sys.controller)}`;
  if (Number.isSafeInteger(attacker) && attacker > 0) head += `, attacker ${nameOf(names, attacker)}`;
  const lines = [head];
  if (progress) {
    let line = `Progress ${percentOf(progress.ratio)}% (${progress.status})`;
    if (progress.etaMs !== null && progress.etaMs !== undefined) {
      line += ` - next phase in ${formatDuration(progress.etaMs)}`;
    }
    lines.push(line);
  }
  const notes = [];
  if (progress && (progress.etaMs === null || progress.etaMs === undefined)) {
    const blockers = Array.isArray(progress.blockers) ? progress.blockers : [];
    if (blockers.length > 0) notes.push(`${progress.status}: ${blockers[0]}`);
    else if (progress.fallback) {
      const fb = progress.fallback;
      const eta = fb.etaMs === null || fb.etaMs === undefined ? "" : ` in ${formatDuration(fb.etaMs)}`;
      notes.push(`${progress.status}: falls back to ${fb.to}${eta}`);
    }
  }
  const inv = card.attackerInvasion;
  if (inv) {
    if (inv.state === "WITHDRAWING") notes.push("Invasion withdrawing");
    else if (inv.withdrawMs !== null && inv.withdrawMs !== undefined) {
      notes.push(`Invasion withdraws in ${formatDuration(inv.withdrawMs)}`);
    }
  }
  if (notes.length > 0) lines.push(notes.join(" | "));
  const present = presentLine(card, fleets, names);
  if (present) lines.push(present);
  return lines;
}

function presentFleets(card, fleets) {
  if (fleets && Array.isArray(fleets.factions)) {
    return { rows: fleets.factions, more: fleets.truncated === true ? ", +more" : "" };
  }
  if (!card.fleets || !Array.isArray(card.fleets.groups)) return null;
  const byFaction = new Map();
  for (const g of card.fleets.groups) {
    const row = byFaction.get(g.factionId) || { factionId: g.factionId, fleets: 0, ships: 0 };
    row.fleets += g.fleets;
    row.ships += g.ships;
    byFaction.set(g.factionId, row);
  }
  const rows = [...byFaction.values()].sort((a, b) => b.ships - a.ships || a.factionId - b.factionId);
  const more = card.fleets.truncated === true
    ? `, +more (total ${card.fleets.fleetsTotal}/${card.fleets.shipsTotal})` : "";
  return { rows, more };
}

function presentLine(card, fleets, names) {
  const parts = [];
  const present = presentFleets(card, fleets);
  if (present) {
    const { rows, more } = present;
    parts.push(rows.length === 0 ? "Present: no fleets"
      : `Present: ${rows.map((r, i) => (i === 0 ? `${nameOf(names, r.factionId)} ${r.fleets} fleets/${r.ships} ships`
        : `${nameOf(names, r.factionId)} ${r.fleets}/${r.ships}`)).join(", ")}${more}`);
  }
  if (Array.isArray(card.sieges)) parts.push(`Sieges: ${card.sieges.length}`);
  if (Array.isArray(card.battles)) parts.push(`Open battles: ${card.battles.filter((b) => b.open).length}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

function regionLines(snapshot, names) {
  const region = snapshot.region;
  if (!region) return [];
  const label = `Region ${snapshot.regionName || UNKNOWN_REGION}`;
  if (region.tooLarge) return [`${label}: ${region.systems} systems, too large to list`];
  if (region.tracked === 0) return [`${label}: no LNE territory`];
  const contested = region.byState.filter(([state]) => state !== STABLE).reduce((sum, [, n]) => sum + n, 0);
  const holders = region.controllers.map((c) => `${nameOf(names, c.factionId)} ${c.systems}`).join(", ");
  const lines = [`${label}: ${region.systems} systems, ${region.tracked} tracked`
    + `${holders ? ` - ${holders}` : ""}; contested ${contested}`];
  for (const row of region.contested) {
    let line = ` - ${row.name} ${row.state}`;
    if (Number.isSafeInteger(row.attacker) && row.attacker > 0) line += ` ${nameOf(names, row.attacker)}`;
    if (row.progress) {
      line += ` ${percentOf(row.progress.ratio)}%`;
      line += row.progress.etaMs === null || row.progress.etaMs === undefined ? ` ${row.progress.status}`
        : ` ${formatDuration(row.progress.etaMs)}`;
    }
    lines.push(line);
  }
  return lines;
}

function cut(lines, maxLines, maxReplyChars, lineBreak) {
  const kept = lines.slice(0, Math.max(1, maxLines));
  const out = [];
  let used = 0;
  for (const line of kept) {
    const sep = out.length > 0 ? lineBreak.length : 0;
    if (used + sep + line.length <= maxReplyChars) {
      out.push(line);
      used += sep + line.length;
      continue;
    }
    const room = maxReplyChars - used - sep - ELLIPSIS.length;
    if (room > 0) out.push(`${line.slice(0, room)}${ELLIPSIS}`);
    else if (out.length > 0) {
      const last = out[out.length - 1];
      out[out.length - 1] = `${last.slice(0, Math.max(0, last.length - ELLIPSIS.length))}${ELLIPSIS}`;
    }
    break;
  }
  return out;
}

function formatFrontReply(snapshot, opts) {
  const names = snapshot.names instanceof Map ? snapshot.names : new Map();
  const lines = [`LNE front - ${snapshot.systemName || UNKNOWN.system}`
    + ` (${snapshot.regionName || UNKNOWN_REGION})`];
  lines.push(...systemLines(snapshot.card, snapshot.fleets || null, names));
  lines.push(...regionLines(snapshot, names));
  return cut(lines, opts.maxLines, opts.maxReplyChars, String(opts.lineBreak));
}

module.exports = { formatFrontReply, formatRefusal, formatDuration };
