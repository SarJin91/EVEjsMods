"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const killObservation = require("../adapter/killObservation");
const { LEVELS } = require("./data/levels");
const { createBountyService, COUNTER_NAMES } = require("./service");

const BOUNTY_METHODS = Object.freeze(["getStatus", "stop", "runPassNow", "residentsFor", "listBoardRows",
  "postFameBounty"]);
const FAME_DISABLED = Object.freeze({ outcome: "disabled" });
const MAX_FACTION_IDS_TEXT = 200;

const messageOf = (err) => String((err && err.message) || err);

function parseFactionIds(text) {
  if (typeof text !== "string" || text.length > MAX_FACTION_IDS_TEXT) return null;
  const out = [];
  for (const part of text.split(",")) {
    const s = part.trim();
    if (s === "") continue;
    if (!/^[0-9]+$/.test(s)) return null;
    const id = Number(s);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : null;
}

function createUnavailableBounty(reason, detail) {
  const why = String(reason || "BOUNTY_UNAVAILABLE");
  const status = Object.freeze({ state: "unavailable", reason: why, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: why === "BOUNTY_DISABLED" ? "BOUNTY_DISABLED" : "NOT_READY" });
  return Object.freeze({ getStatus: () => status, stop() {}, runPassNow: () => refusal, residentsFor: () => refusal,
    listBoardRows: () => refusal, postFameBounty: () => FAME_DISABLED });
}

function startBounty(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const P = config && config.bountyHunters;
    if (!P || P.enabled !== true || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    if (!isModuleEnabled(config, "virtualCorps")) return { ok: false, reason: "dependency_disabled:virtualCorps" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "BOUNTY_START_FAILED", detail: "clock" };
    const factionIds = parseFactionIds(P.factionIds);
    if (!factionIds) return { ok: false, reason: "BOUNTY_START_FAILED", detail: "factionIds" };
    if (typeof deps.homeStationOf !== "function" || typeof deps.bloodlinesOf !== "function") {
      return { ok: false, reason: "BOUNTY_START_FAILED", detail: "homeStationOf/bloodlinesOf" };
    }
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : (typeof persistence.store.getWorldSeed === "function" ? persistence.store.getWorldSeed() : undefined);
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "BOUNTY_START_FAILED", detail: "worldSeed" };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const liveWanted = P.liveEnabled === true;
    const liveState = !liveWanted ? null : killObservation.killWrapMounted() === true ? "on" : "no_wrap";
    const settings = liveState === "no_wrap" ? Object.freeze({ ...P, liveEnabled: false }) : P;

    const service = createBountyService({ store: persistence.store, worldSeed, settings, factionIds,
      levels: LEVELS, getGraph: deps.getGraph, getVirtualCorps: deps.getVirtualCorps,
      homeStationOf: deps.homeStationOf, bloodlinesOf: deps.bloodlinesOf, excludedRegionIds: deps.excludedRegionIds,
      systemFactionsOf: deps.systemFactionsOf,
      ownerCharacterBudget: config.virtualCorps ? config.virtualCorps.ownerCharacterBudget : 0,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      getPresence: deps.getPresence, getBountyScene: deps.getBountyScene, characterNameOf: deps.characterNameOf,
      onResidentsChanged: typeof deps.onResidentsChanged === "function" ? deps.onResidentsChanged : null,
      admitScene: typeof deps.admitScene === "function" ? deps.admitScene : null,
      rewardCreditIsk: deps.rewardCreditIsk, sendCharacterSystemLine: deps.sendCharacterSystemLine,
      rollOfficerLoot: deps.rollOfficerLoot,
      getHuntScene: deps.getHuntScene, getHuntParams: deps.getHuntParams,
      createNemesisStep: typeof deps.createNemesisStep === "function" ? deps.createNemesisStep : null,
      nemesisSettings: config.nemesis || null,
      typesKnown: typeof deps.typesKnown === "function" ? deps.typesKnown : null,
      ewarProfilesOf: typeof deps.ewarProfilesOf === "function" ? deps.ewarProfilesOf : null,
      getNotices: typeof deps.getNotices === "function" ? deps.getNotices : null,
      getChatterAi: typeof deps.getChatterAi === "function" ? deps.getChatterAi : null,
      readFactionNames: typeof deps.readFactionNames === "function" ? deps.readFactionNames : null,
      fameHighsec: deps.fameHighsec && typeof deps.fameHighsec === "object" ? deps.fameHighsec : null,
      getConcord: typeof deps.getConcord === "function" ? deps.getConcord : null,
      journal: persistence.journal || null });
    const booted = service.boot(clock.now());
    if (!booted.ok) {
      service.stop();
      return { ok: false, reason: "BOUNTY_START_FAILED", detail: `${booted.reason}:${booted.detail || ""}` };
    }
    const poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: P.passMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`bounty: pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "BOUNTY_START_FAILED", detail: `poller ${started.reason}` };
    }
    let payInFlight = false;
    const payPoller = P.payoutEnabled === true ? createPoller({
      runPass: () => {
        if (payInFlight) return;
        payInFlight = true;
        service.runPayoutPass(clock.now()).then(() => { payInFlight = false; }, (err) => {
          payInFlight = false;
          logger.log(`bounty: payout pass threw - ${messageOf(err)}`);
        });
      },
      intervalMs: P.payoutPassMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`bounty: payout pass threw - ${messageOf(err)}`),
    }) : null;
    const payStarted = payPoller ? payPoller.start() : { ok: true };
    if (!payStarted.ok) {
      poller.stop();
      service.stop();
      return { ok: false, reason: "BOUNTY_START_FAILED", detail: `payout poller ${payStarted.reason}` };
    }
    const st = service.getStatus();
    logger.log(`bounty: running gangs=${P.maxGangs} slots=${st.slots} maxActive=${P.maxActive}`
      + ` factions=${factionIds.join(",")}`
      + ` active=${st.active} recovered=${st.counters.recovered}`
      + (liveState === "on" ? ` live=on maxLive=${P.maxLive}` : liveState === "no_wrap" ? " live=no_wrap" : "")
      + (P.payoutEnabled === true ? ` payouts=on pending=${st.payouts ? st.payouts.pending : 0}` : ""));
    if (liveState === "no_wrap") {
      logger.log("bounty: LIVE not started - the NPC kill wrap (factionKillStandingRuntime) is not mounted");
    }
    const killListener = liveState === "on"
      ? Object.freeze({ onNpcKill: (obs) => service.onNpcKill(obs, clock.now()) }) : null;
    if (killListener) killObservation.setBounty(killListener);
    const facade = {
      getStatus: () => (liveState ? Object.freeze({ ...service.getStatus(), liveState }) : service.getStatus()),
      runPassNow: () => service.runPass(clock.now()),
      residentsFor: (systemIds, now) => service.residentsFor(systemIds, now),
      listBoardRows: (q) => {
        try {
          return service.listBoardRows(q);
        } catch (_err) {
          return { ok: false, reason: "BOARD_FAILED" };
        }
      },
      postFameBounty: (spec) => {
        try {
          return service.postFameBounty(spec);
        } catch (err) {
          return { outcome: "failed", reason: messageOf(err) };
        }
      },
      stop() {
        if (service.isStopped()) return;
        if (killListener && killObservation.getBounty() === killListener) killObservation.setBounty(null);
        poller.stop();
        if (payPoller) payPoller.stop();
        service.stop();
      },
    };
    return { ok: true, bounty: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "BOUNTY_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startBounty, createUnavailableBounty, parseFactionIds, BOUNTY_METHODS, COUNTER_NAMES };
