"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const P = require("../../lib/shipAi/portrait");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { storeAiPortraitWith } = require("../../lib/adapter/shipAiPortrait");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const AI2 = 91000002;
const T0 = 1700000000000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const GIF = Buffer.from("GIF89a....");

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-shipai-portrait-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function insertRow(store, playerId, aiId) {
  const r = store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
    { playerId, aiId, name: "Jin", nowMs: T0 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

const shaOf = (store, playerId) => store.transaction("t.read", (db) => createShipAiPrefsRepository()
  .getByPlayer(db, playerId)).value.row.portraitSha;

function spyStore() {
  const calls = [];
  return { calls, fn: (aiId, bytes, ext) => {
    calls.push([aiId, Buffer.from(bytes).toString("hex"), ext]);
    return { ok: true, sizes: 6 };
  } };
}

module.exports = ({ test, skip }) => {
  test("PT0 checkImage by magic bytes + size; config defaults (portraitEnabled true, 1 MiB, batch 4)", () => {
    const M = settings();
    assert.deepStrictEqual([M.portraitEnabled, M.portraitMaxBytes, M.portraitBootBatch], [true, 1048576, 4]);
    assert.deepStrictEqual(P.checkImage(JPEG, M), { ok: true, extension: "jpg" });
    assert.deepStrictEqual(P.checkImage(PNG, M), { ok: true, extension: "png" });
    assert.deepStrictEqual(P.checkImage(GIF, M), { ok: false, reason: "BAD_FILE" });
    assert.deepStrictEqual(P.checkImage(Buffer.alloc(0), M), { ok: false, reason: "BAD_FILE" });
    assert.deepStrictEqual(P.checkImage(JPEG, { portraitMaxBytes: 4 }), { ok: false, reason: "TOO_LARGE" });
    assert.strictEqual(P.portraitDirOf(base), path.join(base.dataDir, "shipAi"));
    assert.strictEqual(P.portraitDirOf({}), null);
  });

  const driver = SH.loadDriver();
  const n1 = "PT1 portrait: one vendor store + sha256 in ship_ai_prefs; restart = unchanged (no write); per-player file "
    + "first; adapter core; start pass in steps of portraitBootBatch";
  const n1b = "PT1b portrait jpg -> png (): clear before store, no.jpg left; failed clear -> no "
    + "store, no sha update";
  const n2 = "PT2 portrait: no file -> default, wrong format -> bad_file, too big -> too_large, flag off -> off; no write";
  if (!driver.ok) {
    skip(n1, `better-sqlite3 unavailable (${driver.detail})`);
    skip(n1b, `better-sqlite3 unavailable (${driver.detail})`);
    skip(n2, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(n1, () => SH.withStore(driver, (persistence) => withDir((dir) => {
      const store = persistence.store;
      insertRow(store, PLAYER, AI);
      insertRow(store, OTHER, AI2);
      const spy = spyStore();
      const deps = () => ({ S: settings(), store, repo: createShipAiPrefsRepository(), dir, storePortrait: spy.fn,
        nowMs: () => T0 + 5 });
      fs.writeFileSync(path.join(dir, "avatar.jpg"), JPEG);
      assert.deepStrictEqual(P.syncPortrait(deps(), PLAYER), { ok: true, status: "stored", sizes: 6 });
      assert.deepStrictEqual(spy.calls, [[AI, JPEG.toString("hex"), "jpg"]]);
      assert.strictEqual(shaOf(store, PLAYER), P.sha256Of(JPEG));
      assert.deepStrictEqual(P.syncPortrait(deps(), PLAYER), { ok: true, status: "unchanged" });
      assert.strictEqual(spy.calls.length, 1);
      fs.writeFileSync(path.join(dir, `avatar-${PLAYER}.png`), PNG);
      assert.deepStrictEqual(P.syncPortrait(deps(), PLAYER).status, "stored");
      assert.deepStrictEqual(spy.calls[1], [AI, PNG.toString("hex"), "png"]);
      assert.strictEqual(shaOf(store, PLAYER), P.sha256Of(PNG));
      const refused = P.syncPortrait({ ...deps(), storePortrait: () => ({ ok: false, reason: "STORE_FAILED" }) }, OTHER);
      assert.deepStrictEqual(refused, { ok: false, status: "failed", reason: "STORE_FAILED" });
      assert.strictEqual(shaOf(store, OTHER), null);
      assert.deepStrictEqual(P.syncPortrait(deps(), 9999), { ok: false, status: "failed", reason: "NO_IDENTITY" });

      const steps = [];
      const sync = P.createPortraitSync({ ...deps(), S: settings({ portraitBootBatch: 1 }), defer: (fn) => steps.push(fn) });
      sync.bootPass([PLAYER, OTHER]);
      sync.syncSoon(OTHER);
      assert.deepStrictEqual([steps.length, sync.getStatus().pending], [1, 2]);
      steps.shift()();
      assert.deepStrictEqual([steps.length, sync.getStatus().pending, sync.getStatus().last], [1, 1, "unchanged"]);
      steps.shift()();
      const st = sync.getStatus();
      assert.deepStrictEqual([steps.length, st.state, st.pending, st.last, st.byStatus.stored, st.byStatus.unchanged],
        [0, "running", 0, "stored", 1, 1]);
      assert.deepStrictEqual(spy.calls[2], [AI2, JPEG.toString("hex"), "jpg"]);
      sync.stop();
      sync.syncSoon(PLAYER);
      assert.deepStrictEqual([steps.length, sync.getStatus().state], [0, "stopped"]);
      assert.strictEqual(P.createPortraitSync({ ...deps(), storePortrait: null }).getStatus().state, "unavailable");

      const vendorCalls = [];
      const vendor = { clearCharacterPortraits: (id) => { vendorCalls.push(["clear", id]); },
        storeCharacterPortrait: (id, bytes, opts) => {
          vendorCalls.push([id, bytes.length, opts]);
          return { success: true, data: { charId: id, sizes: [32, 64, 128, 256, 512, 1024], byteLength: bytes.length } };
        } };
      assert.deepStrictEqual(storeAiPortraitWith(vendor, AI, JPEG, "jpg"), { ok: true, sizes: 6 });
      assert.deepStrictEqual(vendorCalls, [["clear", AI], [AI, JPEG.length, { extension: "jpg" }]]);
      assert.deepStrictEqual(storeAiPortraitWith(null, AI, JPEG, "jpg"), { ok: false, reason: "SEAM_UNAVAILABLE",
        detail: "storeCharacterPortrait" });
      assert.deepStrictEqual(storeAiPortraitWith({ storeCharacterPortrait: vendor.storeCharacterPortrait }, AI, JPEG,
        "jpg"), { ok: false, reason: "SEAM_UNAVAILABLE", detail: "clearCharacterPortraits" });
      const noop = () => {};
      assert.deepStrictEqual(storeAiPortraitWith({ clearCharacterPortraits: noop, storeCharacterPortrait: () => ({
        success: false, errorMsg: "INVALID_PORTRAIT_PAYLOAD" }) }, AI, JPEG, "jpg"), { ok: false, reason: "STORE_FAILED",
        detail: "INVALID_PORTRAIT_PAYLOAD" });
      const thrown = storeAiPortraitWith({ clearCharacterPortraits: noop, storeCharacterPortrait: () => {
        throw Object.assign(new Error("x"), { code: "EACCES" }); } }, AI, JPEG, "jpg");
      assert.deepStrictEqual(thrown, { ok: false, reason: "STORE_FAILED", detail: "EACCES" });
    })));

    test(n1b, () => SH.withStore(driver, (persistence) => withDir((dir) => {
      const store = persistence.store;
      insertRow(store, PLAYER, AI);
      const files = new Set();
      const order = [];
      const fake = {
        clearCharacterPortraits: (id) => {
          order.push("clear");
          for (const f of [...files]) if (f.startsWith(`${id}_`)) files.delete(f);
        },
        storeCharacterPortrait: (id, bytes, opts) => {
          order.push("store");
          for (const size of [32, 64]) files.add(`${id}_${size}.${opts.extension}`);
          return { success: true, data: { charId: id, sizes: [32, 64], byteLength: bytes.length } };
        },
      };
      const deps = (vendor) => ({ S: settings(), store, repo: createShipAiPrefsRepository(), dir, nowMs: () => T0,
        storePortrait: (aiId, bytes, ext) => storeAiPortraitWith(vendor, aiId, bytes, ext) });
      fs.writeFileSync(path.join(dir, "avatar.jpg"), JPEG);
      assert.strictEqual(P.syncPortrait(deps(fake), PLAYER).status, "stored");
      assert.deepStrictEqual([...files].sort(), [`${AI}_32.jpg`, `${AI}_64.jpg`]);
      fs.rmSync(path.join(dir, "avatar.jpg"));
      fs.writeFileSync(path.join(dir, "avatar.png"), PNG);
      assert.strictEqual(P.syncPortrait(deps(fake), PLAYER).status, "stored");
      assert.deepStrictEqual([...files].sort(), [`${AI}_32.png`, `${AI}_64.png`]);
      assert.deepStrictEqual(order, ["clear", "store", "clear", "store"]);
      assert.strictEqual(shaOf(store, PLAYER), P.sha256Of(PNG));
      fs.writeFileSync(path.join(dir, "avatar.png"), Buffer.concat([PNG, Buffer.from([7])]));
      const broken = { ...fake, clearCharacterPortraits: () => { order.push("clear"); throw Object.assign(
        new Error("busy"), { code: "EBUSY" }); } };
      assert.deepStrictEqual(P.syncPortrait(deps(broken), PLAYER), { ok: false, status: "failed",
        reason: "STORE_FAILED" });
      assert.deepStrictEqual(order.slice(4), ["clear"]);
      assert.strictEqual(shaOf(store, PLAYER), P.sha256Of(PNG));
    })));

    test(n2, () => SH.withStore(driver, (persistence) => withDir((dir) => {
      const store = persistence.store;
      insertRow(store, PLAYER, AI);
      const spy = spyStore();
      const deps = (over) => ({ S: settings(over), store, repo: createShipAiPrefsRepository(), dir,
        storePortrait: spy.fn, nowMs: () => T0 });
      assert.deepStrictEqual(P.syncPortrait(deps(), PLAYER), { ok: true, status: "default" });
      fs.writeFileSync(path.join(dir, "avatar.jpg"), GIF);
      assert.deepStrictEqual(P.syncPortrait(deps(), PLAYER), { ok: true, status: "bad_file" });
      fs.writeFileSync(path.join(dir, "avatar.jpg"), Buffer.concat([JPEG, Buffer.alloc(2048)]));
      assert.deepStrictEqual(P.syncPortrait(deps({ portraitMaxBytes: 1024 }), PLAYER), { ok: true, status: "too_large" });
      assert.deepStrictEqual(P.syncPortrait(deps({ portraitEnabled: false }), PLAYER), { ok: true, status: "off" });
      assert.deepStrictEqual(P.resolvePortraitFile(path.join(dir, "absent"), PLAYER), { ok: false, reason: "NO_FILE" });
      assert.deepStrictEqual([spy.calls.length, shaOf(store, PLAYER)], [0, null]);
      assert.strictEqual(P.createPortraitSync(deps({ portraitEnabled: false })).getStatus().state, "off");
    })));
  }

  const n3 = "PT3 vendor facts: storeCharacterPortrait / CHARACTER_PORTRAIT_SIZES exported, path via "
    + "resolveRuntimeImagesDir, default hi.jpg; GetCharacterDescription reads charData.description";
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) {
    skip(n3, "EveJS server/src not found above the mod");
    return;
  }
  test(n3, () => {
    const src = fs.readFileSync(path.join(found.srcDir, "services", "character", "portraitImageStore.js"), "utf8");
    for (const fact of ["function storeCharacterPortrait(charId, bytes, options = {})",
      "const CHARACTER_PORTRAIT_SIZES = Object.freeze([32, 64, 128, 256, 512, 1024]);",
      "const { resolveRuntimeImagesDir } = require(\"../../gameStore/storeRoot\");",
      "return path.join(resolveRuntimeImagesDir(), \"Character\");",
      "const extension = normalizePortraitExtension(options.extension);",
      "function clearCharacterPortraits(charId) {",
      "for (const { filePath } of listCharacterPortraitPaths(numericCharId)) {",
      "path.join(IMAGE_ROOT, \"images\", \"hi.jpg\")"]) {
      assert.ok(src.includes(fact), fact);
    }
    const exportsBlock = src.slice(src.lastIndexOf("module.exports"));
    assert.ok(/\bstoreCharacterPortrait,/.test(exportsBlock) && /\bCHARACTER_PORTRAIT_SIZES,/.test(exportsBlock)
      && /\bclearCharacterPortraits,/.test(exportsBlock));
    const charMgr = fs.readFileSync(path.join(found.srcDir, "services", "character", "charMgrService.js"), "utf8");
    assert.ok(charMgr.includes("return charData.description || \"\";"), "GetCharacterDescription");
    const entry = GAME_MODULES.find((e) => e.path === "services/character/portraitImageStore");
    assert.deepStrictEqual(entry.symbols.map((s) => [s.name, s.kind, [...s.consumers], s.wrap]),
      [["storeCharacterPortrait", "export", ["shipAiPortrait"], undefined],
        ["clearCharacterPortraits", "export", ["shipAiPortrait"], undefined]]);
  });
};
