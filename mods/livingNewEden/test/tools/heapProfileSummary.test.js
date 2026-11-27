"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hps = require("../../tools/heapAudit/heapProfileSummary");

const CHILD = path.join(__dirname, "fixtures", "heapProfileChild.js");
const MB = 1024 * 1024;

function sumSelf(node) {
  let total = 0;
  const todo = [node];
  while (todo.length > 0) {
    const n = todo.pop();
    total += n.selfSize > 0 ? n.selfSize : 0;
    for (const c of n.children) todo.push(c);
  }
  return total;
}

let nextId = 1;
function frame(fn, url, children = [], selfSize = 0) {
  nextId += 1;
  return { callFrame: { functionName: fn, scriptId: "1", url, lineNumber: 9, columnNumber: 2 }, selfSize, id: nextId,
    children };
}

function synthetic(lneBytes, vendorBytes) {
  const lne = frame("tick", "/app/mods/livingNewEden/lib/fleets/index.js",
    [frame("parse", "node:internal/json", [], lneBytes)]);
  const vendor = frame("addEntity", "/app/server/src/space/scene/runtime.js", [], vendorBytes);
  return { head: frame("(root)", "", [lne, vendor]), samples: [] };
}

module.exports = function register({ test }) {
  test("HPS1 ownerOf: table (Linux, Windows file:///, node, empty)", () => {
    const cases = [
      ["/app/mods/livingNewEden/lib/fleets/index.js", "lne:fleets"],
      ["file:///C:/EveJS/mods/livingNewEden/lib/telemetry/heapDetail.js", "lne:telemetry"],
      ["C:\\EveJS\\mods\\livingNewEden\\loader.js", "lne:(root)"],
      ["/app/mods/livingNewEden/test/tools/x.js", "lne:(root)"],
      ["/app/mods/shipWing/lib/salvage.js", "mod:shipWing"],
      ["file:///C:/EveJS/mods/hotPathPerf/index.js", "mod:hotPathPerf"],
      ["/app/server/src/space/scene/runtime.js", "vendor:space/scene"],
      ["/app/server/src/gameStore/index.js", "vendor:gameStore"],
      ["/app/server/src/main.js", "vendor:(root)"],
      ["/app/server/node_modules/better-sqlite3/lib/database.js", "npm:better-sqlite3"],
      ["file:///C:/EveJS/server/node_modules/@scope/pkg/index.js", "npm:@scope/pkg"],
      ["node:internal/streams/readable", "node"],
      ["internal/modules/cjs/loader", "node"],
      ["", "native"],
      [undefined, "native"],
      ["evalmachine.<anonymous>", "other"],
    ];
    for (const [url, owner] of cases) assert.strictEqual(hps.ownerOf(url), owner, String(url));
  });

  test("HPS2 summarizeProfile on a real child profile: fixture owner > 50%, owners sum = selfSize sum", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hps-"));
    try {
      const file = path.join(dir, "child.heapprofile");
      const r = childProcess.spawnSync(process.execPath, [CHILD, file, "60000"], { encoding: "utf8", timeout: 15000 });
      assert.strictEqual(r.status, 0, r.stderr);
      const profile = JSON.parse(fs.readFileSync(file, "utf8"));
      const s = hps.summarizeProfile(profile, { top: 10 });
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      assert.strictEqual(s.profileBytes, sumSelf(profile.head));
      assert.strictEqual(s.owners.reduce((t, o) => t + o.bytes, 0), s.profileBytes);
      const fixture = s.owners.find((o) => o.owner === "lne:(root)");
      assert.ok(fixture && fixture.pct > 50, JSON.stringify(s.owners));
      assert.ok(s.topFrames.some((f) => f.frame.includes("heapProfileChild.js")), JSON.stringify(s.topFrames));

      const lines = [];
      const out = path.join(dir, "out.json");
      assert.strictEqual(hps.main(["profile", file, "--top", "5", "--json", out], (l) => lines.push(l)), 0);
      assert.ok(lines.some((l) => l.startsWith("| lne:(root) |")), lines.join("\n"));
      assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).profileBytes, s.profileBytes);

      const bad = path.join(dir, "bad.heapprofile");
      fs.writeFileSync(bad, "{\"head\":{}}");
      assert.strictEqual(hps.main(["profile", bad], () => {}), 1);
      assert.strictEqual(hps.main(["profile", path.join(dir, "missing")], () => {}), 1);
      assert.strictEqual(hps.summarizeProfile({ head: {} }).reason, "BAD_PROFILE");
      assert.strictEqual(hps.main(["profile"], () => {}), 2);
      assert.strictEqual(hps.main(["nope", file], () => {}), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HPS3 diffProfiles: key = stack signature, not node id; owner via the deepest app frame", () => {
    const a = synthetic(2 * MB, 1 * MB);
    const b = synthetic(5 * MB, 1 * MB);
    assert.notStrictEqual(a.head.id, b.head.id);
    const s = hps.summarizeProfile(a);
    const lne = s.owners.find((o) => o.owner === "lne:fleets");
    assert.strictEqual(lne.bytes, 2 * MB);
    assert.strictEqual(lne.viaBytes, 2 * MB);
    assert.strictEqual(s.owners.find((o) => o.owner === "vendor:space/scene").viaBytes, null);
    const d = hps.diffProfiles(a, b, { top: 5 });
    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(d.owners[0], { owner: "lne:fleets", a: 2 * MB, b: 5 * MB, delta: 3 * MB });
    assert.strictEqual(d.owners.find((o) => o.owner === "vendor:space/scene").delta, 0);
    assert.strictEqual(d.stacks.length, 1);
    assert.strictEqual(d.stacks[0].delta, 3 * MB);
    assert.ok(d.stacks[0].stack.startsWith("tick@mods/livingNewEden/lib/fleets/index.js:10"), d.stacks[0].stack);
    assert.strictEqual(hps.diffProfiles(a, null).reason, "BAD_PROFILE");
  });

  test("HPS4 ringSegments: 3/4-field entries, segments, timeline order, verdict, BAD_RING", () => {
    const t0 = Date.UTC(2026, 10, 24, 12, 0, 0);
    const e = (i, mb, chars) => (chars === undefined ? [t0 + i * 60000, mb * MB, 5] : [t0 + i * 60000, mb * MB, 5, chars]);
    const ring = [e(0, 4900), e(1, 4900, 0), e(2, 4950, 0), e(3, 5000, 0), e(4, 5400, 1), e(5, 5600, 2),
      e(6, 5050, 0), e(7, 5030, 0)];
    const timeline = { reads: [{ n: 1, atIso: new Date(t0 + 120000).toISOString(), atMs: t0 + 120000,
      usedHeapBytes: 5000 * MB, profileBytes: 10 * MB }, { n: 0, atIso: new Date(t0).toISOString(), atMs: t0,
      usedHeapBytes: 4900 * MB, profileBytes: null }] };
    const r = hps.ringSegments({ process: { heap: { afterMajor: { ring } } } }, timeline);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.segments.map((s) => [s.cls, s.n]), [["null", 1], ["0", 3], [">0", 2], ["0", 2]]);
    assert.strictEqual(r.segments[0].maxCharacters, null);
    assert.strictEqual(r.segments[1].medianBytes, 4950 * MB);
    assert.strictEqual(r.segments[2].maxCharacters, 2);
    assert.strictEqual(r.segments[3].lastBytes, 5030 * MB);
    assert.strictEqual(r.segments[1].startIso, new Date(t0 + 60000).toISOString());
    assert.deepStrictEqual(r.reads.map((x) => x.n), [0, 1]);
    assert.strictEqual(r.verdict.status, "released");
    assert.strictEqual(r.verdict.deltaMb, 90);
    assert.strictEqual(r.verdict.playBytes, 5600 * MB);

    const retained = ring.slice(0, 6).concat([e(6, 5200, 0), e(7, 5300, 0)]);
    assert.strictEqual(hps.ringSegments({ process: { heap: { afterMajor: { ring: retained } } } }, null).verdict.status,
      "retained");
    assert.strictEqual(hps.ringSegments({ process: { heap: { afterMajor: { ring: ring.slice(0, 4) } } } }, null)
      .verdict.status, "no-play");
    assert.strictEqual(hps.ringSegments({ process: { heap: { afterMajor: { ring: ring.slice(0, 6) } } } }, null)
      .verdict.status, "incomplete");
    assert.strictEqual(hps.ringSegments({ process: { heap: {} } }, null).reason, "BAD_RING");
    assert.strictEqual(hps.ringSegments({ process: { heap: { afterMajor: { ring: [[t0, "x"]] } } } }, null).reason,
      "BAD_RING");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hps-"));
    try {
      const latest = path.join(dir, "latest.json");
      const tl = path.join(dir, "t.json");
      fs.writeFileSync(latest, JSON.stringify({ process: { heap: { afterMajor: { ring } } } }));
      fs.writeFileSync(tl, JSON.stringify(timeline));
      const lines = [];
      assert.strictEqual(hps.main(["ring", latest, "--timeline", tl], (l) => lines.push(l)), 0);
      assert.ok(lines.some((l) => l.startsWith("verdict: released")), lines.join("\n"));
      fs.writeFileSync(latest, "{}");
      assert.strictEqual(hps.main(["ring", latest], () => {}), 1);
      assert.strictEqual(hps.main(["ring", latest, "--top", "0"], () => {}), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
