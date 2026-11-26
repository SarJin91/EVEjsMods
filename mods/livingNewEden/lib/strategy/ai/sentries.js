"use strict";

const ACTIVE = "ACTIVE";
const READY = "ready";
const AUSTERITY = "AUSTERITY";
const HIGHSEC = "highsec";
const BUSY_STATES = Object.freeze(["CONTESTED", "INVASION"]);
const STATION_KIND = "upwell";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const stationKey = (systemId, stationId) => `s:${systemId}:${stationId}`;
const gateKey = (systemId, toSystemId) => `g:${systemId}:${toSystemId}`;

const anchorKeyOf = (systemId, anchorKind, ref) => (anchorKind === "station" && typeof ref.stationId === "string"
  ? stationKey(systemId, ref.stationId)
  : anchorKind === "gate" && isId(ref.toSystemId) ? gateKey(systemId, ref.toSystemId) : null);

function countsOf(rows, anchors) {
  const perAnchor = new Map();
  const perSystem = new Map();
  const fromAnchors = Array.isArray(anchors);
  for (const a of fromAnchors ? anchors : []) {
    if (!a || !isId(a.systemId)) continue;
    const key = anchorKeyOf(a.systemId, a.anchorKind, a.anchorRef || {});
    if (key !== null) perAnchor.set(key, (perAnchor.get(key) || 0) + count(a.live));
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isId(r.systemId)) continue;
    perSystem.set(r.systemId, (perSystem.get(r.systemId) || 0) + 1);
    const key = fromAnchors ? null : anchorKeyOf(r.systemId, r.anchorKind, r.anchorRef || {});
    if (key !== null) perAnchor.set(key, (perAnchor.get(key) || 0) + 1);
  }
  return { perAnchor, perSystem };
}

function broke(snapshot, P) {
  if (!(P.costIsk > 0)) return false;
  const t = snapshot.treasury;
  if (!t || t.mode !== READY || t.accountMode === AUSTERITY) return true;
  return !(Number(t.balanceIsk) >= P.costIsk * P.minBalanceMultiple);
}

function planSentries(snapshot, params, opts) {
  const done = (note) => ({ intents: [], notes: note ? [note] : [] });
  const P = params && params.sentries;
  const sn = snapshot && snapshot.sentries;
  if (!P) return done(null);
  if (!sn || sn.mode !== READY) return done("SENTRY_OFF");
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return done(null);
  if (opts && count(opts.stationBuilds) > 0) return done("SENTRY_YIELD");
  if (broke(snapshot, P)) return done("SENTRY_BROKE");
  if (count(sn.factionLive) >= P.maxPerFaction) return done("SENTRY_CAP");
  if (count(sn.total) >= P.maxTotal) return done("SENTRY_GLOBAL_CAP");
  const isHostile = typeof snapshot.isHostile === "function" ? snapshot.isHostile : () => false;
  const { perAnchor, perSystem } = countsOf(sn.rows, sn.anchors);
  const candidates = [];
  for (const s of Array.isArray(sn.systems) ? sn.systems : []) {
    if (!s || !isId(s.systemId) || BUSY_STATES.includes(s.occupationState)) continue;
    if (s.secClass === HIGHSEC && P.allowHighsec !== true) continue;
    if ((perSystem.get(s.systemId) || 0) >= P.maxPerSystem) continue;
    for (const st of Array.isArray(s.stations) ? s.stations : []) {
      if (!st || st.kind !== STATION_KIND || typeof st.stationId !== "string") continue;
      const on = perAnchor.get(stationKey(s.systemId, st.stationId)) || 0;
      if (on < P.maxPerAnchor) {
        candidates.push({ order: 0, on, systemId: s.systemId, tie: st.stationId, anchorKind: "station",
          anchorRef: { stationId: st.stationId } });
      }
    }
    for (const n of Array.isArray(s.neighbours) ? s.neighbours : []) {
      if (!n || !isId(n.systemId) || !isHostile(n.controllerFactionId)) continue;
      const on = perAnchor.get(gateKey(s.systemId, n.systemId)) || 0;
      if (on < P.maxPerAnchor) {
        candidates.push({ order: 1, on, systemId: s.systemId, tie: n.systemId, anchorKind: "gate",
          anchorRef: { toSystemId: n.systemId } });
      }
    }
  }
  if (candidates.length === 0) return done("SENTRY_NO_SITE");
  const tieOf = (a, b) => (typeof a.tie === "number" && typeof b.tie === "number" ? a.tie - b.tie
    : String(a.tie) < String(b.tie) ? -1 : String(a.tie) > String(b.tie) ? 1 : 0);
  candidates.sort((a, b) => a.order - b.order || a.on - b.on || a.systemId - b.systemId || tieOf(a, b));
  const room = Math.min(P.maxBuildsPerReview, P.maxPerFaction - count(sn.factionLive), P.maxTotal - count(sn.total));
  const intents = [];
  const used = new Set();
  for (const c of candidates) {
    if (intents.length >= room) break;
    if (used.has(c.systemId)) continue;
    used.add(c.systemId);
    intents.push({ type: "SENTRY_BUILD", slot: intents.length, systemId: c.systemId, anchorKind: c.anchorKind,
      anchorRef: c.anchorRef, typeId: sn.typeId });
  }
  if (intents.length === 0) return done("SENTRY_NO_SITE");
  return { intents, notes: ["SENTRY_PLAN"] };
}

module.exports = { planSentries };
