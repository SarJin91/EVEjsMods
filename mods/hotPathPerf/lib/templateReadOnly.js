"use strict";

const { fingerprintFunctions } = require("./blueprintOwnerRead");

const CALLER_FUNCTION = "hydrateSummary";
const CALLER_FILE = "dungeonInstanceCacheMgrService.js";
const ROTATE_CALLER_FUNCTION = "requireTemplate";
const ROTATE_OUTER_FUNCTION = "rotateUniversePersistentInstances";
const ROTATE_FILE = "dungeonRuntime.js";
const GUIDE_FILE = "dungeonTrackingRuntime.js";
const GUIDE_CALLER_FUNCTION = "resolveTemplate";
const GUIDE_OUTER_FUNCTION = "processGuideApproachTexts";
const ADAPTER_FILE = "dungeonSiteAdapter.js";
const ADAPTER_CALLER_FUNCTION = "enrichSiteWithDungeonRuntime";
const CALLERS_FINGERPRINTS = Object.freeze({
  tracking: Object.freeze({
    processGuideApproachTexts: "3da193072f0624bb1657a86b1283ca5e040f4335",
    resolveTemplate: "66ddfa0d5b7fc34ada29ecff3c13913a8c527d27",
    guideAgentIDOf: "c2817e2dccd686d96f5ebc73844b2f80c2986191",
  }),
  adapter: Object.freeze({
    enrichSiteWithDungeonRuntime: "6ffbc4461d2fc09fd600b6a73ccc4642db7fabde",
  }),
});
const DETAIL_MAX = 200;

function defaultNow() {
  return process.hrtime.bigint();
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfTemplate", { value: original });
  return wrapper;
}

const asCallSites = (_error, callSites) => callSites;

function callerFrames(fn) {
  const savedLimit = Error.stackTraceLimit;
  const savedPrepare = Error.prepareStackTrace;
  try {
    Error.stackTraceLimit = 2;
    Error.prepareStackTrace = asCallSites;
    const holder = {};
    Error.captureStackTrace(holder, fn);
    const frames = holder.stack;
    return Array.isArray(frames) ? frames : [];
  } finally {
    Error.stackTraceLimit = savedLimit;
    Error.prepareStackTrace = savedPrepare;
  }
}

function directCaller(fn) {
  const frames = callerFrames(fn);
  return frames.length > 0 ? frames[0] : null;
}

function isFrame(frame, name, fileName) {
  if (!frame) return false;
  const file = String(frame.getFileName() || "").replace(/\\/g, "/");
  return frame.getFunctionName() === name && file.endsWith(`/${fileName}`);
}

function isHydrateSummaryFrame(frame) {
  return isFrame(frame, CALLER_FUNCTION, CALLER_FILE);
}

function isRotateRequireFrames(frames) {
  return isFrame(frames[0], ROTATE_CALLER_FUNCTION, ROTATE_FILE) && isFrame(frames[1], ROTATE_OUTER_FUNCTION, ROTATE_FILE);
}

function isGuideFrames(frames) {
  return isFrame(frames[0], GUIDE_CALLER_FUNCTION, GUIDE_FILE) && isFrame(frames[1], GUIDE_OUTER_FUNCTION, GUIDE_FILE);
}

function isAdapterFrames(frames) {
  return isFrame(frames[0], ADAPTER_CALLER_FUNCTION, ADAPTER_FILE);
}

function firstMismatch(sourceText, expected) {
  const got = fingerprintFunctions(sourceText, Object.keys(expected));
  for (const name of Object.keys(expected)) if (got.get(name) !== expected[name]) return name;
  return null;
}

const ROTATE_UPSTREAM_READONLY = "requireTemplate(templateID, { readOnly: true })";

const GUIDE_UPSTREAM_READONLY = "dungeonAuthority.getTemplateByIDReadOnly(templateID)";

function guideFixedUpstream(trackingSource) {
  const text = String(trackingSource || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(`\nfunction ${GUIDE_CALLER_FUNCTION}(`);
  if (start < 0) return false;
  const end = text.indexOf("\n}\n", start);
  const body = text.slice(start, end < 0 ? text.length : end);
  return body.includes(GUIDE_UPSTREAM_READONLY) && !body.includes("dungeonAuthority.getTemplateByID(");
}

const HYDRATE_UPSTREAM_READONLY = "dungeonAuthority.getTemplateByIDReadOnly(";

function hydrateFixedUpstream(cacheMgrSource) {
  const text = String(cacheMgrSource || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(`\nfunction ${CALLER_FUNCTION}(`);
  if (start < 0) return false;
  const end = text.indexOf("\n}\n", start);
  const body = text.slice(start, end < 0 ? text.length : end);
  return body.includes(HYDRATE_UPSTREAM_READONLY) && !body.includes("dungeonAuthority.getTemplateByID(");
}

function rotateFixedUpstream(sourceText) {
  const text = String(sourceText || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(`\nfunction ${ROTATE_OUTER_FUNCTION}(`);
  if (start < 0) return false;
  const end = text.indexOf("\n}\n", start);
  const body = text.slice(start, end < 0 ? text.length : end);
  return body.includes(ROTATE_UPSTREAM_READONLY) && !/requireTemplate\(templateID\)/.test(body);
}

function emptyWindow() {
  return { served: 0, servedRotate: 0, servedGuide: 0, servedAdapter: 0, passthrough: 0, checkMaxUs: 0, parityChecks: 0 };
}

function createTemplateReadOnly(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || defaultNow;
  const rotateEnabled = config.templateReadOnlyRotate === true;
  const callersEnabled = config.templateReadOnlyCallers === true;
  const priv = { deps: null, disabledReason: null, depth: 0, rotateDepth: 0, guideDepth: 0, adapterDepth: 0,
    guideOk: false, adapterOk: false, callersChecked: false, callersDetail: "", guideObsolete: false, rotateObsolete: false, hydrateObsolete: false, window: emptyWindow() };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN templateReadOnly disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function markRotateObsolete(detail) {
    if (priv.rotateObsolete) return;
    priv.rotateObsolete = true;
    log(`WARN templateReadOnly rotate disabled: obsolete${detail ? ` (${fit(detail)})` : ""}`);
  }

  function markHydrateObsolete(detail) {
    if (priv.hydrateObsolete) return;
    priv.hydrateObsolete = true;
    log(`WARN templateReadOnly hydrate disabled: obsolete${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(authorityExports) {
    if (priv.deps) return true;
    const m = authorityExports;
    if (!m || typeof m !== "object" || typeof m.getTemplateByIDReadOnly !== "function") return false;
    priv.deps = { getTemplateByIDReadOnly: (id) => m.getTemplateByIDReadOnly(id) };
    return true;
  }

  function wrapScope(original) {
    const wrapped = function hotPathPerfTemplateScope() {
      priv.depth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.depth -= 1;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapRotateScope(original) {
    const wrapped = function hotPathPerfTemplateRotateScope() {
      priv.rotateDepth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.rotateDepth -= 1;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapCallerScope(original, field, name) {
    const scoped = {
      [name]: function () {
        priv[field] += 1;
        try {
          return original.apply(this, arguments);
        } finally {
          priv[field] -= 1;
        }
      },
    };
    return markWrapped(scoped[name], original);
  }

  function wrapGuideScope(original) {
    return wrapCallerScope(original, "guideDepth", "hotPathPerfTemplateGuideScope");
  }

  function wrapAdapterScope(original) {
    return wrapCallerScope(original, "adapterDepth", "hotPathPerfTemplateAdapterScope");
  }

  function checkCallersSources(sources) {
    if (!priv.callersChecked) {
      priv.callersChecked = true;
      priv.guideObsolete = guideFixedUpstream(sources && sources.tracking);
      const guideBad = priv.guideObsolete ? null : firstMismatch(sources && sources.tracking, CALLERS_FINGERPRINTS.tracking);
      const adapterBad = firstMismatch(sources && sources.adapter, CALLERS_FINGERPRINTS.adapter);
      priv.guideOk = !priv.guideObsolete && guideBad === null;
      priv.adapterOk = adapterBad === null;
      priv.callersDetail = [guideBad, adapterBad].filter(Boolean).join(", ");
      if (priv.guideObsolete) log(`WARN templateReadOnly guide disabled: obsolete (EveJS reads it itself: ${GUIDE_UPSTREAM_READONLY})`);
      if (priv.callersDetail) log(`WARN templateReadOnly callers drift: ${fit(priv.callersDetail)} (scope without the view)`);
    }
    const out = { guide: priv.guideOk, adapter: priv.adapterOk };
    if (priv.guideObsolete) out.obsolete = ["guide"];
    if (priv.callersDetail) out.detail = priv.callersDetail;
    return out;
  }

  function wrapGetTemplate(original) {
    const wrapped = function hotPathPerfTemplateReadOnly(templateID) {
      const inRotate = rotateEnabled && priv.rotateDepth > 0;
      const inGuide = callersEnabled && priv.guideOk && priv.guideDepth > 0;
      const inAdapter = callersEnabled && priv.adapterOk && priv.adapterDepth > 0;
      if ((priv.depth === 0 && !inRotate && !inGuide && !inAdapter) || priv.disabledReason || !priv.deps) {
        return original.apply(this, arguments);
      }
      let view;
      let rotate = false;
      let guide = false;
      let adapter = false;
      try {
        const started = now();
        const frames = callerFrames(wrapped);
        const us = Number(now() - started) / 1e3;
        if (us > priv.window.checkMaxUs) priv.window.checkMaxUs = us;
        const hydrate = priv.depth > 0 && isHydrateSummaryFrame(frames[0] || null);
        rotate = !hydrate && inRotate && isRotateRequireFrames(frames);
        guide = !hydrate && !rotate && inGuide && isGuideFrames(frames);
        adapter = !hydrate && !rotate && !guide && inAdapter && isAdapterFrames(frames);
        if (!hydrate && !rotate && !guide && !adapter) {
          priv.window.passthrough += 1;
          return original.apply(this, arguments);
        }
        view = priv.deps.getTemplateByIDReadOnly(templateID);
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(this, arguments);
      }
      if (config.templateReadOnlyViewParityCheck === true) {
        const vendor = original.apply(this, arguments);
        priv.window.parityChecks += 1;
        let same;
        try {
          same = JSON.stringify(view) === JSON.stringify(vendor);
        } catch (error) {
          same = false;
        }
        if (!same) {
          disable("parity", `templateID=${templateID}`);
          return vendor;
        }
      }
      if (rotate) priv.window.servedRotate += 1;
      else if (guide) priv.window.servedGuide += 1;
      else if (adapter) priv.window.servedAdapter += 1;
      else priv.window.served += 1;
      return view;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.deps ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null,
      disabledReason: priv.disabledReason,
      depth: priv.depth,
      rotateDepth: priv.rotateDepth,
      rotate: !rotateEnabled ? "off" : priv.rotateObsolete ? "obsolete" : "on",
      hydrate: priv.hydrateObsolete ? "obsolete" : "on",
      guide: !callersEnabled ? "off" : priv.guideObsolete ? "obsolete" : !priv.callersChecked ? "waiting" : priv.guideOk ? "on" : "drift",
      state: stateText(),
    };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window };
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats templateReadOnly state=${stateText()} served=${w.served} passthrough=${w.passthrough} ` +
      `checkMaxUs=${w.checkMaxUs.toFixed(1)} parityChecks=${w.parityChecks}` + (rotateEnabled ? ` servedRotate=${w.servedRotate}` : "") +
      (callersEnabled ? ` servedGuide=${w.servedGuide} servedAdapter=${w.servedAdapter}` : "");
    priv.window = emptyWindow();
    return [line];
  }

  return { setDeps, wrapScope, wrapRotateScope, wrapGuideScope, wrapAdapterScope, checkCallersSources, wrapGetTemplate, disable,
    markRotateObsolete, markHydrateObsolete, status, statsSnapshot, drainStatsLines };
}

module.exports = {
  createTemplateReadOnly, rotateFixedUpstream, ROTATE_UPSTREAM_READONLY, guideFixedUpstream, GUIDE_UPSTREAM_READONLY, hydrateFixedUpstream,
  HYDRATE_UPSTREAM_READONLY, directCaller, callerFrames, isFrame, isHydrateSummaryFrame, isRotateRequireFrames, isGuideFrames, isAdapterFrames,
  CALLER_FUNCTION, CALLER_FILE, ROTATE_CALLER_FUNCTION, ROTATE_OUTER_FUNCTION, ROTATE_FILE, CALLERS_FINGERPRINTS,
};
