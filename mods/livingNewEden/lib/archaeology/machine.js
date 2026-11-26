"use strict";

const { CHAIN_STATE, END_REASON, STAGE_STATE, STAGE_KIND, ARCHIVE_CONTENT_KEY } = require("./schema");

const EVENT = Object.freeze({ DEADLINE: "DEADLINE", DISABLED: "DISABLED", RELOCATIONS: "RELOCATIONS",
  NO_PLACE: "NO_PLACE", COMPLETED: "COMPLETED", STOLEN: "STOLEN" });
const TRANSITIONS = Object.freeze([
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.DEADLINE, to: CHAIN_STATE.EXPIRED,
    endReason: END_REASON.DEADLINE }),
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.DISABLED, to: CHAIN_STATE.CANCELLED,
    endReason: END_REASON.DISABLED }),
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.RELOCATIONS, to: CHAIN_STATE.EXPIRED,
    endReason: END_REASON.RELOCATIONS }),
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.NO_PLACE, to: CHAIN_STATE.EXPIRED,
    endReason: END_REASON.NO_PLACE }),
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.COMPLETED, to: CHAIN_STATE.COMPLETED,
    endReason: END_REASON.COMPLETED }),
  Object.freeze({ from: CHAIN_STATE.ACTIVE, event: EVENT.STOLEN, to: CHAIN_STATE.STOLEN,
    endReason: END_REASON.STOLEN }),
]);
const SITE_GONE_STATES = Object.freeze(["LOST", "FAILED", "PURGED", "COMPLETED", "CLEANING", "CLEANED"]);
const INSTANCE_GONE_STATES = Object.freeze(["failed", "despawned", "missing"]);
const SITE_SPEC_INVALID = "SITE_SPEC_INVALID";
const TERMINAL = Object.freeze([CHAIN_STATE.COMPLETED, CHAIN_STATE.EXPIRED, CHAIN_STATE.STOLEN, CHAIN_STATE.CANCELLED]);

function transition(state, event) {
  const t = TRANSITIONS.find((x) => x.from === state && x.event === event);
  return t ? { ok: true, to: t.to, endReason: t.endReason } : { ok: false, reason: "TRANSITION_INVALID" };
}

function isTerminal(state) {
  return TERMINAL.includes(state);
}

function stepOf(chain, now) {
  if (!chain || chain.state !== CHAIN_STATE.ACTIVE) return { action: "SKIP" };
  if (now >= chain.deadlineAt) return { action: "END", event: EVENT.DEADLINE };
  return { action: "RESCHEDULE", nextCheckAt: chain.deadlineAt };
}

function archiveWinOf(read) {
  if (!read || read.ok !== true || !Array.isArray(read.wins)) return null;
  return read.wins.find((w) => w && w.contentKey === ARCHIVE_CONTENT_KEY) || null;
}

function stageStepOf(chain, now, facts, P) {
  if (!chain || chain.state !== CHAIN_STATE.ACTIVE) return { action: "SKIP" };
  if (now >= chain.deadlineAt) return { action: "END", event: EVENT.DEADLINE };
  const f = facts || {};
  switch (chain.stageState) {
    case STAGE_STATE.REVEALED:
      if (chain.stageKind === STAGE_KIND.WH) {
        if (Number.isSafeInteger(chain.stageDueAt) && now >= chain.stageDueAt) {
          return { action: "RESPAWN", specInvalid: false, lostWin: false };
        }
        return { action: "SPAWN" };
      }
      if (f.presence === "near") return { action: "SPAWN" };
      return { action: "RESCHEDULE", nextCheckAt: now + P.presenceCheckMs,
        ...(f.presence === "far" ? {} : { note: "presence.unavailable" }) };
    case STAGE_STATE.SITE_PENDING:
    case STAGE_STATE.SITE_ACTIVE: {
      const site = f.site || { row: null, read: null };
      const win = archiveWinOf(site.read);
      if (win) return { action: win.characterId === chain.characterId ? "FOUND" : "STEAL", win };
      const row = site.row;
      const readState = site.read && site.read.ok === true ? site.read.state : null;
      const gone = !row || SITE_GONE_STATES.includes(row.state)
        || (row.state === "ACTIVE" && INSTANCE_GONE_STATES.includes(readState));
      if (gone || (Number.isSafeInteger(chain.stageDueAt) && now >= chain.stageDueAt)) {
        return { action: "RESPAWN", specInvalid: Boolean(row && row.state === "FAILED"
          && row.failReason === SITE_SPEC_INVALID),
        lostWin: chain.stageState === STAGE_STATE.SITE_ACTIVE && readState === "missing" };
      }
      if (chain.stageState === STAGE_STATE.SITE_PENDING && row.state === "ACTIVE") {
        return { action: "ACTIVATE", nextCheckAt: now + P.sitePollMs };
      }
      return { action: "RESCHEDULE", nextCheckAt: now + P.sitePollMs };
    }
    case STAGE_STATE.FOUND:
      return { action: "DELIVER" };
    default:
      return { action: "RESCHEDULE", nextCheckAt: chain.deadlineAt };
  }
}

module.exports = { EVENT, TRANSITIONS, SITE_GONE_STATES, INSTANCE_GONE_STATES, transition, isTerminal, stepOf,
  archiveWinOf, stageStepOf };
