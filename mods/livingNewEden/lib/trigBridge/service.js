"use strict";

const rules = require("./rules");

const COUNTER_NAMES = Object.freeze(["jumps", "jumpsHeavy", "passthroughVanilla", "refusedRange",
  "refusedCooldown", "scopeErrors", "drift", "installs", "installRefused", "installDuplicate", "installErrors", "links",
  "linkPartial", "mailsSent", "presentationApplied"]);

function createTrigBridgeService(deps) {
  const cfg = deps.cfg;
  const clock = deps.clock;
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const lastJumpAt = new Map();

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `trigBridge.${name}`, n);
  }

  function prune(now) {
    for (const [id, at] of lastJumpAt) {
      if (now - at >= cfg.jumpCooldownMs) lastJumpAt.delete(id);
    }
  }

  function decide(q) {
    if (!rules.isTrigMarker(q.source) || !rules.isTrigMarker(q.destination)) return { pass: true };
    if (!q.sourcePosition || !q.destinationPosition) return { pass: true };
    const now = clock.now();
    const prev = lastJumpAt.has(q.characterId) ? lastJumpAt.get(q.characterId) : null;
    const d = rules.decideJump({ realLy: q.realLy, lastJumpAt: prev, now, cfg });
    if (!d.ok) {
      if (d.reason === "NO_POSITION") return { pass: true };
      return { ok: false, reason: d.reason, message: rules.refusalMessage(d.reason, d.detail) };
    }
    return { ok: true, effLy: d.effLy, at: now,
      position: rules.scaledDestinationPosition(q.sourcePosition, q.destinationPosition, q.realLy, d.effLy) };
  }

  function onJump(e) {
    const at = Number.isFinite(e.at) ? e.at : clock.now();
    prune(at);
    lastJumpAt.set(e.characterId, at);
    bump("jumps");
    if (e.heavy === true) bump("jumpsHeavy");
  }

  function onEvent(name) {
    bump(String(name));
  }

  function getStatus() {
    return Object.freeze({ counters: Object.freeze({ ...counters }), cooldowns: lastJumpAt.size });
  }

  return Object.freeze({ decide, onJump, onEvent, bump, getStatus });
}

module.exports = { createTrigBridgeService, COUNTER_NAMES };
