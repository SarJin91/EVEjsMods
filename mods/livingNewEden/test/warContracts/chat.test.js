"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startWarContracts } = require("../../lib/warContracts");
const { formatWarReply, CORP_TEXT } = require("../../lib/warContracts/format");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const HOUR = 3600000;
const HOME = 10000002;
const AWAY = 10000043;
const REGION_OF = { 30000142: HOME, 30000144: HOME, 30002187: AWAY };
const NAMES = Object.freeze({
  faction: (id) => ({ 500001: "Caldari State", 500003: "Amarr Empire" })[id] || null,
  type: (id) => ({ 621: "Caracal", 24690: "Harbinger" })[id] || null,
  system: (id) => ({ 30000142: "Jita", 30000144: "Perimeter", 30002187: "Amarr", 30003000: "Tama" })[id] || null,
  region: (id) => ({ [HOME]: "The Forge", [AWAY]: "Domain" })[id] || null,
});

function row(offerId, o) {
  return { offerId, factionId: 500001, systemId: 30000142, typeId: 621, quantity: 4, itemKind: "hull",
    itemKey: "group:cruiser", lpAmount: 1500, iskAmount: 0, standingMicro: 10000, state: "OPEN", endReason: null,
    adoptedAt: AT - 3 * HOUR, ...o };
}

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

module.exports = ({ test }) => {
  test("WC1 formatWarReply: own region first, maxLines, front / no front, corporation row, maxChars cut", () => {
    const rows = [row("to_c", { factionId: 500003, systemId: 30002187, typeId: 24690, lpAmount: 0 }),
      row("to_b", { systemId: 30000144, state: "LAPSED", endReason: "NO_CHARACTER_ACCEPTOR" }),
      row("to_a"), row("to_d", { systemId: 30002187, factionId: 500003 })];
    const v = { rows, playerRegionId: HOME, regionOf: (s) => REGION_OF[s] || null, names: NAMES,
      frontOf: (f) => (f === 500001 ? 30003000 : null), now: AT, maxLines: 3, maxChars: 900, lineBreak: "<br>" };
    assert.deepStrictEqual(formatWarReply(v).split("<br>"), ["LNE war contracts:",
      "Caldari State: 4 x Caracal -> Jita (The Forge), +1,500 LP, +0.010 standing, listed 3h ago, front: Tama",
      `Caldari State: 4 x Caracal -> Perimeter (The Forge): ${CORP_TEXT}`,
      "Amarr Empire: 4 x Harbinger -> Amarr (Domain), +0.010 standing, listed 3h ago"]);
    assert.strictEqual(CORP_TEXT, "accepted by a corporation, no reward");
    const cut = formatWarReply({ ...v, maxChars: 200 });
    assert.ok(cut.length <= 200 && cut.endsWith("..."), cut);
    assert.strictEqual(formatWarReply({ ...v, rows: [] }), "LNE war contracts: none open");
    assert.ok(formatWarReply({ ...v, playerRegionId: AWAY, maxLines: 1 }).endsWith("-> Amarr (Domain), "
      + "+0.010 standing, listed 3h ago"));
  });

  test("WC2 handle: RATE_LIMITED and BUSY without a read; chatEnabled=false -> no registration", () => {
    const reads = [];
    let admits = true;
    const store = { limits: { maxRowsPerTransaction: 500 }, transaction: (name) => {
      reads.push(name);
      if (name === "warContracts.chatRead") return { ok: true, value: { ok: true, rows: [], fronts: new Map() } };
      return { ok: false, reason: "TX_FAILED" };
    } };
    const installs = [];
    const adapter = { installChatCommand: (opts) => {
      installs.push(opts);
      return { ok: true };
    }, uninstallChatCommand: () => ({ ok: true }) };
    const boot = (env) => startWarContracts({ config: configOf(env), adapter,
      ctx: { persistence: { ok: true, store }, governor: { admits: () => admits } }, clock: { now: () => AT },
      setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    const on = boot({});
    assert.ok(on.ok, JSON.stringify(on));
    assert.deepStrictEqual(installs.map((i) => i.name), ["war"]);
    assert.strictEqual(installs[0].match("!kontrakty"), true);
    assert.strictEqual(installs[0].match("!WAR now"), true);
    assert.strictEqual(installs[0].match("!warp"), false);
    const handle = installs[0].handle;
    const chatReads = () => reads.filter((n) => n === "warContracts.chatRead").length;
    assert.strictEqual(handle({ characterId: 9001, systemId: 30000142 }), "LNE war contracts: none open");
    assert.strictEqual(chatReads(), 1);
    assert.strictEqual(handle({ characterId: 9001, systemId: 30000142 }),
      "LNE war contracts: wait 10 s before the next !war");
    admits = false;
    assert.strictEqual(handle({ characterId: 9002 }), "LNE war contracts: server busy, try again later");
    assert.strictEqual(chatReads(), 1, "no read on a refusal");
    const c = on.warContracts.getStatus().counters;
    assert.deepStrictEqual([c.chatReplies, c.chatRateLimited], [1, 1]);
    on.warContracts.stop("test");
    installs.length = 0;
    const off = boot({ EVEJS_LNE_WAR_CONTRACTS_CHAT_ENABLED: "0" });
    assert.ok(off.ok, JSON.stringify(off));
    assert.deepStrictEqual(installs, []);
    assert.strictEqual(off.warContracts.getStatus().chat, "off");
    off.warContracts.stop("test");
  });
};
