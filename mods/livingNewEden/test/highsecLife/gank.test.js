"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { gankSettingsOf, GANK_METRICS } = require("../../lib/highsecLife/schema");
const { ROLL, bucketOf, planGank, hullsOf } = require("../../lib/highsecLife/gank/plan");
const { GANK_HULLS } = require("../../lib/highsecLife/gank/data");
const { createGank } = require("../../lib/highsecLife/gank/service");
const { startHighsecLife } = require("../../lib/highsecLife");
const { buildGankWreckField } = require("../../lib/world/wreckPool");
const salvagePlan = require("../../lib/events/salvage/plan");
const salvageData = require("../../lib/events/salvage/data");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const HS = require("./highsecLife.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYS = 30002768;
const FLAT = Object.freeze(Array.from({ length: 24 }, () => 1000));
const SEED = 424242;

function defaults() {
  return resolveConfig({ modDir: MOD_DIR, env: {} }).config;
}

function G(over) {
  const gank = { ...defaults().highsecLife.gank, enabled: true, ...(over || {}) };
  const r = gankSettingsOf({ highsecLife: { gank } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function gankBucket(settings, from) {
  for (let b = from; b < from + 500; b += 1) {
    const p = planGank(SYS, b, SEED, FLAT, settings);
    const B = settings.bucketMs;
    if (p.roll === ROLL.GANK && p.at > b * B && p.at + settings.fieldTtlMs < (b + 1) * B) {
      return { bucket: b, plan: p };
    }
  }
  throw new Error("no gank bucket");
}

function harness(over) {
  const o = over || {};
  const settings = o.settings || G({ chancePermille: 1000, systemIds: String(SYS), fieldTtlMs: 3600000 });
  const calls = [];
  const rumours = [];
  const metrics = [];
  const governor = { ok: true, admits: () => governor.ok };
  const made = createGank({ settings, worldSeed: SEED, hourCurvePermille: FLAT,
    describeSystem: () => ({ secClass: o.secClass || "highsec" }),
    empireFactionOf: () => ({ ok: true, factionId: 500001 }),
    getWrecks: () => ({ placeGankField: (p) => {
      calls.push(p);
      return o.place ? o.place(p) : { ok: true, duplicate: false, fieldId: `wf:hg:${p.systemId}:${p.bucket}` };
    } }),
    getGovernor: () => governor,
    onRumour: (e) => {
      rumours.push(e);
      return true;
    },
    telemetry: { count: (n, v) => metrics.push(["count", n, v]), observe: (n, v) => metrics.push(["observe", n, v]) },
    nowMs: () => 0 });
  assert.ok(made.ok, JSON.stringify(made));
  return { gank: made.gank, calls, rumours, metrics, governor, settings };
}

module.exports = ({ test }) => {
  test("HG1 gank plan (pure): deterministic, chance 0 -> QUIET, 1000 -> GANK, at in the bucket, gankers in range, "
    + "Khanid gets Amarr hulls, bad settings refused", () => {
    const S = G();
    assert.deepStrictEqual([S.systemIds, S.bucketMs, S.fieldTtlMs, S.maxPerPass],
      [[30002641, 30002765, 30002768, 30003503], 14400000, 21600000, 1]);
    assert.deepStrictEqual(planGank(SYS, 4242, SEED, FLAT, S), planGank(SYS, 4242, SEED, FLAT, S));
    const quiet = G({ chancePermille: 0 });
    const always = G({ chancePermille: 1000 });
    let freighters = 0;
    for (let b = 1000; b < 1200; b += 1) {
      assert.strictEqual(planGank(SYS, b, SEED, FLAT, quiet).roll, ROLL.QUIET, `bucket ${b}`);
      const p = planGank(SYS, b, SEED, FLAT, always);
      assert.strictEqual(p.roll, ROLL.GANK, `bucket ${b}`);
      assert.ok(p.at >= b * always.bucketMs && p.at < (b + 1) * always.bucketMs, `at ${p.at}`);
      assert.strictEqual(bucketOf(p.at, always.bucketMs), b);
      const [min, max] = p.victimKind === "freighter" ? [8, 14] : [2, 4];
      assert.ok(p.gankers >= min && p.gankers <= max, `${p.victimKind} ${p.gankers}`);
      if (p.victimKind === "freighter") freighters += 1;
      assert.strictEqual(planGank(SYS, b, SEED, FLAT, quiet).at, p.at);
    }
    assert.ok(freighters >= 50 && freighters <= 110, `freighters ${freighters} / 200 at 400 permille`);
    assert.deepStrictEqual(hullsOf(500008), GANK_HULLS[500003]);
    assert.deepStrictEqual(hullsOf(999999), GANK_HULLS[500003]);
    assert.deepStrictEqual(hullsOf(500001), { freighter: 20185, industrial: 648 });
    const bad = (gank) => gankSettingsOf({ highsecLife: { gank: { ...defaults().highsecLife.gank, ...gank } } });
    assert.deepStrictEqual(bad({ gankersHaulerMin: 5, gankersHaulerMax: 4 }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "gank.gankersHaulerMin>gankersHaulerMax" });
    assert.strictEqual(bad({ systemIds: "30002768,30002768" }).detail, "gank.systemIds");
  });

  test("HG3 gank service: before at none, at one call + rumour, memo, restart duplicate -> rumour, tooLate, "
    + "notHighsec, governor retry, tx refusal retried; startHighsecLife flag off = no timer / call / metric",
  async () => {
    const h = harness();
    const { bucket, plan } = gankBucket(h.settings, 2000);
    const B = h.settings.bucketMs;
    h.gank.runPass(bucket * B);
    assert.deepStrictEqual([h.calls.length, h.rumours.length], [0, 0], "before at");
    h.gank.runPass(plan.at);
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.calls[0], { systemId: SYS, bucket, at: plan.at, factionId: 500001,
      victim: { hullGroup: plan.victimKind, typeId: GANK_HULLS[500001][plan.victimKind] },
      gankers: { hullGroup: "destroyer", typeId: 16240, count: plan.gankers }, ttlMs: h.settings.fieldTtlMs });
    assert.deepStrictEqual(h.rumours, [{ systemId: SYS, bucket, at: plan.at, shipsLost: 1 + plan.gankers }]);
    h.gank.runPass(plan.at + 60000);
    assert.strictEqual(h.calls.length, 1, "memo of the bucket");
    let st = h.gank.getStatus().counters;
    assert.deepStrictEqual([st.created, st.duplicate, st.rumoursAdded, st.passes], [1, 0, 1, 3]);
    const names = new Set(Object.values(GANK_METRICS));
    assert.ok(h.metrics.every(([, n]) => names.has(n)), JSON.stringify(h.metrics));
    assert.deepStrictEqual(h.metrics.filter(([k]) => k === "count"), [["count", "highsecLife.gankFields", 1]]);

    const restart = harness({ place: (p) => ({ ok: true, duplicate: true,
      fieldId: `wf:hg:${p.systemId}:${p.bucket}` }) });
    restart.gank.runPass(plan.at + 1000);
    st = restart.gank.getStatus().counters;
    assert.deepStrictEqual([restart.calls.length, restart.rumours.length, st.created, st.duplicate], [1, 1, 0, 1]);
    assert.ok(!restart.metrics.some(([k]) => k === "count"), "a duplicate is no new field");

    const late = harness();
    late.gank.runPass(plan.at + late.settings.fieldTtlMs);
    assert.deepStrictEqual([late.calls.length, late.gank.getStatus().counters.tooLate], [0, 1]);
    const low = harness({ secClass: "lowsec" });
    low.gank.runPass(plan.at);
    assert.deepStrictEqual([low.calls.length, low.gank.getStatus().counters.notHighsec], [0, 1]);

    const held = harness();
    held.governor.ok = false;
    held.gank.runPass(plan.at);
    assert.deepStrictEqual([held.calls.length, held.gank.getStatus().counters["deferred.GOVERNOR"]], [0, 1]);
    held.governor.ok = true;
    held.gank.runPass(plan.at + 1);
    assert.strictEqual(held.calls.length, 1, "retried after the governor");

    let busy = true;
    const tx = harness({ place: () => (busy ? { ok: false, reason: "STORE_SUSPENDED", stage: "tx" }
      : { ok: true, duplicate: false, fieldId: "x" }) });
    tx.gank.runPass(plan.at);
    busy = false;
    tx.gank.runPass(plan.at + 1);
    assert.deepStrictEqual([tx.calls.length, tx.rumours.length, tx.gank.getStatus().counters.failed], [2, 1, 1]);
    const refused = harness({ place: () => ({ ok: false, reason: "QUEUE_FULL", stage: "enqueue" }) });
    refused.gank.runPass(plan.at);
    refused.gank.runPass(plan.at + 1);
    assert.deepStrictEqual([refused.calls.length, refused.rumours.length], [1, 0], "a field refusal is handled");

    const boot = async (enabled) => {
      const timers = [];
      const metrics = [];
      const placed = [];
      const base = HS.baseConfig();
      const config = { ...base, highsecLife: { ...base.highsecLife,
        gank: { ...base.highsecLife.gank, enabled, chancePermille: 1000, systemIds: String(HS.JITA) } } };
      const clock = { t: 0, now() { return clock.t; } };
      const vc = { ensureOwnerIdentity: () => ({ ok: true }), getOwnerIdentity: () => ({ ok: true, state: "LINKED",
        characterIds: Array.from({ length: 10 }, (_, i) => 92000000 + i), refusedMemberCount: 0 }) };
      const r = startHighsecLife({ config, worldSeed: HS.SEED, clock,
        telemetry: { count: (n) => metrics.push(n), gauge: (n) => metrics.push(n), observe: (n) => metrics.push(n) },
        setTimer: (fn) => {
          const t = { fn, cancel() {}, hasRef: () => false };
          timers.push(t);
          return t;
        },
        getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: HS.fakeGraph() }) }),
        getVirtualCorps: () => vc, listStations: () => ({ ok: true, stations: [] }),
        bloodlinesOf: (fid) => (VC_DATA.getById(fid) ? VC_DATA.getById(fid).bloodlineIds : null),
        getWrecks: () => ({ placeGankField: (p) => {
          placed.push(p);
          return { ok: true, duplicate: false, fieldId: "x" };
        } }),
        resolveEmpireFaction: (graph, id) => (graph && id === HS.JITA ? { ok: true, factionId: 500001 }
          : { ok: false }) });
      assert.ok(r.ok, JSON.stringify(r));
      await r.highsecLife.whenReady();
      return { hs: r.highsecLife, timers, metrics, placed, clock };
    };
    const off = await boot(false);
    assert.deepStrictEqual([off.timers.length, off.placed.length, off.hs.getStatus().gank.state], [0, 0, "off"]);
    assert.ok(!off.metrics.some((n) => String(n).startsWith("highsecLife.gank")), "no gank metric off");
    const on = await boot(true);
    assert.deepStrictEqual([on.timers.length, on.hs.getStatus().gank.state], [1, "running"]);
    const S = gankSettingsOf({ highsecLife: { gank: { ...defaults().highsecLife.gank, chancePermille: 1000 } } })
      .settings;
    const curve = HS.baseConfig().highsecLife.hourCurvePermille.split(",").map(Number);
    let found = null;
    for (let b = 3000; b < 3200 && !found; b += 1) {
      const p = planGank(HS.JITA, b, HS.SEED, curve, S);
      if (p.roll === ROLL.GANK) found = p;
    }
    assert.ok(found, "a gank bucket for Jita");
    on.clock.t = found.at;
    on.timers[0].fn();
    assert.deepStrictEqual([on.placed.length, on.placed[0].factionId, on.placed[0].at], [1, 500001, found.at]);
    assert.deepStrictEqual(on.metrics.filter((n) => n === GANK_METRICS.fields), [GANK_METRICS.fields]);
    on.hs.stop();
    assert.strictEqual(on.hs.getStatus().gank.state, "stopped");
  });

  test("HG5 vendor fact: a wreck owned by a non-character is free loot (no suspect); the anomaly of a gank field "
    + "owns its wrecks by an NPC corporation, never a character", () => {
    const loot = fs.readFileSync(path.join(SERVER_SRC, "services", "_shared", "spaceLootEntitlement.js"), "utf8")
      .replace(/\r\n/g, "\n");
    assert.match(loot,
      /\nfunction isPlayerCharacterOwner\(ownerID\) \{\n\s*return Boolean\(getCharacterRecordSafe\(ownerID\)\);\n\}/);
    assert.match(loot, /if \(!isPlayerCharacterOwner\(ownerID\)\) \{\n\s*return true;\n\s*\}/);
    const wrecks = defaults().wrecks;
    const built = buildGankWreckField({ systemId: SYS, bucket: 7, at: 1000, factionId: 500001,
      victim: { hullGroup: "freighter", typeId: 20185 }, gankers: { hullGroup: "destroyer", typeId: 16240, count: 9 },
      ttlMs: 21600000 }, wrecks);
    assert.ok(built.ok, JSON.stringify(built));
    const sa = defaults().salvageAnomaly;
    const params = Object.fromEntries(salvagePlan.PARAM_NAMES.map((k) => [k, sa[k]]));
    const planned = salvagePlan.planAnomaly(built.field, { salvage: built.field.salvageUnits,
      loot: built.field.lootUnits }, params, 12345);
    assert.ok(planned.ok && planned.wrecks.length > 0, JSON.stringify(planned));
    const owners = new Set(planned.wrecks.map((w) => salvagePlan.placeSpecOf({ anomalyId: "a", systemId: SYS,
      expiresAt: 2000 }, w, { siteKey: "k", nowMs: 1000, lootTableFor: () => null }).ownerId));
    assert.deepStrictEqual([...owners], [salvageData.ownerCorporationOf(500001)]);
    const owner = [...owners][0];
    assert.ok(owner >= 1000000 && owner < 2000000, `owner ${owner}`);
  });
};
