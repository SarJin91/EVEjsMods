"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { parseArgs, planGmChange } = require("../../tools/account/accountGm");
const { main, EXIT } = require("../../tools/account/setGm");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);

const fakeBuild = (account) => {
  const isGM = account.isGM !== false;
  return { ...account, isGM, role: isGM ? "9" : "0", chatRole: isGM ? "5" : "1", banned: Boolean(account.banned) };
};

function fakeVendor({ accounts, leaseError = null, lieOnVerify = false }) {
  const calls = { lease: 0, writes: 0, flushes: 0, shutdowns: 0 };
  const memory = JSON.parse(JSON.stringify(accounts));
  const durable = JSON.parse(JSON.stringify(accounts));
  const gameStore = {
    _sqliteDbPath: "/fake/gameStore.sqlite",
    acquirePersistenceOwnerLease: () => {
      calls.lease += 1;
      if (leaseError) throw leaseError;
      return { role: "maintenance" };
    },
    readPersisted: (table, pth) => {
      assert.strictEqual(table, "accounts");
      if (pth === "/") return { success: true, data: JSON.parse(JSON.stringify(durable)) };
      const name = pth.slice(1);
      const data = { ...durable[name] };
      if (lieOnVerify) data.isGM = true;
      return { success: true, data };
    },
    shutdown: async () => { calls.shutdowns += 1; return { success: true }; },
  };
  const accountStore = {
    readAccountsTable: () => memory,
    writeAccountRecord: (name, record) => { calls.writes += 1; memory[name] = record; return { success: true }; },
    flushAccounts: () => {
      calls.flushes += 1;
      for (const [k, v] of Object.entries(memory)) durable[k] = JSON.parse(JSON.stringify(v));
      return { success: true };
    },
  };
  const vendor = { ok: true, gameStore, accountStore, roleProfiles: { buildPersistedAccountRoleRecord: fakeBuild } };
  return { calls, durable, loadVendor: (role) => { calls.role = role; return vendor; } };
}

const quiet = () => {};
const GM_ACCOUNT = { id: 7, passwordhash: "abc", isGM: true, role: "9", chatRole: "5", banned: false };

module.exports = ({ test, skip }) => {
  if (!found.ok) {
    skip("setGm T1 real vendor buildPersistedAccountRoleRecord", "server/src not found");
  } else {
    test("setGm T1 real vendor buildPersistedAccountRoleRecord: off, off again, on", () => {
      const { buildPersistedAccountRoleRecord: build } = require(path.join(found.srcDir, "services", "account",
        "accountRoleProfiles"));
      const gm = build({ id: 42, passwordhash: "hash42", isGM: true, banned: false });
      const off = planGmChange({ x: gm }, "x", false, build);
      assert.strictEqual(off.ok, true);
      assert.strictEqual(off.changed, true);
      assert.strictEqual(off.record.isGM, false);
      assert.strictEqual(off.record.role, "0");
      assert.strictEqual(off.record.passwordhash, "hash42");
      assert.strictEqual(off.record.id, 42);
      assert.strictEqual(off.before.isGM, true);
      assert.strictEqual(off.after.isGM, false);
      const again = planGmChange({ x: off.record }, "x", false, build);
      assert.strictEqual(again.changed, false);
      const on = planGmChange({ x: off.record }, "x", true, build);
      assert.strictEqual(on.changed, true);
      assert.strictEqual(on.record.isGM, true);
      assert.notStrictEqual(on.record.role, "0");
    });
  }

  test("setGm T2 parseArgs refusals and NOT_FOUND with similar names", () => {
    for (const argv of [["on"], ["off", "a/b"], ["status", "--dry-run"], ["off", "x", "--force"]]) {
      const parsed = parseArgs(argv);
      assert.strictEqual(parsed.ok, false, argv.join(" "));
      assert.strictEqual(parsed.reason, "USAGE", argv.join(" "));
    }
    assert.deepStrictEqual(parseArgs(["off", "x", "--dry-run"]), { ok: true, cmd: "off", userName: "x", dryRun: true });
    assert.deepStrictEqual(parseArgs(["status"]), { ok: true, cmd: "status", userName: null, dryRun: false });
    const plan = planGmChange({ foo: GM_ACCOUNT, bar: GM_ACCOUNT }, "Foo", false, fakeBuild);
    assert.deepStrictEqual(plan, { ok: false, reason: "NOT_FOUND", similar: ["foo"] });
  });

  test("setGm T3 live server lease -> REFUSED, no write, shutdown once", async () => {
    const leaseError = Object.assign(new Error("owner conflict"), { code: "PERSISTENCE_OWNER_CONFLICT" });
    const fake = fakeVendor({ accounts: { x: GM_ACCOUNT }, leaseError });
    const errors = [];
    const code = await main(["off", "x"], { out: quiet, err: (s) => errors.push(s), loadVendor: fake.loadVendor });
    assert.strictEqual(code, EXIT.REFUSED);
    assert.strictEqual(fake.calls.role, "maintenance");
    assert.strictEqual(fake.calls.writes, 0);
    assert.strictEqual(fake.calls.shutdowns, 1);
    assert.ok(errors.some((s) => s.includes("SERVER_RUNNING")), errors.join("\n"));
  });

  test("setGm T4 fake store: happy path, verify mismatch, repeat unchanged", async () => {
    const fake = fakeVendor({ accounts: { x: GM_ACCOUNT } });
    const lines = [];
    const code = await main(["off", "x"], { out: (s) => lines.push(s), err: quiet, loadVendor: fake.loadVendor });
    assert.strictEqual(code, EXIT.OK);
    assert.deepStrictEqual([fake.calls.lease, fake.calls.writes, fake.calls.flushes, fake.calls.shutdowns], [1, 1, 1, 1]);
    assert.strictEqual(fake.durable.x.isGM, false);
    assert.strictEqual(fake.durable.x.passwordhash, "abc");
    assert.ok(lines.includes("account x: isGM true -> false, role 9 -> 0"), lines.join("\n"));

    const liar = fakeVendor({ accounts: { x: GM_ACCOUNT }, lieOnVerify: true });
    const failed = await main(["off", "x"], { out: quiet, err: quiet, loadVendor: liar.loadVendor });
    assert.strictEqual(failed, EXIT.FAILED);
    assert.strictEqual(liar.calls.shutdowns, 1);

    const repeat = fakeVendor({ accounts: { x: fake.durable.x } });
    const again = await main(["off", "x"], { out: quiet, err: quiet, loadVendor: repeat.loadVendor });
    assert.strictEqual(again, EXIT.OK);
    assert.strictEqual(repeat.calls.writes, 0);
    assert.strictEqual(repeat.calls.shutdowns, 1);
  });

  if (!found.ok) {
    skip("setGm T5 vendor facts", "server/src not found");
  } else {
    test("setGm T5 vendor facts: normalization, exports, login normalization, maintenance exclusive", () => {
      const text = (...parts) => fs.readFileSync(path.join(found.srcDir, ...parts), "utf8");
      const roles = text("services", "account", "accountRoleProfiles.js");
      assert.ok(roles.includes("account.isGM !== false"));
      assert.ok(/module\.exports\s*=\s*\{[\s\S]*\bbuildPersistedAccountRoleRecord,/.test(roles));
      const store = text("services", "login", "accountStore.js");
      const storeExports = store.slice(store.indexOf("module.exports"));
      for (const name of ["readAccountsTable", "writeAccountRecord", "flushAccounts"]) {
        assert.ok(new RegExp(`\\b${name},`).test(storeExports), name);
      }
      const gameStore = text("gameStore", "index.js");
      const gsExports = gameStore.slice(gameStore.lastIndexOf("module.exports"));
      for (const name of ["acquirePersistenceOwnerLease", "readPersisted", "shutdown"]) {
        assert.ok(new RegExp(`\\n\\s*${name},`).test(gsExports), name);
      }
      assert.ok(text("network", "tcp", "handshake.js").includes("buildPersistedAccountRoleRecord(rawAccount)"));
      assert.ok(text("gameStore", "sqliteStore.js").includes('role === "maintenance"'));
    });
  }
};
