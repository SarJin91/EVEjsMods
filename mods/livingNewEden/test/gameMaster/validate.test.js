"use strict";

const assert = require("node:assert");

const { validateProposal } = require("../../lib/gameMaster/validate");
const { buildOffer } = require("../../lib/gameMaster/digest");
const { templateProposal } = require("../../lib/gameMaster/fallback");
const { createStepRegistry, registerBuiltin, MAX_KINDS, MAX_HINT_SOURCES } = require("../../lib/gameMaster/registry");
const { VALIDATOR_REASONS } = require("../../lib/gameMaster/schema");
const { ARCS, fillTemplate } = require("../../lib/gameMaster/data/arcs");
const F = require("./fixture");

const DAY = 86400000;
const CYCLE = 1763568000000;

function siteStub() {
  return F.stubKind("SITE", { maxPerThread: 2, duration: { minMs: 3600000, maxMs: 12 * 3600000 },
    validate: (p) => (p.site === "bad" ? { ok: false, reason: "STUB_BAD" }
      : { ok: true, params: { site: p.site, place: p.place, hours: p.hours } }) });
}

function offerOf() {
  const place = (ref, id) => {
    const s = F.SYSTEMS.find((x) => x.id === id);
    return Object.freeze({ ref, systemId: id, name: s.name, regionId: s.regionId, regionName: F.REGIONS.get(s.regionId),
      secClass: s.secClass });
  };
  return Object.freeze({
    places: Object.freeze([place("P1", 30000001), place("P2", 30000021), place("P3", 30000002)]),
    factions: Object.freeze([
      Object.freeze({ key: "guristas", factionId: 500010, role: "pirate", name: "Guristas Pirates" }),
      Object.freeze({ key: "caldari", factionId: 500001, role: "actor", name: "Caldari State" })]),
    arcs: Object.freeze(["MUTINY", "WAR_RUMOUR"]),
    stepKinds: Object.freeze([]),
    recent: Object.freeze([Object.freeze({ arc: "DEFECTOR", regionId: 10000001, systemId: 30000002,
      cycleAt: CYCLE - DAY })]),
    activity: Object.freeze([]), lines: Object.freeze([]), cycleAt: CYCLE });
}

function base(over) {
  return { v: 1, arc: "WAR_RUMOUR", faction: "guristas", place: "P1", title: "War rumours near Ostu",
    hook: "Pilots in Ostu speak of a Guristas Pirates fleet in Alpha Reach.",
    steps: [{ t: "NEWS" }, { t: "NOTICE", text: "Scouts near Ostu count more ships." }, { t: "WAIT", hours: 6 }],
    end: { won: "The fleet never came.", lost: "The rumour goes quiet." }, ...(over || {}) };
}

module.exports = ({ test }) => {
  const S = F.settingsOf();

  test("G1 validator: a valid proposal -> plan with IDs; every refusal rule its reason; registry BAD_KIND / RESERVED / "
    + "DUPLICATE / FULL, hint sources FULL at 7", () => {
    const { registry } = F.registryWithBuiltins(S);
    assert.strictEqual(registerBuiltin(registry, siteStub()).ok, true);
    const offer = offerOf();
    const ok = validateProposal(JSON.stringify(base()), offer, registry, S);
    assert.ok(ok.ok, JSON.stringify(ok));
    const p = ok.plan;
    assert.deepStrictEqual([p.arc, p.source, p.factionId, p.actorFactionId, p.systemId, p.regionId],
      ["WAR_RUMOUR", "ai", 500010, null, 30000001, 10000001]);
    assert.deepStrictEqual(p.steps.map((s) => [s.kind, s.version, s.durationMs]),
      [["NEWS", 1, 0], ["NOTICE", 1, 0], ["WAIT", 1, 6 * 3600000]]);
    assert.deepStrictEqual(p.textFallback, []);
    const fenced = validateProposal(`Here:\n\`\`\`json\n${JSON.stringify(base())}\n\`\`\``, offer, registry, S);
    assert.ok(fenced.ok, JSON.stringify(fenced));
    assert.strictEqual(validateProposal(JSON.stringify(base({ steps: [{ t: "WAIT", hours: 99 }] })), offer, registry,
      S).plan.steps[0].params.hours, S.waitMaxHours, "hours clamped, never refused");

    const short = F.settingsOf({ maxThreadMs: 5 * 3600000 });
    const cases = [
      ["x".repeat(S.maxProposalChars + 1), "TOO_LARGE"],
      ["no json here", "NOT_JSON"],
      [JSON.stringify(base({ reward: 1 })), "UNKNOWN_KEY"],
      [JSON.stringify(base({ v: 2 })), "BAD_VERSION"],
      [JSON.stringify(base({ arc: "NOPE" })), "ARC_UNKNOWN"],
      [JSON.stringify(base({ arc: "DEFECTOR", actor: "caldari" })), "ARC_COOLDOWN"],
      [JSON.stringify(base({ faction: "sansha" })), "FACTION_UNKNOWN"],
      [JSON.stringify(base({ actor: "guristas" })), "ACTOR_UNKNOWN"],
      [JSON.stringify(base({ place: "P9" })), "PLACE_UNKNOWN"],
      [JSON.stringify(base({ arc: "MUTINY", place: "P2", steps: [{ t: "NEWS" }] })), "PLACE_SEC"],
      [JSON.stringify(base({ place: "P3" })), "PLACE_COOLDOWN"],
      [JSON.stringify(base({ steps: [] })), "STEPS_COUNT"],
      [JSON.stringify(base({ steps: [{ t: "SITE" }] })), "STEP_KIND"],
      [JSON.stringify(base({ arc: "MUTINY", steps: [{ t: "SITE", site: "bad", place: "P1", hours: 3 }] })),
        "STEP_PARAMS:STUB_BAD"],
      [JSON.stringify(base({ steps: [{ t: "NEWS" }, { t: "NEWS" }] })), "STEP_LIMIT"],
    ];
    const seen = new Set();
    for (const [raw, reason] of cases) {
      const r = validateProposal(raw, offer, registry, S);
      assert.deepStrictEqual(r, { ok: false, reason }, `${reason}: ${raw.slice(0, 80)}`);
      seen.add(reason.split(":")[0]);
    }
    const long = validateProposal(JSON.stringify(base({ steps: [{ t: "WAIT", hours: 6 }] })), offer, registry, short);
    assert.deepStrictEqual(long, { ok: false, reason: "TOO_LONG" });
    seen.add("TOO_LONG");
    assert.deepStrictEqual([...seen].sort(), [...VALIDATOR_REASONS].sort(), "one case per rule of the table");

    const reg = createStepRegistry();
    assert.deepStrictEqual(reg.register({ type: "BOSS" }), { ok: false, reason: "BAD_KIND" });
    assert.deepStrictEqual(reg.register(F.stubKind("SITE")), { ok: false, reason: "RESERVED" });
    const boss = reg.register(F.stubKind("BOSS"));
    assert.strictEqual(boss.ok, true);
    assert.deepStrictEqual(reg.register(F.stubKind("BOSS")), { ok: false, reason: "DUPLICATE" });
    for (let i = 2; i <= MAX_KINDS; i += 1) {
      assert.strictEqual(reg.register(F.stubKind(`KIND_${String(i).padStart(2, "0")}`)).ok, true, `kind ${i}`);
    }
    assert.deepStrictEqual(reg.register(F.stubKind("KIND_17")), { ok: false, reason: "FULL" });
    assert.deepStrictEqual(reg.list().map((k) => k.type)[0], "BOSS");
    boss.unregister();
    assert.strictEqual(reg.get("BOSS"), null);
    assert.strictEqual(reg.register(F.stubKind("KIND_17")).ok, true);
    for (let i = 1; i <= MAX_HINT_SOURCES; i += 1) {
      assert.strictEqual(reg.registerHintSource({ key: `src${i}`, read: () => null }).ok, true, `source ${i}`);
    }
    assert.deepStrictEqual(reg.registerHintSource({ key: "src7", read: () => null }), { ok: false, reason: "FULL" });
    assert.strictEqual(MAX_HINT_SOURCES, 6);
  });

  test("G2 text field with a digit / a link / a name outside the offer -> the field template, textFallback, plan ok",
    () => {
      const { registry } = F.registryWithBuiltins(S);
      const offer = offerOf();
      const raw = JSON.stringify(base({ title: "War 2 near Ostu", hook: "See http://example.com for Ostu.",
        steps: [{ t: "NEWS" }, { t: "NOTICE", text: "Pilots fly to Delve now." }, { t: "WAIT", hours: 2 }],
        end: { won: "The Guristas Pirates left for Delve.", lost: "The rumour goes quiet." } }));
      const r = validateProposal(raw, offer, registry, S);
      assert.ok(r.ok, JSON.stringify(r));
      const en = ARCS.WAR_RUMOUR.texts.en;
      const names = { system: "Ostu", region: "Alpha Reach", faction: "Guristas Pirates", actor: "" };
      assert.deepStrictEqual(r.plan.textFallback, ["title", "hook", "won", "notice"]);
      assert.deepStrictEqual([r.plan.title, r.plan.hook, r.plan.end.won, r.plan.end.lost, r.plan.steps[1].params.text],
        [fillTemplate(en.title, names), fillTemplate(en.hook, names), fillTemplate(en.won, names),
          "The rumour goes quiet.", fillTemplate(en.notice, names)]);
    });

  test("G3 template x 3 seeds x offered arcs passes the validator; SITE arcs offered only with SITE registered", () => {
    const graph = F.graphFixture();
    const input = (registry) => ({ cycleAt: CYCLE, seed: 4242, graph, factionNames: F.NAMES,
      activityRows: [{ regionId: 10000002, samples: 30 }], recentThreads: [], registry, S });
    const plain = F.registryWithBuiltins(S).registry;
    const a = buildOffer(input(plain));
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(a.offer.arcs, ["WAR_RUMOUR"]);
    assert.deepStrictEqual(buildOffer(input(plain)), a, "deterministic");
    assert.strictEqual(a.offer.places[0].regionId, 10000002, "the active region first");
    assert.ok(a.offer.places.every((p) => p.secClass !== "highsec"), "lowsec / nullsec only");
    assert.deepStrictEqual(a.offer.activity, [{ regionId: 10000002, level: "high" }]);
    const withSite = F.registryWithBuiltins(S).registry;
    assert.strictEqual(registerBuiltin(withSite, siteStub()).ok, true);
    const b = buildOffer(input(withSite));
    assert.deepStrictEqual(b.offer.arcs, ["DEFECTOR", "MUTINY", "SMUGGLER_CACHE", "WAR_RUMOUR"]);
    for (const [offer, registry] of [[a.offer, plain], [b.offer, withSite]]) {
      for (const arc of offer.arcs) {
        for (const seed of [1, 77, 4242]) {
          const one = Object.freeze({ ...offer, arcs: Object.freeze([arc]) });
          const t = templateProposal(one, seed, S);
          assert.ok(t.ok && typeof t.raw === "string", `${arc} ${seed} ${JSON.stringify(t)}`);
          const v = validateProposal(t.raw, one, registry, S, "template");
          assert.ok(v.ok, `${arc} ${seed} ${JSON.stringify(v)}`);
          assert.deepStrictEqual([v.plan.arc, v.plan.source, v.plan.textFallback], [arc, "template", []],
            `${arc} ${seed}`);
        }
      }
    }
  });
};
