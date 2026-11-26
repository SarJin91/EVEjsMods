"use strict";

const { validateConfig } = require("./rules");
const { createTrigBridgeService, COUNTER_NAMES } = require("./service");
const { createInstallService } = require("./installService");
const { parseDiagCommand } = require("./install");

const TRIG_BRIDGE_METHODS = Object.freeze(["getStatus", "stop"]);
const COMMAND_NAME = "trigbridge";
const GM_ONLY_REPLY = "Only GM accounts can use !trigbridge.";

const messageOf = (err) => String((err && err.message) || err);

function createUnavailableTrigBridge(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, stop() {} });
}

function mailerOf(cfg, adapter, persistence, logger) {
  if (!cfg.statusMail) return null;
  const p = persistence;
  const sender = typeof adapter.defaultMailSender === "function" ? adapter.defaultMailSender() : null;
  if (!p || p.ok !== true || !p.store || !p.journal || typeof adapter.sendPlayerMail !== "function"
    || !sender || sender.ok !== true) {
    const why = !p || p.ok !== true || !p.journal ? "no journal" : (sender && sender.reason) || "no sender";
    logger.log(`trigBridge: W133 trigBridge.statusMail on, mail seam unavailable (${why}) - status in the log only`);
    return null;
  }
  return { store: p.store, journal: p.journal, senderId: sender.senderId };
}

function startInstall({ cfg, adapter, clock, service, logger, persistence, look }) {
  const off = (state) => ({ state, stop() {} });
  try {
    const needed = ["installTrigBridgeDepositHook", "uninstallTrigBridgeDepositHook", "listTrigBridges",
      "writeTrigBridgeMarker", "writeTrigBridgeDestination", "syncTrigBridgeScene", "trigBridgeDistanceLy",
      "trigBridgeCoreType"];
    const missing = needed.find((name) => typeof adapter[name] !== "function");
    if (missing) {
      logger.log(`trigBridge: install off - no adapter.${missing}`);
      return off("off:SEAM_UNAVAILABLE");
    }
    const core = adapter.trigBridgeCoreType(cfg.coreTypeId);
    if (!core || core.ok !== true || core.found !== true) {
      logger.log(`trigBridge: W129 trigBridge.coreTypeId ${cfg.coreTypeId} not in the type registry`
        + `${core && core.ok !== true ? ` (${core.reason})` : ""} - install off`);
      return off("off:W129");
    }
    if (core.fuel === true) {
      logger.log(`trigBridge: W132 trigBridge.coreTypeId ${cfg.coreTypeId} is a fuel type - the core can reach the`
        + " fuel bay and burn");
    }
    const svc = createInstallService({ cfg, adapter, clock, bump: service.bump,
      log: (line) => logger.log(line), mailer: mailerOf(cfg, adapter, persistence, logger),
      applyLook: look ? look.apply : null });
    const hook = adapter.installTrigBridgeDepositHook({ coreTypeId: cfg.coreTypeId, onCore: svc.onCore,
      onEvent: service.onEvent });
    if (!hook || hook.ok !== true) {
      const reason = String((hook && hook.reason) || "SEAM_UNAVAILABLE");
      logger.log(`trigBridge: install off - ${reason}${hook && hook.detail ? ` (${hook.detail})` : ""}`);
      return off(`off:${reason}`);
    }
    const repaired = svc.repair();
    logger.log(`trigBridge: install on coreTypeId=${cfg.coreTypeId} repair alliances=${repaired.alliances}`
      + ` linkPartial=${repaired.partial} links=${repaired.linked}${repaired.truncated ? " truncated" : ""}`);
    let chat = false;
    if (cfg.debugCommand && typeof adapter.installChatCommand === "function") {
      const r = adapter.installChatCommand({ name: COMMAND_NAME, match: (text) => parseDiagCommand(text) !== null,
        handle: (_rec, text, ctx) => (ctx && ctx.gm === true ? svc.diagnose(text, service.getStatus().counters)
          : GM_ONLY_REPLY), failReply: "trigBridge unavailable" });
      chat = Boolean(r && r.ok);
      if (!chat) logger.log(`trigBridge: !trigbridge off - ${(r && r.reason) || "no result"}`);
    }
    return { state: "on", stop() {
      adapter.uninstallTrigBridgeDepositHook();
      if (chat && typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
    } };
  } catch (err) {
    logger.log(`trigBridge: install off - ${messageOf(err)}`);
    return off("off:TRIG_BRIDGE_START_FAILED");
  }
}

function startPresentation({ cfg, adapter, service, logger }) {
  const off = (state) => ({ state, apply() {}, stop() {} });
  const typeId = cfg.presentationTypeId;
  if (!(typeId > 0)) return off("off");
  try {
    const needed = ["installTrigBridgePresentation", "applyTrigBridgePresentation", "uninstallTrigBridgePresentation",
      "listTrigBridges", "trigBridgeCoreType"];
    const missing = needed.find((name) => typeof adapter[name] !== "function");
    if (missing) {
      logger.log(`trigBridge: presentation off - no adapter.${missing}`);
      return off("off:SEAM_UNAVAILABLE");
    }
    const type = adapter.trigBridgeCoreType(typeId);
    if (!type || type.ok !== true || type.found !== true) {
      logger.log(`trigBridge: W127 trigBridge.presentationTypeId ${typeId} not in the type registry`
        + `${type && type.ok !== true ? ` (${type.reason})` : ""} - look off`);
      return off("off:W127");
    }
    const installed = adapter.installTrigBridgePresentation({ typeId,
      onApplied: () => service.bump("presentationApplied") });
    if (!installed || installed.ok !== true) {
      const reason = String((installed && installed.reason) || "SEAM_UNAVAILABLE");
      logger.log(`trigBridge: presentation off - ${reason}${installed && installed.detail ? ` (${installed.detail})`
        : ""}`);
      return off(`off:${reason}`);
    }
    const listed = adapter.listTrigBridges({ max: cfg.listMax });
    let applied = 0;
    if (listed && listed.ok) {
      for (const row of listed.rows) {
        const r = adapter.applyTrigBridgePresentation(row.structureId);
        if (r && r.ok && r.applied) applied += 1;
      }
    }
    logger.log(`trigBridge: presentation on typeId=${typeId}${type.name ? ` (${type.name})` : ""} applied=${applied}`
      + `${listed && listed.ok ? (listed.truncated ? " truncated" : "") : ` list failed (${listed && listed.reason})`}`);
    return { state: "on", apply(structureId) {
      adapter.applyTrigBridgePresentation(structureId);
    }, stop() {
      adapter.uninstallTrigBridgePresentation();
    } };
  } catch (err) {
    logger.log(`trigBridge: presentation off - ${messageOf(err)}`);
    return off("off:TRIG_BRIDGE_START_FAILED");
  }
}

function startTrigBridge(deps) {
  try {
    const { config, adapter, clock } = deps || {};
    const P = config && config.trigBridge;
    if (!P || P.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const checked = validateConfig(P);
    if (!checked.ok) return { ok: false, reason: "TRIG_BRIDGE_START_FAILED", detail: checked.reason };
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "TRIG_BRIDGE_START_FAILED", detail: "clock" };
    }
    if (!adapter || typeof adapter.installTrigBridgeJumpScope !== "function"
      || typeof adapter.uninstallTrigBridgeJumpScope !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "no installTrigBridgeJumpScope" };
    }
    for (const w of checked.warnings) logger.log(`trigBridge: ${w}`);
    const service = createTrigBridgeService({ cfg: checked.cfg, clock, telemetry: deps.telemetry || null });
    const installed = adapter.installTrigBridgeJumpScope({ decide: service.decide, onJump: service.onJump,
      onEvent: service.onEvent });
    if (!installed || installed.ok !== true) {
      const reason = String((installed && installed.reason) || "SEAM_UNAVAILABLE");
      if (reason === "TRIG_BRIDGE_DRIFT") service.bump("drift");
      return { ok: false, reason, ...(installed && installed.detail ? { detail: String(installed.detail) } : {}) };
    }
    const cfg = checked.cfg;
    logger.log(`trigBridge: running maxRangeLy=${cfg.maxRangeLy} fuelLyPermille=${cfg.fuelLyPermille}`
      + ` cooldownMs=${cfg.jumpCooldownMs}`);
    const lookPart = startPresentation({ cfg, adapter, service, logger });
    const installPart = startInstall({ cfg, adapter, clock, service, logger, persistence: deps.persistence,
      look: lookPart });
    let stopped = false;
    const facade = {
      getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", ...service.getStatus(),
        install: installPart.state, presentation: lookPart.state }),
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          installPart.stop();
          lookPart.stop();
          adapter.uninstallTrigBridgeJumpScope();
        } catch (_err) {
        }
      },
    };
    return { ok: true, trigBridge: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "TRIG_BRIDGE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startTrigBridge, createUnavailableTrigBridge, TRIG_BRIDGE_METHODS, COUNTER_NAMES, COMMAND_NAME,
  COMMAND_RE: require("./install").DIAG_RE };
