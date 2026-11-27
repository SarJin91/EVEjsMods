"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { countByDay, capturesVerdict, main, DAY_MS } = require("../../tools/measure/capturesPerDay");

const AT = 1763013600000;

module.exports = ({ test }) => {
  test("CPD1 capturesPerDay: windows per 24 h, rollback rule, missing file", () => {
    const rows = [
      { capturedAt: AT - DAY_MS },
      { capturedAt: AT - 1 },
      { capturedAt: AT },
      { capturedAt: AT - DAY_MS - 1 },
      { capturedAt: AT - 2 * DAY_MS },
      { capturedAt: AT - 2 * DAY_MS - 1 },
    ];
    const r = countByDay(rows, { at: AT, days: 2 });
    assert.strictEqual(r.at, AT);
    assert.deepStrictEqual(r.windows.map((w) => ({ index: w.index, captures: w.captures })),
      [{ index: 0, captures: 2 }, { index: 1, captures: 2 }]);
    assert.deepStrictEqual(r.windows[1], { index: 1, from: AT - 2 * DAY_MS, to: AT - DAY_MS, captures: 2 });

    assert.deepStrictEqual(capturesVerdict(8, 11), { limit: 10, rollback: true });
    assert.strictEqual(capturesVerdict(8, 10).rollback, false);
    assert.deepStrictEqual(capturesVerdict(0, 2), { limit: 2, rollback: false });
    assert.strictEqual(capturesVerdict(0, 3).rollback, true);

    const errs = [];
    const code = main(["--db", path.join(os.tmpdir(), "lne-cpd1-missing.sqlite")], { out: () => {}, err: (s) => errs.push(s) });
    assert.strictEqual(code, 1);
    assert.strictEqual(errs.length, 1);
  });
};
