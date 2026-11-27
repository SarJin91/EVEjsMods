"use strict";

const assert = require("node:assert");

const { formatMail, formatNoticeLine, FOOTER } = require("../../lib/notices/format");

module.exports = ({ test }) => {
  test("NMF1 formatMail: title of 1 vs N lines, <br>, escaping, title <= 150, body <= 8000 with whole lines", () => {
    const one = formatMail(["Guristas attack Jita"]);
    assert.strictEqual(one.title, "LNE: Guristas attack Jita");
    assert.strictEqual(one.body, `Guristas attack Jita<br><br>${FOOTER}`);

    const many = formatMail(["a <b> & c", "second"]);
    assert.strictEqual(many.title, "LNE front report: 2 events");
    assert.strictEqual(many.body, `a &lt;b&gt; &amp; c<br>second<br><br>${FOOTER}`);

    const long = formatMail(["x".repeat(400)]);
    assert.strictEqual(long.title.length, 150);
    assert.ok(long.title.endsWith("..."));

    const lines = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")} ${"y".repeat(396)}`);
    const big = formatMail(lines);
    assert.ok(big.body.length <= 8000, String(big.body.length));
    const parts = big.body.split("<br>");
    const kept = parts.filter((p) => /^\d\d y+$/.test(p));
    assert.ok(kept.length >= 18 && kept.length < 30, String(kept.length));
    assert.ok(kept.every((p) => p.length === 399), "no line cut");
    assert.ok(big.body.includes(`... ${30 - kept.length} more<br><br>${FOOTER}`));

    assert.deepStrictEqual(formatMail(lines), big);
  });

  test("NMF2 formatNoticeLine: 7 kinds, personal, missing names, UTC time, <= 400", () => {
    const AT = Date.UTC(2026, 10, 2, 14, 5, 30);
    const names = new Map([[500010, "Guristas Pirates"], [500001, "Caldari State"]]);
    const o = { systemName: "6-CZ49", regionName: "Fountain", names, personal: false };
    const ev = (kind, extra = {}) => ({ kind, systemId: 30001000, at: AT, attacker: 500010, defender: 500001,
      ...extra });
    const line = (kind, extra, opts = o) => formatNoticeLine(ev(kind, extra), opts);
    assert.strictEqual(line("ATTACK_STARTED"),
      "[14:05 UTC] Invasion: Guristas Pirates attack Caldari State in 6-CZ49 (Fountain).");
    assert.strictEqual(line("SYSTEM_CAPTURED"),
      "[14:05 UTC] Captured: 6-CZ49 (Fountain) is now held by Guristas Pirates (was Caldari State).");
    assert.strictEqual(line("SYSTEM_RELEASED", { defender: 500010, attacker: null }),
      "[14:05 UTC] Released: Guristas Pirates lost control of 6-CZ49 (Fountain).");
    assert.strictEqual(line("SYSTEM_RELEASED", { defender: 500010, attacker: null }, { ...o, personal: true }),
      "[14:05 UTC] Released: Guristas Pirates lost control of 6-CZ49 (Fountain). Your kills helped.");
    assert.strictEqual(line("ATTACK_REPELLED", { attacker: 500010, defender: 500001 }),
      "[14:05 UTC] Repelled: Caldari State held 6-CZ49 (Fountain) against Guristas Pirates.");
    assert.strictEqual(line("SIEGE_STARTED"),
      "[14:05 UTC] Siege: Guristas Pirates besiege a Caldari State station in 6-CZ49 (Fountain).");
    assert.strictEqual(line("SIEGE_ENDED", { outcome: "CAPTURED", endReason: null }),
      "[14:05 UTC] Siege over in 6-CZ49 (Fountain): station captured by Guristas Pirates.");
    assert.strictEqual(line("SIEGE_ENDED", { outcome: "DESTROYED", endReason: "NATIVE_DESTROYED" }),
      "[14:05 UTC] Siege over in 6-CZ49 (Fountain): station destroyed by capsuleers.");
    assert.strictEqual(line("PLAYER_IMPACT", { defender: 500010, attacker: null }),
      "[14:05 UTC] Your kills weakened Guristas Pirates' hold on 6-CZ49 (Fountain).");
    assert.strictEqual(formatNoticeLine(ev("ATTACK_STARTED", { attacker: 777 }), { names: new Map() }),
      "[14:05 UTC] Invasion: an unknown faction attack an unknown faction in an unknown system.");
    const long = formatNoticeLine(ev("SYSTEM_CAPTURED"), { ...o, systemName: "x".repeat(500) });
    assert.ok(long.length <= 400 && long.endsWith("..."), String(long.length));
  });
};
