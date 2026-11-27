"use strict";

const assert = require("node:assert");

const { createRouter } = require("../../lib/observer/router");
const { createViewRegistry } = require("../../lib/observer/views");

const BASE = { maxResponseBytes: 65536, refreshSeconds: 5 };

function setup(extra) {
  const views = createViewRegistry();
  const state = { hold: false, reads: [] };
  const getData = (req) => {
    if (state.hold) return { available: false, reason: "GOVERNOR_HOLD" };
    state.reads.push(req.param);
    return { available: true, systemId: req.param };
  };
  const reg = views.registerView("system-card", { title: "Card", listed: false, param: "system", getData,
    cacheKey: (req) => (state.hold ? null : `k${req.param}`) });
  assert.ok(reg.ok);
  assert.ok(views.registerView("plain", { title: "Plain", getData: () => ({ a: 1 }) }).ok);
  const router = createRouter({ views, assets: {}, config: { ...BASE, ...extra }, modVersion: "t", now: () => 5000 });
  const get = (url) => router.route({ method: "GET", url, host: "127.0.0.1" });
  const body = (url) => JSON.parse(get(url).body);
  return { state, get, body };
}

module.exports = ({ test }) => {
  test("T3 param: registry rules, BAD_PARAM, envelope, two systems in two slots", () => {
    const reg = createViewRegistry();
    const getData = () => ({});
    assert.strictEqual(reg.registerView("a", { title: "x", getData, param: "system" }).reason, "VIEW_DEF_INVALID",
      "param needs listed:false");
    assert.strictEqual(reg.registerView("b", { title: "x", getData, listed: false, param: "9x" }).reason,
      "VIEW_DEF_INVALID");
    assert.ok(reg.registerView("c", { title: "x", getData, listed: false, param: "system" }).ok);
    assert.strictEqual(reg.getView("c").param, "system");

    const { state, get, body } = setup({ systemCardCacheSlots: 4 });
    for (const q of ["", "?system=abc", "?system=0", "?system=-1", "?system=1.5", "?system=99999999999999999",
      "?other=1"]) {
      const r = get(`/api/views/system-card${q}`);
      assert.strictEqual(r.status, 400, q);
      assert.strictEqual(JSON.parse(r.body).error.reason, "BAD_PARAM");
    }
    const a = body("/api/views/system-card?system=30000142");
    assert.deepStrictEqual([a.param, a.data.systemId, a.cached], [30000142, 30000142, false]);
    const b = body("/api/views/system-card?system=30000143");
    assert.deepStrictEqual([b.data.systemId, b.cached], [30000143, false]);
    const again = body("/api/views/system-card?system=30000142");
    assert.deepStrictEqual([again.data.systemId, again.cached], [30000142, true]);
    assert.deepStrictEqual(state.reads, [30000142, 30000143]);
  });

  test("T3 slots: over the limit the oldest used leaves; HOLD gives the own stale answer or the raw hold", () => {
    const { state, body } = setup({ systemCardCacheSlots: 2 });
    const url = (id) => `/api/views/system-card?system=${id}`;
    body(url(1));
    body(url(2));
    body(url(1));
    body(url(3));
    state.reads.length = 0;
    assert.strictEqual(body(url(1)).cached, true);
    assert.strictEqual(body(url(3)).cached, true);
    assert.strictEqual(body(url(2)).cached, false, "slot 2 was dropped");
    assert.deepStrictEqual(state.reads, [2]);

    const { state: s2, body: b2 } = setup({ systemCardCacheSlots: 2 });
    b2(url(7));
    s2.hold = true;
    const held = b2(url(7));
    assert.deepStrictEqual([held.stale, held.data.systemId, held.data.stale, held.data.reason],
      [true, 7, true, "GOVERNOR_HOLD"]);
    const raw = b2(url(8));
    assert.deepStrictEqual([raw.stale, raw.data.available, raw.data.reason, raw.data.systemId],
      [false, false, "GOVERNOR_HOLD", undefined]);
  });

  test("T3 a view without param ignores the query, no param field, one slot by default", () => {
    const { get, body } = setup();
    const plain = get("/api/views/plain").body;
    assert.strictEqual(get("/api/views/plain?system=abc").body, plain);
    assert.ok(!plain.includes("\"param\""));
    const url = (id) => `/api/views/system-card?system=${id}`;
    body(url(1));
    body(url(2));
    assert.strictEqual(body(url(1)).cached, false, "default limit is one slot");
  });

  test("T4 optParams: registry rules, own slot per set, BAD_PARAM, req.params, old views byte for byte", () => {
    const reg = createViewRegistry();
    const getData = () => ({});
    let n = 0;
    const bad = (def) => {
      n += 1;
      return reg.registerView(`v${n}`, { title: "x", getData, ...def });
    };
    assert.strictEqual(bad({ optParams: ["faction"] }).reason, "VIEW_DEF_INVALID", "needs listed:false");
    assert.strictEqual(bad({ listed: false, optParams: ["a", "b", "c", "d"] }).reason, "VIEW_DEF_INVALID", "> 3");
    assert.strictEqual(bad({ listed: false, optParams: ["a", "a"] }).reason, "VIEW_DEF_INVALID", "duplicates");
    assert.strictEqual(bad({ listed: false, param: "a", optParams: ["a"] }).reason, "VIEW_DEF_INVALID", "= param");
    assert.strictEqual(bad({ listed: false, optParams: [] }).reason, "VIEW_DEF_INVALID", "empty");
    assert.strictEqual(bad({ listed: false, optParams: ["9x"] }).reason, "VIEW_DEF_INVALID", "name");
    assert.ok(reg.registerView("ok", { title: "x", getData, listed: false, optParams: ["faction"] }).ok);
    assert.deepStrictEqual(reg.getView("ok").optParams, ["faction"]);
    assert.strictEqual(createViewRegistry().getView("none"), null);

    const views = createViewRegistry();
    const reads = [];
    assert.ok(views.registerView("kb", { title: "KB", listed: false, optParams: ["faction", "system"],
      getData: (req) => {
        reads.push(req.params);
        return { p: req.params };
      }, cacheKey: () => "k" }).ok);
    assert.ok(views.registerView("system-card", { title: "Card", listed: false, param: "system",
      getData: (req) => ({ available: true, systemId: req.param }), cacheKey: () => "k" }).ok);
    const router = createRouter({ views, assets: {}, config: { ...BASE, systemCardCacheSlots: 8 }, modVersion: "t",
      now: () => 5000 });
    const get = (url) => router.route({ method: "GET", url, host: "127.0.0.1" });
    const b = (url) => JSON.parse(get(url).body);
    assert.deepStrictEqual([b("/api/views/kb?faction=1").params, b("/api/views/kb?faction=2").cached,
      b("/api/views/kb?faction=1").cached], [{ faction: 1 }, false, true], "one slot per value");
    assert.deepStrictEqual(b("/api/views/kb?system=3&faction=1").params, { faction: 1, system: 3 });
    assert.deepStrictEqual(b("/api/views/kb").params, {});
    assert.deepStrictEqual(reads, [{ faction: 1 }, { faction: 2 }, { faction: 1, system: 3 }, {}]);
    assert.ok(Object.isFrozen(reads[0]));
    for (const q of ["?system=abc", "?faction=0", "?faction=1.5", "?system=-2"]) {
      const r = get(`/api/views/kb${q}`);
      assert.deepStrictEqual([r.status, JSON.parse(r.body).error.reason], [400, "BAD_PARAM"], q);
    }
    assert.strictEqual(get("/api/views/system-card?system=30000142").body,
      "{\"ok\":true,\"id\":\"system-card\",\"title\":\"Card\",\"generatedAtMs\":5000,\"cached\":false,\"stale\":false,"
        + "\"param\":30000142,\"data\":{\"available\":true,\"systemId\":30000142}}", "a param view byte for byte");
  });
};
