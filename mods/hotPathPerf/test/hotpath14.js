"use strict";

const assert = require("assert");
const path = require("path");
const vm = require("vm");

const MISSING = path.join(__dirname, "missing.json");
const ROTATE_SYMBOL = "dungeonRuntime.rotateUniversePersistentInstances#templateRotateScope";

function fakeAuthority() {
  const records = new Map([["t1", { templateID: "t1", sourceDungeonID: 5, rooms: { a: { x: 1 } } }]]);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const views = new Map();
  const freezeDeep = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const c of Object.values(value)) freezeDeep(c); }
    return value;
  };
  return {
    getTemplateByID: function getTemplateByID(id) {
      const t = records.get(String(id || "").trim());
      return t ? clone(t) : null;
    },
    getTemplateByIDReadOnly: function getTemplateByIDReadOnly(id) {
      const r = records.get(String(id || "").trim());
      if (!r) return null;
      if (!views.has(r)) views.set(r, freezeDeep(clone(r)));
      return views.get(r);
    },
  };
}

const RUNTIME_CODE = "(function (dungeonAuthority) {\n" +
  "  function requireTemplate(templateID, options = {}) {\n" +
  "    return options.readOnly === true ? dungeonAuthority.getTemplateByIDReadOnly(templateID) : dungeonAuthority.getTemplateByID(templateID);\n" +
  "  }\n" +
  "  function listenerTemplate(templateID) { return requireTemplate(templateID); }\n" +
  "  function rotateUniversePersistentInstances(templateID, fail) {\n" +
  "    const template = requireTemplate(templateID);\n" +
  "    if (fail) throw new Error(\"rotate boom\");\n" +
  "    return { template, direct: dungeonAuthority.getTemplateByID(templateID), listener: listenerTemplate(templateID) };\n" +
  "  }\n" +
  "  return { requireTemplate, rotateUniversePersistentInstances };\n" +
  "})";

function fakeRuntime(authority, filename) {
  return vm.runInThisContext(RUNTIME_CODE, { filename })(authority);
}

function register(ctx) {
  const { test, src, config, loader, createRecorder } = ctx;
  const { createState, patchTarget } = loader;
  const RUNTIME_FILE = "/app/server/src/services/dungeon/dungeonRuntime.js";

  function setup(cfg) {
    const lines = [];
    const st = createState({ ...config, templateReadOnlyView: true, templateReadOnlyRotate: true, ...cfg },
      createRecorder({ slowCallMs: 1e9 }, () => {}), { log: (l) => lines.push(l) });
    const authority = fakeAuthority();
    patchTarget("dungeonAuthority", authority, st);
    const runtime = fakeRuntime(authority, RUNTIME_FILE);
    patchTarget("dungeonRuntime", runtime, st);
    return { st, authority, runtime, lines };
  }

  test("R1 template rotation: flag off (or without templateReadOnlyView) = no wrap of rotateUniversePersistentInstances", () => {
    const cfg = require("../config");
    const def = cfg.loadConfig({ env: {}, settingsPath: MISSING });
    assert.strictEqual(def.templateReadOnlyRotate, false);
    assert.strictEqual(cfg.loadConfig({ env: { HOTPATH_TEMPLATE_READONLY_ROTATE: "1" }, settingsPath: MISSING }).templateReadOnlyRotate, true);
    for (const flags of [{ templateReadOnlyView: true, templateReadOnlyRotate: false }, { templateReadOnlyView: false, templateReadOnlyRotate: true }]) {
      const st = createState({ ...config, ...flags }, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: () => {} });
      const runtime = fakeRuntime(fakeAuthority(), RUNTIME_FILE);
      const fn = runtime.rotateUniversePersistentInstances;
      patchTarget("dungeonRuntime", runtime, st);
      assert.strictEqual(runtime.rotateUniversePersistentInstances, fn, JSON.stringify(flags));
      assert.ok(!st.expected.has(ROTATE_SYMBOL), JSON.stringify(flags));
    }
    const on = setup({});
    assert.ok(on.runtime.rotateUniversePersistentInstances.__hotPathPerfTemplate, "flag on: wrapper");
    assert.ok(on.st.patched.has(ROTATE_SYMBOL) && on.st.expected.has(ROTATE_SYMBOL));
  });

  test("R2 template rotation: requireTemplate from rotate in scope = vendor view; outside the scope / other caller = clone", () => {
    const s = setup({});
    const view = s.authority.getTemplateByIDReadOnly("t1");
    const out = s.runtime.rotateUniversePersistentInstances("t1");
    assert.strictEqual(out.template, view, "requireTemplate z rotate = widok getTemplateByIDReadOnly");
    for (const [label, value] of [["direct", out.direct], ["listener", out.listener], ["outside the scope", s.runtime.requireTemplate("t1")]]) {
      assert.ok(!Object.isFrozen(value), label);
      assert.strictEqual(JSON.stringify(value), JSON.stringify(view), label);
    }
    const elsewhere = fakeRuntime(s.authority, "/app/server/src/services/dungeon/dungeonUniverseRuntime.js");
    assert.ok(!Object.isFrozen(s.runtime.rotateUniversePersistentInstances.__hotPathPerfTemplate.call(null, "t1").template), "without scope");
    const wrapRotate = s.st.template.wrapRotateScope(elsewhere.rotateUniversePersistentInstances);
    assert.ok(!Object.isFrozen(wrapRotate("t1").template), "other file");
    const snap = s.st.template.statsSnapshot();
    assert.deepStrictEqual([snap.servedRotate, snap.served, snap.rotateDepth, snap.depth], [1, 0, 0, 0]);
    assert.ok(/ parityChecks=0 servedRotate=1$/.test(s.st.template.drainStatsLines()[0]));
    const p = setup({ templateReadOnlyViewParityCheck: true });
    assert.ok(Object.isFrozen(p.runtime.rotateUniversePersistentInstances("t1").template));
    assert.strictEqual(p.st.template.statsSnapshot().parityChecks, 1);
  });

  test("R3 template rotation: original's exception resets rotateDepth, then clone outside the scope", () => {
    const s = setup({});
    assert.throws(() => s.runtime.rotateUniversePersistentInstances("t1", true), /rotate boom/);
    assert.strictEqual(s.st.template.status().rotateDepth, 0);
    assert.strictEqual(s.st.template.status().disabledReason, null);
    assert.ok(!Object.isFrozen(s.runtime.requireTemplate("t1")));
    assert.ok(Object.isFrozen(s.runtime.rotateUniversePersistentInstances("t1").template));
  });

  test("R4 vendor facts 261115.2: rotation takes the view itself (readOnly), template only for buildInstanceRecordFromOptions, :4297 through a property", () => {
    const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
    const rt = norm("services/dungeon/dungeonRuntime.js");
    const start = rt.indexOf("\nfunction rotateUniversePersistentInstances(rotations = [], options = {}) {\n");
    assert.ok(start >= 0);
    const body = rt.slice(start, rt.indexOf("\n}\n", start));
    assert.strictEqual((body.match(/requireTemplate\(/g) || []).length, 1);
    assert.ok(body.includes("templatesByID.set(templateID, requireTemplate(templateID, { readOnly: true }));"));
    assert.ok(!body.includes("dungeonAuthority.getTemplateByID("), "rotation does not call getTemplateByID directly");
    assert.strictEqual((body.match(/templatesByID\.get\(/g) || []).length, 1);
    assert.deepStrictEqual([...body.matchAll(/^.*\btemplate\b.*$/gm)].map((m) => m[0].trim()).filter((l) => !l.startsWith("//")), [
      "const template = templatesByID.get(normalizeText(rotation.nextDefinition.templateID, \"\"));",
      "if (!template) {",
      "template,",
    ]);
    assert.ok(/const created = buildInstanceRecordFromOptions\(\n\s+nextInstanceID,\n\s+template,\n/.test(body));
    assert.ok(rt.includes("templatesByID.set(definition.templateID, requireTemplate(definition.templateID, { readOnly: true }));"), "reconcile readOnly");
    assert.ok(/^function requireTemplate\(templateID, options = \{\}\) \{[\s\S]*?: dungeonAuthority\.getTemplateByID\(normalizedTemplateID\);/m.test(rt));
    assert.ok(/\nmodule\.exports = \{[\s\S]*?\n  rotateUniversePersistentInstances,\n/.test(rt));
    const uni = norm("services/dungeon/dungeonUniverseRuntime.js");
    assert.ok(uni.includes("? dungeonRuntime.rotateUniversePersistentInstances(rotations, { nowMs })"), "call through a property");
    for (const rel of ["services/dungeon/dungeonUniverseRuntime.js", "services/dungeon/dungeonRuntime.js"]) {
      assert.ok(!/\{[^}]*\brotateUniversePersistentInstances\b[^}]*\}\s*=\s*require/.test(norm(rel)), `no destructuring: ${rel}`);
    }
  });

  test("R5 rotation obsolete: vendor with readOnly in rotation = no wrapper, point ready (no DRIFT), WARN once; old text = wrapper", () => {
    const { rotateFixedUpstream, ROTATE_UPSTREAM_READONLY } = require("../lib/templateReadOnly");
    const realFile = path.join(ctx.SERVER_SRC, "services/dungeon/dungeonRuntime.js");
    const text = src("services/dungeon/dungeonRuntime.js");
    assert.strictEqual(rotateFixedUpstream(text), true, "261115.2");
    const old = text.replace("requireTemplate(templateID, { readOnly: true })", "requireTemplate(templateID)");
    assert.strictEqual(rotateFixedUpstream(old), false, "261108.1 (clone in rotation)");
    assert.strictEqual(rotateFixedUpstream(""), false);
    assert.ok(ROTATE_UPSTREAM_READONLY.includes("readOnly: true"));

    const lines = [];
    const st = createState({ ...config, templateReadOnlyView: true, templateReadOnlyRotate: true },
      createRecorder({ slowCallMs: 1e9 }, () => {}), { log: (l) => lines.push(l) });
    const authority = fakeAuthority();
    patchTarget("dungeonAuthority", authority, st);
    const runtime = fakeRuntime(authority, RUNTIME_FILE);
    const fn = runtime.rotateUniversePersistentInstances;
    patchTarget("dungeonRuntime", runtime, st, realFile);
    assert.strictEqual(runtime.rotateUniversePersistentInstances, fn, "no wrapper");
    assert.ok(st.patched.has(ROTATE_SYMBOL), "point ready = probe without DRIFT");
    assert.strictEqual(st.template.status().rotate, "obsolete");
    assert.strictEqual(st.template.status().disabledReason, null, "hydrateSummary templates keep working");
    assert.strictEqual(lines.filter((l) => l.includes("templateReadOnly rotate disabled: obsolete")).length, 1, lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("DRIFT")));
    assert.strictEqual(createState({ ...config, templateReadOnlyView: true }, createRecorder({ slowCallMs: 1e9 }, () => {}),
      { log: () => {} }).template.status().rotate, "off");
    assert.strictEqual(setup({}).st.template.status().rotate, "on");
  });
}

module.exports = { register };
