"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const H = require("../../lib/adapter/incursionHud");
const { createHudDriver } = require("../../lib/factionIncursions/hud");
const { startFactionIncursions } = require("../../lib/factionIncursions");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const T0 = 1760000000000;
const TALE = 9500000000001;
const [A, B, C, D, OUT] = [30000001, 30000002, 30000003, 30000004, 30000099];
const REMOVE_ID = 980000001;

const abs = (rel) => path.join(SERVER_SRC, ...`${rel}.js`.split("/"));
const lf = (text) => text.replace(/\r\n/g, "\n");

const buildDict = (entries = []) => ({ type: "dict", entries });
const helpers = {
  buildDict,
  buildKeyVal: (entries = []) => ({ type: "object", name: "util.KeyVal", args: buildDict(entries) }),
  buildFiletimeLong: (rawValue) => ({ type: "long", value: rawValue }),
};

function session(characterID, systemId, log) {
  return { characterID, solarsystemid2: systemId, sendNotification: (name, idType, payload) => log.push({ characterID,
    name, idType, payload }) };
}

function incursion(influenceMilli) {
  return { taleId: TALE, factionId: 500026, systems: [{ systemId: A, sceneType: 1 }, { systemId: B, sceneType: 2 },
    { systemId: C, sceneType: 3 }, { systemId: D, sceneType: 4 }], influenceMilli, influenceUpdatedAt: T0,
  graceMinutes: 10, decayMilliPerHour: 20 };
}

const spec = (influenceMilli) => ({ incursions: [incursion(influenceMilli)], templateNameID: 0,
  removeTemplateID: REMOVE_ID, maxSessions: 256 });
const keyValOf = (kv) => new Map(kv.args.entries);

function rig(opts = {}) {
  const log = [];
  const sessions = [session(91000001, A, log), session(91000002, OUT, log)];
  const vendor = { tales: [], reads: 0 };
  const cache = {
    [abs("services/_shared/serviceHelpers")]: { exports: helpers },
    [abs("services/chat/sessionRegistry")]: { exports: { getSessions: () => sessions } },
    [abs("services/incursion/incursionLifecycle")]: { exports: { listTales: () => {
      vendor.reads += 1;
      return vendor.tales;
    } } },
  };
  const adapter = createAdapter({ moduleApi: { _cache: cache }, readFileSync: opts.readFileSync });
  adapter.setServerSrc(SERVER_SRC);
  return { log, sessions, vendor, adapter };
}

function timerSeam() {
  const timers = [];
  return { timers, live: () => timers.filter((t) => !t.cancelled && !t.fired),
    setTimer(fn, ms) {
      const t = { fn, ms, cancelled: false, fired: false, cancel() { t.cancelled = true; }, hasRef: () => false };
      timers.push(t);
      return t;
    },
    fire() {
      const t = timers.filter((x) => !x.cancelled && !x.fired).pop();
      t.fired = true;
      t.fn();
    } };
}

const SETTINGS = Object.freeze({ refreshMs: 5000, maxSessionsPerSync: 256, removeTemplateID: REMOVE_ID,
  templateNameID: 0, maxActive: 1 });
const VIEW = Object.freeze({ incursionId: 1, factionId: 500026, systems: [{ systemId: A, role: "hq" }],
  influenceMilli: 600, state: "ACTIVE", phase: "ESTABLISHED", influenceRawMilli: 600, influenceUpdatedAt: T0,
  graceMinutes: 10, decayMilliPerHour: 20 });

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(abs("services/incursion/incursionPresentation"))) {
    skip("FI10-FI12 faction incursion HUD", `server/src not found (${SERVER_SRC})`);
    return;
  }

  test("FI10 HUD sync on the real createAdapter: data once, influence step, remove, vendor wins, clear", () => {
    const { log, sessions, vendor, adapter } = rig();
    const results = [];
    const sync = (s) => {
      const r = adapter.factionIncursionHudSync(s);
      results.push(r);
      return r;
    };
    assert.deepStrictEqual(sync(spec(600)), { ok: true, sessions: 2, data: 1, influence: 0, removed: 0,
      vendorSkipped: 0, errors: 0 });
    assert.strictEqual(log.length, 1);
    const [n] = log;
    assert.deepStrictEqual([n.characterID, n.name, n.idType, n.payload[0]], [91000001, "OnTaleData", "charid", A]);
    const [taleId, kv] = n.payload[1].entries[0];
    const k = keyValOf(kv);
    assert.deepStrictEqual([taleId, k.get("taleID"), k.get("severity"), k.get("locationID"), k.get("visualEffect"),
      k.get("hasChat"), k.get("incursedSystems"), k.get("effects")], [TALE, TALE, 1, A, null, false, [A, B, C, D], []]);
    assert.deepStrictEqual([...kv.args.entries.map((e) => e[0])], ["templateClassID", "templateNameID", "taleID",
      "locationID", "severity", "visualEffect", "incursedSystems", "hasFinalEncounter", "hasChat",
      "chatAnnouncementMessageId", "influenceData", "effects"], "key order of the vendor taleKeyVal");
    const inf = keyValOf(k.get("influenceData"));
    assert.deepStrictEqual([inf.get("influence"), inf.get("lastUpdated").value, inf.get("graceTime"),
      inf.get("decayRate")], [0.6, 116444736000000000n + BigInt(T0) * 10000n, 10, 0.02]);

    assert.strictEqual(sync(spec(600)).data, 0);
    sync(spec(605));
    assert.strictEqual(log.length, 1, "a second sync and +0.005 send nothing");
    assert.strictEqual(sync(spec(610)).influence, 1);
    assert.deepStrictEqual([log[1].name, log[1].idType, log[1].payload[0], keyValOf(log[1].payload[1]).get("influence")],
      ["OnInfluenceUpdate", "charid", TALE, 0.61]);

    sessions[0].solarsystemid2 = OUT;
    assert.strictEqual(sync(spec(610)).removed, 1);
    assert.deepStrictEqual([log[2].name, log[2].idType, log[2].payload], ["OnTaleRemove", "solarsystemid2",
      [TALE, 2, REMOVE_ID]]);

    vendor.tales = [{ taleID: 8000000000001, terminal: null, placement: { systems: [{ solarSystemID: A }] } }];
    sessions[0].solarsystemid2 = A;
    const v = sync(spec(610));
    assert.deepStrictEqual([v.data, v.vendorSkipped, log.length], [0, 1, 3], "a vendor tale in A: no LNE HUD");

    sessions[0].solarsystemid2 = B;
    assert.strictEqual(sync(spec(610)).data, 1);
    assert.strictEqual(adapter.factionIncursionHudStats().tracked, 1);
    const cleared = adapter.factionIncursionHudClear(REMOVE_ID);
    assert.deepStrictEqual([cleared.ok, cleared.removed], [true, 1]);
    assert.deepStrictEqual([log[4].name, log[4].payload], ["OnTaleRemove", [TALE, 2, REMOVE_ID]]);
    assert.deepStrictEqual(adapter.factionIncursionHudStats(), { installed: true, drift: null, tracked: 0 });

    const sent = () => log.length;
    assert.strictEqual(sync(spec(610)).data, 1, "B shown again");
    let before = sent();
    sessions[0].solarsystemid2 = A;
    assert.deepStrictEqual([sync(spec(610)).removed, sent() - before], [0, 0], "jump to a vendor tale system: 0 sends");
    sessions[0].solarsystemid2 = B;
    assert.strictEqual(sync(spec(610)).data, 1);
    before = sent();
    vendor.tales = [...vendor.tales, { taleID: 8000000000002, terminal: null,
      placement: { systems: [{ solarSystemID: B }] } }];
    assert.deepStrictEqual([sync(spec(610)).removed, sent() - before], [0, 0], "a vendor tale appears in B: 0 sends");
    vendor.tales = [];
    assert.strictEqual(sync(spec(610)).data, 1);
    before = sent();
    sessions[0].solarsystemid2 = 30002750;
    assert.deepStrictEqual([sync(spec(610)).removed, sent() - before], [0, 0], "jump to an observed tale system");
    assert.strictEqual(adapter.factionIncursionHudStats().tracked, 0);

    sessions[0].solarsystemid2 = B;
    assert.strictEqual(sync(spec(610)).data, 1);
    sessions.reverse();
    sessions[1].solarsystemid2 = OUT;
    before = sent();
    assert.deepStrictEqual([sync({ ...spec(610), maxSessions: 1 }).removed, log[log.length - 1].name, sent() - before],
      [1, "OnTaleRemove", 1]);
    const reads = vendor.reads;
    assert.strictEqual(sync({ ...spec(610), incursions: [] }).sessions, 0);
    assert.strictEqual(vendor.reads, reads, "no listTales call");
    assert.deepStrictEqual(results.filter((r) => !r.ok || JSON.stringify(r).includes("not_in_game_modules")), []);
  });

  test("FI11 driver: DRIFT -> hudDrift once, poller stopped; stop -> clear; hud.enabled off -> no driver", () => {
    const presentation = abs("services/incursion/incursionPresentation");
    const changed = (p, enc) => (p === presentation ? `${fs.readFileSync(p, enc)}\n// changed` : fs.readFileSync(p, enc));
    const { adapter, log } = rig({ readFileSync: changed });
    const counts = [];
    const lines = [];
    const t = timerSeam();
    const driver = createHudDriver({ getAdapter: () => adapter, listActive: () => ({ ok: true, incursions: [VIEW] }),
      settings: SETTINGS, telemetry: { count: (name, n) => counts.push([name, n]), gauge() {} },
      logger: { log: (l) => lines.push(l) }, now: () => T0, setTimer: t.setTimer });
    assert.deepStrictEqual(driver.start(), { ok: true });
    t.fire();
    assert.strictEqual(driver.runPass().ok, false, "second pass after the drift");
    assert.deepStrictEqual(counts, [["world.factionIncursions.hudDrift", 1]]);
    assert.deepStrictEqual([driver.status().state, driver.status().counters.hudDrift], ["drift", 1]);
    assert.deepStrictEqual(t.live(), [], "poller stopped");
    assert.strictEqual(lines.filter((l) => l.includes("INCURSION_HUD_DRIFT")).length, 1, lines.join("\n"));
    assert.strictEqual(log.length, 0, "nothing sent");
    assert.strictEqual(adapter.factionIncursionHudStats().drift, `${H.PRESENTATION_FILE} sha1`);

    const clears = [];
    const spy = { factionIncursionHudSync: () => ({ ok: true, sessions: 0, data: 0, influence: 0, removed: 0,
      vendorSkipped: 0, errors: 0 }), factionIncursionHudClear: (id) => {
      clears.push(id);
      return { ok: true, sessions: 1, data: 0, influence: 0, removed: 1, vendorSkipped: 0, errors: 0 };
    } };
    const t2 = timerSeam();
    const d2 = createHudDriver({ getAdapter: () => spy, listActive: () => ({ ok: true, incursions: [] }),
      settings: SETTINGS, now: () => T0, setTimer: t2.setTimer });
    d2.start();
    t2.fire();
    d2.stop();
    assert.deepStrictEqual([clears, d2.status().state, d2.status().counters.hudRemove], [[REMOVE_ID], "stopped", 1]);

    const store = { transaction: () => ({ ok: true, value: { ok: true, count: 0 } }) };
    const boot = (env) => {
      const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
        EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1", ...env } });
      assert.deepStrictEqual(r.errors || [], []);
      const subs = [];
      const presence = { onSystemObserved: (cb) => (subs.push(cb), { ok: true, unsubscribe() {} }),
        onSystemUnobserved: (cb) => (subs.push(cb), { ok: true, unsubscribe() {} }) };
      const fi = startFactionIncursions({ config: r.config, clock: { now: () => T0 }, setTimer: timerSeam().setTimer,
        persistence: { ok: true, store, journal: {} }, getAdapter: () => spy, getPresence: () => presence });
      assert.strictEqual(fi.ok, true, JSON.stringify(fi));
      return { fi: fi.factionIncursions, subs };
    };
    const off = boot({});
    assert.deepStrictEqual([off.subs.length, "hud" in off.fi.getStatus()], [0, false], "hud off: no driver");
    off.fi.stop();
    clears.length = 0;
    const on = boot({ EVEJS_LNE_FACTION_INCURSIONS_HUD_ENABLED: "1" });
    assert.deepStrictEqual([on.subs.length, on.fi.getStatus().hud.state], [2, "running"]);
    on.fi.stop();
    assert.deepStrictEqual(clears, [REMOVE_ID], "stop of the service clears the HUD");
  });

  test("FI12 vendor facts: presentation SHA-1, projection shapes, builders, no production taleMgr path", () => {
    const presentation = lf(fs.readFileSync(abs("services/incursion/incursionPresentation"), "utf8"));
    assert.strictEqual(crypto.createHash("sha1").update(presentation).digest("hex"), H.PRESENTATION_SHA1);
    const projection = lf(fs.readFileSync(abs("services/incursion/incursionProjectionRuntime"), "utf8"));
    for (const shape of H.PROJECTION_SHAPES) assert.ok(projection.includes(shape), shape);
    const observed = lf(fs.readFileSync(path.join(SERVER_SRC, ...H.OBSERVED_FILE.split("/")), "utf8"));
    assert.strictEqual(crypto.createHash("sha1").update(observed).digest("hex"), H.OBSERVED_SHA1);
    const table = observed.slice(observed.indexOf("OBSERVED_TALE_IDS_BY_SOLAR_SYSTEM_ID = "));
    assert.deepStrictEqual([...table.slice(0, table.indexOf("});")).matchAll(/^ {2}(\d+): /gm)].map((m) => Number(m[1])),
      [...H.OBSERVED_SYSTEMS]);
    const helpersText = lf(fs.readFileSync(abs("services/_shared/serviceHelpers"), "utf8"));
    const exportsBlock = helpersText.slice(helpersText.lastIndexOf("module.exports = {"));
    for (const name of ["buildKeyVal", "buildDict", "buildFiletimeLong"]) {
      assert.ok(new RegExp(`^function ${name}\\(`, "m").test(helpersText), `function ${name}`);
      assert.ok(exportsBlock.includes(`\n  ${name},\n`), `export ${name}`);
    }

    const named = [];
    const callers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
        } else if (e.name.endsWith(".js")) {
          const text = fs.readFileSync(p, "utf8");
          const rel = path.relative(SERVER_SRC, p).split(path.sep).join("/");
          if (text.includes("sendSolarSystemTaleData")) named.push(rel);
          if (text.includes("buildSystemTalesDict(")) callers.push(rel);
        }
      }
    };
    walk(SERVER_SRC);
    assert.deepStrictEqual(named, ["services/tale/taleMgrService.js"]);
    const taleMgr = lf(fs.readFileSync(abs("services/tale/taleMgrService"), "utf8"));
    assert.strictEqual(taleMgr.split("sendSolarSystemTaleData").length - 1, 2, "definition + _testing only");
    assert.ok(/TaleMgrService\._testing = \{\n {2}sendSolarSystemTaleData,\n\};/.test(taleMgr));
    assert.deepStrictEqual(callers.sort(), ["services/incursion/incursionPresentation.js",
      "services/incursion/incursionProjectionRuntime.js", "services/tale/taleMgrService.js"]);

    assert.strictEqual(GAME_MODULES.some((m) => m.path === "services/incursion/incursionPresentation"), false);
    const hud = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumers.includes(H.CONSUMER))
      .map((s) => [m.path, s.name, s.wrap === true]));
    assert.deepStrictEqual(hud, [["services/_shared/serviceHelpers", "buildKeyVal", false],
      ["services/_shared/serviceHelpers", "buildDict", false],
      ["services/_shared/serviceHelpers", "buildFiletimeLong", false],
      ["services/incursion/incursionLifecycle", "listTales", false],
      ["gameStore/index", "read", false],
      ["services/chat/sessionRegistry", "getSessions", false]]);
  });
};
