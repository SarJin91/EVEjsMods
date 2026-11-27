"use strict";

process.env.SHIPWING_NO_INSTALL = "1";

const path = require("node:path");

const TEST_FILES = Object.freeze([
  "core/twinSpec.test.js",
  "core/wingService.test.js",
  "core/wingLoss.test.js",
  "core/tickDriver.test.js",
  "core/miningEngine.test.js",
  "core/targetPolicy.test.js",
  "core/cycleSchedule.test.js",
  "core/combatEngine.test.js",
  "core/ammoReceipts.test.js",
  "core/activeTask.test.js",
  "core/logiPolicy.test.js",
  "core/logiTask.test.js",
  "core/propTask.test.js",
  "core/burstTask.test.js",
  "core/droneTask.test.js",
  "core/formation.test.js",
  "core/salvageTask.test.js",
  "core/ewarTask.test.js",
  "core/twinRunning.test.js",
  "adapter/combatAccess.test.js",
  "adapter/droneAccess.test.js",
  "adapter/burstAccess.test.js",
  "adapter/activeAccess.test.js",
  "adapter/logiAccess.test.js",
  "adapter/ewarAccess.test.js",
  "adapter/propAccess.test.js",
  "adapter/twinDerived.test.js",
  "adapter/guards.test.js",
  "adapter/boardHook.test.js",
  "adapter/vendor.test.js",
  "adapter/chatHook.test.js",
  "adapter/lossHook.test.js",
  "adapter/sceneGuard.test.js",
  "adapter/miningHook.test.js",
  "adapter/overflowCans.test.js",
  "adapter/realCargo.test.js",
  "adapter/cargoAccess.test.js",
  "adapter/salvageHook.test.js",
  "adapter/commandMirror.test.js",
  "adapter/safeLogoffHook.test.js",
  "adapter/npcAggro.test.js",
  "channels/chat.test.js",
  "channels/clientWindow.test.js",
  "channels/uiPrefs.test.js",
  "adapter/clientService.test.js",
  "adapter/handshakeHook.test.js",
  "adapter/clientDelivery.test.js",
  "store/wingStore.test.js",
  "store/droneJournal.test.js",
  "store/formationStore.test.js",
  "store/uiPrefsStore.test.js",
  "loader/loader.test.js",
  "config/config.test.js",
  "vendor/facts.test.js",
  "vendor/salvager.test.js",
]);

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function skip(name, reason) {
  cases.push({ name, skipped: String(reason) });
}

async function main() {
  const started = Date.now();
  for (const rel of TEST_FILES) {
    if (only && !only.some((fragment) => rel.includes(fragment))) continue;
    try {
      require(path.join(__dirname, rel))({ test, skip });
    } catch (err) {
      cases.push({ name: `load ${rel}`, fn: () => { throw err; } });
    }
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.skipped !== undefined) {
      skipped += 1;
      console.log(`SKIP ${c.name} - ${c.skipped}`);
      continue;
    }
    try {
      await c.fn();
      passed += 1;
      console.log(`PASS ${c.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${c.name}`);
      console.log(`     ${(err && err.stack) || err}`);
    }
  }
  const tag = only ? " [only]" : "";
  console.log(`\n${passed}/${passed + failed} PASS, ${skipped} SKIP${tag} (${Date.now() - started} ms)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`FAIL runner - ${(err && err.stack) || err}`);
  process.exitCode = 1;
});
