"use strict";

const assert = require("node:assert");

const { classifyLiveEnd } = require("../../lib/battle/liveEndMonitor");

module.exports = ({ test }) => {
  test("LEM1 classifyLiveEnd: side down / both down / timeout / still fighting; bad liveSince never times out",
    () => {
      const T = 300000;
      const rows = [
        [{ aliveA: 2, aliveB: 0, liveSince: 0, now: 10, timeoutMs: T }, { reason: "END", cause: "SIDE_B_DOWN" }],
        [{ aliveA: 0, aliveB: 1, liveSince: 0, now: 10, timeoutMs: T }, { reason: "END", cause: "SIDE_A_DOWN" }],
        [{ aliveA: 0, aliveB: 0, liveSince: 0, now: 10, timeoutMs: T }, { reason: "END", cause: "BOTH_DOWN" }],
        [{ aliveA: 1, aliveB: 1, liveSince: 1000, now: 1000 + T, timeoutMs: T }, { reason: "END", cause: "TIMEOUT" }],
        [{ aliveA: 1, aliveB: 1, liveSince: 1000, now: 1000 + T - 1, timeoutMs: T }, null],
        [{ aliveA: 1, aliveB: 1, liveSince: null, now: 10 * T, timeoutMs: T }, null],
      ];
      assert.deepStrictEqual(rows.map(([input]) => classifyLiveEnd(input)), rows.map(([, want]) => want));
    });
};
