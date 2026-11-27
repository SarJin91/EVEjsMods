"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { resolveConfig } = require("../../config");
const clientHook = require("../../clientHook");
const H = require("../../lib/adapter/clientHandshakeHook");
const { buildPayload, createClientDelivery, MAX_SIGNED_FUNC_BYTES } = require("../../lib/adapter/clientDelivery");
const { registerClientServiceWith, callerOf } = require("../../lib/adapter/clientService");
const { buildSnapshot } = require("../../lib/jobBoard/readModel");
const { toWireV1 } = require("../../lib/jobBoard/wire");
const { startJobBoard, createUnavailableJobBoard, FACADE_METHODS } = require("../../lib/jobBoard");
const warContracts = require("../../lib/warContracts");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(MOD_DIR, "..", "..");
const SRC = path.join(ROOT, "server", "src");
const HANDSHAKE_FILE = path.join(ROOT, ...H.HANDSHAKE_REL);
const SHIP_WING_HOOK = path.join(ROOT, "mods", "shipWing", "lib", "adapter", "handshakeHook.js");
const ENTRYPOINT = path.join(ROOT, "docker", "entrypoint.sh");
const BOARD_PY = path.join(MOD_DIR, "client", "board.py");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const JITA = 30000142;
const PERIMETER = 30000144;
const AMARR = 30002187;
const CHAR = 90000001;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_JOB_BOARD_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

function host() {
  const calls = [];
  const base = function baseCompile() {
    calls.push(Array.prototype.slice.call(arguments));
    return "compiled";
  };
  return { calls, base, moduleApi: { _cache: {}, prototype: { _compile: base } } };
}

function marshaled(text) {
  const data = Buffer.from(text, "ascii");
  const header = Buffer.alloc(5);
  header[0] = 0x74;
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

function job(over) {
  return { jobId: "fj:1:0", kind: "KILL", state: "OPEN", systemId: JITA, targetCount: 5, iskAmount: 2000000,
    lpAmount: 0, completions: 1, maxCompletions: 10, description: "Kill pirates", expiresAt: AT + 3600000,
    myProgress: 0, myState: null, ...over };
}

function war(over) {
  return { offerId: "to_1", factionId: 500001, systemId: JITA, quantity: 4, typeId: 621, lpAmount: 1500,
    iskAmount: 0, standingMicro: 10000, description: "Living New Eden: war contract 4x Caracal for Caldari State",
    contractId: 0, offerExpiresAt: AT + 7200000, ...over };
}

const JUMPS = new Map([[JITA, 0], [PERIMETER, 1], [AMARR, 9]]);
const NAMES = { system: (id) => ({ [JITA]: "Jita", [PERIMETER]: "Perimeter", [AMARR]: "Amarr" })[id] || null,
  faction: () => "Caldari State" };

function fakeAdapter(over = {}) {
  const calls = { register: [], chat: [], notify: [], ready: [] };
  const adapter = {
    calls,
    handlers: null,
    boardHookState: () => ({ status: "WRAPPED" }),
    publishBoardDelivery: () => ({ ok: true, bytes: 1234, delivery: { setReady: (f) => calls.ready.push(f),
      stats: () => ({ ready: true, composed: 0, skipped: 0 }) } }),
    withdrawBoardDelivery: () => ({ ok: true }),
    registerClientService(world, spec) {
      calls.register.push(spec.name);
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {} };
    },
    sendClientNotification(characterId, type, payload) {
      calls.notify.push([characterId, type, payload]);
      return { ok: true };
    },
    installChatCommand(opts) {
      calls.chat.push(opts);
      return { ok: true };
    },
    uninstallChatCommand: () => ({ ok: true }),
    readFactionNames: () => ({ ok: true, names: new Map([[500001, "Caldari State"]]) }),
    ...over,
  };
  return adapter;
}

function fakeCtx(over = {}) {
  const graph = { getSystem: (id) => ({ [JITA]: { name: "Jita" }, [PERIMETER]: { name: "Perimeter" } })[id] || null,
    getNeighbors: (id) => (id === JITA ? [PERIMETER] : id === PERIMETER ? [JITA] : []) };
  return { graph: { getGraph: () => ({ ok: true, graph }) }, governor: { admits: () => true },
    frontJobs: { listBoard: () => ({ ok: true, day: 1, jobs: [job({ systemId: PERIMETER })] }) },
    warContracts: { listForBoard: () => ({ ok: true, rows: [war({ contractId: 77 })] }) }, ...over };
}

module.exports = ({ test, skip }) => {
  const haveTree = fs.existsSync(HANDSHAKE_FILE) && fs.existsSync(path.join(SRC, "services", "baseService.js"));

  if (!haveTree) skip("JB1 vendor facts", `no EveJS server tree under ${ROOT}`);
  else {
    test("JB1 vendor facts: handshake hash + seams, BaseService Handle_, register/lookup, sendNotification, "
      + "entrypoint order", () => {
      const read = (...rel) => fs.readFileSync(path.join(SRC, ...rel), "utf8").replace(/\r\n/g, "\n");
      const handshake = fs.readFileSync(HANDSHAKE_FILE, "utf8");
      const hashes = H.parseHashList(configOf().config.jobBoard.handshakeHashes);
      assert.ok(hashes.includes(H.sha256(handshake)), `default jobBoard.handshakeHashes misses ${H.sha256(handshake)}`);
      assert.ok(handshake.includes(H.SEAM_FUNCTION) && handshake.includes(H.SEAM_CALL), "signedFunc seams");
      assert.ok(read("services", "baseService.js").includes("Handle_${"), "BaseService Handle_${");
      const manager = read("services", "serviceManager.js");
      assert.ok(manager.includes("  register(service) {") && manager.includes("  lookup(name"), "register / lookup");
      assert.ok(read("network", "clientSession.js").includes("sendNotification(notifyType, idType, payloadTuple"),
        "sendNotification");
      const blocks = fs.readFileSync(ENTRYPOINT, "utf8").split("exec node").slice(1);
      assert.strictEqual(blocks.length, 2, "two node blocks");
      for (const block of blocks) {
        const at = (mod) => block.indexOf(`--require /app/mods/${mod}`);
        assert.ok(at("livingNewEden/clientHook.js") >= 0, "clientHook line");
        assert.ok(at("livingNewEden/clientHook.js") < at("shipWing/loader.js"), "clientHook before shipWing");
        assert.ok(at("livingNewEden/clientHook.js") < at("moonOreAnomalies/loader.js"), "clientHook before moon");
      }
    });
  }

  if (!haveTree || !fs.existsSync(SHIP_WING_HOOK)) skip("JB2 composition", "no handshake.js or shipWing hook");
  else {
    test("JB2 composition: LNE first + real shipWing -> baseline + shipWing TAIL + LNE TAIL, both WRAPPED; off and "
      + "NO_INSTALL leave _compile untouched", () => {
      const baseline = fs.readFileSync(HANDSHAKE_FILE, "utf8");
      const sw = require("../../../shipWing/lib/adapter/handshakeHook");
      const h = host();
      const globalObj = {};
      const lines = [];
      const logger = { log: (m) => lines.push(m) };
      const lne = clientHook.install({ moduleApi: h.moduleApi, globalObj, env: {}, isMainThread: true,
        loadConfig: () => configOf(), root: ROOT, logger });
      assert.strictEqual(lne.ok, true, JSON.stringify(lne));
      assert.strictEqual(globalObj[H.HOOK_STATE_KEY], lne.hook, "state published");
      const ship = sw.installHandshakeHook({ moduleApi: h.moduleApi, globalObj, root: ROOT,
        readFile: (f) => fs.readFileSync(f, "utf8"), hashes: [sw.sha256(baseline)],
        delivery: { compose: (o) => o }, logger });
      assert.strictEqual(ship.ok, true, JSON.stringify(ship));
      assert.strictEqual(h.moduleApi.prototype._compile.call({}, baseline, HANDSHAKE_FILE, "third"), "compiled");
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual(h.calls[0][0], baseline + sw.TAIL + H.TAIL, "order of the tails");
      assert.strictEqual(h.calls[0][2], "third", "every argument goes on");
      assert.deepStrictEqual([ship.state.status, lne.hook.state.status], ["WRAPPED", "WRAPPED"]);
      assert.ok(lines.includes(`LNE_BOARD_UI:WRAPPER_READY tail=${Buffer.byteLength(sw.TAIL)}`), lines.join("|"));
      vm.compileFunction(h.calls[0][0], ["exports", "require", "module", "__filename", "__dirname"]);
      const forwarded = vm.runInNewContext(`let buildTidiSignedFunc = function (id, options) { return [id, options]; };${
        H.TAIL}\nbuildTidiSignedFunc(7, { accountRole: 3 });`, {});
      assert.deepStrictEqual(JSON.parse(JSON.stringify(forwarded)), [7, { accountRole: 3 }], "TAIL forwards the options");
      assert.strictEqual(clientHook.install({ moduleApi: h.moduleApi, globalObj, env: {}, isMainThread: true,
        loadConfig: () => configOf(), root: ROOT }).reason, "already_installed");
      const late = host();
      const refused = H.installBoardHandshakeHook({ moduleApi: late.moduleApi,
        globalObj: { [H.DCB_KEY]: {} }, root: ROOT, readFile: () => baseline, hashes: [H.sha256(baseline)] });
      assert.deepStrictEqual([refused.ok, refused.reason], [false, "LOAD_ORDER"]);
      assert.strictEqual(late.moduleApi.prototype._compile, late.base);
      for (const deps of [{ env: {}, loadConfig: () => resolveConfig({ modDir: MOD_DIR, env: {} }) },
        { env: { EVEJS_LNE_NO_INSTALL: "1" }, loadConfig: () => configOf() }]) {
        const off = host();
        const g = {};
        const r = clientHook.install({ moduleApi: off.moduleApi, globalObj: g, isMainThread: true, root: ROOT, ...deps });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(off.moduleApi.prototype._compile, off.base, r.reason);
        assert.deepStrictEqual(Object.getOwnPropertySymbols(g), []);
      }
    });
  }

  const moonNames = path.join(ROOT, "mods", "moonOreAnomalies", "lib", "transientNames.js");
  const dcbExtend = path.join(ROOT, "mods", "droneClassBalance", "simulation", "delivery.js");
  if (!haveTree || !fs.existsSync(moonNames) || !fs.existsSync(dcbExtend)) {
    skip("JB2b call-site peers", "no handshake.js, moonOreAnomalies or droneClassBalance");
  } else {
    test("JB2b call-site peers: the login call wrapped by real Moon and DCB -> WRAPPED, our tail last and once; "
      + "an edited declaration -> CONFLICT", () => {
      const baseline = fs.readFileSync(HANDSHAKE_FILE, "utf8");
      const extend = require(dcbExtend).extendSource;
      const peerWrapped = (text) => {
        const h = host();
        const Module = require("node:module");
        const names = require(moonNames);
        require(path.join(SRC, "network", "protocolProfile.js"));
        const saved = Module.prototype._compile;
        const quiet = console.log;
        let moon = null;
        try {
          Module.prototype._compile = h.moduleApi.prototype._compile;
          console.log = () => {};
          moon = names.install(ROOT, path.dirname(path.dirname(moonNames)));
          assert.strictEqual(moon.active, true, moon.reason);
          Module.prototype._compile.call({}, text, HANDSHAKE_FILE);
        } finally {
          console.log = quiet;
          if (moon && typeof moon.restore === "function") moon.restore();
          Module.prototype._compile = saved;
          delete globalThis[H.MOON_KEY];
        }
        return extend(h.calls[0][0]);
      };
      const peers = peerWrapped(baseline);
      assert.ok(typeof peers === "string" && !peers.startsWith(baseline), "both peers wrap the call site");
      const run = (content) => {
        const h = host();
        const hook = H.installBoardHandshakeHook({ moduleApi: h.moduleApi, globalObj: {}, root: ROOT,
          readFile: () => baseline, hashes: [H.sha256(baseline)] });
        assert.strictEqual(hook.ok, true, JSON.stringify(hook));
        h.moduleApi.prototype._compile.call({}, content, HANDSHAKE_FILE);
        return { state: hook.state, out: h.calls[0][0] };
      };
      const ok = run(peers);
      assert.strictEqual(ok.state.status, "WRAPPED");
      assert.strictEqual(ok.out, peers + H.TAIL);
      assert.strictEqual(ok.state.tailBytes, Buffer.byteLength(peers) - Buffer.byteLength(baseline));
      vm.compileFunction(ok.out, ["exports", "require", "module", "__filename", "__dirname"]);
      const edited = peers.replace(H.SEAM_FUNCTION, "async function buildTidiSignedFunc(");
      const bad = run(edited);
      assert.strictEqual(bad.state.status, "CONFLICT");
      assert.strictEqual(bad.out, edited);
    });
  }

  test("JB3 delivery: header 0x74 + LE length + ASCII; board.py ASCII within the budget; not ready, too big, bad "
    + "header -> the same buffer", () => {
    const source = fs.readFileSync(BOARD_PY, "utf8");
    assert.ok(/^[\x00-\x7f]*$/.test(source), "client/board.py is ASCII");
    assert.ok(!source.includes("\t"), "spaces only");
    const budget = configOf().config.jobBoard.maxClientPayloadBytes;
    const payload = buildPayload(source, budget);
    assert.strictEqual(payload.ok, true, JSON.stringify(payload));
    assert.ok(payload.bytes <= budget, `${payload.bytes} > ${budget}`);
    assert.ok(payload.bytes <= budget / 2, `payload ${payload.bytes} > ${budget / 2}`);
    for (const key of ["'near' in data", "'front' in data", "'news' in data"]) assert.ok(source.includes(key), key);
    assert.strictEqual(buildPayload(source, 100).ok, false, "over a small budget");
    assert.strictEqual(buildPayload("x = 'é'\n", budget).ok, false, "not ASCII");
    const delivery = createClientDelivery({ encoded: payload.encoded });
    const original = marshaled("(0)");
    assert.strictEqual(delivery.compose(original), original, "not ready");
    delivery.setReady(true);
    const out = delivery.compose(original);
    assert.notStrictEqual(out, original);
    assert.strictEqual(out[0], 0x74);
    assert.strictEqual(out.readUInt32LE(1), out.length - 5);
    const text = out.toString("latin1", 5);
    assert.ok(/^[\x00-\x7f]*$/.test(text), "ASCII");
    assert.ok(text.startsWith("(lambda _lne_r: ") && text.endsWith("(0))"), text.slice(-20));
    const bad = Buffer.from(original);
    bad[0] = 0x75;
    assert.strictEqual(delivery.compose(bad), bad, "bad header");
    const big = marshaled(`(${"1".repeat(MAX_SIGNED_FUNC_BYTES)})`);
    assert.strictEqual(delivery.compose(big), big, "above 256 KB");
    assert.deepStrictEqual(delivery.stats(), { ready: true, composed: 1, skipped: 3 });
  });

  test("JB4 readModel: mine first, jumps (-1 last), limits + more, ASCII and length, one source refused", () => {
    const jobs = { ok: true, day: 1, jobs: [
      job({ jobId: "fj:a", systemId: AMARR }),
      job({ jobId: "fj:b", systemId: 30009999, myProgress: 7, myState: "DONE" }),
      job({ jobId: "fj:c", systemId: JITA, description: `Zażółć ${"x".repeat(200)}` }),
      job({ jobId: "fj:d", systemId: 30009999 }),
    ] };
    const input = { now: AT, viewer: { characterId: CHAR, systemId: JITA }, jobs,
      wars: { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" }, jumpsOf: (id) => JUMPS.get(id) ?? null, names: NAMES,
      limits: { maxJobRows: 3, maxWarRows: 5 } };
    const s = buildSnapshot(input);
    assert.deepStrictEqual(s.jobs.map((j) => [j.ref, j.jumps]), [["fj:b", -1], ["fj:c", 0], ["fj:a", 9]]);
    assert.deepStrictEqual(s.more, { jobs: 1, wars: 0 });
    assert.deepStrictEqual(s.refusals, ["warContracts:WAR_CONTRACTS_UNAVAILABLE"]);
    assert.deepStrictEqual(s.wars, []);
    assert.deepStrictEqual([s.jobs[0].mine, s.jobs[0].state, s.jobs[0].sysName], ["5/5 done", "DONE", "an unknown system"]);
    assert.strictEqual(s.jobs[1].title.length, 80);
    assert.ok(s.jobs[1].title.startsWith("Za???? xx"), s.jobs[1].title);
    assert.deepStrictEqual([s.jobs[2].reward, s.jobs[2].progress, s.jobs[2].endsIn], ["2,000,000 ISK", "1/10 done",
      3600]);
    const w = buildSnapshot({ ...input, jobs: { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" }, wars: { ok: true,
      rows: [war({ offerId: "to_9", systemId: AMARR }), war({ offerId: "to_2", contractId: 55 }),
        war({ offerId: "to_1", systemId: 30009999 })] }, limits: { maxJobRows: 3, maxWarRows: 2 } });
    assert.deepStrictEqual(w.refusals, ["frontJobs:FRONT_JOBS_UNAVAILABLE"]);
    assert.deepStrictEqual(w.wars.map((r) => [r.ref, r.jumps, r.contractId]), [["wc:to_2", 0, 55], ["wc:to_9", 9, 0]]);
    assert.deepStrictEqual([w.wars[0].title, w.wars[0].reward, w.wars[0].endsIn],
      ["4x Caracal for Caldari State", "+1,500 LP, +0.010 standing", 7200]);
    assert.deepStrictEqual(w.more, { jobs: 0, wars: 1 });
    const wire = toWireV1(w, { pollMs: 15000, travel: true, contracts: w.warsOk });
    assert.deepStrictEqual([wire.v, wire.at, wire.sys, wire.sysName, wire.ui], [1, AT / 1000, JITA, "Jita",
      { pollMs: 15000, travel: true, contracts: true, pins: false }]);
  });

  test("JB5 service and facade: NO_CHARACTER, RATE_LIMIT, BUSY, throwing source, lneBoardSvc class, !board, stub keys, "
    + "listForBoard, off", () => {
    let now = AT;
    const clock = { now: () => now };
    const adapter = fakeAdapter();
    const ctx = fakeCtx();
    const started = startJobBoard({ config: configOf().config, ctx, adapter, clock, world: {} });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    const jb = started.jobBoard;
    assert.deepStrictEqual(Object.keys(jb).sort(), [...FACADE_METHODS].sort());
    assert.deepStrictEqual(Object.keys(createUnavailableJobBoard("x")).sort(), [...FACADE_METHODS].sort());
    assert.deepStrictEqual(adapter.calls.ready, [true], "ready after the register");
    assert.deepStrictEqual(Object.keys(adapter.handlers), ["GetBoard", "Report", "Pin", "Unpin"], "handlers");
    const { GetBoard, Report } = adapter.handlers;
    assert.deepStrictEqual(GetBoard({ characterId: 0 }), { v: 1, ok: false, reason: "NO_CHARACTER" });
    const first = GetBoard({ characterId: CHAR, systemId: JITA });
    assert.strictEqual(first.v, 1);
    assert.deepStrictEqual(first.jobs.map((j) => [j.sysName, j.jumps]), [["Perimeter", 1]]);
    assert.deepStrictEqual(first.wars.map((w) => w.contractId), [77]);
    assert.deepStrictEqual(GetBoard({ characterId: CHAR, systemId: JITA }), { v: 1, ok: false, reason: "RATE_LIMIT" });
    now += 60000;
    ctx.governor = { admits: () => false };
    assert.deepStrictEqual(jb.readBoard(CHAR, JITA), { ok: false, reason: "BUSY" });
    now += 60000;
    ctx.governor = { admits: () => true };
    ctx.frontJobs = { listBoard: () => {
      throw new Error("boom");
    } };
    const thrown = jb.readBoard(CHAR, JITA);
    assert.deepStrictEqual([thrown.ok, thrown.reason], [false, "JOB_BOARD_UNAVAILABLE"]);
    assert.deepStrictEqual(Report({ characterId: CHAR, args: [1, 3396210, ["win=1", "info.ShowInfo=1"]] }), { ok: true });
    const chat = adapter.calls.chat.find((c) => c.name === "board");
    assert.ok(chat && chat.match("!tablica") && chat.match("!board"));
    assert.strictEqual(chat.handle({ characterId: CHAR, systemId: JITA }), "LNE board: opening window");
    assert.deepStrictEqual(adapter.calls.notify, [[CHAR, "OnLneBoardOpen", { v: 1 }]]);
    jb.stop("test");
    assert.deepStrictEqual(jb.readBoard(CHAR, JITA), { ok: false, reason: "JOB_BOARD_UNAVAILABLE" });
    const noHook = fakeAdapter({ boardHookState: () => ({ status: "ABSENT" }) });
    const nh = startJobBoard({ config: configOf().config, ctx: fakeCtx(), adapter: noHook, clock, world: {} });
    assert.deepStrictEqual(noHook.calls.ready, []);
    assert.strictEqual(noHook.calls.chat[0].handle({ characterId: CHAR }),
      "LNE board: window unavailable (hook:ABSENT), use !jobs / !war");
    nh.jobBoard.stop("test");

    class FakeBase {
      constructor(name) {
        this.name = name;
      }

      callMethod() {}
    }
    const services = new Map();
    const world = { serviceManager: { register: (s) => services.set(s.name, s), lookup: (n) => services.get(n) } };
    const reg = registerClientServiceWith(FakeBase, world, { name: "lneBoardSvc", handlers: {
      GetBoard: (req) => ({ v: 1, who: req.characterId, sys: req.systemId }),
      Report: () => {
        throw new Error("x");
      } } });
    assert.strictEqual(reg.ok, true, JSON.stringify(reg));
    const svc = services.get("lneBoardSvc");
    const handle = (method, args, session) => svc[`Handle_${method}`](args, session);
    assert.deepStrictEqual(handle("GetBoard", [], { charid: CHAR, solarsystemid2: JITA, stationid: 60003760 }),
      { type: "dict", entries: [["v", 1], ["who", CHAR], ["sys", JITA]] });
    assert.deepStrictEqual(handle("Report", [1], {}), { type: "dict", entries: [["ok", false], ["reason", "INTERNAL"]] });
    assert.deepStrictEqual(registerClientServiceWith(FakeBase, world, { name: "lneBoardSvc",
      handlers: { GetBoard: () => 1 } }).reason, "SERVICE_NAME_TAKEN");
    assert.strictEqual(callerOf({ characterID: 9, corporationID: 98000001, solarsystemid2: JITA }).corporationId,
      98000001);
    assert.strictEqual(callerOf({ characterID: 9 }).corporationId, 0);
    assert.strictEqual(callerOf({ charid: 9, corpid: -5 }).corporationId, 0);
    const corpReg = registerClientServiceWith(FakeBase, world, { name: "lneCorpProbeSvc",
      handlers: { Who: (req) => ({ corp: req.corporationId }) } });
    const corpSvc = services.get("lneCorpProbeSvc");
    assert.deepStrictEqual(corpSvc[`Handle_${"Who"}`]([], { charid: CHAR, corporationID: 98000001 }),
      { type: "dict", entries: [["corp", 98000001]] });
    corpReg.unregister();
    reg.unregister();
    assert.deepStrictEqual(handle("GetBoard", [], {}),
      { type: "dict", entries: [["ok", false], ["reason", "JOB_BOARD_UNAVAILABLE"]] });

    assert.ok(warContracts.FACADE_METHODS.includes("listForBoard"));
    assert.deepStrictEqual(Object.keys(warContracts.createUnavailableWarContracts("x")).sort(),
      [...warContracts.FACADE_METHODS].sort());

    const off = fakeAdapter();
    const r = startJobBoard({ config: resolveConfig({ modDir: MOD_DIR, env: {} }).config, ctx: fakeCtx(), adapter: off,
      clock, world: {} });
    assert.deepStrictEqual([r.ok, r.reason], [false, "disabled_by_config"]);
    assert.deepStrictEqual([off.calls.register, off.calls.chat], [[], []]);

    const { loadDriver, withStore } = require("../notices/storeHelper");
    const driver = loadDriver();
    if (!driver.ok) return;
    withStore(driver, ({ store }) => {
      const run = (fn) => {
        const t = store.transaction("t", fn);
        assert.ok(t.ok, JSON.stringify(t));
        return t.value;
      };
      run((db) => db.prepare("INSERT INTO world_trade_budgets (faction_id, isk_available, isk_reserved, created_at, "
        + "updated_at, version) VALUES (500001, 1000000000, 0, ?, ?, 1)").run(AT, AT));
      run((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
        + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
        + "price_source, state, created_at, expires_at, updated_at, version, side, channel, contract_id) VALUES "
        + "('to_a', 500001, 'npc-1', ?, 1000162, 'hull', 'type:1', 621, 4, 1000, 50000000, 1000, 'bid', 'OPEN', ?, ?, "
        + "?, 1, 'buy', 'contract', 777)").run(JITA, AT, AT + 86400000, AT));
      const wc = warContracts.startWarContracts({ config: configOf({ EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1" }).config,
        ctx: { persistence: { ok: true, store } }, clock: { now: () => AT }, adapter: null,
        setTimer: () => ({ cancel() {}, hasRef: () => false }) }).warContracts;
      const listed = wc.listForBoard({});
      assert.strictEqual(listed.ok, true, JSON.stringify(listed));
      assert.deepStrictEqual(listed.rows.map((x) => [x.offerId, x.contractId, x.offerExpiresAt]),
        [["to_a", 777, AT + 86400000]]);
      wc.stop("test");
    });
  });

  test("JB6 Report: probe then `!board` item inside the window -> RATE_LIMIT + retryMs "
    + "reportSuppressed, the resent item gives its PROBE line after the window; distance memo entry budget", () => {
    let now = AT;
    const lines = [];
    const adapter = fakeAdapter();
    const cfg = configOf().config;
    const started = startJobBoard({ config: cfg, ctx: fakeCtx(), adapter, clock: { now: () => now }, world: {},
      logger: { log: (l) => lines.push(l) } });
    const jb = started.jobBoard;
    const { Report } = adapter.handlers;
    const probe = (items) => Report({ characterId: CHAR, args: [1, 3396210, items] });
    assert.deepStrictEqual(probe(["win=1"]), { ok: true });
    now += 5000;
    assert.deepStrictEqual(probe(["ui.win.eve=1"]),
      { ok: false, reason: "RATE_LIMIT", retryMs: cfg.jobBoard.reportMinIntervalMs - 5000 });
    assert.strictEqual(jb.getStatus().counters.reportSuppressed, 1);
    assert.ok(!lines.some((l) => l.includes("ui.win.eve=1")), "no line inside the window");
    now += cfg.jobBoard.reportMinIntervalMs - 5000;
    assert.deepStrictEqual(probe(["ui.win.eve=1"]), { ok: true });
    assert.ok(lines.includes(`jobBoard: LNE_BOARD_UI:PROBE ${CHAR} proto=1 build=3396210 ui.win.eve=1`), lines.join("|"));
    assert.deepStrictEqual(Report({ characterId: 0, args: [] }), { ok: false, reason: "NO_CHARACTER" });
    jb.stop("test");

    const line = { getSystem: () => null,
      getNeighbors: (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 30) };
    const small = { ...cfg, jobBoard: { ...cfg.jobBoard, distanceMemoMaxEntries: 25, minCallIntervalMs: 250 } };
    const mb = startJobBoard({ config: small, ctx: fakeCtx({ graph: { getGraph: () => ({ ok: true, graph: line }) } }),
      adapter: fakeAdapter(), clock: { now: () => now }, world: {} }).jobBoard;
    for (const sys of [1, 2, 3]) {
      now += 1000;
      assert.strictEqual(mb.readBoard(CHAR, sys).ok, true);
    }
    const st = mb.getStatus();
    assert.deepStrictEqual([st.memo, st.memoEntries], [2, 25], JSON.stringify(st));
    mb.stop("test");
    assert.strictEqual(cfg.jobBoard.distanceMemoMaxEntries, 200000, "default");
    assert.notStrictEqual(configOf({ EVEJS_LNE_JOB_BOARD_DISTANCE_MEMO_MAX_ENTRIES: "999" }).config.jobBoard
      .distanceMemoMaxEntries, 999, "below the range is not taken");
  });

  test("JB7 board.py: a poll with the same board does not rebuild the "
    + "window; a rebuild keeps the scroll position; the signature leaves out at/ageS and counts endsIn/age as text", () => {
    const source = fs.readFileSync(BOARD_PY, "utf8").replace(/\r\n/g, "\n");
    const method = (name) => {
      const start = source.indexOf(`\n        def ${name}(`);
      assert.ok(start >= 0, `def ${name}`);
      const end = source.indexOf("\n        def ", start + 1);
      return source.slice(start, end < 0 ? source.length : end);
    };
    const render = method("render");
    const skip = render.indexOf("self.drawn == self.signature(self.owner.state)");
    assert.ok(skip >= 0 && skip < render.indexOf("self.build("), "render: same signature -> return before build");
    assert.ok(/self\.drawn == self\.signature\(self\.owner\.state\):\n\s+return\n/.test(render), render);

    const build = method("build");
    const at = (needle) => {
      const i = build.indexOf(needle);
      assert.ok(i >= 0, `build has ${needle}`);
      return i;
    };
    assert.ok(at("position = self.scroll_position()") < at("self.flush(self.body)"), "position read before flush");
    assert.ok(at("holder = scroll(parent=self.body") < at("self.scroll_restore(holder, position)"), "restore on the new scroll");
    assert.ok(at("self.fill(holder, data)") < at("self.scroll_restore(holder, position)"), "restore after the rows");
    assert.ok(at("self.scroll_restore(holder, position)") < at("self.drawn = self.signature(data)"), "drawn last");
    assert.ok(!/\n            if not data:\n                return\n/.test(build), "no early return before drawn");

    const close = method("close");
    assert.ok(close.indexOf("self.drawn = None") < close.indexOf("if win is None or where == 'player':"),
      "close forgets the drawn signature (a reopen draws the board again)");

    assert.ok(/_LNE_SIG_SKIP = \('at', 'ageS'\)/.test(source), "at / ageS are not drawn");
    assert.ok(/_LNE_SIG_DURATION = \('endsIn', 'age'\)/.test(source), "countdowns as drawn text");
    assert.ok(/item = _lne_duration\(item\)/.test(source), "frozen copy maps a countdown to _lne_duration");
    const wireSource = fs.readFileSync(path.join(MOD_DIR, "lib", "jobBoard", "wire.js"), "utf8");
    for (const key of ["at:", "ageS:", "endsIn:", "age:"]) assert.ok(wireSource.includes(key), `wire.js ${key}`);
  });
};
