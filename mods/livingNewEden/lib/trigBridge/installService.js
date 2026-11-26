"use strict";

const rules = require("./rules");
const install = require("./install");

const MAIL_AGGREGATE = "trig_bridge";
const MAIL_EVENT = "TRIG_BRIDGE_MAIL";
const MARKER_VERSION = rules.MARKER_VERSION;
const DIAG_ROWS_MAX = 8;

const messageOf = (err) => String((err && err.message) || err).slice(0, 120);

function createInstallService(deps) {
  const { cfg, adapter, clock, bump, log } = deps;
  const mailer = deps.mailer || null;

  function distance(a, b) {
    const ly = adapter.trigBridgeDistanceLy(a, b);
    return Number.isFinite(ly) ? ly : NaN;
  }

  function mail(kind, structureId, partnerId, characterId, facts) {
    if (!mailer || !(characterId > 0)) return false;
    const key = install.mailKeyOf(structureId, kind, partnerId);
    const opened = mailer.store.transaction("trigBridge.mail", (tx) => mailer.journal.applyOnce(tx, { key,
      aggregate: { type: MAIL_AGGREGATE, id: structureId }, eventType: MAIL_EVENT,
      payload: { kind, characterId, partnerId: partnerId || 0 } }, () => null));
    const once = opened && opened.ok ? opened.value : null;
    if (!once || once.ok !== true) {
      if (!once || once.reason !== "IDEMPOTENCY_CONFLICT") {
        log(`trigBridge: mail ${key} not sent - ${(opened && !opened.ok ? opened.reason : once && once.reason)
          || "no result"}`);
      }
      return false;
    }
    if (once.duplicate === true) return false;
    const m = install.mailBodyOf(kind, facts);
    const sent = adapter.sendPlayerMail({ senderId: mailer.senderId, toCharacterId: characterId, title: m.title,
      body: m.body, sentDate: install.filetimeOf(clock.now()) });
    if (sent && sent.ok) {
      bump("mailsSent");
      return true;
    }
    log(`trigBridge: mail ${key} failed - ${sent ? sent.reason : "no result"}`);
    return false;
  }

  function linkMailFacts(a, b) {
    return { structure: a, partner: b, realLy: distance(a.systemId, b.systemId), fuelLyPermille: cfg.fuelLyPermille,
      maxRangeLy: cfg.maxRangeLy };
  }

  function link(a, b, counter) {
    const w1 = adapter.writeTrigBridgeDestination(a.structureId, b.systemId);
    const w2 = w1.ok ? adapter.writeTrigBridgeDestination(b.structureId, a.systemId) : w1;
    if (!w1.ok || !w2.ok) {
      log(`trigBridge: link ${a.structureId}<->${b.structureId} failed - ${(w1.ok ? w2 : w1).reason}`);
      return false;
    }
    adapter.syncTrigBridgeScene(a.systemId);
    adapter.syncTrigBridgeScene(b.systemId);
    announceLink(a, b, counter);
    return true;
  }

  function announceLink(a, b, counter) {
    bump(counter);
    mail("LINKED", a.structureId, b.structureId, a.installedBy, linkMailFacts(a, b));
    mail("LINKED", b.structureId, a.structureId, b.installedBy, linkMailFacts(b, a));
  }

  function settleAlliance(allianceId) {
    const out = { partial: 0, linked: 0 };
    const listed = adapter.listTrigBridges({ allianceId, max: cfg.listMax });
    if (!listed.ok) {
      log(`trigBridge: list of alliance ${allianceId} failed - ${listed.reason}`);
      return out;
    }
    const plan = install.planPairs(install.markedViewOf(listed.rows), distance, cfg.maxRangeLy);
    for (const [a, b] of plan.partial) if (link(a, b, "linkPartial")) out.partial += 1;
    for (const [a, b] of plan.pairs) if (link(a, b, "links")) out.linked += 1;
    if (plan.unpaired.length >= 2) {
      log(`trigBridge: alliance ${allianceId} free bridges without a partner in range: `
        + `${plan.unpaired.map((m) => m.structureId).join(",")}`);
    }
    return out;
  }

  function refuse(q, reason, detail) {
    bump("installRefused");
    if (cfg.statusMail) {
      mail("REFUSED", q.structure.structureId, 0, q.characterId, { structure: q.structure, reason, detail });
    }
    return { ok: false, message: install.installRefusalText(reason, detail) };
  }

  function onCore(q) {
    try {
      const s = q.structure;
      const allianceId = s.allianceId;
      const now = clock.now();
      let markedOfAlliance = [];
      if (allianceId) {
        const listed = adapter.listTrigBridges({ allianceId, max: cfg.listMax });
        if (!listed.ok) return { ok: false, message: install.installRefusalText("UNAVAILABLE") };
        if (listed.truncated === true) {
          log(`trigBridge: install on ${s.structureId} refused - Ansiblex list truncated at listMax=${cfg.listMax}`);
          return { ok: false, message: install.installRefusalText("UNAVAILABLE") };
        }
        markedOfAlliance = install.markedViewOf(listed.rows).filter((m) => m.structureId !== s.structureId);
      }
      const d = install.decideInstall({ structure: s, hasRole: q.hasRole, sameCorp: q.corporationId > 0
        && q.corporationId === s.ownerCorpId, allianceId, markedOfAlliance,
      lyOf: distance, cfg, now });
      if (!d.ok) return refuse(q, d.reason, d.detail);
      const partner = d.partner ? markedOfAlliance.find((m) => m.structureId === d.partner.structureId) || null : null;
      const preLinked = Boolean(partner) && s.destinationSystemId === partner.systemId
        && partner.destinationSystemId === s.systemId && partner.systemId !== s.systemId;
      const v = q.consume(install.installKeyOf(s.structureId));
      if (!v || !v.ok) {
        log(`trigBridge: core void on ${s.structureId} failed - ${v ? `${v.reason}${v.detail ? `:${v.detail}` : ""}`
          : "no result"}`);
        return { ok: false, message: install.installRefusalText(v && v.ambiguous === false ? "UNAVAILABLE"
          : "MARKER_PENDING") };
      }
      if (v.outcome === "ALREADY_COMMITTED") bump("installDuplicate");
      const marker = { v: MARKER_VERSION, installedAt: now, installedBy: q.characterId, coreTypeId: q.core.typeId };
      const w = adapter.writeTrigBridgeMarker(s.structureId, marker);
      if (!w.ok) {
        log(`trigBridge: marker of ${s.structureId} failed after the void - ${w.reason}`);
        return { ok: false, message: install.installRefusalText("MARKER_PENDING") };
      }
      if (!w.alreadySet) bump("installs");
      if (typeof deps.applyLook === "function") deps.applyLook(s.structureId);
      if (cfg.statusMail) {
        mail("INSTALLED", s.structureId, 0, q.characterId, { structure: s, partner, maxRangeLy: cfg.maxRangeLy });
      }
      if (allianceId) settleAlliance(allianceId);
      if (preLinked) {
        const self = { structureId: s.structureId, systemId: s.systemId, systemName: s.systemName,
          installedBy: q.characterId };
        announceLink(self, partner, "links");
      }
      return { ok: true, consumedItemId: v.outcome === "VOIDED" && v.gone ? q.core.itemId : null };
    } catch (err) {
      log(`trigBridge: install failed - ${messageOf(err)}`);
      return { ok: false, message: install.installRefusalText("UNAVAILABLE") };
    }
  }

  function repair() {
    const out = { alliances: 0, partial: 0, linked: 0, truncated: false };
    try {
      const listed = adapter.listTrigBridges({ max: cfg.listMax });
      if (!listed.ok) {
        log(`trigBridge: repair list failed - ${listed.reason}`);
        return out;
      }
      out.truncated = listed.truncated === true;
      const alliances = [...new Set(install.markedViewOf(listed.rows).map((m) => m.allianceId).filter(Boolean))]
        .sort((a, b) => a - b);
      for (const allianceId of alliances) {
        const r = settleAlliance(allianceId);
        out.alliances += 1;
        out.partial += r.partial;
        out.linked += r.linked;
      }
    } catch (err) {
      log(`trigBridge: repair failed - ${messageOf(err)}`);
    }
    return out;
  }

  function diagnose(text, counters) {
    const parsed = install.parseDiagCommand(text);
    if (!parsed || parsed.cmd !== "status") return "Usage: !trigbridge status";
    const listed = adapter.listTrigBridges({ max: cfg.listMax });
    if (!listed.ok) return `trigBridge: list failed (${listed.reason})`;
    const view = install.markedViewOf(listed.rows);
    const c = counters || {};
    const head = `trigBridge: ${view.length} marked, ${view.filter((m) => m.linked).length} linked`
      + `${listed.truncated ? " (list truncated)" : ""}; installs=${c.installs || 0} refused=${c.installRefused || 0}`
      + ` links=${c.links || 0} jumps=${c.jumps || 0} mail=${mailer ? "on" : "off"}`;
    const lines = view.slice(0, DIAG_ROWS_MAX).map((m) => `${m.structureId}@${m.systemName || m.systemId}`
      + ` a${m.allianceId} -> ${m.linked ? m.partnerId : "free"}`);
    return [head, ...lines].join("<br>");
  }

  return Object.freeze({ onCore, repair, settleAlliance, diagnose });
}

module.exports = { createInstallService, MAIL_AGGREGATE, MAIL_EVENT };
