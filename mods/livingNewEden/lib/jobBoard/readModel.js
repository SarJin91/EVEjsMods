"use strict";

const { rewardText: jobRewardText } = require("../frontJobs/format");
const { rewardText: warRewardText } = require("../warContracts/format");
const { asciiText, toInt, LEN } = require("./wire");
const { UNKNOWN } = require("../names/fallback");

const MS_PER_SECOND = 1000;
const WAR_TITLE_PREFIX = "Living New Eden: war contract ";
const DONE = "DONE";
const OPEN = "OPEN";
const PIN = Object.freeze({ NONE: 0, ACCEPT: 1, DROP: 2 });
const REWARD_KIND = Object.freeze({ FRONT: "PAID", WAR: "WAR" });
const PAYOUT_PENDING = "PENDING";
const NEAR_REF_PREFIX = Object.freeze({ events: "ev:", heavy: "hv:", power: "pw:", salvage: "sv:", anomaly: "an:",
  sit: "si:", story: "gm:" });
const SIGNATURE_MASK = Object.freeze({ title: "Unknown signature", kind: "signature" });

const call = (fn, id) => {
  try {
    const v = typeof fn === "function" ? fn(id) : null;
    return typeof v === "string" && v !== "" ? v : null;
  } catch (_err) {
    return null;
  }
};

const jumpsOrMinus = (jumpsOf, systemId) => {
  try {
    const j = typeof jumpsOf === "function" ? jumpsOf(systemId) : null;
    return Number.isSafeInteger(j) && j >= 0 ? j : -1;
  } catch (_err) {
    return -1;
  }
};

const secondsLeft = (until, now) => (Number.isFinite(until) ? Math.max(0, Math.floor((until - now) / MS_PER_SECOND))
  : 0);

const byJumps = (a, b) => (a === b ? 0 : a < 0 ? 1 : b < 0 ? -1 : a - b);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const refusalOf = (source, r) => asciiText(`${source}:${(r && r.reason) || "NO_RESULT"}`, LEN.refusal);

function jobRow(job, ctx) {
  const target = Math.max(0, toInt(job.targetCount));
  const mineCount = Math.min(Math.max(0, toInt(job.myProgress)), target);
  const engaged = mineCount > 0 || (job.myState !== null && job.myState !== undefined);
  const mine = engaged ? `${mineCount}/${target}${job.myState === DONE ? " done" : ""}` : "";
  const sys = toInt(job.systemId);
  return {
    sortMine: engaged ? 0 : 1, sortId: String(job.jobId),
    isOpen: job.state === OPEN && job.myState !== DONE, inProgress: mineCount > 0 && job.myState !== DONE,
    pin: PIN.NONE,
    ref: asciiText(String(job.jobId).startsWith("fj:") ? job.jobId : `fj:${job.jobId}`, LEN.ref),
    kind: asciiText(job.kind, LEN.kind),
    title: asciiText(job.description || `${job.kind} job`, LEN.title),
    sys, sysName: asciiText(call(ctx.names.system, sys) || UNKNOWN.system, LEN.sysName),
    jumps: jumpsOrMinus(ctx.jumpsOf, sys),
    reward: asciiText(jobRewardText(job), LEN.reward),
    progress: asciiText(`${toInt(job.completions)}/${toInt(job.maxCompletions)} done`, LEN.progress),
    mine: asciiText(mine, LEN.mine),
    endsIn: secondsLeft(Number(job.expiresAt), ctx.now),
    state: asciiText(job.myState === DONE ? DONE : job.state, LEN.state),
  };
}

function warTitle(row, ctx) {
  const text = String(row.description || "");
  return text.startsWith(WAR_TITLE_PREFIX) ? text.slice(WAR_TITLE_PREFIX.length)
    : (text || `${toInt(row.quantity)}x ${UNKNOWN.item} for `
      + `${call(ctx.names.faction, row.factionId) || UNKNOWN.faction}`);
}

function warRow(row, ctx) {
  const sys = toInt(row.systemId);
  const title = warTitle(row, ctx);
  return {
    sortId: String(row.offerId),
    ref: asciiText(`wc:${row.offerId}`, LEN.ref),
    contractId: Math.max(0, toInt(row.contractId)),
    title: asciiText(title, LEN.title),
    sys, sysName: asciiText(call(ctx.names.system, sys) || UNKNOWN.system, LEN.sysName),
    jumps: jumpsOrMinus(ctx.jumpsOf, sys),
    reward: asciiText(warRewardText(row), LEN.reward),
    endsIn: row.offerExpiresAt === null || row.offerExpiresAt === undefined ? 0
      : secondsLeft(Number(row.offerExpiresAt), ctx.now),
  };
}

function rewardRow(r, ctx, war) {
  const sys = toInt(r.systemId);
  const at = toInt(war ? r.awardedAt : r.doneAt);
  const id = String(war ? r.offerId : r.jobId);
  const ref = war ? `wc:${id}` : (id.startsWith("fj:") ? id : `fj:${id}`);
  return {
    sortAt: at, sortId: asciiText(ref, LEN.ref),
    ref: asciiText(ref, LEN.ref),
    kind: war ? REWARD_KIND.WAR : REWARD_KIND.FRONT,
    title: asciiText(war ? warTitle(r, ctx) : (r.description || `${r.kind} job`), LEN.title),
    sys, sysName: asciiText(call(ctx.names.system, sys) || UNKNOWN.system, LEN.sysName),
    jumps: jumpsOrMinus(ctx.jumpsOf, sys),
    reward: asciiText(war ? warRewardText(r) : jobRewardText(r), LEN.reward),
    progress: "done",
    mine: "",
    endsIn: 0,
    state: asciiText(r.payoutState || PAYOUT_PENDING, LEN.state),
    pin: PIN.NONE,
  };
}

function nearRow(r, ctx, systemIds, reveal) {
  if (!r || typeof r !== "object" || !Object.prototype.hasOwnProperty.call(NEAR_REF_PREFIX, r.source)) return null;
  if (typeof r.ref !== "string" || !r.ref.startsWith(NEAR_REF_PREFIX[r.source])) return null;
  const sys = r.systemId;
  if (!Number.isSafeInteger(sys) || !(systemIds instanceof Set) || !systemIds.has(sys)) return null;
  const masked = r.scan === true && !reveal;
  return {
    ref: asciiText(r.ref, LEN.nearRef),
    src: asciiText(r.source, LEN.src),
    kind: asciiText(masked ? SIGNATURE_MASK.kind : r.kind, LEN.nearKind),
    title: asciiText(masked ? SIGNATURE_MASK.title : r.title, LEN.title),
    sys, sysName: asciiText(call(ctx.names.system, sys) || UNKNOWN.system, LEN.sysName),
    jumps: jumpsOrMinus(ctx.jumpsOf, sys),
    level: masked ? "" : asciiText(r.level || "", LEN.level),
    scan: r.scan === true,
    reward: masked ? "" : asciiText(r.rewardText || "", LEN.reward),
    endsIn: Number.isSafeInteger(r.endsAt) ? secondsLeft(r.endsAt, ctx.now) : 0,
    state: asciiText(r.state, LEN.state),
  };
}

const byEndsIn = (a, b) => (a === b ? 0 : a === 0 ? 1 : b === 0 ? -1 : a - b);

function nearbySections(nb, ctx, limits, reveal) {
  const out = { refusals: [] };
  const tail = [];
  const ev = nb.events;
  if (ev) {
    tail.push(...(Array.isArray(ev.refusals) ? ev.refusals : []).map((r) => asciiText(r, LEN.refusal)));
    const rows = (Array.isArray(ev.rows) ? ev.rows : []).map((r) => nearRow(r, ctx, ev.systemIds, reveal))
      .filter((r) => r !== null);
    rows.sort((a, b) => byJumps(a.jumps, b.jumps) || byEndsIn(a.endsIn, b.endsIn) || byText(a.ref, b.ref));
    const max = Math.max(0, toInt(limits.maxNearRows));
    out.near = rows.slice(0, max);
    out.moreNear = Math.max(0, rows.length - max) + Math.max(0, toInt(ev.truncatedSources));
  }
  const fr = nb.front;
  if (fr && fr.ok === true && Array.isArray(fr.lines)) out.front = { sys: toInt(fr.sys), lines: fr.lines.slice() };
  else if (fr) out.refusals.push(refusalOf("front", fr));
  const nw = nb.news;
  if (nw && nw.ok === true && nw.edition) {
    const e = nw.edition;
    out.news = { seq: toInt(e.seq), title: String(e.title || ""), text: String(e.firstParagraph || ""),
      ageS: secondsLeft(ctx.now, toInt(e.publishedAt)), maxChars: Math.max(0, toInt(limits.newsMaxChars)) };
  } else if (nw && nw.ok !== true) out.refusals.push(refusalOf("news", nw));
  out.tail = tail;
  return out;
}

const WANTED_MAX_ROWS = 12;
const WANTED_LEVELS = 6;
const SEEN_KINDS = Object.freeze(["system", "constellation", "region"]);
const ISK_UNITS = Object.freeze([[1e9, "B"], [1e6, "M"], [1e3, "K"]]);

function iskText(isk) {
  const n = Math.max(0, toInt(isk));
  for (const [unit, suffix] of ISK_UNITS) if (n >= unit) return `${(n / unit).toFixed(1)}${suffix} ISK`;
  return `${n} ISK`;
}

function wantedRow(r) {
  if (!r || typeof r !== "object" || typeof r.nick !== "string" || r.nick === "") return null;
  const level = toInt(r.level);
  if (level < 1 || level > WANTED_LEVELS) return null;
  const seen = r.seen && typeof r.seen === "object" && SEEN_KINDS.includes(r.seen.kind)
    && typeof r.seen.name === "string" && r.seen.name !== "" ? { kind: r.seen.kind, name: r.seen.name } : null;
  const ageS = seen && Number.isSafeInteger(r.ageS) && r.ageS >= 0 ? r.ageS : null;
  const jumps = seen && Number.isSafeInteger(r.jumps) && r.jumps >= 0 ? r.jumps : null;
  const systemId = seen && Number.isSafeInteger(r.systemId) && r.systemId > 0 ? r.systemId : null;
  return { nick: r.nick, level, reward: iskText(r.rewardIsk), smuggler: r.smuggler === true, seen, ageS, jumps,
    systemId };
}

function wantedSection(w) {
  const summary = w.summary && typeof w.summary === "object" ? w.summary : {};
  const byLevel = [];
  for (let i = 0; i < WANTED_LEVELS; i += 1) {
    byLevel.push(Math.max(0, toInt(Array.isArray(summary.byLevel) ? summary.byLevel[i] : 0)));
  }
  const rows = (list) => (Array.isArray(list) ? list : []).map(wantedRow).filter((r) => r !== null)
    .slice(0, WANTED_MAX_ROWS);
  return { total: Math.max(0, toInt(summary.total)), byLevel, near: rows(w.near), top: rows(w.top),
    more: Math.max(0, toInt(w.more)) };
}

const rowsOf = (r) => (r && r.ok === true && Array.isArray(r.rows) ? r.rows : []);

const strip = ({ sortMine: _m, sortId: _i, sortAt: _a, isOpen: _o, inProgress: _p, ...rest }) => rest;
const byEnds = (a, b) => a.endsIn - b.endsIn || byText(a.ref, b.ref);

function buildSnapshot(input) {
  const now = toInt(input.now);
  const names = input.names || {};
  const ctx = { now, names, jumpsOf: input.jumpsOf };
  const viewerSys = input.viewer && Number.isSafeInteger(input.viewer.systemId) && input.viewer.systemId > 0
    ? input.viewer.systemId : 0;
  const limits = input.limits || {};
  const refusals = [];

  const jobsOk = Boolean(input.jobs && input.jobs.ok === true && Array.isArray(input.jobs.jobs));
  if (!jobsOk) refusals.push(refusalOf("frontJobs", input.jobs));
  const allJobs = jobsOk ? input.jobs.jobs.map((j) => jobRow(j, ctx)) : [];
  allJobs.sort((a, b) => a.sortMine - b.sortMine || byJumps(a.jumps, b.jumps) || byText(a.sortId, b.sortId));

  const pinsOn = input.pinsOn === true;
  const withMine = input.done !== undefined || input.awards !== undefined || input.pins !== undefined;
  const mineRefusal = (r) => {
    if (r === undefined || r === null || r.ok === true) return;
    const text = refusalOf("mine", r);
    if (!refusals.includes(text)) refusals.push(text);
  };
  if (pinsOn) mineRefusal(input.pins);
  mineRefusal(input.done);
  mineRefusal(input.awards);
  const pinned = new Set(pinsOn ? rowsOf(input.pins).map((p) => String(p.jobRef)) : []);
  for (const row of allJobs) {
    if (!pinsOn) continue;
    if (pinned.has(row.sortId) && row.isOpen) row.pin = PIN.DROP;
    else if (pinned.has(row.sortId)) row.pin = PIN.NONE;
    else row.pin = row.isOpen ? PIN.ACCEPT : PIN.NONE;
  }
  let mine = null;
  let moreMine = 0;
  if (withMine) {
    const groupPinned = allJobs.filter((r) => r.pin === PIN.DROP).sort(byEnds);
    const groupActive = allJobs.filter((r) => r.pin !== PIN.DROP && r.inProgress).sort(byEnds);
    const rewards = [...rowsOf(input.done).map((r) => rewardRow(r, ctx, false)),
      ...rowsOf(input.awards).map((r) => rewardRow(r, ctx, true))];
    rewards.sort((a, b) => b.sortAt - a.sortAt || byText(a.sortId, b.sortId));
    const all = [...groupPinned, ...groupActive, ...rewards];
    const maxMine = Math.max(0, toInt(limits.maxMineRows));
    mine = all.slice(0, maxMine);
    moreMine = Math.max(0, all.length - maxMine);
  }
  const shown = new Set((mine || []).map((r) => r.ref));
  const restJobs = allJobs.filter((r) => !shown.has(r.ref));
  const maxJobs = Math.max(0, toInt(limits.maxJobRows));

  const warsOk = Boolean(input.wars && input.wars.ok === true && Array.isArray(input.wars.rows));
  if (!warsOk) refusals.push(refusalOf("warContracts", input.wars));
  const allWars = warsOk ? input.wars.rows.map((r) => warRow(r, ctx)) : [];
  allWars.sort((a, b) => byJumps(a.jumps, b.jumps) || byText(a.sortId, b.sortId));
  const maxWars = Math.max(0, toInt(limits.maxWarRows));

  const nb = input.nearby && typeof input.nearby === "object"
    ? nearbySections(input.nearby, ctx, limits, input.revealSignatures === true) : null;
  if (nb) refusals.push(...nb.refusals);
  const wv = input.wanted && typeof input.wanted === "object" ? input.wanted : null;
  const wanted = wv && wv.ok === true ? wantedSection(wv) : null;
  if (wv && wv.ok !== true) refusals.push(refusalOf("wanted", wv));
  if (nb) refusals.push(...nb.tail);

  return {
    now,
    sys: viewerSys,
    sysName: viewerSys > 0 ? asciiText(call(names.system, viewerSys) || UNKNOWN.system, LEN.sysName) : "",
    jobs: restJobs.slice(0, maxJobs).map(strip),
    wars: allWars.slice(0, maxWars).map(strip),
    mine: mine === null ? null : mine.map(strip),
    more: { jobs: Math.max(0, restJobs.length - maxJobs), wars: Math.max(0, allWars.length - maxWars),
      ...(mine === null ? {} : { mine: moreMine }), ...(nb && nb.near ? { near: nb.moreNear } : {}) },
    refusals,
    jobsOk,
    warsOk,
    ...(nb && nb.near ? { near: nb.near } : {}),
    ...(nb && nb.front ? { front: nb.front } : {}),
    ...(nb && nb.news ? { news: nb.news } : {}),
    ...(wanted ? { wanted } : {}),
  };
}

module.exports = { WAR_TITLE_PREFIX, PIN, REWARD_KIND, NEAR_REF_PREFIX, SIGNATURE_MASK, buildSnapshot, iskText };
