"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { fingerprintFunctions } = require("../lib/blueprintOwnerRead");
const { createTemplateReadOnly, guideFixedUpstream, CALLERS_FINGERPRINTS } = require("../lib/templateReadOnly");
const {
  createDungeonInstanceRef, computeAnchors, anchorsFixedUpstream, FINGERPRINTS, ANCHORS, NAMED_CALLERS, TICK_FUNCTION,
} = require("../lib/dungeonInstanceRef");

const FIXTURES = path.join(__dirname, "fixtures", "dungeonRead");
const UPSTREAM_RESOLVE = "  // Read-only: message and transmission builders only read the template.\n" +
  "  return templateID ? dungeonAuthority.getTemplateByIDReadOnly(templateID) : null;\n";
const LEGACY_RESOLVE = "  return templateID ? dungeonAuthority.getTemplateByID(templateID) : null;\n";
const MOON_OVERLAY = path.resolve(__dirname, "..", "..", "moonOreAnomalies", "lib", "presentationOverlay.js");

function fresh(name) {
  const file = path.join(FIXTURES, `${name}.js`);
  delete require.cache[require.resolve(file)];
  return require(file);
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const deepFrozen = (value) => !value || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freezeDeep(v);
    Object.freeze(value);
  }
  return value;
}

function fakeAuthority() {
  const records = new Map([["t1", { templateID: "t1", populationHints: { guideAgentID: 7, containers: [{ role: "c" }] } }]]);
  const views = new Map();
  return {
    getTemplateByID: function getTemplateByID(id) {
      const r = records.get(String(id));
      return r ? clone(r) : null;
    },
    getTemplateByIDReadOnly: function getTemplateByIDReadOnly(id) {
      const r = records.get(String(id));
      if (!r) return null;
      if (!views.has(r)) views.set(r, freezeDeep(clone(r)));
      return views.get(r);
    },
  };
}

function fakeRuntime() {
  const entries = new Map([[1, { instanceID: 1, templateID: "t1", metadata: { siteID: 5 }, hazardState: { gateDefense: {} } }]]);
  return {
    entries,
    getInstance: function getInstance(id) {
      const e = entries.get(Number(id));
      return e ? clone(e) : null;
    },
    getInstanceRef: function getInstanceRef(id) {
      return entries.get(Number(id)) || null;
    },
  };
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const dungeonDir = path.join(SERVER_SRC, "services", "dungeon");
  const real = (name) => path.join(dungeonDir, name);
  const haveSrc = ["dungeonUniverseSiteService.js", "dungeonTrackingRuntime.js", "dungeonSiteAdapter.js", "dungeonRuntime.js",
    "dungeonRuntimeState.js"].every((f) => fs.existsSync(real(f)));
  const text = (name) => fs.readFileSync(real(name), "utf8");
  const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
  const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };

  test("DR1 templateReadOnlyCallers: G1 obsolete on 261115.2 (mechanism on 261108.1), G2 in scope = view; arrow get, outside the scope = clone; flag off unchanged", () => {
    if (!haveSrc) return;
    const lines = [];
    const st = loader.createState({ ...base, templateReadOnlyView: true, templateReadOnlyCallers: true }, null,
      { log: (l) => lines.push(l) });
    const authority = fakeAuthority();
    const tracking = fresh("dungeonTrackingRuntime");
    const adapter = fresh("dungeonSiteAdapter");
    tracking.setDeps(authority);
    adapter.setDeps(authority);
    loader.patchTarget("dungeonAuthority", authority, st);
    loader.patchTarget("dungeonTrackingRuntime", tracking, st, real("dungeonTrackingRuntime.js"));
    loader.patchTarget("dungeonSiteAdapter", adapter, st, real("dungeonSiteAdapter.js"));
    for (const p of loader.TEMPLATE_CALLERS_POINTS) assert.ok(st.patched.has(p.symbol), p.symbol);
    assert.ok(tracking.processGuideApproachTexts.__hotPathPerfTemplate && adapter.enrichSiteWithDungeonRuntime.__hotPathPerfTemplate);
    const g = tracking.processGuideApproachTexts(null, { templateID: "t1" });
    assert.ok(!Object.isFrozen(g.viaResolve), "G1 obsolete: the fake (old shape) gets the vendor clone");
    for (const r of [g.direct, g.viaGuideSite, tracking.resolveTemplate({ templateID: "t1" }), tracking.guideSiteOfShip({ templateID: "t1" })]) {
      assert.ok(!Object.isFrozen(r), "clone");
      assert.strictEqual(JSON.stringify(r), JSON.stringify(g.viaResolve));
    }
    const a = adapter.enrichSiteWithDungeonRuntime({ templateID: "t1" });
    assert.ok(deepFrozen(a.direct), "G2 direct getTemplateByID = view");
    assert.ok(!Object.isFrozen(a.viaGet), "arrow get = clone");
    assert.ok(!Object.isFrozen(adapter.resolveTemplateForSite("t1")));
    const snap = st.template.statsSnapshot();
    assert.deepStrictEqual([snap.servedGuide, snap.servedAdapter, snap.served, snap.passthrough, snap.guide], [0, 1, 0, 1, "obsolete"]);
    assert.ok(/^stats templateReadOnly state=ready served=0 passthrough=1 checkMaxUs=[\d.]+ parityChecks=0 servedGuide=0 servedAdapter=1$/
      .test(st.template.drainStatsLines()[0]));
    assert.deepStrictEqual(lines, ["WARN templateReadOnly guide disabled: obsolete (EveJS reads it itself: dungeonAuthority.getTemplateByIDReadOnly(templateID))"]);
    const legacyTracking = text("dungeonTrackingRuntime.js").replace(/\r\n/g, "\n").replace(UPSTREAM_RESOLVE, LEGACY_RESOLVE);
    assert.strictEqual(fingerprintFunctions(legacyTracking, ["resolveTemplate"]).get("resolveTemplate"), CALLERS_FINGERPRINTS.tracking.resolveTemplate);
    const legacy = createTemplateReadOnly({ config: { templateReadOnlyView: true, templateReadOnlyCallers: true }, log: () => {} });
    assert.deepStrictEqual(legacy.checkCallersSources({ tracking: legacyTracking, adapter: text("dungeonSiteAdapter.js") }),
      { guide: true, adapter: true });
    const lAuth = fakeAuthority();
    assert.strictEqual(legacy.setDeps(lAuth), true);
    lAuth.getTemplateByID = legacy.wrapGetTemplate(lAuth.getTemplateByID);
    const lTracking = fresh("dungeonTrackingRuntime");
    lTracking.setDeps(lAuth);
    lTracking.processGuideApproachTexts = legacy.wrapGuideScope(lTracking.processGuideApproachTexts);
    const lg = lTracking.processGuideApproachTexts(null, { templateID: "t1" });
    assert.ok(deepFrozen(lg.viaResolve), "G1 resolveTemplate ← processGuideApproachTexts = widok");
    assert.strictEqual(lg.viaResolve, lAuth.getTemplateByIDReadOnly("t1"));
    assert.ok(!Object.isFrozen(lg.direct) && !Object.isFrozen(lg.viaGuideSite), "other frames = clone");
    assert.deepStrictEqual([legacy.statsSnapshot().servedGuide, legacy.status().guide], [1, "on"]);
    assert.ok(loader.missingSymbols(st).every((s) => s.endsWith("#templateScope")), loader.missingSymbols(st).join(","));
    const dl = [];
    const drift = loader.createState({ ...base, templateReadOnlyView: true, templateReadOnlyCallers: true }, null, { log: (l) => dl.push(l) });
    const t2 = fresh("dungeonTrackingRuntime");
    const a2 = fresh("dungeonSiteAdapter");
    const auth2 = fakeAuthority();
    t2.setDeps(auth2);
    a2.setDeps(auth2);
    loader.patchTarget("dungeonAuthority", auth2, drift);
    loader.patchTarget("dungeonTrackingRuntime", t2, drift, path.join(FIXTURES, "dungeonTrackingRuntime.js"));
    loader.patchTarget("dungeonSiteAdapter", a2, drift, path.join(FIXTURES, "dungeonSiteAdapter.js"));
    assert.ok(!Object.isFrozen(t2.processGuideApproachTexts(null, { templateID: "t1" }).viaResolve));
    assert.ok(!Object.isFrozen(a2.enrichSiteWithDungeonRuntime({ templateID: "t1" }).direct));
    assert.strictEqual(drift.template.status().state, "ready");
    assert.deepStrictEqual(dl, ["WARN templateReadOnly callers drift: processGuideApproachTexts, enrichSiteWithDungeonRuntime (scope without the view)"]);
    const off = loader.createState({ ...base, templateReadOnlyView: true }, null, { log: () => {} });
    assert.ok(![...off.expected].some((s) => s.includes("#templateGuideScope") || s.includes("#templateAdapterScope")));
    assert.ok(!off.requestPattern.test("./dungeonTrackingRuntime") && !off.requestPattern.test("./dungeonSiteAdapter"));
    const t3 = fresh("dungeonTrackingRuntime");
    const fn = t3.processGuideApproachTexts;
    loader.patchTarget("dungeonTrackingRuntime", t3, off, real("dungeonTrackingRuntime.js"));
    assert.strictEqual(t3.processGuideApproachTexts, fn);
    assert.ok(/^stats templateReadOnly state=waiting served=0 passthrough=0 checkMaxUs=0\.0 parityChecks=0$/.test(off.template.drainStatsLines()[0]));
    const cfg = require("../config");
    const missing = path.join(__dirname, "missing.json");
    const def = cfg.loadConfig({ env: {}, settingsPath: missing });
    assert.deepStrictEqual([def.templateReadOnlyCallers, def.dungeonInstanceRef, def.dungeonInstanceRefParityCheck], [false, false, false]);
    const on = cfg.loadConfig({ env: { HOTPATH_TEMPLATE_READONLY_CALLERS: "1", HOTPATH_DUNGEON_INSTANCE_REF: "1",
      HOTPATH_DUNGEON_INSTANCE_REF_PARITY: "on" }, settingsPath: missing });
    assert.deepStrictEqual([on.templateReadOnlyCallers, on.dungeonInstanceRef, on.dungeonInstanceRefParityCheck], [true, true, true]);
    const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "compose.yaml"), "utf8");
    for (const key of ["HOTPATH_TEMPLATE_READONLY_CALLERS", "HOTPATH_DUNGEON_INSTANCE_REF", "HOTPATH_DUNGEON_INSTANCE_REF_PARITY"]) {
      assert.ok(compose.includes(`${key}: \${${key}:-0}`), key);
    }
  });

  test("DR2 vendor facts 261115.2 (templates): G1 obsolete (resolveTemplate = view), G2 fingerprint, the only caller processGuideApproachTexts through a property", () => {
    if (!haveSrc) return;
    const t = createTemplateReadOnly({ config: { templateReadOnlyCallers: true }, log: () => {} });
    assert.deepStrictEqual(t.checkCallersSources({ tracking: text("dungeonTrackingRuntime.js"), adapter: text("dungeonSiteAdapter.js") }),
      { guide: false, adapter: true, obsolete: ["guide"] });
    assert.strictEqual(guideFixedUpstream(text("dungeonTrackingRuntime.js")), true);
    assert.strictEqual(guideFixedUpstream(text("dungeonTrackingRuntime.js").replace(/\r\n/g, "\n").replace(UPSTREAM_RESOLVE, LEGACY_RESOLVE)), false);
    const tfp = fingerprintFunctions(text("dungeonTrackingRuntime.js"), ["processGuideApproachTexts", "guideAgentIDOf"]);
    for (const [name, sha] of tfp) assert.strictEqual(sha, CALLERS_FINGERPRINTS.tracking[name], name);
    assert.deepStrictEqual(Object.keys(CALLERS_FINGERPRINTS.tracking), ["processGuideApproachTexts", "resolveTemplate", "guideAgentIDOf"]);
    const site = text("dungeonUniverseSiteService.js").replace(/\r\n/g, "\n");
    assert.ok(site.includes("dungeonTrackingRuntime.processGuideApproachTexts("));
    assert.ok(site.includes('\nconst dungeonTrackingRuntime = require(path.join(__dirname, "./dungeonTrackingRuntime"));\n'));
    const destructure = /\{[^{}]*\b(processGuideApproachTexts|enrichSiteWithDungeonRuntime|getInstance)\b[^{}]*\}\s*=\s*(require|[A-Za-z_$][\w$.]*\s*;)/;
    const hits = [];
    const callers = [];
    for (const file of ctx.listJs(SERVER_SRC)) {
      const body = fs.readFileSync(file, "utf8");
      if (destructure.test(body)) hits.push(path.relative(SERVER_SRC, file));
      if (body.includes("processGuideApproachTexts(") && !file.endsWith("dungeonTrackingRuntime.js")) callers.push(path.relative(SERVER_SRC, file));
    }
    assert.deepStrictEqual(hits, []);
    assert.deepStrictEqual(callers.map((f) => f.replace(/\\/g, "/")), ["services/dungeon/dungeonUniverseSiteService.js"]);
    assert.strictEqual(site.split("processGuideApproachTexts(").length - 1, 1);
  });

  test("DR3 vendor facts 261115.2 (instances): checkSources = ok, anchors A1-A3 obsolete (getInstanceReadOnly in InPass), NAMED_CALLERS, getInstanceRef; loader: probe, order, flag off", () => {
    if (!haveSrc) return;
    const sources = { site: text("dungeonUniverseSiteService.js"), tracking: text("dungeonTrackingRuntime.js"),
      runtime: text("dungeonRuntime.js"), runtimeState: text("dungeonRuntimeState.js") };
    const refLines = [];
    const ref = createDungeonInstanceRef({ config: {}, log: (l) => refLines.push(l) });
    assert.deepStrictEqual(ref.checkSources(sources), { ok: true, obsolete: ["anchors"] });
    assert.strictEqual(ref.status().anchors, "obsolete");
    assert.deepStrictEqual(refLines, ["WARN dungeonInstanceRef anchors disabled: obsolete (EveJS reads it itself: tickSceneSiteBehaviorsInPass → getInstanceReadOnly)"]);
    assert.strictEqual(computeAnchors(sources.site), null, "261115.2: getInstance anchors are gone");
    const fixed = anchorsFixedUpstream(sources.site);
    const lines = sources.site.replace(/\r\n/g, "\n").split("\n");
    assert.ok(fixed && lines[fixed.fnLine - 1].startsWith(`function ${TICK_FUNCTION}(`));
    assert.strictEqual(lines[fixed.fnLine], `  return require("../incursion/incursionHooks").sitePass(() => ${TICK_FUNCTION}InPass(scene, options));`);
    const reverted = sources.site.replace(ANCHORS.A3.text.replace("getInstance(", "getInstanceReadOnly("), ANCHORS.A3.text);
    assert.strictEqual(anchorsFixedUpstream(reverted), null);
    assert.deepStrictEqual(NAMED_CALLERS, ["processGateDefenseHazards", "maybeAdvanceExplicitlySatisfiedObjective"]);
    for (const name of NAMED_CALLERS) {
      const body = fingerprintFunctions(sources.site, [name]);
      assert.strictEqual(body.get(name), FINGERPRINTS.site[name], name);
    }
    const rt = sources.runtime.replace(/\r\n/g, "\n");
    assert.ok(/\nmodule\.exports = \{\n[\s\S]*?\n  getInstance,\n[\s\S]*?\n  getInstanceRef,\n/.test(rt));
    assert.ok(/\nfunction getInstance\(instanceID\) \{\n  return runtimeState\.getInstanceSnapshot\(instanceID\);\n\}\n/.test(rt));
    assert.ok(/instancesByID\.set\(/.test(text("dungeonRuntimeIndexes.js")));
    const fixtureSite = fs.readFileSync(path.join(FIXTURES, "dungeonUniverseSiteService.js"), "utf8");
    const doubled = fixtureSite.replace(ANCHORS.A3.text, `${ANCHORS.A3.text}\n    ${ANCHORS.A3.text}`);
    const bad = createDungeonInstanceRef({ config: {}, log: () => {},
      fingerprints: { site: Object.fromEntries(fingerprintFunctions(doubled, [TICK_FUNCTION])) } });
    assert.deepStrictEqual(bad.checkSources({ site: doubled }), { ok: false, reason: "anchor", detail: "A3 x2" });
    const lineLog = [];
    const st = loader.createState({ ...base, dungeonInstanceRef: true }, null, { log: (l) => lineLog.push(l) });
    const runtime = fakeRuntime();
    loader.patchTarget("dungeonRuntime", runtime, st, real("dungeonRuntime.js"));
    for (const symbol of loader.DUNGEON_REF_REQUIRED) assert.ok(st.patched.has(symbol), symbol);
    assert.ok(runtime.getInstance.__hotPathPerfInstanceRef);
    assert.strictEqual(st.instanceRef.status().state, "ready");
    st.gameSeen = true;
    assert.strictEqual(loader.checkInstanceRefDrift(st), false);
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(st)), loader.probeMessage(st));
    const d = loader.createState({ ...base, dungeonInstanceRef: true }, null, { log: () => {} });
    const r2 = fakeRuntime();
    const fn2 = r2.getInstance;
    loader.patchTarget("dungeonRuntime", r2, d, path.join(FIXTURES, "dungeonRuntime.js"));
    assert.strictEqual(r2.getInstance, fn2);
    d.gameSeen = true;
    assert.ok(loader.probeMessage(d).endsWith("; dungeonInstanceRef disabled: drift"), loader.probeMessage(d));
    const o = loader.createState({ ...base, dungeonInstanceRef: true }, null, { log: () => {} });
    const r3 = fakeRuntime();
    require(MOON_OVERLAY).install(r3, { templatesByFamily: {} });
    loader.patchTarget("dungeonRuntime", r3, o, real("dungeonRuntime.js"));
    assert.strictEqual(o.instanceRef.status().state, "disabled:order");
    assert.strictEqual(r3.getInstance.name, "moonPresentationReader");
    const off = loader.createState(base, null, { log: () => {} });
    assert.strictEqual(off.instanceRef, null);
    assert.ok(![...off.expected].some((s) => s.includes("#instanceRef")));
    const r4 = fakeRuntime();
    const fn4 = r4.getInstance;
    loader.patchTarget("dungeonRuntime", r4, off, real("dungeonRuntime.js"));
    assert.strictEqual(r4.getInstance, fn4);
  });

  test("DR4 dungeonInstanceRef V8 frames: anchors and names = ref (also through moonPresentationReader); the rest = clone; line-shift, parity, drift", () => {
    const siteText = fs.readFileSync(path.join(FIXTURES, "dungeonUniverseSiteService.js"), "utf8");
    const fp = (txt) => ({ site: Object.fromEntries(fingerprintFunctions(txt, ["tickSceneSiteBehaviors", "processGateDefenseHazards"])) });
    function setup(opts = {}) {
      const lines = [];
      const ref = createDungeonInstanceRef({ config: { dungeonInstanceRefParityCheck: opts.parity === true }, log: (l) => lines.push(l),
        fingerprints: opts.fingerprints || fp(siteText) });
      const runtime = fakeRuntime();
      assert.strictEqual(ref.setDeps(runtime), true);
      const check = ref.checkSources({ site: opts.siteText || siteText });
      runtime.getInstance = ref.wrapGetInstance(runtime.getInstance);
      if (opts.moon) require(MOON_OVERLAY).install(runtime, { templatesByFamily: {} });
      const site = fresh("dungeonUniverseSiteService");
      const tracking = { processGuideApproachTexts(_scene, instance) { site.sink.a3 = instance; } };
      site.setDeps(runtime, tracking);
      return { ref, lines, runtime, site, check, entry: runtime.entries.get(1) };
    }
    for (const moon of [false, true]) {
      const s = setup({ moon });
      assert.deepStrictEqual(s.check, { ok: true });
      const sink = s.site.tickSceneSiteBehaviors(null, { instanceID: 1 });
      for (const key of ["a1", "a2", "a3", "advanceArg", "advanceInner", "gate"]) assert.strictEqual(sink[key], s.entry, `${key} moon=${moon}`);
      assert.ok(sink.nonAnchor !== s.entry && JSON.stringify(sink.nonAnchor) === JSON.stringify(s.entry), "non-anchor = clone");
      s.site.otherSiteFunction({ instanceID: 1 });
      assert.ok(sink.otherFunction !== s.entry, "another function = clone");
      assert.ok(s.runtime.getInstance(1) !== s.entry, "caller from another file = clone");
      assert.strictEqual(s.site.processGateDefenseHazards(null, { instanceID: 99 }), undefined);
      assert.strictEqual(sink.gate, null, "no instance = null as in the vendor");
      const snap = s.ref.statsSnapshot();
      assert.deepStrictEqual([snap.servedAnchor, snap.servedNamed, snap.passthrough, snap.noEnclosing, snap.state], [3, 3, 3, 0, "ready"]);
      assert.ok(/^stats dungeonInstanceRef state=ready servedNamed=3 servedAnchor=3 passthrough=3 noEnclosing=0 checkUsTotal=[\d.]+ checkMaxUs=[\d.]+ parityChecks=0$/
        .test(s.ref.drainStatsLines()[0]));
    }
    const shifted = setup({ siteText: `\n\n${siteText}`, fingerprints: fp(siteText) });
    assert.deepStrictEqual(shifted.check, { ok: true });
    const sh = shifted.site.tickSceneSiteBehaviors(null, { instanceID: 1 });
    assert.ok(sh.a1 !== shifted.entry && sh.a2 !== shifted.entry, "line-shift = clone");
    assert.strictEqual(shifted.ref.status().state, "disabled:line-shift");
    assert.ok(shifted.lines[0].startsWith("WARN dungeonInstanceRef disabled: line-shift"), shifted.lines.join("|"));
    const p = setup({ parity: true });
    p.site.processGateDefenseHazards(null, { instanceID: 1 });
    assert.strictEqual(p.site.sink.gate, p.entry, "parity zgodne = ref");
    assert.strictEqual(p.ref.statsSnapshot().parityChecks, 1);
    const liar = createDungeonInstanceRef({ config: { dungeonInstanceRefParityCheck: true }, log: () => {}, fingerprints: fp(siteText) });
    liar.setDeps({ getInstanceRef: () => ({ instanceID: 1, tampered: true }) });
    liar.checkSources({ site: siteText });
    const vendor = fakeRuntime();
    vendor.getInstance = liar.wrapGetInstance(vendor.getInstance);
    const ls = fresh("dungeonUniverseSiteService");
    ls.setDeps(vendor, { processGuideApproachTexts() {} });
    ls.processGateDefenseHazards(null, { instanceID: 1 });
    assert.deepStrictEqual(ls.sink.gate, vendor.entries.get(1));
    assert.ok(ls.sink.gate !== vendor.entries.get(1), "vendor result (clone)");
    assert.strictEqual(liar.status().state, "disabled:parity");
    const d = setup({ fingerprints: { site: { tickSceneSiteBehaviors: "0".repeat(40) } } });
    assert.deepStrictEqual(d.check, { ok: false, reason: "drift", detail: "site.tickSceneSiteBehaviors" });
    assert.strictEqual(d.ref.status().state, "disabled:drift");
    assert.ok(d.site.tickSceneSiteBehaviors(null, { instanceID: 1 }).a1 !== d.entry);
    assert.deepStrictEqual(d.lines, ["WARN dungeonInstanceRef disabled: drift (site.tickSceneSiteBehaviors)"]);
    assert.strictEqual(Object.values(FINGERPRINTS).reduce((n, g) => n + Object.keys(g).length, 0), 16);
  });
}

module.exports = { register };
