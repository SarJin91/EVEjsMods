"use strict";

const assert = require("node:assert");

const { CIVILIAN_CORPS } = require("../../lib/highsecLife/data/civilianCorps");
const { corpNameOf } = require("../../lib/strategy/capsuleers/capsuleerRules");
const { MAX_SLOTS } = require("../../lib/strategy/data/capsuleers");
const VC = require("../../lib/strategy/data/virtualCorps");

const FIRST_20 = ["Jita Freight Collective|JFCOL", "Perimeter Hauling Union|PHUN", "Amarr Prime Logistics|APLOG",
  "Dodixie Trade Syndicate|DTSYN", "Rens Market Brokers|RMBRK", "Hek Bazaar Traders|HEKBZ",
  "Kador Ore Cooperative|KOREC", "Lonetrek Belt Miners|LBMIN", "Essence Veldspar Guild|EVGLD",
  "Sinq Laison Prospectors|SLPRO", "Citadel Courier Service|CCSRV", "Domain Mission Runners|DMRUN",
  "Caldari Contract Pilots|CCPLT", "Gallente Mission Guild|GMGLD", "Tash-Murkon Industrials|TMIND",
  "Placid Salvage Company|PSALV", "Molden Heath Shipping|MHSHP", "Verge Vendor Exchange|VVEX",
  "Khanid Cargo Lines|KCLIN", "Black Rise Outfitters|BROUT"];

module.exports = ({ test }) => {
  test("FC1-4 free corps civilian catalogue: 60 entries, distinct, no collision with capsuleers and "
    + "faction corporations, 1..20 unchanged", () => {
    const names = CIVILIAN_CORPS.map((c) => c.name);
    const tickers = CIVILIAN_CORPS.map((c) => c.ticker);
    for (const c of CIVILIAN_CORPS) {
      assert.ok(c.name.length >= 1 && c.name.length <= 50 && /^[\x20-\x7e]+$/.test(c.name), c.name);
      assert.ok(/^[A-Z0-9]{2,5}$/.test(c.ticker), c.ticker);
    }
    const taken = { names: new Set(), tickers: new Set() };
    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
      const n = corpNameOf(slot);
      taken.names.add(n.name);
      taken.tickers.add(n.ticker);
    }
    for (const f of VC.getFactions()) {
      for (const e of [f, f.alliance, ...(f.corporations || [])]) {
        if (!e) continue;
        taken.names.add(e.name);
        taken.tickers.add(e.ticker);
      }
    }
    assert.deepStrictEqual({ count: CIVILIAN_CORPS.length, names: new Set(names).size, tickers: new Set(tickers).size,
      nameHits: names.filter((n) => taken.names.has(n)), tickerHits: tickers.filter((t) => taken.tickers.has(t)),
      first20: CIVILIAN_CORPS.slice(0, 20).map((c) => `${c.name}|${c.ticker}`) },
    { count: 60, names: 60, tickers: 60, nameHits: [], tickerHits: [], first20: FIRST_20 });
  });
};
