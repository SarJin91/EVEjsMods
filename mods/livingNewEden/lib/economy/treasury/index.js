"use strict";

const { createTreasuryRepository } = require("./treasuryRepository");
const { createTreasuryService } = require("./treasuryService");
const { createHullValueTable } = require("./hullValues");
const { createRecipeTable, recipeParamsOf } = require("../production/recipes");
const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../data/mineralRefPrices");

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableTreasury(reason, detail) {
  const status = Object.freeze({ state: "off", reason: String(reason) });
  const off = Object.freeze({ ok: true, treasury: Object.freeze({ mode: "off" }) });
  const refuse = () => Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    getMode: () => "off",
    fundsTrade: () => false,
    readForReview: () => off,
    settleIntentInTx: refuse,
    creditTradeProceedsInTx: refuse,
    readMercAccountInDb: () => Object.freeze({ ok: true, mode: "off" }),
    readUnpaidDaysInDb: () => Object.freeze({ ok: true, mode: "off" }),
    chargeMercInTx: () => Object.freeze({ ok: false, reason: "TREASURY_OFF" }),
    chargeWarSpendInTx: () => Object.freeze({ ok: false, reason: "TREASURY_OFF" }),
    listForPanel: refuse,
    lossConsequence: null,
    count() {},
    noteRefusal() {},
    getChangeCount: () => 0,
    getSeq: () => 0,
    getDay: () => 0,
    getStatus: () => status,
    stop() {},
  });
}

function startTreasury(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    if (!config || !config.treasury || config.treasury.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "TREASURY_START_FAILED", detail: "clock" };
    let hullValues;
    try {
      const recipes = createRecipeTable(deps.recipesData || require("../data/hullRecipes"),
        recipeParamsOf(config.production), deps.industryCatalog || undefined);
      hullValues = createHullValueTable(recipes, REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE);
    } catch (err) {
      return { ok: false, reason: "TREASURY_START_FAILED", detail: `hull values: ${messageOf(err)}` };
    }
    const repository = createTreasuryRepository({ journal: persistence.journal, clock });
    const service = createTreasuryService({ store: persistence.store, repository, config, clock, hullValues,
      getTrade: deps.getTrade, getStrategy: deps.getStrategy, telemetry: deps.telemetry || null });
    return { ok: true, treasury: service };
  } catch (err) {
    return { ok: false, reason: "TREASURY_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startTreasury, createUnavailableTreasury };
