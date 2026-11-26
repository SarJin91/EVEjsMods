"use strict";

const S = require("../schema");

const BOOTSTRAP = "bootstrap";
const REWOUND = "rewound";

const refusal = (r, detail) => ({ ok: false, reason: String((r && r.reason) || "KILLBOARD_READ_FAILED"),
  detail: `${detail}${r && r.detail ? `:${r.detail}` : ""}` });

function bootstrapCursor(tx, kbRepo, source, stored, now, P) {
  const battles = source === S.KB_SOURCES.BATTLES;
  const max = battles ? kbRepo.maxBattleNo(tx) : kbRepo.maxKillId(tx);
  if (!max || max.ok !== true) return refusal(max, `${source}.max`);
  const maxNo = Number(max.max) || 0;
  if (stored && stored.afterNo <= max.max) return { ok: true, cursor: stored, event: null, maxNo };
  const fromAt = Math.max(0, now - P.bootstrapLookbackMs);
  const first = battles ? kbRepo.firstBattleNoAtOrAfter(tx, fromAt) : kbRepo.firstKillIdAtOrAfter(tx, fromAt);
  if (!first || first.ok !== true) return refusal(first, `${source}.first`);
  const afterNo = first.key === null ? max.max : first.key - 1;
  return { ok: true, event: stored ? REWOUND : BOOTSTRAP, maxNo, cursor: Object.freeze({ source, afterAt: fromAt, afterNo,
    afterKey: "", facts: stored ? stored.facts : 0, version: stored ? stored.version : 0 }) };
}

function readBattleFacts(tx, kbRepo, cursor, P) {
  const r = kbRepo.listBattlesAfter(tx, cursor.afterNo, P.sourcePageRows);
  if (!r || r.ok !== true) return refusal(r, "kb_battles.page");
  const facts = r.battles.map((b) => Object.freeze({ no: b.battleNo, at: b.settledAt, systemId: b.systemId,
    sides: b.sides }));
  const last = facts.length > 0 ? facts[facts.length - 1] : null;
  return { ok: true, facts, endNo: last ? last.no : cursor.afterNo, endAt: last ? last.at : cursor.afterAt };
}

function readKillFacts(tx, kbRepo, cursor, P) {
  const r = kbRepo.listPveKillsAfter(tx, cursor.afterNo, P.sourcePageRows);
  if (!r || r.ok !== true) return refusal(r, "kb_kills.page");
  const facts = r.kills.map((k) => Object.freeze({ no: k.killId, at: k.killAt, systemId: k.systemId }));
  const last = facts.length > 0 ? facts[facts.length - 1] : null;
  return { ok: true, facts, endNo: r.scannedTo === null ? cursor.afterNo : r.scannedTo,
    endAt: last ? last.at : cursor.afterAt };
}

module.exports = { bootstrapCursor, readBattleFacts, readKillFacts, BOOTSTRAP, REWOUND };
