"use strict";

const S = require("./schema");
const PC = require("./power/catalog");
const { labelOf: heavyLabelOf } = require("./planner");
const { labelOf: powerLabelOf } = require("./power/choose");
const { labelOf: worldLabelOf } = require("./world/choose");
const { incursionLabelOf } = require("./incursion/label");
const WC = require("./world/catalog");
const { LAYER, layerOfRow } = require("./layer");

const REF_PREFIX = Object.freeze({ [LAYER.HEAVY]: "hv:", [LAYER.POWER]: "pw:", [LAYER.WORLD]: "an:",
  [LAYER.INCURSION]: "in:" });
const SOURCE_OF = Object.freeze({ [LAYER.HEAVY]: "heavy", [LAYER.POWER]: "power", [LAYER.WORLD]: "anomaly",
  [LAYER.INCURSION]: "incursion" });
const LEVEL_OF_TIER = Object.freeze({ 1: "L4", 2: "L5", 3: "INCURSION" });
const BOARD_STATES = Object.freeze([S.STATE.PLANNED, S.STATE.ENGAGED]);
const HEAVY_REWARD = Object.freeze({ chest: "Loot chest", payout: "Loot chest, LP + standing" });
const POWER_REWARD = Object.freeze({ power_small: "Loot chest", power_cache: "Cache loot", power_rare: "Rare loot" });
const SIGNATURE = "signature";
const ROW_LEN = Object.freeze({ ref: 64, kind: 24, title: 80, reward: 60, state: 16 });

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function clip(value, max) {
  const text = String(value ?? "").replace(/[^\x20-\x7e]/g, "?");
  return text.length > max ? text.slice(0, max) : text;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const endsOf = (row) => (Number.isSafeInteger(row.endsAt) ? row.endsAt : Number.MAX_SAFE_INTEGER);

function byEndsThenRef(a, b) {
  return endsOf(a) - endsOf(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

function heavyRow(e, ctx) {
  const defense = e.eventType === S.TYPE.DEFENSE;
  const titleFaction = defense && Number.isSafeInteger(e.beneficiaryFactionId) ? e.beneficiaryFactionId : e.factionId;
  return {
    kind: e.eventType,
    title: heavyLabelOf({ factionName: ctx.factionName }, titleFaction, e.eventType),
    scan: false,
    rewardText: defense && ctx.payoutEnabled ? HEAVY_REWARD.payout : HEAVY_REWARD.chest,
    level: null,
  };
}

function powerRow(e, ctx) {
  const name = safe(() => ctx.factionName(e.factionId), null);
  const meta = has(PC.META, e.eventType) ? PC.META[e.eventType] : null;
  const visibility = safe(() => PC.visibilityOfPocket(e.eventType, e.tier, e.variant, e.pocket, ctx.params), null);
  return {
    kind: e.variant || e.eventType,
    title: powerLabelOf(name, e.eventType, e.affix),
    scan: visibility === SIGNATURE,
    rewardText: meta && has(POWER_REWARD, meta.rewardProfile) ? POWER_REWARD[meta.rewardProfile] : null,
    level: null,
  };
}

function worldRow(e, ctx) {
  const name = safe(() => ctx.factionName(e.factionId), null);
  const meta = WC.META[e.variant];
  const visibility = safe(() => PC.visibilityOfPocket(e.eventType, e.tier, e.variant, e.pocket, ctx.worldParams),
    null);
  const pays = ctx.payoutEnabled && Number.isSafeInteger(e.beneficiaryFactionId);
  const text = pays && typeof meta.payoutRewardText === "string" ? meta.payoutRewardText : meta.rewardText;
  return {
    kind: e.variant,
    title: safe(() => worldLabelOf(name, e.variant), e.variant),
    scan: visibility === SIGNATURE,
    rewardText: typeof text === "string" ? text : null,
    level: has(LEVEL_OF_TIER, e.tier) ? LEVEL_OF_TIER[e.tier] : null,
  };
}

function partOf(layer, e, ctx) {
  if (layer === LAYER.HEAVY) return heavyRow(e, ctx);
  if (layer === LAYER.WORLD) return worldRow(e, ctx);
  if (layer === LAYER.INCURSION) {
    const name = safe(() => ctx.factionName(e.factionId), null);
    return { ...worldRow(e, ctx), title: incursionLabelOf(name, e.variant) };
  }
  return powerRow(e, ctx);
}

function heavyRowsOf(rows, opts) {
  const ids = opts && opts.systemIds instanceof Set ? opts.systemIds : null;
  const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1;
  const params = (opts && opts.params) || {};
  const ctx = { factionName: opts && typeof opts.factionName === "function" ? opts.factionName : () => null,
    params, worldParams: (opts && opts.worldParams) || params,
    payoutEnabled: Boolean(opts && opts.payoutEnabled === true) };
  const out = [];
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!e || !BOARD_STATES.includes(e.state) || !Number.isSafeInteger(e.systemId)) continue;
    const layer = layerOfRow(e);
    if (!has(REF_PREFIX, layer)) continue;
    if ((layer === LAYER.WORLD || layer === LAYER.INCURSION) && !WC.isWorldVariant(e.eventType, e.variant)) continue;
    if (ids !== null && !ids.has(e.systemId)) continue;
    const part = partOf(layer, e, ctx);
    out.push({
      ref: clip(`${REF_PREFIX[layer]}${e.eventId}`, ROW_LEN.ref),
      source: SOURCE_OF[layer],
      kind: clip(part.kind, ROW_LEN.kind),
      title: clip(part.title, ROW_LEN.title),
      systemId: e.systemId,
      factionId: Number.isSafeInteger(e.factionId) && e.factionId > 0 ? e.factionId : null,
      level: part.level,
      scan: part.scan,
      rewardText: part.rewardText === null ? null : clip(part.rewardText, ROW_LEN.reward),
      endsAt: Number.isSafeInteger(e.expiresAt) ? e.expiresAt : null,
      state: clip(e.state, ROW_LEN.state),
    });
  }
  out.sort(byEndsThenRef);
  return { rows: out.slice(0, limit), truncated: out.length > limit };
}

module.exports = { REF_PREFIX, SOURCE_OF, LEVEL_OF_TIER, HEAVY_REWARD, POWER_REWARD, ROW_LEN, heavyRowsOf };
