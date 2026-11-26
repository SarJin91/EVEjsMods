"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { parseArgs, planGmChange, listAccounts } = require("./accountGm");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3 });
const OWNER_ROLE_ENV = "EVEJS_GAMESTORE_OWNER_ROLE";
const ACCOUNTS_TABLE = "accounts";
const SHUTDOWN_REASON = "lne-set-gm";
const LEASE_BUSY_CODES = Object.freeze(["PERSISTENCE_OWNER_CONFLICT", "PERSISTENCE_OWNER_ACTIVE"]);
const USAGE = "usage: node mods/livingNewEden/tools/account/setGm.js on|off <account> [--dry-run]\n"
  + "       node mods/livingNewEden/tools/account/setGm.js status [<account>]";

const messageOf = (error) => String((error && error.message) || error);

function loadVendorFromDisk(role) {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, reason: "SERVER_SRC_NOT_FOUND" };
  if (!process.env[OWNER_ROLE_ENV]) process.env[OWNER_ROLE_ENV] = role;
  const gameStore = require(path.join(found.srcDir, "gameStore"));
  const accountStore = require(path.join(found.srcDir, "services", "login", "accountStore"));
  const roleProfiles = require(path.join(found.srcDir, "services", "account", "accountRoleProfiles"));
  return { ok: true, gameStore, accountStore, roleProfiles };
}

const describe = (summary) => `isGM ${summary.isGM}, role ${summary.role}, chatRole ${summary.chatRole}`
  + `${summary.banned ? ", banned" : ""}`;

const changeLine = (userName, plan) => `account ${userName}: isGM ${plan.before.isGM} -> ${plan.after.isGM}, `
  + `role ${plan.before.role} -> ${plan.after.role}`;

function refuseNotFound(userName, plan, err) {
  const hint = plan.similar.length > 0 ? ` (similar: ${plan.similar.join(", ")})` : "";
  err(`REFUSED NOT_FOUND: no account ${userName}${hint}`);
  return { code: EXIT.REFUSED };
}

function runWrite(args, vendor, out, err) {
  const { gameStore, accountStore, roleProfiles } = vendor;
  const wantGm = args.cmd === "on";
  try {
    gameStore.acquirePersistenceOwnerLease({ recover: true });
  } catch (error) {
    if (error && LEASE_BUSY_CODES.includes(error.code)) {
      err(`REFUSED SERVER_RUNNING (${error.code}): stop the server (\`docker compose stop server\`); `
        + "after a hard kill the lease expires after ~30 s, retry in 30 s");
      return { code: EXIT.REFUSED };
    }
    return { code: EXIT.FAILED, message: `LEASE_FAILED: ${messageOf(error)}` };
  }
  const build = roleProfiles.buildPersistedAccountRoleRecord;
  const plan = planGmChange(accountStore.readAccountsTable(), args.userName, wantGm, build);
  if (!plan.ok) return refuseNotFound(args.userName, plan, err);
  out(`before: account ${args.userName}: ${describe(plan.before)}`);
  if (!plan.changed) {
    out(`UNCHANGED account ${args.userName}: ${describe(plan.after)}`);
    return { code: EXIT.OK };
  }
  const written = accountStore.writeAccountRecord(args.userName, plan.record);
  if (written && written.success === false) {
    return { code: EXIT.FAILED, message: `WRITE_FAILED: ${written.errorMsg || written.code || "unknown error"}` };
  }
  const flushed = accountStore.flushAccounts();
  if (!flushed || flushed.success !== true) {
    return { code: EXIT.FAILED, message: `FLUSH_FAILED: ${(flushed && (flushed.errorMsg || flushed.code)) || "unknown error"}` };
  }
  const durable = gameStore.readPersisted(ACCOUNTS_TABLE, `/${args.userName}`);
  const data = durable && durable.success === true ? durable.data : null;
  if (!data || data.isGM !== wantGm || data.role !== plan.record.role) {
    return { code: EXIT.FAILED, message: `VERIFY_MISMATCH: the stored account ${args.userName} does not match the plan` };
  }
  out(changeLine(args.userName, plan));
  return { code: EXIT.OK };
}

function runRead(args, vendor, out, err) {
  const { gameStore, roleProfiles } = vendor;
  const build = roleProfiles.buildPersistedAccountRoleRecord;
  const read = gameStore.readPersisted(ACCOUNTS_TABLE, "/");
  if (!read || read.success !== true) {
    return { code: EXIT.FAILED, message: `READ_FAILED: ${(read && (read.errorMsg || read.code)) || "unknown error"}` };
  }
  const accounts = read.data && typeof read.data === "object" ? read.data : {};
  if (args.cmd === "status") {
    if (args.userName !== null) {
      const probe = planGmChange(accounts, args.userName, true, build);
      if (!probe.ok) return refuseNotFound(args.userName, probe, err);
      out(`account ${args.userName}: ${describe(probe.before)}`);
      return { code: EXIT.OK };
    }
    const rows = listAccounts(accounts, build);
    out(`accounts: ${rows.length}`);
    for (const row of rows) out(`account ${row.userName}: ${describe(row)}`);
    return { code: EXIT.OK };
  }
  const plan = planGmChange(accounts, args.userName, args.cmd === "on", build);
  if (!plan.ok) return refuseNotFound(args.userName, plan, err);
  out(`before: account ${args.userName}: ${describe(plan.before)}`);
  out(plan.changed ? `DRY-RUN ${changeLine(args.userName, plan)} (not written)` : `UNCHANGED account ${args.userName}`);
  return { code: EXIT.OK };
}

async function main(argv, deps = {}) {
  const out = typeof deps.out === "function" ? deps.out : (s) => process.stdout.write(`${s}\n`);
  const err = typeof deps.err === "function" ? deps.err : (s) => process.stderr.write(`${s}\n`);
  const loadVendor = typeof deps.loadVendor === "function" ? deps.loadVendor : loadVendorFromDisk;

  const args = parseArgs(argv);
  if (!args.ok) {
    err(`USAGE: ${args.message}`);
    err(USAGE);
    return EXIT.USAGE;
  }
  const writes = args.cmd !== "status" && !args.dryRun;

  let vendor;
  try {
    vendor = loadVendor(writes ? "maintenance" : "reader");
  } catch (error) {
    err(`FAILED VENDOR_LOAD: ${messageOf(error)}`);
    return EXIT.FAILED;
  }
  if (!vendor || vendor.ok !== true) {
    err(`FAILED ${(vendor && vendor.reason) || "VENDOR_LOAD"}`);
    return EXIT.FAILED;
  }

  let result;
  try {
    out(`db: ${vendor.gameStore._sqliteDbPath}`);
    result = writes ? runWrite(args, vendor, out, err) : runRead(args, vendor, out, err);
  } catch (error) {
    result = { code: EXIT.FAILED, message: messageOf(error) };
  }

  let shutdownProblem = null;
  try {
    const closed = await vendor.gameStore.shutdown(SHUTDOWN_REASON);
    if (!closed || closed.success !== true) {
      shutdownProblem = (closed && (closed.errorMsg || closed.code)) || "unknown error";
    }
  } catch (error) {
    shutdownProblem = messageOf(error);
  }
  if (shutdownProblem !== null) {
    const message = result.message
      ? `${result.message}; GameStore shutdown also failed: ${shutdownProblem}`
      : `SHUTDOWN_FAILED: ${shutdownProblem}`;
    result = { code: EXIT.FAILED, message };
  }
  if (result.code === EXIT.FAILED) err(`FAILED ${result.message || ""}`.trimEnd());
  return result.code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { EXIT, main, loadVendorFromDisk };
