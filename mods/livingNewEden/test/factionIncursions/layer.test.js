"use strict";

const assert = require("node:assert");

const L = require("../../lib/heavyEvents/layer");
const S = require("../../lib/heavyEvents/schema");
const FS = require("../../lib/factionIncursions/schema");
const { pumpPlanned } = require("../../lib/heavyEvents/planner");
const { createLive } = require("../../lib/heavyEvents/live");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, TRIG, DEFENDER, CHAR, SYS, harness, boot, cfg } = require("./harness");

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI5 heavyEvents incursion layer", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FI5 hin: layer: plan + duplicate, layer off -> CANCELLED (DISABLED), clear = no influence drop", () => {
    assert.strictEqual(L.layerOfEventId("hin:1:hq:1"), "incursion");
    assert.strictEqual(L.PREFIX_OF.incursion, FS.SITE_EVENT_PREFIX);
    withStore(driver, ({ store }) => {
      const h = harness(store);
      boot(h);
      const heavy = h.ctx.heavyEvents;
      const spec = { eventId: "hin:9:hq:1", systemId: SYS[0], factionId: TRIG, beneficiaryFactionId: DEFENDER,
        kind: "breach", tier: 3, expiresAt: T0 + 3600000, at: T0 };
      const first = h.run((tx) => heavy.planIncursionSiteInTx(tx, spec));
      assert.deepStrictEqual([first.ok, first.duplicate], [true, undefined], JSON.stringify(first));
      const row = h.heavyRow("hin:9:hq:1");
      assert.deepStrictEqual([row.state, row.eventType, row.variant, row.affix, row.beneficiaryFactionId, row.planKey],
        ["PLANNED", "trail", "breach", "none", DEFENDER, "hin:9:hq:1"]);
      assert.strictEqual(h.run((tx) => heavy.planIncursionSiteInTx(tx, spec)).duplicate, true);
      assert.deepStrictEqual(h.run((tx) => heavy.getSiteInTx(tx, "hin:9:hq:1")).site.state, "PLANNED");
      assert.deepStrictEqual(h.run((tx) => heavy.getSiteInTx(tx, "hin:9:none:1")), { ok: true, site: null });

      const c = cfg();
      const env = { store, repo: h.repo, settings: c.heavyEvents, power: c.powerSites, world: c.eventAnomalies,
        incursionEnabled: false, getSites: () => h.sites, getStations: () => h.ctx.stations,
        getWorldRepository: () => h.worldRepository };
      const out = pumpPlanned(env, T0 + 1000);
      assert.strictEqual(out.disabled, 1, JSON.stringify(out));
      assert.deepStrictEqual([h.heavyRow("hin:9:hq:1").state, h.heavyRow("hin:9:hq:1").endReason],
        ["CANCELLED", "DISABLED"]);

      assert.ok(h.run((tx) => heavy.planIncursionSiteInTx(tx, { ...spec, eventId: "hin:9:staging:1", kind: "staging",
        tier: 1 })).ok);
      const live = createLive({ ...env, incursionEnabled: true, journal: h.journal, payoutRepo: h.payouts,
        getOccupation: () => h.occupation, admits: () => true, factionName: () => null, getSeam: () => null },
      { bump: (name) => assert.ok(S.COUNTER_NAMES.includes(name), name), refuse: () => {} });
      h.run((tx) => {
        const r = h.repo.getInTx(tx, "hin:9:staging:1").row;
        const engaged = h.repo.transitionInTx(tx, { eventId: r.eventId, expectedVersion: r.version, from: "PLANNED",
          to: "ENGAGED", at: T0, patch: { engagedAt: T0 } }).row;
        const cleared = live.clearInTx(tx, engaged, T0 + 500, null, [CHAR]);
        assert.strictEqual(cleared.duplicate, false);
      });
      assert.strictEqual(h.occupation.drops.length, 0, "no influence drop for a hin: clear");
      assert.deepStrictEqual(h.run((tx) => heavy.siteParticipantsInTx(tx, "hin:9:staging:1", 1)),
        { ok: true, characterIds: [CHAR] });
    });
  });
};
