"use strict";

const { fingerprintFunctions } = require("./blueprintOwnerRead");
const { callerFrames } = require("./templateReadOnly");

const DETAIL_MAX = 200;
const SITE_FILE = "dungeonUniverseSiteService.js";
const TICK_FUNCTION = "tickSceneSiteBehaviors";
const MOON_FRAME_FUNCTION = "moonPresentationReader";
const MOON_FRAME_FILE = "/moonOreAnomalies/lib/presentationOverlay.js";
const NAMED_CALLERS = Object.freeze(["processGateDefenseHazards", "maybeAdvanceExplicitlySatisfiedObjective"]);

const ANCHORS = Object.freeze({
  A1: Object.freeze({ text: "processPaidMissionMiningObjective(scene, dungeonRuntime.getInstance(instance.instanceID) || instance," }),
  A2: Object.freeze({ text: "dungeonRuntime.getInstance(instance.instanceID) || instance;", after: "const refreshedForObjective =" }),
  A3: Object.freeze({
    text: "dungeonTrackingRuntime.processGuideApproachTexts(scene, dungeonRuntime.getInstance(instance.instanceID) || instance);",
  }),
});

const FINGERPRINTS = Object.freeze({
  site: Object.freeze({
    tickSceneSiteBehaviors: "4bf0a3067f50a31562d43c2ba6514f922e7f2f2e",
    processGateDefenseHazards: "1c8704037aefa335299b592afe83d9a61f905a54",
    maybeAdvanceExplicitlySatisfiedObjective: "514bfe3f1c93a65d336e0e455c8e86ee0f39c5cc",
    processPaidMissionMiningObjective: "b8583d228ab6951c098c9f1d70b7317d19a3077e",
    readPaidMissionMiningTrigger: "10a8321fe1fcc9a14f86b35c3809145945473ab1",
    isSiteObjectiveExplicitlySatisfied: "d201f3ee5d391410b6922968dbe3993b608b131f",
    isDungeonInstanceObjectiveCompleted: "6d54b04f88f503ac02f716f331f2a4a6bc35aa15",
  }),
  tracking: Object.freeze({
    processGuideApproachTexts: "3da193072f0624bb1657a86b1283ca5e040f4335",
    resolveTemplate: "fde3a620f0f095753234e45e84cfef81bcc7d7f5",
    guideAgentIDOf: "c2817e2dccd686d96f5ebc73844b2f80c2986191",
  }),
  runtime: Object.freeze({
    getInstance: "8cfa765e393b8788284f4b6b764194ce47d7b26e",
    getInstanceRef: "041eabd66edf5fc8ec34b0148ff36acb13181cb8",
    mergeStateField: "f3bf3242316dbc1da5afd9599b37e1022eb09eaf",
    mergeHazardState: "c724628d1533fa22b42804815b39e5e200d70a8e",
  }),
  runtimeState: Object.freeze({
    getInstanceSnapshot: "7b6abf5a9e2540a2d80e44f6da63b37136b2eb74",
    getInstanceRef: "f0d8a16e501b425e40f5b91943f05b8d11754bf0",
  }),
});

function defaultNow() {
  return process.hrtime.bigint();
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfInstanceRef", { value: original });
  return wrapper;
}

function fileOf(frame) {
  return String(frame && frame.getFileName() || "").replace(/\\/g, "/");
}

function isMoonPresentationFrame(frame) {
  return Boolean(frame) && frame.getFunctionName() === MOON_FRAME_FUNCTION && fileOf(frame).endsWith(MOON_FRAME_FILE);
}

function scanAnchors(siteSource) {
  const lines = String(siteSource || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`function ${TICK_FUNCTION}(`));
  if (start < 0) return { ok: false, detail: `${TICK_FUNCTION} missing` };
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, detail: `${TICK_FUNCTION} unterminated` };
  const found = new Map();
  for (const [key, anchor] of Object.entries(ANCHORS)) {
    const hits = [];
    for (let i = start + 1; i < end; i += 1) {
      if (lines[i].trim() !== anchor.text) continue;
      if (anchor.after && lines[i - 1].trim() !== anchor.after) continue;
      hits.push(i + 1);
    }
    if (hits.length !== 1) return { ok: false, detail: `${key} x${hits.length}` };
    found.set(hits[0], key);
  }
  return { ok: true, fnLine: start + 1, lines: found };
}

const UPSTREAM_TICK_DELEGATE = `${TICK_FUNCTION}InPass(`;

function functionLines(lines, name) {
  const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) if (lines[i] === "}") return { start, end: i };
  return null;
}

function anchorsFixedUpstream(siteSource) {
  const lines = String(siteSource || "").replace(/\r\n/g, "\n").split("\n");
  const tick = functionLines(lines, TICK_FUNCTION);
  const pass = functionLines(lines, `${TICK_FUNCTION}InPass`);
  if (!tick || !pass) return null;
  const tickBody = lines.slice(tick.start, tick.end + 1).join("\n");
  if (!tickBody.includes(UPSTREAM_TICK_DELEGATE) || tickBody.includes("dungeonRuntime.getInstance(")) return null;
  for (const anchor of Object.values(ANCHORS)) {
    const readOnly = anchor.text.replace("dungeonRuntime.getInstance(", "dungeonRuntime.getInstanceReadOnly(");
    const afterOk = (i) => !anchor.after || lines[i - 1].trim() === anchor.after;
    let readOnlyHits = 0;
    for (let i = pass.start + 1; i < pass.end; i += 1) {
      const line = lines[i].trim();
      if (line === anchor.text && afterOk(i)) return null;
      if (line === readOnly && afterOk(i)) readOnlyHits += 1;
    }
    if (readOnlyHits !== 1) return null;
  }
  return { fnLine: tick.start + 1 };
}

function computeAnchors(siteSource) {
  const scan = scanAnchors(siteSource);
  return scan.ok ? { fnLine: scan.fnLine, lines: scan.lines } : null;
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function emptyWindow() {
  return { servedNamed: 0, servedAnchor: 0, passthrough: 0, noEnclosing: 0, checkUsTotal: 0, checkMaxUs: 0, parityChecks: 0 };
}

function createDungeonInstanceRef(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || defaultNow;
  const fingerprints = options.fingerprints || FINGERPRINTS;
  const priv = { deps: null, sourcesOk: false, anchors: null, anchorsObsolete: false, disabledReason: null, window: emptyWindow() };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN dungeonInstanceRef disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(runtimeExports) {
    if (priv.deps) return true;
    const m = runtimeExports;
    if (!m || typeof m !== "object" || typeof m.getInstanceRef !== "function") return false;
    priv.deps = { getInstanceRef: (id) => m.getInstanceRef(id) };
    return true;
  }

  function checkSources(sources) {
    for (const group of Object.keys(fingerprints)) {
      const expected = fingerprints[group];
      const got = fingerprintFunctions(sources && sources[group], Object.keys(expected));
      for (const name of Object.keys(expected)) {
        if (got.get(name) !== expected[name]) {
          const detail = `${group}.${name}`;
          disable("drift", detail);
          return { ok: false, reason: "drift", detail };
        }
      }
    }
    const scan = scanAnchors(sources && sources.site);
    if (!scan.ok) {
      const fixed = anchorsFixedUpstream(sources && sources.site);
      if (fixed) {
        priv.anchors = { fnLine: fixed.fnLine, lines: new Map() };
        priv.sourcesOk = true;
        if (!priv.anchorsObsolete) {
          priv.anchorsObsolete = true;
          log(`WARN dungeonInstanceRef anchors disabled: obsolete (EveJS reads it itself: ${TICK_FUNCTION}InPass → getInstanceReadOnly)`);
        }
        return { ok: true, obsolete: ["anchors"] };
      }
      disable("anchor", scan.detail);
      return { ok: false, reason: "anchor", detail: scan.detail };
    }
    priv.anchors = { fnLine: scan.fnLine, lines: scan.lines };
    priv.sourcesOk = true;
    return { ok: true };
  }

  function classify(frames) {
    let f = frames[0] || null;
    if (isMoonPresentationFrame(f)) f = frames[1] || null;
    if (!f || !fileOf(f).endsWith(`/${SITE_FILE}`)) return "pass";
    const name = f.getFunctionName();
    if (NAMED_CALLERS.includes(name)) return "named";
    if (name !== TICK_FUNCTION) return "pass";
    if (typeof f.getEnclosingLineNumber !== "function") return "noEnclosing";
    if (f.getEnclosingLineNumber() !== priv.anchors.fnLine) return "line-shift";
    return priv.anchors.lines.has(f.getLineNumber()) ? "anchor" : "pass";
  }

  function wrapGetInstance(original) {
    const wrapped = function hotPathPerfDungeonInstanceRef(instanceID) {
      if (priv.disabledReason || !priv.deps || !priv.sourcesOk) return original.apply(this, arguments);
      const w = priv.window;
      let kind;
      let ref;
      try {
        const started = now();
        const frames = callerFrames(wrapped);
        kind = classify(frames);
        const us = Number(now() - started) / 1e3;
        w.checkUsTotal += us;
        if (us > w.checkMaxUs) w.checkMaxUs = us;
        if (kind === "named" || kind === "anchor") ref = priv.deps.getInstanceRef(instanceID);
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(this, arguments);
      }
      if (kind === "line-shift") {
        disable("line-shift", `enclosing!=${priv.anchors.fnLine}`);
        return original.apply(this, arguments);
      }
      if (kind === "noEnclosing") w.noEnclosing += 1;
      if (kind !== "named" && kind !== "anchor") {
        w.passthrough += 1;
        return original.apply(this, arguments);
      }
      if (config.dungeonInstanceRefParityCheck === true) {
        const vendor = original.apply(this, arguments);
        w.parityChecks += 1;
        if (!sameJson(ref, vendor)) {
          disable("parity", `instanceID=${instanceID}`);
          return vendor;
        }
      }
      if (kind === "named") w.servedNamed += 1;
      else w.servedAnchor += 1;
      return ref;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.deps && priv.sourcesOk ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null && priv.sourcesOk,
      disabledReason: priv.disabledReason,
      state: stateText(),
      anchors: priv.anchorsObsolete ? "obsolete" : "on",
    };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window };
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats dungeonInstanceRef state=${stateText()} servedNamed=${w.servedNamed} servedAnchor=${w.servedAnchor} ` +
      `passthrough=${w.passthrough} noEnclosing=${w.noEnclosing} checkUsTotal=${w.checkUsTotal.toFixed(1)} ` +
      `checkMaxUs=${w.checkMaxUs.toFixed(1)} parityChecks=${w.parityChecks}`;
    priv.window = emptyWindow();
    return [line];
  }

  return { setDeps, checkSources, wrapGetInstance, disable, status, statsSnapshot, drainStatsLines };
}

module.exports = {
  createDungeonInstanceRef, computeAnchors, anchorsFixedUpstream, isMoonPresentationFrame, FINGERPRINTS, NAMED_CALLERS, ANCHORS, SITE_FILE, TICK_FUNCTION,
};
