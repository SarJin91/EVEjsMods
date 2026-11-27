"use strict";

const assert = require("node:assert");

const { harness: H } = require("./service.test");
const { fakeSites, fakePresence } = require("./fixture");

const ARCHIVE = "container:lne_archive";
const winOf = (characterId, outcomeId) => ({ ok: true, state: "active",
  wins: [{ contentKey: ARCHIVE, characterId, outcomeId, atMs: 1 }] });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("A7/A8 archaeology stages", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  const chainOf = (r) => H.chains(r)[0];
  const mails = (r) => r.q("SELECT event_key, kind FROM world_notice_items ORDER BY item_id");
  const fragments = (r) => r.q("SELECT * FROM world_arch_fragments ORDER BY stage_no");
  const eventOf = (c) => `${c.chain_id}:s${c.stage_no}:r${c.stage_spawn_no}`;

  test("A7 archaeology stages: presence gate, SITE_PENDING/ACTIVE, owner win -> FOUND -> lore + hint + stage 2 "
    + "elsewhere; theft -> relocation, over maxRelocations -> EXPIRED; SITES_FULL retry; respawn; last -> COMPLETED",
  () => {
    H.withStore(driver, (opened) => {
      const conf = H.cfg({ EVEJS_LNE_ARCHAEOLOGY_MAX_RELOCATIONS: "1" });
      const P = conf.archaeology;
      const presence = fakePresence();
      const r = H.rig(opened, conf, { presence });
      assert.strictEqual(r.started.ok, true, JSON.stringify(r.started));
      assert.strictEqual(r.sites.calls.providers.length, 1, "provider arc: registered");
      assert.strictEqual(r.sites.calls.providers[0].prefix, "arc:");
      r.emit(H.hackWin());
      let t = H.T0;
      r.a.runPass(t);
      let c = chainOf(r);
      assert.deepStrictEqual([c.stage_state, r.sites.calls.create.length, c.next_check_at],
        ["REVEALED", 0, t + P.presenceCheckMs]);
      presence.where.set(H.C1, c.stage_system_id + 1);
      t += P.presenceCheckMs;
      r.a.runPass(t);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_state, c.stage_due_at, c.next_check_at],
        ["SITE_PENDING", t + P.stageSiteMs, t + P.sitePollMs]);
      const req = r.sites.calls.create[0];
      assert.deepStrictEqual([req.eventId, req.slot, req.systemId, req.templateId, req.factionId],
        [`${c.chain_id}:s1:r0`, 0, c.stage_system_id, c.stage_template_id, c.stage_faction_id]);
      const built = r.sites.calls.providers[0].build(req.eventId, 0);
      assert.strictEqual(built.ok, true);
      assert.deepStrictEqual(built.containers.map((x) => [x.key, x.hackingDifficulty, x.offsetMeters]),
        [["lne_archive", P.archiveDifficultyStart, P.archiveOffsetMeters]]);
      assert.deepStrictEqual(r.sites.calls.providers[0].build(`${c.chain_id}:s2:r0`, 0).containers, []);
      r.sites.setState(req.eventId, "ACTIVE");
      t += P.sitePollMs;
      r.a.runPass(t);
      assert.strictEqual(chainOf(r).stage_state, "SITE_ACTIVE");
      const stage1Region = c.stage_region_id;
      r.wins.set(`lne:${req.eventId}:0`, winOf(H.C1, "o-own"));
      r.emit(H.hackWin({ own: true, lneEventId: req.eventId }));
      r.a.runPass(t + 1);
      assert.strictEqual(chainOf(r).stage_state, "FOUND");
      assert.ok(r.lines.some((l) => l.text === "Archive fragment decoded. Details follow by mail."));
      r.a.runPass(t + 2);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_no, c.stage_state, c.stage_spawn_no, c.stage_relocations], [2, "REVEALED", 0, 0]);
      assert.notStrictEqual(c.stage_region_id, stage1Region);
      assert.deepStrictEqual(mails(r).map((m) => [m.event_key, m.kind]).slice(1), [
        [`arch:lore:${c.chain_id}:1`, "ARCH_LORE"], [`arch:hint:${c.chain_id}:2`, "ARCH_HINT"]]);
      const f = fragments(r);
      assert.deepStrictEqual([f.length, f[0].lore_source, f[0].delivered_at], [1, "template", t + 2]);
      assert.ok(f[0].lore_text.length <= 400 && f[0].hint_text.includes(`Sys-${c.stage_system_id}`));
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["hacks.ownWake"], st["stages.spawned"], st["stages.found"], st["lore.template"],
        st.errors], [1, 1, 1, 1, 0]);

      presence.where.set(H.C1, c.stage_system_id);
      t += 10;
      r.a.runPass(t);
      c = chainOf(r);
      assert.strictEqual(c.stage_state, "SITE_PENDING");
      const before = { system: c.stage_system_id };
      r.wins.set(`lne:${eventOf(c)}:0`, winOf(H.C2, "o-thief"));
      t += P.sitePollMs;
      r.a.runPass(t);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_no, c.stage_state, c.stage_relocations, c.stage_spawn_no], [2, "REVEALED", 1, 1]);
      assert.notStrictEqual(c.stage_system_id, before.system);
      assert.strictEqual(mails(r).at(-1).event_key, `arch:hint:${c.chain_id}:2:m1`);
      assert.deepStrictEqual(r.sites.calls.providers[0].build(`${c.chain_id}:s2:r0`, 0).containers, []);
      assert.strictEqual(r.sites.calls.providers[0].build(`${c.chain_id}:s2:r1`, 0).containers.length, 1);
      presence.where.set(H.C1, c.stage_system_id);
      t += 10;
      r.a.runPass(t);
      c = chainOf(r);
      r.wins.set(`lne:${eventOf(c)}:0`, winOf(H.C2, "o-thief-2"));
      t += P.sitePollMs;
      r.a.runPass(t);
      c = chainOf(r);
      assert.deepStrictEqual([c.state, c.end_reason], ["EXPIRED", "RELOCATIONS"]);
      assert.deepStrictEqual(r.sites.calls.cleanup.at(-1), [eventOf(c), "EVENT_END"]);
      assert.deepStrictEqual([r.a.getStatus().counters["stages.stolen"], r.a.getStatus().counters["stages.relocated"]],
        [2, 1]);
      r.a.stop();
    });

    H.withStore(driver, (opened) => {
      const conf = H.cfg({ EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MIN: "2", EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MAX: "2" });
      const P = conf.archaeology;
      const presence = fakePresence();
      const sites = fakeSites();
      const r = H.rig(opened, conf, { presence, sites });
      r.emit(H.hackWin());
      let t = H.T0;
      r.a.runPass(t);
      let c = chainOf(r);
      presence.where.set(H.C1, c.stage_system_id);
      sites.refuse = "SITES_FULL";
      t += P.presenceCheckMs;
      r.a.runPass(t);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_state, c.stage_spawn_no, c.next_check_at], ["REVEALED", 0, t + P.retryMs]);
      assert.strictEqual(r.a.getStatus().counters["sites.refused.SITES_FULL"], 1);
      sites.refuse = null;
      t += P.retryMs;
      r.a.runPass(t);
      c = chainOf(r);
      assert.strictEqual(c.stage_state, "SITE_PENDING");
      const r0 = eventOf(c);
      t = c.stage_due_at;
      r.a.runPass(t);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_state, c.stage_spawn_no], ["REVEALED", 1]);
      assert.deepStrictEqual(sites.calls.cleanup.at(-1), [r0, "EVENT_END"]);
      r.a.runPass(t + 1);
      c = chainOf(r);
      assert.deepStrictEqual([c.stage_state, eventOf(c)], ["SITE_PENDING", `${c.chain_id}:s1:r1`]);
      for (let n = 1; n <= 2; n += 1) {
        c = chainOf(r);
        if (n === 2) {
          presence.where.set(H.C1, c.stage_system_id);
          r.a.runPass(t + 10 * n);
          c = chainOf(r);
          assert.strictEqual(c.stage_state, "SITE_PENDING");
        }
        r.wins.set(`lne:${eventOf(c)}:0`, winOf(H.C1, `o-${n}`));
        r.emit(H.hackWin({ own: true, lneEventId: eventOf(c) }));
        r.a.runPass(t + 10 * n + 1);
        r.a.runPass(t + 10 * n + 2);
      }
      c = chainOf(r);
      assert.deepStrictEqual([c.state, c.end_reason, c.stage_no], ["COMPLETED", "COMPLETED", 2]);
      assert.deepStrictEqual(mails(r).slice(-2).map((m) => [m.event_key, m.kind]),
        [[`arch:lore:${c.chain_id}:2`, "ARCH_LORE"], [`arch:end:${c.chain_id}`, "ARCH_HINT"]]);
      const lore = fragments(r).map((x) => x.lore_text);
      assert.strictEqual(new Set(lore).size, 2, "no repeated lore within a chain");
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["stages.respawned"], st["chains.ended.COMPLETED"], st.errors], [1, 1, 0]);
      r.a.stop();
    });
  });

  test("A8 archaeology restart: a new service in SITE_ACTIVE (win in the stub) and in FOUND (delivered_at NULL) -> "
    + "one Local line, one ARCH_LORE, one stage 2", () => H.withStore(driver, (opened) => {
    const conf = H.cfg();
    const P = conf.archaeology;
    const presence = fakePresence();
    const sites = fakeSites();
    const wins = new Map();
    const shared = { presence, sites, wins };
    const r1 = H.rig(opened, conf, shared);
    r1.emit(H.hackWin());
    let t = H.T0;
    r1.a.runPass(t);
    let c = chainOf(r1);
    presence.where.set(H.C1, c.stage_system_id);
    t += P.presenceCheckMs;
    r1.a.runPass(t);
    sites.setState(eventOf(chainOf(r1)), "ACTIVE");
    t += P.sitePollMs;
    r1.a.runPass(t);
    c = chainOf(r1);
    assert.strictEqual(c.stage_state, "SITE_ACTIVE");
    wins.set(`lne:${eventOf(c)}:0`, winOf(H.C1, "o-own"));
    r1.a.stop();

    const r2 = H.rig(opened, conf, shared);
    t += P.sitePollMs;
    r2.a.runPass(t);
    assert.strictEqual(chainOf(r2).stage_state, "FOUND");
    assert.strictEqual(fragments(r2)[0].delivered_at, null);
    r2.a.stop();

    const r3 = H.rig(opened, conf, shared);
    r3.a.runPass(t + 1);
    r3.a.runPass(t + 2);
    r3.a.stop();
    const r4 = H.rig(opened, conf, shared);
    r4.a.runPass(t + 3);
    c = chainOf(r4);
    assert.deepStrictEqual([c.stage_no, c.stage_state], [2, "REVEALED"]);
    const lines = [...r1.lines, ...r2.lines, ...r3.lines, ...r4.lines]
      .filter((l) => l.text.startsWith("Archive fragment decoded"));
    assert.strictEqual(lines.length, 1, "one Local line");
    const m = mails(r4).map((x) => x.event_key);
    assert.deepStrictEqual(m.filter((k) => k.startsWith("arch:lore:")), [`arch:lore:${c.chain_id}:1`]);
    assert.deepStrictEqual(m.filter((k) => k === `arch:hint:${c.chain_id}:2`).length, 1);
    assert.strictEqual(fragments(r4).length, 1);
    r4.a.stop();
  }));

  test("A8 archaeology: FOUND with found_at = now - maxPlaceRetries x retryMs and no graph -> RESCHEDULE "
    + "now + retryMs, ACTIVE, no mail; the graph back -> stage 2 (one hint)", () => H.withStore(driver, (opened) => {
    const conf = H.cfg();
    const P = conf.archaeology;
    const presence = fakePresence();
    const sites = fakeSites();
    const wins = new Map();
    const shared = { presence, sites, wins };
    const r1 = H.rig(opened, conf, shared);
    r1.emit(H.hackWin());
    let t = H.T0;
    r1.a.runPass(t);
    presence.where.set(H.C1, chainOf(r1).stage_system_id);
    t += P.presenceCheckMs;
    r1.a.runPass(t);
    sites.setState(eventOf(chainOf(r1)), "ACTIVE");
    t += P.sitePollMs;
    r1.a.runPass(t);
    wins.set(`lne:${eventOf(chainOf(r1))}:0`, winOf(H.C1, "o-own"));
    t += P.sitePollMs;
    const r2 = H.rig(opened, conf, { ...shared, getGraph: () => null });
    r1.a.stop();
    r2.a.runPass(t);
    assert.strictEqual(chainOf(r2).stage_state, "FOUND");
    const foundAt = fragments(r2)[0].found_at;
    const mailsBefore = mails(r2).length;
    const late = foundAt + P.maxPlaceRetries * P.retryMs;
    r2.a.runPass(late);
    let c = chainOf(r2);
    assert.deepStrictEqual([c.state, c.stage_state, c.stage_no, c.next_check_at], ["ACTIVE", "FOUND", 1, late + P.retryMs]);
    assert.strictEqual(mails(r2).length, mailsBefore, "no mail while the graph is not ready");
    r2.a.stop();
    const r3 = H.rig(opened, conf, shared);
    r3.a.runPass(late + P.retryMs);
    c = chainOf(r3);
    assert.deepStrictEqual([c.state, c.stage_no, c.stage_state], ["ACTIVE", 2, "REVEALED"]);
    assert.strictEqual(mails(r3).filter((m) => m.event_key === `arch:hint:${c.chain_id}:2`).length, 1);
    assert.strictEqual(r3.a.getStatus().counters["stages.noPlace"], 0);
    r3.a.stop();
  }));
};
