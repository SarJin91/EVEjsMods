// Port with changes of EveJS 261108.1 services/incursion/incursionProjectionRuntime.js sendSession (AGPL-3.0-only, see CREDITS.md): per session the remembered tale is removed (OnTaleRemove "solarsystemid2" [taleID, 2, templateID]) BEFORE a replacement, a token without the influence value (a new token = OnTaleData "charid" [systemID, dict]), never

"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");
const { createIncursionTalesRead } = require("./incursionTalesRead");

const HELPERS_PATH = "services/_shared/serviceHelpers";
const REGISTRY_PATH = "services/chat/sessionRegistry";
const LIFECYCLE_PATH = "services/incursion/incursionLifecycle";
const PRESENTATION_FILE = "services/incursion/incursionPresentation.js";
const PROJECTION_FILE = "services/incursion/incursionProjectionRuntime.js";
const PRESENTATION_SHA1 = "409faee03ab3207e5e3c17a119c962b49ac43c54";
const PROJECTION_SHAPES = Object.freeze([
  "\"OnTaleRemove\", \"solarsystemid2\", [previous.taleID, 2, previous.templateID]",
  "\"OnTaleData\", \"charid\", [systemID,",
  "\"OnInfluenceUpdate\", \"charid\",",
]);
const OBSERVED_FILE = "services/tale/observedTaleData.js";
const OBSERVED_SHA1 = "a01643b93ed92b6e72da4cb2b68f4fe5d82ea3cb";
const OBSERVED_SYSTEMS = new Set([30001363, 30002750, 30002751, 30002753]);
const CONSUMER = "factionIncursions.hud";
const TEMPLATE_CLASS_ID = 2;
const FILETIME_EPOCH = 116444736000000000n;
const FILETIME_PER_MS = 10000n;
const MILLI = 1000;
const MILLI_PER_STEP = 10;
const DETAIL_MAX = 200;

const fit = (text) => {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
};
const lf = (text) => String(text).replace(/\r\n/g, "\n");
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNat = (v) => Number.isSafeInteger(v) && v >= 0;
const positiveId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const systemOf = (session) => (session.solarsystemid2 !== undefined ? Number(session.solarsystemid2) || 0
  : Number(session.solarsystemid || (session._space && session._space.systemID)) || 0);
const characterOf = (session) => positiveId(session.characterID || session.charid);

function systemsMapOf(spec) {
  if (!spec || !Array.isArray(spec.incursions) || !isNat(spec.templateNameID) || !isNat(spec.removeTemplateID)
    || !isId(spec.maxSessions)) {
    return null;
  }
  const bySystem = new Map();
  for (const inc of spec.incursions) {
    if (!inc || !isId(inc.taleId) || !Array.isArray(inc.systems) || !isNat(inc.influenceMilli)
      || !isNat(inc.influenceUpdatedAt) || !isNat(inc.graceMinutes) || !isNat(inc.decayMilliPerHour)) {
      return null;
    }
    for (const s of inc.systems) {
      if (!s || !isId(s.systemId) || !isId(s.sceneType)) return null;
      if (!bySystem.has(s.systemId)) bySystem.set(s.systemId, { incursion: inc, sceneType: s.sceneType });
    }
  }
  return bySystem;
}

function createIncursionHud(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  const serverSrc = deps && typeof deps.serverSrc === "function" ? deps.serverSrc : () => null;
  const readFile = deps && typeof deps.readFile === "function" ? deps.readFile : () => null;
  const consumerDrift = deps && typeof deps.consumerDrift === "function" ? deps.consumerDrift : () => null;
  const sessionState = new WeakMap();
  const talesRead = createIncursionTalesRead({ requireGame });
  let fingerprintResult = null;
  let tracked = 0;

  function readText(srcDir, rel) {
    try {
      const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
      return typeof text === "string" ? lf(text) : null;
    } catch (_err) {
      return null;
    }
  }

  function fingerprintDetail(srcDir) {
    const presentation = readText(srcDir, PRESENTATION_FILE);
    if (presentation === null) return `${PRESENTATION_FILE} missing`;
    if (sha1(presentation) !== PRESENTATION_SHA1) return `${PRESENTATION_FILE} sha1`;
    const projection = readText(srcDir, PROJECTION_FILE);
    if (projection === null) return `${PROJECTION_FILE} missing`;
    for (const shape of PROJECTION_SHAPES) if (!projection.includes(shape)) return `${PROJECTION_FILE} ${shape}`;
    const observed = readText(srcDir, OBSERVED_FILE);
    if (observed === null) return `${OBSERVED_FILE} missing`;
    if (sha1(observed) !== OBSERVED_SHA1) return `${OBSERVED_FILE} sha1`;
    return null;
  }

  function ready() {
    const drift = consumerDrift();
    if (drift) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: fit(`${CONSUMER} ${drift}`) };
    if (fingerprintResult !== null && fingerprintResult.ok !== true) return fingerprintResult;
    if (!requireGame) return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "no requireGame" };
    const srcDir = serverSrc();
    if (typeof srcDir !== "string" || srcDir === "") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "server_src_unknown" };
    }
    if (fingerprintResult === null) {
      const detail = fingerprintDetail(srcDir);
      fingerprintResult = detail === null ? Object.freeze({ ok: true })
        : Object.freeze({ ok: false, reason: "INCURSION_HUD_DRIFT", detail: fit(detail) });
      if (detail !== null) return fingerprintResult;
    }
    const loaded = {};
    for (const [key, rel] of [["helpers", HELPERS_PATH], ["registry", REGISTRY_PATH], ["lifecycle", LIFECYCLE_PATH]]) {
      const r = requireGame(rel);
      if (!r || !r.ok || !r.exports) {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit(`${rel} ${(r && r.reason) || ""}`) };
      }
      loaded[key] = r.exports;
    }
    const h = loaded.helpers;
    if (typeof h.buildKeyVal !== "function" || typeof h.buildDict !== "function"
      || typeof h.buildFiletimeLong !== "function" || typeof loaded.registry.getSessions !== "function"
      || typeof loaded.lifecycle.listTales !== "function") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "builder / getSessions / listTales missing" };
    }
    return { ok: true, ...loaded };
  }

  function influenceData(h, inc) {
    return h.buildKeyVal([
      ["influence", inc.influenceMilli / MILLI],
      ["lastUpdated", h.buildFiletimeLong(FILETIME_EPOCH + BigInt(inc.influenceUpdatedAt) * FILETIME_PER_MS)],
      ["graceTime", inc.graceMinutes], ["decayRate", inc.decayMilliPerHour / MILLI],
    ]);
  }

  function taleKeyVal(h, inc, systemId, sceneType, templateNameID) {
    return h.buildKeyVal([
      ["templateClassID", TEMPLATE_CLASS_ID], ["templateNameID", templateNameID], ["taleID", inc.taleId],
      ["locationID", systemId], ["severity", sceneType], ["visualEffect", null],
      ["incursedSystems", inc.systems.map((s) => s.systemId)],
      ["hasFinalEncounter", false], ["hasChat", false], ["chatAnnouncementMessageId", 0],
      ["influenceData", influenceData(h, inc)], ["effects", []],
    ]);
  }

  function vendorSystemsOf(lifecycle) {
    try {
      const read = talesRead.read(lifecycle);
      if (!read.ok) return null;
      const tales = read.tales;
      const out = new Set();
      for (const tale of tales) {
        if (!tale || tale.terminal) continue;
        const rows = tale.placement && Array.isArray(tale.placement.systems) ? tale.placement.systems : [];
        for (const row of rows) {
          const id = positiveId(row && row.solarSystemID);
          if (id > 0) out.add(id);
        }
      }
      return out;
    } catch (_err) {
      return null;
    }
  }

  function sessionsOf(registry, max) {
    const list = registry.getSessions();
    if (!Array.isArray(list)) return [];
    const shown = list.filter((s) => s && sessionState.has(s));
    return shown.length === 0 ? list.slice(0, max)
      : [...shown, ...list.filter((s) => !(s && sessionState.has(s)))].slice(0, max);
  }

  const emptyResult = () => ({ ok: true, sessions: 0, data: 0, influence: 0, removed: 0, vendorSkipped: 0, errors: 0 });

  function sync(spec) {
    try {
      const bySystem = systemsMapOf(spec);
      if (bySystem === null) return { ok: false, reason: "INVALID_INPUT" };
      const g = ready();
      if (!g.ok) return g;
      if (bySystem.size === 0 && tracked === 0) return emptyResult();
      const vendorSystems = vendorSystemsOf(g.lifecycle);
      if (vendorSystems === null) return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "listTales" };
      const out = emptyResult();
      let shown = 0;
      for (const session of sessionsOf(g.registry, spec.maxSessions)) {
        try {
          if (!session || typeof session.sendNotification !== "function") continue;
          const characterId = characterOf(session);
          let prev = sessionState.get(session) || null;
          if (prev && prev.characterId !== characterId) {
            sessionState.delete(session);
            prev = null;
          }
          if (characterId === 0) continue;
          out.sessions += 1;
          const systemId = systemOf(session);
          const hit = bySystem.get(systemId) || null;
          if (hit && vendorSystems.has(systemId)) out.vendorSkipped += 1;
          const next = hit && !vendorSystems.has(systemId) ? hit : null;
          if (prev && (vendorSystems.has(systemId) || (systemId !== prev.systemId && OBSERVED_SYSTEMS.has(systemId)))) {
            sessionState.delete(session);
            prev = null;
          }
          if (prev && (!next || prev.taleId !== next.incursion.taleId)) {
            session.sendNotification("OnTaleRemove", "solarsystemid2", [prev.taleId, 2, spec.removeTemplateID]);
            sessionState.delete(session);
            out.removed += 1;
            prev = null;
          }
          if (!next) continue;
          const inc = next.incursion;
          const token = JSON.stringify([inc.taleId, systemId, next.sceneType, spec.templateNameID,
            inc.systems.map((s) => s.systemId), inc.graceMinutes, inc.decayMilliPerHour]);
          if (!prev || prev.token !== token) {
            session.sendNotification("OnTaleData", "charid", [systemId, g.helpers.buildDict([[inc.taleId,
              taleKeyVal(g.helpers, inc, systemId, next.sceneType, spec.templateNameID)]])]);
            sessionState.set(session, { characterId, systemId, taleId: inc.taleId, token,
              sentMilli: inc.influenceMilli });
            out.data += 1;
          } else if (Math.abs(inc.influenceMilli - prev.sentMilli) >= MILLI_PER_STEP) {
            session.sendNotification("OnInfluenceUpdate", "charid", [inc.taleId, influenceData(g.helpers, inc)]);
            sessionState.set(session, { ...prev, sentMilli: inc.influenceMilli });
            out.influence += 1;
          }
        } catch (_err) {
          out.errors += 1;
        } finally {
          if (session && sessionState.has(session)) shown += 1;
        }
      }
      tracked = shown;
      return out;
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((err && err.message) || err) };
    }
  }

  function clear(removeTemplateID) {
    try {
      if (!isNat(removeTemplateID)) return { ok: false, reason: "INVALID_INPUT" };
      const g = ready();
      if (!g.ok) return g;
      const out = emptyResult();
      const list = g.registry.getSessions();
      for (const session of Array.isArray(list) ? list : []) {
        try {
          const prev = session ? sessionState.get(session) : null;
          if (!prev) continue;
          sessionState.delete(session);
          out.sessions += 1;
          if (typeof session.sendNotification !== "function" || characterOf(session) !== prev.characterId) continue;
          session.sendNotification("OnTaleRemove", "solarsystemid2", [prev.taleId, 2, removeTemplateID]);
          out.removed += 1;
        } catch (_err) {
          out.errors += 1;
        }
      }
      tracked = 0;
      return out;
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((err && err.message) || err) };
    }
  }

  function stats() {
    const installed = fingerprintResult !== null && fingerprintResult.ok === true;
    const drift = fingerprintResult !== null && fingerprintResult.ok !== true ? fingerprintResult.detail : null;
    return { installed, drift, tracked };
  }

  return Object.freeze({ sync, clear, stats });
}

module.exports = { CONSUMER, PRESENTATION_FILE, PROJECTION_FILE, PRESENTATION_SHA1, PROJECTION_SHAPES, OBSERVED_FILE,
  OBSERVED_SHA1, OBSERVED_SYSTEMS, createIncursionHud };
