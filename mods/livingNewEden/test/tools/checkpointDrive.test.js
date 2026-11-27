"use strict";

const assert = require("node:assert");

const { createCheckpointDrive } = require("../../tools/campaign/checkpointDrive");

const SETTINGS = Object.freeze({ checkpointForceFrames: 4000, checkpointTargetFrames: 600,
  checkpointMaxIntervalMs: 120000 });

function handle(log, result) {
  return { store: { getWalStatus: () => ({ rowsSinceCheckpoint: 10, estimatedFrames: 700, lastCheckpointAtMs: null }) },
    checkpointer: { runOnce: (reason) => {
      log.push(reason);
      return result || { ok: true };
    } } };
}

module.exports = function register({ test }) {
  test("CKD1 checkpointDrive: decision target -> runOnce(target), byReason counted, takeDay resets", () => {
    const seen = [];
    const drive = createCheckpointDrive({ settings: SETTINGS, nowMs: () => 0,
      decide: (wal, gov, now, s) => {
        seen.push([wal.estimatedFrames, gov, now, s]);
        return "target";
      } });
    const log = [];
    assert.deepStrictEqual(drive.afterPass(handle(log)), { ran: true, reason: "target" });
    assert.deepStrictEqual(log, ["target"]);
    assert.deepStrictEqual(seen, [[700, null, 0, SETTINGS]]);
    assert.deepStrictEqual(drive.afterPass(handle(log, { ok: false, reason: "CHECKPOINT_IN_FLIGHT" })),
      { ran: false, reason: "target" });
    assert.deepStrictEqual(drive.takeDay(), { force: 0, target: 1, interval: 0 });
    assert.deepStrictEqual(drive.takeDay(), { force: 0, target: 0, interval: 0 });
  });

  test("CKD2 checkpointDrive: decision null -> no runOnce; no checkpointer -> not run", () => {
    const drive = createCheckpointDrive({ settings: SETTINGS, nowMs: () => 0, decide: () => null });
    const log = [];
    assert.deepStrictEqual(drive.afterPass(handle(log)), { ran: false, reason: null });
    assert.deepStrictEqual(log, []);
    const always = createCheckpointDrive({ settings: SETTINGS, nowMs: () => 0, decide: () => "force" });
    assert.deepStrictEqual(always.afterPass({ store: handle(log).store, checkpointer: null }),
      { ran: false, reason: null });
    assert.deepStrictEqual(log, []);
    assert.deepStrictEqual(drive.takeDay(), { force: 0, target: 0, interval: 0 });
  });

  test("CKD3 benchCampaign parseArgs --checkpoint: inline ok, wrong value throws, default between", () => {
    const { parseArgs, DEFAULTS } = require("../../tools/benchCampaign");
    assert.strictEqual(parseArgs(["--checkpoint", "inline"]).checkpoint, "inline");
    assert.strictEqual(parseArgs(["--checkpoint", "between"]).checkpoint, "between");
    assert.throws(() => parseArgs(["--checkpoint", "sometimes"]), /--checkpoint needs between\|inline/u);
    assert.throws(() => parseArgs(["--checkpoint"]), /needs a value/u);
    assert.strictEqual(DEFAULTS.checkpoint, "between");
  });
};
