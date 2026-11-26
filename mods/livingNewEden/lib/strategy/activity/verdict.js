"use strict";

const { describeNote, LOCAL_BLOCK_CODES } = require("./notes");

const VERDICT = Object.freeze({ WORKING: "WORKING", WAITING: "WAITING", BLOCKED: "BLOCKED", STALE: "STALE",
  ERROR: "ERROR", NO_OFFENSIVE: "NO_OFFENSIVE" });
const VERDICT_LABEL = Object.freeze({ WORKING: "WORKING", WAITING: "WAITING", BLOCKED: "BLOCKED",
  STALE: "STALE", ERROR: "ERROR", NO_OFFENSIVE: "NO OFFENSIVE" });

const OFFENSIVE_BRAKE_CODES = Object.freeze(["UPKEEP_UNPAID", "UPKEEP_RESERVE", "UPKEEP_SHIP_CAP", "FRONT_LIMIT",
  "INSUFFICIENT_RESOURCES"]);

const PASSIVE_INTENTS = Object.freeze(["FACTION_TOUCH", "OBSERVE", "UPKEEP", "TERRITORY_MARK"]);

const INTENT_LABELS = Object.freeze({
  LAUNCH: "operation launch",
  MOBILIZE: "fleet mobilization",
  MINE_DISPATCH: "miner dispatch",
  MINE_RELEASE: "miner release",
  PRODUCE: "production order",
  CONVOY_DISPATCH: "convoy dispatch",
  BUILD_PLAN: "station build plan",
  REPLENISH: "fleet replenishment",
  REQUEST_REFIT: "fleet refit",
  CLOSE_OPERATION: "operation close",
  DISBAND: "fleet disband",
});

const DEGRADED_STRATEGY = Object.freeze(["degraded", "unavailable", "stopped"]);
const SEED_WAITING = Object.freeze(["pending", "off", "skipped"]);
const AI_BROKEN = Object.freeze(["unavailable", "stopped"]);

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < MINUTE_MS) return "<1 min";
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} min`;
  return `${Math.round(ms / HOUR_MS)} h`;
}

function summarizeDecision(applied) {
  if (!applied || typeof applied !== "object") return [];
  return Object.keys(applied)
    .filter((type) => !PASSIVE_INTENTS.includes(type) && Number.isFinite(applied[type]) && applied[type] > 0)
    .map((type) => ({ type, label: INTENT_LABELS[type] || type, count: applied[type] }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

function decisionText(decision) {
  return decision.map((d) => (d.count > 1 ? `${d.label} ×${d.count}` : d.label)).join(", ");
}

function groupNotes(notes) {
  const out = [];
  const byCode = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const d = describeNote(note);
    let entry = byCode.get(d.code);
    if (!entry) {
      entry = { code: d.code, args: [], category: d.category, text: d.text };
      byCode.set(d.code, entry);
      out.push(entry);
    }
    if (d.arg !== null && !entry.args.includes(d.arg)) entry.args.push(d.arg);
  }
  return out.map((e) => ({ code: e.code, arg: e.args.length > 0 ? e.args.join(", ") : null, category: e.category,
    text: e.text }));
}

function result(code, sentence, blocks, waits) {
  return { code, label: VERDICT_LABEL[code], sentence, blocks, waits };
}

function fmtDate(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "none";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function offensiveSentence(off, notes, now, nowText) {
  const brake = notes.find((n) => OFFENSIVE_BRAKE_CODES.includes(n.code));
  const brakeText = brake ? `; brake: ${brake.text}${brake.arg ? ` (${brake.arg})` : ""}` : "";
  const idle = off.idleInvasion || null;
  const fleets = idle && Number.isFinite(idle.fleets) && idle.fleets > 0
    ? `; idle invasion fleets: ${idle.fleets}${idle.truncated ? "+" : ""} (${idle.ships} ships), oldest idle for `
      + `${Number.isFinite(idle.oldestSince) ? fmtDuration(now - idle.oldestSince) : "-"}` : "";
  return `No offensive for ${fmtDuration(now - off.since)} (last capture: ${fmtDate(off.lastCaptureAt)})`
    + `${brakeText}${fleets}. Still: ${nowText}.`;
}

function judgeFaction(input) {
  const x = input || {};
  const s = x.strategy || {};
  const memory = x.memory || null;
  const row = x.row || null;
  const ev = x.reviewEvent || null;
  const notes = groupNotes(memory ? memory.notes : []);
  const blocks = notes.filter((n) => n.category === "blokada");
  const waits = notes.filter((n) => n.category === "oczekiwane");
  const decision = summarizeDecision(memory ? memory.applied : null);
  const activity = Number.isFinite(x.activityCount) ? x.activityCount : 0;
  const nowText = typeof x.nowText === "string" && x.nowText !== "" ? x.nowText : `activities: ${activity}`;
  const now = x.now;
  const limit = x.intervalMs * x.staleFactor;
  const failed = Array.isArray(x.failedServices) ? x.failedServices : [];

  if (s.state === "starting") return result(VERDICT.WAITING, "Strategy service is starting (graph / seed).", blocks, waits);
  if (s.aiState === "off" && s.aiReason === "disabled_by_config") {
    return result(VERDICT.WAITING, "Faction AI disabled in the config (strategy.aiEnabled).", blocks, waits);
  }
  if (row === null && SEED_WAITING.includes(s.seedState)) {
    return result(VERDICT.WAITING, `No faction row — faction seed not done (${s.seedState}).`, blocks, waits);
  }

  if (failed.length > 0) {
    const first = failed[0];
    const more = failed.length > 1 ? ` and ${failed.length - 1} more` : "";
    return result(VERDICT.ERROR, `Service ${first.name} failed: ${first.reason || "no reason"}${more}.`,
      blocks, waits);
  }
  if (DEGRADED_STRATEGY.includes(s.state) || s.seedState === "failed") {
    return result(VERDICT.ERROR, `Strategy service in state ${s.state}: ${s.reason || "no reason"}.`, blocks, waits);
  }
  if (AI_BROKEN.includes(s.aiState)) {
    return result(VERDICT.ERROR, `Faction AI unavailable: ${s.aiReason || "no reason"}.`, blocks, waits);
  }
  if (ev && ev.state === "QUARANTINED") {
    return result(VERDICT.ERROR, `Faction review quarantined by the scheduler: ${ev.lastError || "no description"}.`,
      blocks, waits);
  }
  if (ev && ev.state === "RETRY" && Number.isFinite(ev.attempts) && ev.attempts >= 1) {
    return result(VERDICT.ERROR, `Review rejected and retried (attempt ${ev.attempts}): `
      + `${ev.lastError || "no description"}.`, blocks, waits);
  }
  if (memory && memory.outcome === "SKIPPED" && (!Array.isArray(memory.notes) || memory.notes.length === 0)) {
    const why = typeof memory.reason === "string" && memory.reason ? memory.reason : "DECIDE_THREW";
    return result(VERDICT.ERROR, `Review decision threw an exception (${why}; details in the log).`, blocks, waits);
  }
  if (memory && memory.refused > 0 && decision.length === 0) {
    return result(VERDICT.ERROR, `All review decisions refused (${memory.refused}); last refusal: `
      + `${x.lastRefusal || "none"}.`, blocks, waits);
  }
  if (ev && ev.found === false && row && row.status !== "ELIMINATED" && s.aiState === "on"
    && s.state === "running" && !(memory && memory.outcome === "SKIPPED")) {
    return result(VERDICT.ERROR, "No scheduled review — the review chain is broken.", blocks, waits);
  }

  const lastReviewAt = row && Number.isFinite(row.lastReviewAt) ? row.lastReviewAt : null;
  if (lastReviewAt !== null && now - lastReviewAt > limit) {
    return result(VERDICT.STALE, `Last review ${fmtDuration(now - lastReviewAt)} ago, expected every `
      + `${fmtDuration(x.intervalMs)}.`, blocks, waits);
  }
  if (lastReviewAt === null && now - x.startedAt > limit) {
    return result(VERDICT.STALE, `No review at all for ${fmtDuration(now - x.startedAt)} since start.`,
      blocks, waits);
  }

  const working = activity > 0 || decision.length > 0;
  const hard = blocks.filter((n) => !LOCAL_BLOCK_CODES.includes(n.code));
  const ordered = [...hard, ...blocks.filter((n) => !hard.includes(n))];
  const shown = hard.length > 0 || !working ? ordered : [];
  if (shown.length > 0) {
    const b = shown[0];
    const more = shown.length > 1 ? `; +${shown.length - 1} more blocks` : "";
    const despite = activity > 0 ? ` Still: ${nowText}.` : "";
    return result(VERDICT.BLOCKED, `Blocked: ${b.text}${b.arg ? ` (${b.arg})` : ""}${more}.${despite}`,
      blocks, waits);
  }

  const off = x.offensive && typeof x.offensive === "object" ? x.offensive : null;
  if (off && off.stalled === true && Number.isFinite(off.since)) {
    return result(VERDICT.NO_OFFENSIVE, offensiveSentence(off, notes, now, nowText), blocks, waits);
  }

  if (working) {
    const last = decision.length > 0 ? `; last review: ${decisionText(decision)}` : "";
    const local = blocks.length > 0 ? `; local shortages: ${blocks[0].text}${blocks[0].arg ? ` (${blocks[0].arg})` : ""}`
      + `${blocks.length > 1 ? ` and ${blocks.length - 1} more` : ""}` : "";
    return result(VERDICT.WORKING, `Working — ${activity > 0 ? nowText : "no current activities"}${last}${local}.`,
      blocks, waits);
  }

  if (waits.length > 0) {
    const w = waits[0];
    return result(VERDICT.WAITING, `Waiting: ${w.text}${w.arg ? ` (${w.arg})` : ""}.`, blocks, waits);
  }
  if (memory === null) {
    const until = Number.isFinite(x.nextReviewAt) ? ` (in ~${fmtDuration(x.nextReviewAt - now)})` : "";
    return result(VERDICT.WAITING, `Waiting for the first review after start${until}.`, blocks, waits);
  }
  return result(VERDICT.WAITING, "The review found nothing to do.", blocks, waits);
}

module.exports = { VERDICT, VERDICT_LABEL, OFFENSIVE_BRAKE_CODES,
  PASSIVE_INTENTS, INTENT_LABELS, judgeFaction, summarizeDecision,
  decisionText, groupNotes, fmtDuration };
