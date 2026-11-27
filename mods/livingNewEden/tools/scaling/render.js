"use strict";

const COLUMNS = Object.freeze([
  "stage", "axis", "live fleets from the audit (AI + bench nom.)", "tick p95 median / max of windows / max", "verdict", "flags",
  "scheduler passMs p95", "dueBacklog first→last (slope/h)", "completed/min", "ms/event (est.)",
  "RSS MB first→last (slope/h)", "heap MB", "GC major n / max ms / % of time", "ELU %", "governor ≠NORMAL %",
  "spikes lne/gc/evejs/unattr", "quarantined / journal dupl. (info) / audit dupl. settl.", "liveShips max",
]);

function cell(v) {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "-";
  return String(v).replace(/\|/gu, "\\|");
}

function pct(share) {
  return typeof share === "number" && Number.isFinite(share) ? Math.round(share * 1000) / 10 : null;
}

function fleetsCell(s, aiFleets) {
  const fleetAxis = s.axis === "base" || s.axis === "virtual";
  const live = s.fleets && typeof s.fleets.live === "number" && Number.isFinite(s.fleets.live) ? s.fleets.live : null;
  if (live !== null) {
    return fleetAxis ? `${live} (${aiFleets === null ? "?" : aiFleets} + ${s.benchFleets} nom.)` : `${live}`;
  }
  if (!fleetAxis) return s.benchFleets > 0 ? `bench ${s.benchFleets}` : "-";
  return aiFleets === null ? `? + ${s.benchFleets}` : `${aiFleets} + ${s.benchFleets}`;
}

function p95Cell(value, source) {
  const v = cell(value);
  return source === "rows" && v !== "-" ? `${v} (rows)` : v;
}

function rssRuleText(t, base) {
  const thr = cell(t.rssGrowthMbPerHour);
  if (base && base.mode === "baseline" && typeof base.label === "string") {
    return `RSS_GROWING: slope > slope ${cell(base.label)} (${cell(base.slopeMbPerHour)}) + ${thr} MB/h,`
      + ` ${cell(base.label)} absolute`;
  }
  return `RSS_GROWING: slope > ${thr} MB/h`;
}

function auditCell(audit) {
  return audit ? String(audit.duplicateSettlements) : "none";
}

function auditLine(audit) {
  if (!audit) return "no audit (double settlement not checked)";
  return `audit ${cell(audit.file)}: duplicateSettlements ${audit.duplicateSettlements}, errors ${audit.errors}`;
}

function stageCell(s) {
  const extra = [`windows ${s.windows}`, `rows ${s.measuredRows}/${s.rows}`];
  if (s.restarts > 0) extra.push(`restarts=${s.restarts}`);
  if (s.interrupted) extra.push("interrupted");
  if (s.axis === "physical") extra.push(`demo x${s.demoMultiplier}`);
  return `${s.label} (${extra.join(", ")})`;
}

function row(s, aiFleets) {
  const b = s.scheduler.dueBacklog;
  const m = s.memory;
  const est = s.scheduler.msPerEventEstimate === null ? null : `${s.scheduler.msPerEventEstimate} est.`;
  return [
    stageCell(s), s.axis, fleetsCell(s, aiFleets),
    `${cell(s.tick.p95Median)} / ${cell(s.tick.p95Max)} / ${cell(s.tick.max)}`,
    s.verdict, s.flags.length > 0 ? s.flags.join(", ") : "-",
    p95Cell(s.scheduler.passP95Median, s.scheduler.passP95Source),
    `${cell(b.first)}→${cell(b.last)} (${cell(b.slopePerHour)})`,
    cell(s.scheduler.completedPerMin), cell(est),
    `${cell(m.rssMbFirst)}→${cell(m.rssMbLast)} (${cell(m.rssSlopeMbPerHour)})`, cell(m.heapUsedMbLast),
    `${cell(s.gc.majorCount)} / ${cell(s.gc.majorMaxMs)} / ${cell(s.gc.wallPercent)}`,
    cell(s.cpu.eluAvg), cell(pct(s.governor.nonNormalShare)),
    `${s.spikes.lne}/${s.spikes.gc}/${s.spikes.evejsTick}/${s.spikes.unattributed}`,
    `${s.safety.quarantinedDelta} / ${s.safety.duplicatesDelta} / ${auditCell(s.safety.audit)}`,
    cell(s.materialization.liveShipsMax),
  ].map((v) => cell(v));
}

function renderMarkdown(report) {
  const t = report.thresholds || {};
  const ai = Number.isSafeInteger(report.aiFleets) ? report.aiFleets : null;
  const stages = Array.isArray(report.stages) ? report.stages : [];
  const lines = [];
  lines.push(`Thresholds: warn ${cell(t.warnP95Ms)} ms, fail ${cell(t.failP95Ms)} ms (p95 tick.intervalMs, median of windows),`
    + ` stop ${cell(t.stopMs)} ms, warmup ${cell(t.warmupMs)} ms. AI fleets: ${cell(ai)}.`
    + ` ${rssRuleText(t, report.rssBaseline)}.`);
  lines.push("p95 of channels without windows (spanMs 0): median of row p95, marked \"(rows)\".");
  lines.push("");
  lines.push(`| ${COLUMNS.join(" | ")} |`);
  lines.push(`|${COLUMNS.map(() => "---").join("|")}|`);
  for (const s of stages) lines.push(`| ${row(s, ai).join(" | ")} |`);
  lines.push("");
  lines.push("Additionally (per stage):");
  for (const s of stages) {
    const share = pct(s.scheduler.budgetExhaustedShare);
    lines.push(`- ${s.label}: tick workMs p95 ${p95Cell(s.tick.workP95Median, s.tick.workP95Source)},`
      + ` windows with max >= stop ${s.tick.stopWindows},`
      + ` lateness p95 ${p95Cell(s.scheduler.latenessP95Median, s.scheduler.latenessP95Source)},`
      + ` persistence tx p95 ${p95Cell(s.persistence.txP95Median, s.persistence.txP95Source)}`
      + ` / checkpoint p95 ${p95Cell(s.persistence.checkpointP95Median, s.persistence.checkpointP95Source)}`
      + ` / slowOps ${s.persistence.slowOpsDelta},`
      + ` GC n ${s.gc.count} / ${cell(s.gc.totalMs)} ms, CPU user ${cell(s.cpu.userAvg)} %,`
      + ` governor changes ${s.governor.changesDelta} / emergency ${s.governor.emergencyDelta}`
      + ` / unplayable ${s.governor.unplayableDelta}, fleets.limit ${s.safety.fleetLimitDelta},`
      + ` alarms ${s.safety.alarms.length > 0 ? s.safety.alarms.join(" ") : "-"},`
      + ` liveBattles max ${cell(s.materialization.liveBattlesMax)}, spawn p95 max ${cell(s.materialization.spawnP95Max)},`
      + ` failedBattles max ${cell(s.materialization.failedBattlesMax)}, ${auditLine(s.safety.audit)}`
      + `${s.note ? `, note: ${s.note}` : ""}`
      + `${share === null ? "" : `, budget exhausted ${share} %`}`
      + `${s.histogramsDeferred ? `, histogramsDeferred: rows ${s.deferredRows} / tick windows ${s.deferredWindows}`
        + ` (max ${s.deferredMax}, p95 may be older)` : ""}`);
  }
  const r = report.recommendation || { lastOk: null, stoppedAt: null, candidateMaxVirtualFleets: null, notes: [] };
  lines.push("");
  lines.push(`Recommendation: last OK stage ${cell(r.lastOk)}, stopped at ${cell(r.stoppedAt)},`
    + ` limits.maxVirtualFleets candidate ${cell(r.candidateMaxVirtualFleets)}.`);
  for (const n of r.notes) lines.push(`- ${n}`);
  return `${lines.join("\n")}\n`;
}

function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

module.exports = { COLUMNS, renderMarkdown, renderJson };
