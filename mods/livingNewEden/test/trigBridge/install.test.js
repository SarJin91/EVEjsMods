"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const install = require("../../lib/trigBridge/install");
const { startTrigBridge } = require("../../lib/trigBridge");
const { createInstallService } = require("../../lib/trigBridge/installService");
const A = require("../../lib/adapter/trigBridgeInstall");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStore } = require("../notices/storeHelper");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const LY = 9460730472580800;
const CORE = 341640;
const OZONE = 16273;
const CHAR = 90000001;
const CORP = 98000001;
const ALLIANCE = 99000001;
const SHIP = 7000;
const CFG = Object.freeze({ enabled: true, maxRangeLy: 50, fuelLyPermille: 20, jumpCooldownMs: 600000,
  maxPairsPerAlliance: 1, coreTypeId: CORE, requireRole: true, statusMail: true, debugCommand: true,
  presentationTypeId: 0, listMax: 2000 });

const textOf = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const clone = (x) => JSON.parse(JSON.stringify(x));

function vendor(opts = {}) {
  const o = { authority: { corporationID: CORP, isCEO: false, roles: 2048n }, vendorThrow: null, ...opts };
  const systems = new Map([[1, { solarSystemName: "Alpha", position: { x: 0, y: 0, z: 0 } }],
    [2, { solarSystemName: "Beta", position: { x: 40 * LY, y: 0, z: 0 } }],
    [3, { solarSystemName: "Gamma", position: { x: 70 * LY, y: 0, z: 0 } }]]);
  const rows = new Map();
  const bridge = (id, sys, extra = {}) => rows.set(id, { structureID: id, solarSystemID: sys, typeID: 35841,
    ownerCorpID: CORP, allianceID: ALLIANCE, devFlags: {}, ...extra });
  bridge(101, 1);
  bridge(102, 2);
  bridge(103, 3);
  bridge(104, 1);
  rows.set(200, { structureID: 200, solarSystemID: 1, typeID: 35832, ownerCorpID: CORP, devFlags: {} });
  const items = new Map([[501, { itemID: 501, typeID: CORE, ownerID: CHAR, locationID: SHIP, flagID: 5, quantity: 1 }],
    [502, { itemID: 502, typeID: CORE, ownerID: CHAR, locationID: SHIP, flagID: 5, quantity: 1 }],
    [601, { itemID: 601, typeID: OZONE, ownerID: CHAR, locationID: SHIP, flagID: 5, quantity: 100 }]]);
  const receipts = new Set();
  const calls = { vendor: [], transfers: [], synced: 0, writes: 0, scenes: [] };
  class FakeDelivery {
    Handle_DropOffItems(args, session) {
      calls.vendor.push({ args, session, self: this });
      if (o.vendorThrow) throw o.vendorThrow;
      return args[0].filter((id) => items.get(id) && items.get(id).typeID === OZONE);
    }
  }
  const v = {
    deliveryClass: FakeDelivery,
    serviceHelpers: { unwrapMarshalValue: (x) => (x && x.type === "list" ? x.items : x) },
    itemStore: { findItemById: (id) => (items.has(id) ? clone(items.get(id)) : null), ITEM_FLAGS: { CARGO_HOLD: 5 } },
    itemCustody: {
      getCommittedReceipt: (key) => ({ success: true, committed: receipts.has(key) }),
      transfer: (cmd) => {
        calls.transfers.push(cmd);
        if (receipts.has(cmd.idempotencyKey)) return { success: true, duplicate: true, data: { changes: [] } };
        const item = items.get(cmd.items.itemID);
        if (!item) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
        items.delete(cmd.items.itemID);
        receipts.add(cmd.idempotencyKey);
        return { success: true, durable: true, data: { changes: [{ item: { ...item, locationID: 0 }, previousData: item }] } };
      },
      custodyRef: { ownerLocation: (ownerID, locationID, flagID) => ({ kind: "owner-location", ownerID, locationID,
        flagID }), void: () => ({ kind: "void" }) },
      CUSTODY_REASON: { ESS_KEY_CONSUME: "ess-key-consume" },
    },
    characterState: { syncInventoryItemForSession: () => { calls.synced += 1; } },
    structureState: {
      getStructureByID: (id) => rows.get(id) || null,
      listStructures: () => [...rows.values()].map(clone),
      updateStructureRecord: (id, fn) => {
        const cur = rows.get(id);
        if (!cur) return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
        calls.writes += 1;
        rows.set(id, fn(clone(cur)) || cur);
        return { success: true };
      },
    },
    runtime: { isSolarSystemSceneLoaded: (id) => id === 1, syncStructureSceneState: (id) => calls.scenes.push(id) },
    worldData: { getSolarSystemByID: (id) => systems.get(id) || null },
    corpAuth: { getPersistedCorporationAuthority: () => o.authority,
      corporationAuthorityHasRole: (a, mask) => (a.roles & mask) === mask },
    itemTypes: { resolveItemByTypeID: (t) => (t === CORE ? { groupID: 4000, name: "Core" } : null) },
    throwUserError: (name, values) => {
      throw Object.assign(new Error(`${name}: ${values && values.notify}`), { userError: name, values });
    },
  };
  return { o, v, rows, items, receipts, calls, FakeDelivery };
}

function fakeAdapter(f, extra = {}) {
  let hook = null;
  const mails = [];
  const chats = new Map();
  return { mails, chats, hookOf: () => hook, ...{
    installTrigBridgeJumpScope: () => ({ ok: true }), uninstallTrigBridgeJumpScope: () => ({ ok: true }),
    installTrigBridgeDepositHook: (opts) => {
      hook = A.createDepositHook({ ...f.v, ...opts });
      return hook.install();
    },
    uninstallTrigBridgeDepositHook: () => { if (hook) hook.uninstall(); return { ok: true }; },
    listTrigBridges: (o) => A.listTrigBridgesFrom(f.v, o),
    writeTrigBridgeMarker: (id, m) => A.writeMarkerFrom(f.v, id, m),
    writeTrigBridgeDestination: (id, s) => A.writeDestinationFrom(f.v, id, s),
    syncTrigBridgeScene: (s) => A.syncSceneFrom(f.v, s),
    trigBridgeDistanceLy: (a, b) => A.distanceLyFrom(f.v, a, b),
    trigBridgeCoreType: (t) => A.coreTypeFrom(f.v, t),
    defaultMailSender: () => ({ ok: true, senderId: 1 }),
    sendPlayerMail: (spec) => { mails.push(spec); return { ok: true, messageId: mails.length }; },
    installChatCommand: (c) => { chats.set(c.name, c); return { ok: true }; },
    uninstallChatCommand: (n) => { chats.delete(n); return { ok: true }; },
    ...extra } };
}

function fakePersistence() {
  const keys = new Set();
  return { keys, ok: true, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
    journal: { applyOnce: (_tx, spec, fn) => {
      if (keys.has(spec.key)) return { ok: true, duplicate: true };
      keys.add(spec.key);
      return { ok: true, duplicate: false, value: fn() };
    } } };
}

const SESSION = Object.freeze({ characterID: CHAR, corporationID: CORP, _space: { shipID: SHIP, systemID: 1 } });

function boot(f, opts = {}) {
  const adapter = fakeAdapter(f, opts.adapter);
  const lines = [];
  const clock = { t: 1700000000000, now() { return this.t; } };
  const persistence = opts.persistence === undefined ? fakePersistence() : opts.persistence;
  const r = startTrigBridge({ config: { trigBridge: { ...CFG, ...(opts.cfg || {}) } }, adapter, clock,
    logger: { log: (l) => lines.push(l) }, persistence });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { r, adapter, lines, clock, persistence, mgr: new f.FakeDelivery() };
}

const counters = (b) => b.r.trigBridge.getStatus().counters;

module.exports = ({ test, skip }) => {
  test("TC1 decideInstall: marker, alliance, owner, role, pair limit, same system, range; choosePartner oldest free", () => {
    const st = (extra = {}) => ({ structureId: 101, systemId: 1, typeId: 35841, ownerCorpId: CORP, allianceId: ALLIANCE,
      devFlags: {}, ...extra });
    const free = (id, sys, at, linked = false) => ({ structureId: id, systemId: sys, installedAt: at, linked });
    const base = { structure: st(), hasRole: true, sameCorp: true, allianceId: ALLIANCE, markedOfAlliance: [],
      lyOf: () => 40, cfg: CFG };
    const why = (patch) => install.decideInstall({ ...base, ...patch });
    assert.deepStrictEqual(why({}), { ok: true, partner: null });
    assert.strictEqual(why({ structure: st({ typeId: 35832 }) }).reason, "NOT_ANSIBLEX");
    assert.strictEqual(why({ structure: st({ devFlags: { lneTrigBridge: { v: 1 } } }) }).reason, "ALREADY_INSTALLED");
    assert.strictEqual(why({ allianceId: null }).reason, "NO_ALLIANCE");
    assert.strictEqual(why({ sameCorp: false }).reason, "NOT_OWNER");
    assert.strictEqual(why({ hasRole: false }).reason, "NO_ROLE");
    assert.strictEqual(why({ hasRole: false, cfg: { ...CFG, requireRole: false } }).ok, true, "requireRole off");
    assert.strictEqual(why({ markedOfAlliance: [free(102, 2, 5, true), free(103, 3, 6, true)] }).reason, "PAIR_LIMIT");
    assert.strictEqual(why({ markedOfAlliance: [free(104, 1, 5)] }).reason, "SAME_SYSTEM");
    const far = why({ markedOfAlliance: [free(103, 3, 5)], lyOf: () => 70 });
    assert.deepStrictEqual([far.reason, far.detail], ["PARTNER_TOO_FAR", "70.00 LY > 50 LY"]);
    assert.deepStrictEqual(why({ markedOfAlliance: [free(102, 2, 9)] }), { ok: true,
      partner: { structureId: 102, systemId: 2 } });
    assert.strictEqual(install.choosePartner([free(9, 2, 7), free(5, 2, 7), free(3, 2, 1, true)]).structureId, 5,
      "oldest free, then structureId; a linked one is never chosen");
    assert.strictEqual(install.choosePartner([free(3, 2, 1, true)]), null);
    assert.ok(/stays in your cargo hold/.test(install.installRefusalText("NO_ROLE")));
    assert.deepStrictEqual(install.parseDiagCommand("!trigbridge status"), { cmd: "status" });
    assert.deepStrictEqual(install.parseDiagCommand("!TrigBridge"), { cmd: "usage" });
    assert.strictEqual(install.parseDiagCommand("!trigbridges"), null);
    const m = install.mailBodyOf("LINKED", { structure: { structureId: 101, systemId: 1, systemName: "Alpha" },
      partner: { structureId: 102, systemId: 2, systemName: "Beta" }, realLy: 40, fuelLyPermille: 20 });
    assert.strictEqual(m.title, "Triglavian conduit linked");
    for (const part of ["Alpha (1)", "Beta (2)", "40.00 LY", "0.80 LY", "frigate (1.2e6 kg): 53",
      "battleship (1e8 kg): 290", "freighter (1e9 kg): 2450", "titan (1.48e9 kg): 3602"]) {
      assert.ok(m.body.includes(part), `${part} in ${m.body}`);
    }
  });

  test("TC2 Cargo Deposit wrap: core + ozone -> vendor gets the ozone first; refusal = CustomNotify, core kept;"
    + " vendor throw = core kept; other structures pass; vendor facts", () => {
    const f = vendor();
    const b = boot(f);
    const args = [[601, 501], SHIP, 101];
    const moved = b.mgr.Handle_DropOffItems(args, SESSION);
    assert.deepStrictEqual(f.calls.vendor[0].args, [[601], SHIP, 101], "the vendor gets the rest only");
    assert.strictEqual(f.calls.vendor[0].self, b.mgr);
    assert.deepStrictEqual(moved, [601, 501], "vendor movedItemIDs + the consumed core");
    assert.deepStrictEqual(f.calls.transfers.map((t) => [t.items, t.from, t.to.kind, t.reason, t.idempotencyKey]),
      [[{ itemID: 501, quantity: 1 }, { kind: "owner-location", ownerID: CHAR, locationID: SHIP, flagID: 5 }, "void",
        "ess-key-consume", "lne:tbr:install:101"]]);
    assert.strictEqual(f.calls.synced, 1, "inventory of the session synced");
    assert.strictEqual(f.rows.get(101).devFlags.lneTrigBridge.installedBy, CHAR);
    assert.strictEqual(counters(b).installs, 1);

    const n = vendor({ authority: { corporationID: CORP, isCEO: false, roles: 0n } });
    const nb = boot(n);
    assert.throws(() => nb.mgr.Handle_DropOffItems([[502], SHIP, 101], SESSION),
      (e) => e.userError === "CustomNotify" && /Station Manager/.test(e.values.notify));
    assert.deepStrictEqual(n.calls.vendor.map((c) => c.args[0]), [[]], "the vendor access check ran first");
    assert.ok(n.items.has(502) && n.calls.transfers.length === 0 && !n.rows.get(101).devFlags.lneTrigBridge);
    assert.strictEqual(counters(nb).installRefused, 1);

    const boom = Object.assign(new Error("too far"), { userError: "CustomNotify" });
    const t = vendor({ vendorThrow: boom });
    const tb = boot(t);
    assert.throws(() => tb.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION), (e) => e === boom);
    assert.ok(t.items.has(501) && t.calls.transfers.length === 0);

    const p = vendor();
    const pb = boot(p);
    const same = [[501, 601], SHIP, 200];
    pb.mgr.Handle_DropOffItems(same, SESSION);
    pb.mgr.Handle_DropOffItems([[601], SHIP, 101], SESSION);
    assert.strictEqual(p.calls.vendor[0].args, same);
    assert.deepStrictEqual(p.calls.vendor[1].args, [[601], SHIP, 101]);
    assert.ok(p.items.has(501));
    pb.r.trigBridge.stop("test");
    assert.ok(!p.FakeDelivery.prototype.Handle_DropOffItems[A.HOOK_MARKER]);

    const cargo = textOf("services/structure/structureCargoDeliveryService.js");
    const handler = cargo.slice(cargo.indexOf("  Handle_DropOffItems(args, session) {"));
    const order = ["const access = validateCargoDepositAccess(session, shipID, structure);",
      "!isAllowedFlexFuelType(item.typeID, structure.typeID)", "if (legs.length <= 0) {\n      return [];",
      "return deliveryResult.movedItemIDs;"].map((s) => (s.startsWith("!") ? cargo.indexOf(s) : handler.indexOf(s)));
    assert.ok(order.every((i) => i >= 0), `handler facts ${order}`);
    assert.ok(!/async\s+Handle_DropOffItems/.test(cargo), "synchronous handler");
    assert.ok(cargo.includes("const TYPE_LIQUID_OZONE = 16273;") && cargo.includes("const GROUP_FUEL_BLOCK = 1136;"));
    assert.ok(/^module\.exports = StructureCargoDeliveryService;$/m.test(cargo));
    assert.ok(textOf("services/sovereignty/sovPlayerDeployment.js").includes("const CORP_ROLE_STATION_MANAGER = 2048n;"));
    assert.strictEqual(A.CORP_ROLE_STATION_MANAGER, 2048n);
    const custody = textOf("services/inventory/itemCustody.js");
    assert.ok(custody.includes("if (reason === CUSTODY_REASON.ESS_KEY_CONSUME) return route === \"local-remove\";"));
    assert.ok(custody.includes("  ownerLocation(ownerID, locationID, flagID = defaultItemStore.ITEM_FLAGS.HANGAR) {"));
    assert.ok(textOf("services/structure/structureJumpBridgeMgrService.js")
      .includes("if (settlement.sourceStructureID !== structureID) {"));
  });

  test("TC3 install idempotent: receipt ALREADY_COMMITTED -> no second void, marker written, core kept", () => {
    const f = vendor();
    f.receipts.add("lne:tbr:install:101");
    const b = boot(f);
    const moved = b.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION);
    assert.deepStrictEqual(moved, [], "the core is not reported as moved");
    assert.strictEqual(f.calls.transfers.length, 0, "no second void");
    assert.ok(f.items.has(501), "the core stays in the hold");
    assert.strictEqual(f.rows.get(101).devFlags.lneTrigBridge.v, 1, "marker written");
    assert.deepStrictEqual([counters(b).installDuplicate, counters(b).installs], [1, 1]);
    assert.throws(() => b.mgr.Handle_DropOffItems([[502], SHIP, 101], SESSION),
      (e) => /already carries/.test(e.values.notify));
    assert.ok(f.items.has(502));
    const g = vendor();
    const gb = boot(g);
    assert.deepStrictEqual(gb.mgr.Handle_DropOffItems([[501, 502], SHIP, 102], SESSION), [501]);
    assert.ok(!g.items.has(501) && g.items.has(502));
  });

  test("TC4 pairing: second bridge of the alliance links both; partial pair completed by the start repair", () => {
    const f = vendor();
    const b = boot(f);
    b.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION);
    b.clock.t += 1000;
    b.mgr.Handle_DropOffItems([[502], SHIP, 102], SESSION);
    const dest = (id) => f.rows.get(id).devFlags.destinationSolarsystemID;
    assert.deepStrictEqual([dest(101), dest(102)], [2, 1], "both ends point at each other");
    assert.strictEqual(f.rows.get(101).devFlags.sovereigntyJumpBridgeDestinationSolarsystemID, 2);
    assert.ok(f.calls.scenes.includes(1), "the loaded scene synced");
    assert.strictEqual(counters(b).links, 1);
    f.items.set(503, { itemID: 503, typeID: CORE, ownerID: CHAR, locationID: SHIP, flagID: 5, quantity: 1 });
    assert.throws(() => b.mgr.Handle_DropOffItems([[503], SHIP, 103], SESSION),
      (e) => /conduit pairs/.test(e.values.notify));
    assert.ok(f.items.has(503));

    const p = vendor();
    const mark = (id, at) => ({ v: 1, installedAt: at, installedBy: CHAR, coreTypeId: CORE });
    p.rows.get(101).devFlags = { lneTrigBridge: mark(101, 1), destinationSolarsystemID: 2,
      sovereigntyJumpBridgeDestinationSolarsystemID: 2 };
    p.rows.get(102).devFlags = { lneTrigBridge: mark(102, 2) };
    const pb = boot(p);
    assert.strictEqual(p.rows.get(102).devFlags.destinationSolarsystemID, 1);
    assert.strictEqual(counters(pb).linkPartial, 1);
    assert.ok(pb.lines.some((l) => l === "trigBridge: install on coreTypeId=341640 repair alliances=1 linkPartial=1"
      + " links=0"), pb.lines.join("\n"));
    const writes = p.calls.writes;
    const again = createInstallService({ cfg: CFG, adapter: pb.adapter, clock: pb.clock, bump: () => {}, log: () => {} });
    assert.deepStrictEqual(again.repair(), { alliances: 1, partial: 0, linked: 0, truncated: false });
    assert.strictEqual(p.calls.writes, writes);
    const chat = pb.adapter.chats.get("trigbridge");
    assert.ok(chat && chat.match("!trigbridge status"));
    const reply = chat.handle(null, "!trigbridge status", { transport: "xmpp", gm: true });
    assert.ok(reply.startsWith("trigBridge: 2 marked, 2 linked") && reply.includes("101@Alpha"), reply);
    for (const ctx of [{ transport: "xmpp", gm: false }, undefined]) {
      assert.strictEqual(chat.handle(null, "!trigbridge status", ctx), "Only GM accounts can use !trigbridge.");
    }
    assert.strictEqual(p.calls.writes, writes, "diagnostics write nothing");
  });

  test("TC6: two free bridges out of range, a new one in range of the oldest -> decideInstall"
    + " and settleAlliance pair the same bridges, no stop at the first bad pair, the repair writes nothing again", () => {
    const f = vendor();
    const mark = (at) => ({ v: 1, installedAt: at, installedBy: CHAR, coreTypeId: CORE });
    f.rows.get(103).devFlags = { lneTrigBridge: mark(1), destinationSolarsystemID: 9 };
    f.rows.get(101).devFlags = { lneTrigBridge: mark(2), destinationSolarsystemID: 9 };
    const b = boot(f, { cfg: { maxPairsPerAlliance: 2 } });
    assert.ok(b.lines.some((l) => l.endsWith("free bridges without a partner in range: 103,101")), b.lines.join("\n"));
    const writes0 = f.calls.writes;
    const marked = install.markedViewOf(A.listTrigBridgesFrom(f.v, { allianceId: ALLIANCE, max: 100 }).rows);
    const d = install.decideInstall({ structure: A.summaryOf(f.rows.get(102), () => ""), hasRole: true, sameCorp: true,
      allianceId: ALLIANCE, markedOfAlliance: marked, lyOf: (x, y) => A.distanceLyFrom(f.v, x, y),
      cfg: { ...CFG, maxPairsPerAlliance: 2 } });
    assert.deepStrictEqual(d, { ok: true, partner: { structureId: 103, systemId: 3 } });
    b.mgr.Handle_DropOffItems([[501], SHIP, 102], SESSION);
    const dest = (id) => f.rows.get(id).devFlags.destinationSolarsystemID;
    assert.deepStrictEqual([dest(102), dest(103), dest(101)], [3, 2, 9], "the new bridge linked with the oldest free");
    assert.strictEqual(counters(b).links, 1);
    const writes = f.calls.writes;
    assert.ok(writes > writes0);
    const again = createInstallService({ cfg: { ...CFG, maxPairsPerAlliance: 2 }, adapter: b.adapter, clock: b.clock,
      bump: () => {}, log: () => {} });
    assert.deepStrictEqual(again.repair(), { alliances: 1, partial: 0, linked: 0, truncated: false });
    assert.strictEqual(f.calls.writes, writes);
    const m = (id, sys, at) => ({ structureId: id, systemId: sys, installedAt: at, linked: false });
    const ly = (x, y) => (x === 1 || y === 1 ? 99 : 10);
    const plan = install.planPairs([m(1, 1, 1), m(2, 2, 2), m(3, 3, 3)], ly, 50);
    assert.deepStrictEqual([plan.pairs.map((p) => p.map((q) => q.structureId)), plan.unpaired.map((q) => q.structureId)],
      [[[2, 3]], [1]]);
  });

  test("TC7 LOWs: truncated list = refusal before the void, one `now` for decision and marker"
    + " LINKED for an existing vendor pair, INSTALLED names the partner", () => {
    const t = vendor();
    const tb = boot(t, { cfg: { listMax: 2 } });
    assert.throws(() => tb.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION),
      (e) => /could not be installed now/.test(e.values.notify));
    assert.ok(t.items.has(501) && t.calls.transfers.length === 0 && !t.rows.get(101).devFlags.lneTrigBridge);
    assert.ok(tb.lines.some((l) => l.includes("Ansiblex list truncated at listMax=2")), tb.lines.join("\n"));

    const m = (id, sys, at) => ({ structureId: id, systemId: sys, installedAt: at, linked: false });
    const ly = (a, b) => ((a === 1 && b === 2) || (a === 2 && b === 1) ? 99 : 10);
    const q = { structure: { structureId: 9, systemId: 1, typeId: 35841, devFlags: {} }, hasRole: true, sameCorp: true,
      allianceId: ALLIANCE, markedOfAlliance: [m(10, 2, 10), m(20, 3, 20)], lyOf: ly,
      cfg: { ...CFG, maxPairsPerAlliance: 2 } };
    assert.deepStrictEqual(install.decideInstall(q), { ok: true, partner: null }, "self newest: X-Y pair");
    assert.deepStrictEqual(install.decideInstall({ ...q, now: 5 }),
      { ok: true, partner: { structureId: 20, systemId: 3 } }, "self oldest: self-Y");
    const n = vendor();
    const nb = boot(n);
    nb.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION);
    assert.strictEqual(n.rows.get(101).devFlags.lneTrigBridge.installedAt, nb.clock.t);

    const p = vendor();
    p.rows.get(101).devFlags = { destinationSolarsystemID: 2, sovereigntyJumpBridgeDestinationSolarsystemID: 2 };
    p.rows.get(102).devFlags = { lneTrigBridge: { v: 1, installedAt: 1, installedBy: CHAR + 1, coreTypeId: CORE },
      destinationSolarsystemID: 1, sovereigntyJumpBridgeDestinationSolarsystemID: 1 };
    const pb = boot(p);
    const writes = p.calls.writes;
    pb.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION);
    assert.strictEqual(p.calls.writes, writes + 1, "the marker only");
    assert.strictEqual(counters(pb).links, 1);
    assert.deepStrictEqual(pb.adapter.mails.map((x) => `${x.toCharacterId}:${x.title}`), [
      `${CHAR}:Triglavian conduit installed`, `${CHAR}:Triglavian conduit linked`,
      `${CHAR + 1}:Triglavian conduit linked`]);
    const body = pb.adapter.mails[0].body;
    assert.ok(body.includes("links now with the Triglavian bridge in Beta (2)") && !body.includes("second core"), body);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("TC5 status mail at most once (journal key)", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("TC5 status mail at most once: the journal key tbr:mail:* before sendMail, a repeat sends nothing", () => {
    withStore(driver, (opened) => {
      const journal = createJournal({ clock: { now: () => 1700000000000 }, maxPayloadBytes: 4096, maxRows: 500 });
      const persistence = { ok: true, store: opened.store, journal };
      const f = vendor();
      const b = boot(f, { persistence });
      b.mgr.Handle_DropOffItems([[501], SHIP, 101], SESSION);
      b.mgr.Handle_DropOffItems([[502], SHIP, 102], SESSION);
      const titles = b.adapter.mails.map((m) => `${m.toCharacterId}:${m.title}`);
      assert.deepStrictEqual(titles, [`${CHAR}:Triglavian conduit installed`, `${CHAR}:Triglavian conduit installed`,
        `${CHAR}:Triglavian conduit linked`, `${CHAR}:Triglavian conduit linked`]);
      assert.ok(/^\d+$/.test(b.adapter.mails[0].sentDate) && b.adapter.mails[0].senderId === 1);
      const svc = createInstallService({ cfg: CFG, adapter: b.adapter, clock: b.clock, bump: () => {}, log: () => {},
        mailer: { store: opened.store, journal, senderId: 1 } });
      f.rows.get(102).devFlags = { ...f.rows.get(102).devFlags, destinationSolarsystemID: 3,
        sovereigntyJumpBridgeDestinationSolarsystemID: 3 };
      svc.repair();
      assert.strictEqual(f.rows.get(102).devFlags.destinationSolarsystemID, 1, "relinked");
      assert.strictEqual(b.adapter.mails.length, 4, "LINKED keys already in the journal");
      const keys = opened.store.transaction("t", (tx) => ["tbr:mail:101:INSTALLED:0", "tbr:mail:101:LINKED:102",
        "tbr:mail:102:LINKED:101"].map((k) => journal.findByKey(tx, k).found)).value;
      assert.deepStrictEqual(keys, [true, true, true]);
      const off = vendor();
      const ob = boot(off, { cfg: { statusMail: false }, persistence });
      ob.mgr.Handle_DropOffItems([[501], SHIP, 103], SESSION);
      assert.strictEqual(ob.adapter.mails.length, 0);
      const nj = boot(vendor(), { persistence: null });
      assert.ok(nj.lines.some((l) => l.startsWith("trigBridge: W133")), nj.lines.join("\n"));
    });
  });
};
