"use strict";

const { REWARD_EVENT_CATALOG } = require("./data/eventCatalog");

const SOURCE = "events";
const REF_PREFIX = "ev:";
const SIGNATURE_EVENT_TYPES = Object.freeze(["ded_complex", "battle_relics"]);
const REWARD_TEXT = Object.freeze({ depot: "Faction loot depot", vault: "Faction loot vault" });
const STATE_TEXT = Object.freeze({ PLANNED: "WAITING", ACTIVE: "ACTIVE", COMPLETING: "COMPLETING" });
const ROW_LEN = Object.freeze({ ref: 64, kind: 24, title: 80, reward: 60, state: 16 });

const REWARD_OF_TYPE = Object.freeze(Object.fromEntries(REWARD_EVENT_CATALOG
  .filter((t) => Object.prototype.hasOwnProperty.call(REWARD_TEXT, t.reward))
  .map((t) => [t.eventType, REWARD_TEXT[t.reward]])));

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function clip(value, max) {
  const text = String(value ?? "").replace(/[^\x20-\x7e]/g, "?");
  return text.length > max ? text.slice(0, max) : text;
}

const endsOf = (row) => (Number.isSafeInteger(row.endsAt) ? row.endsAt : Number.MAX_SAFE_INTEGER);

function byEndsThenRef(a, b) {
  return endsOf(a) - endsOf(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

function rowOf(e) {
  return {
    ref: clip(`${REF_PREFIX}${e.eventId}`, ROW_LEN.ref),
    source: SOURCE,
    kind: clip(e.eventType, ROW_LEN.kind),
    title: clip(e.label || e.eventType, ROW_LEN.title),
    systemId: e.systemId,
    factionId: Number.isSafeInteger(e.factionId) && e.factionId > 0 ? e.factionId : null,
    level: null,
    scan: SIGNATURE_EVENT_TYPES.includes(e.eventType),
    rewardText: has(REWARD_OF_TYPE, e.eventType) ? REWARD_OF_TYPE[e.eventType] : null,
    endsAt: Number.isSafeInteger(e.expiresAt) ? e.expiresAt : null,
    state: clip(STATE_TEXT[e.state], ROW_LEN.state),
  };
}

function eventRowsOf(rows, opts) {
  const ids = opts && opts.systemIds instanceof Set ? opts.systemIds : null;
  const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1;
  const out = [];
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!e || !has(STATE_TEXT, e.state) || !Number.isSafeInteger(e.systemId)) continue;
    if (ids !== null && !ids.has(e.systemId)) continue;
    out.push(rowOf(e));
  }
  out.sort(byEndsThenRef);
  return { rows: out.slice(0, limit), truncated: out.length > limit };
}

module.exports = { SOURCE, REF_PREFIX, SIGNATURE_EVENT_TYPES, REWARD_TEXT, ROW_LEN, eventRowsOf, byEndsThenRef, clip };
