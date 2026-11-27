"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cdp = require("../../tools/heapAudit/cdp");
const summary = require("../../tools/heapAudit/snapshotSummary");

const CHILD = path.join(__dirname, "fixtures", "heapAuditChild.js");
const URL_WAIT_MS = 15000;
const HAS_MEMINFO = fs.existsSync("/proc/meminfo");
const DEADLINE_S = 0.05;
const LATE_OPEN_MS = 150;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lne-heap-"));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_err) {
  }
}

function startChild() {
  const child = childProcess.spawn(process.execPath, ["--inspect=127.0.0.1:0", CHILD, "serve"],
    { stdio: ["pipe", "pipe", "pipe"] });
  const url = new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("no inspector url from the child")), URL_WAIT_MS);
    child.stdout.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("ws://"));
      if (line) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}`));
    });
  });
  child.stderr.resume();
  return { child, url };
}

function stopChild(child) {
  try {
    child.stdin.end();
  } catch (_err) {
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch (_err) {
    }
  }, 2000).unref();
}

async function withChild(fn) {
  const { child, url } = startChild();
  const dir = tmpDir();
  try {
    return await fn(await url, child, dir);
  } finally {
    stopChild(child);
    cleanup(dir);
  }
}

function writeSnapshot(file, n) {
  childProcess.execFileSync(process.execPath, [CHILD, "write", file, String(n)], { stdio: "ignore" });
}

module.exports = ({ test, skip }) => {
  test("HA1 cdp.js on a real inspector: stats (pid, heap limit), snapshot -> file without .partial, OUT_EXISTS",
    () => withChild(async (url, child, dir) => {
      const opts = cdp.parseArgs(["stats", "--ws", url, "--timeout-s", "30"]);
      assert.strictEqual(opts.ok, true);
      const stats = await cdp.runStats(opts);
      assert.strictEqual(stats.ok, true, JSON.stringify(stats));
      assert.strictEqual(stats.pid, child.pid);
      assert.strictEqual(stats.heapReason, null);
      assert.ok(stats.heap.heap_size_limit > 0 && stats.heap.used_heap_size > 0);
      assert.ok(Array.isArray(stats.spaces) && stats.spaces.length > 0);
      const gc = await cdp.runStats(cdp.parseArgs(["stats", "--ws", url, "--gc"]));
      assert.strictEqual(gc.ok, true);
      assert.strictEqual(gc.gc, true);

      const out = path.join(dir, "heap", "a.heapsnapshot");
      const snap = await cdp.runSnapshot(cdp.parseArgs(["snapshot", "--ws", url, "--out", out, "--timeout-s", "60"]));
      assert.strictEqual(snap.ok, true, JSON.stringify(snap));
      assert.ok(fs.existsSync(out) && snap.bytes === fs.statSync(out).size && snap.bytes > 0);
      assert.ok(!fs.existsSync(`${out}.partial`));
      assert.strictEqual(snap.memCheck, HAS_MEMINFO ? "ok" : "unavailable");
      const parsed = summary.summarize(out, { top: 5 });
      assert.strictEqual(parsed.ok, true, "the streamed chunks form a valid snapshot");
      assert.deepStrictEqual(await cdp.runSnapshot(cdp.parseArgs(["snapshot", "--ws", url, "--out", out])),
        { ok: false, reason: "OUT_EXISTS", detail: out });
      assert.deepStrictEqual(cdp.parseArgs(["stats"]),
        { ok: false, reason: "USAGE", detail: "give exactly one of --port, --ws" });
      assert.strictEqual(cdp.checkResources({ usedBytes: 100, memAvailableBytes: 100, diskFreeBytes: 1000,
        memFactor: 1.5, diskFactor: 1.5, force: false }).reason, "LOW_MEMORY");
      assert.strictEqual(cdp.checkResources({ usedBytes: 100, memAvailableBytes: 100, diskFreeBytes: 100,
        memFactor: 1.5, diskFactor: 1.5, force: true }).memCheck, "forced");
      assert.strictEqual(cdp.parseMemInfo("MemTotal: 10 kB\nMemAvailable:    2048 kB\n"), 2048 * 1024);
    }));

  const lowName = "HA1b cdp.js snapshot --mem-factor 1e9 -> LOW_MEMORY (real /proc/meminfo), no file";
  if (!HAS_MEMINFO) skip(lowName, "no /proc/meminfo on this machine (Linux only)");
  else {
    test(lowName, () => withChild(async (url, _child, dir) => {
      const out = path.join(dir, "low.heapsnapshot");
      const r = await cdp.runSnapshot(cdp.parseArgs(["snapshot", "--ws", url, "--out", out, "--mem-factor", "1e9"]));
      assert.strictEqual(r.reason, "LOW_MEMORY");
      assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.partial`));
    }));
  }

  test("HA3 cdp.js: a socket that opens after the deadline is closed at once, no Runtime.evaluate",
    async () => {
      const sockets = [];
      class LateSocket {
        constructor() {
          this.listeners = {};
          this.sent = [];
          this.closed = false;
          sockets.push(this);
          setTimeout(() => this.fire("open", {}), LATE_OPEN_MS);
        }
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        }
        fire(type, event) {
          if (this.listeners[type]) this.listeners[type](event);
        }
        send(text) {
          this.sent.push(text);
        }
        close() {
          if (this.closed) return;
          this.closed = true;
          this.fire("close", {});
        }
      }
      const opts = cdp.parseArgs(["stats", "--ws", "ws://127.0.0.1:1/late", "--timeout-s", String(DEADLINE_S)]);
      assert.strictEqual(opts.ok, true);
      const r = await cdp.runStats(opts, { WebSocketImpl: LateSocket, readFile: () => "" });
      assert.strictEqual(r.reason, "TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, LATE_OPEN_MS * 2));
      assert.strictEqual(sockets.length, 1);
      assert.strictEqual(sockets[0].closed, true, "the late session is closed");
      assert.deepStrictEqual(sockets[0].sent, [], "no command sent after the deadline");
    });

  test("HS1-HS2 cdp.js heapsample on a real inspector: profiles + timeline, no .partial, OUT_EXISTS, usage exit 2",
    () => withChild(async (url, _child, dir) => {
      const port = String(new URL(url).port);
      const lines = [];
      const code = await cdp.main(["heapsample", "--port", port, "--out-dir", dir, "--duration-s", "3", "--every-s",
        "1", "--interval-bytes", "4096", "--call-timeout-s", "30", "--min-free-mb", "0"],
      { print: (l) => lines.push(l) });
      const out = JSON.parse(lines[0]);
      assert.strictEqual(code, 0, lines[0]);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.command, "heapsample");
      assert.strictEqual(out.stoppedBy, "duration");
      const files = fs.readdirSync(dir);
      const profiles = files.filter((f) => f.startsWith(`hs-${out.runId}-`) && f.endsWith(".heapprofile"));
      assert.ok(profiles.length >= 2, JSON.stringify(files));
      for (const f of profiles) {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        assert.ok(p.head && Array.isArray(p.samples), f);
      }
      assert.ok(!files.some((f) => f.endsWith(".partial")), JSON.stringify(files));
      const timeline = JSON.parse(fs.readFileSync(out.timeline, "utf8"));
      assert.strictEqual(out.timeline, path.join(dir, `hs-${out.runId}.timeline.json`));
      assert.ok(timeline.reads.length >= 3 && timeline.reads.length === out.reads, JSON.stringify(timeline.reads));
      assert.ok(timeline.reads.every((r) => r.usedHeapBytes > 0));
      assert.strictEqual(timeline.reads[0].file, null);
      assert.ok(timeline.reads.slice(1).every((r) => profiles.includes(r.file) && r.profileSamples >= 0));
      assert.strictEqual(timeline.intervalBytes, 4096);

      const atMs = Date.parse(timeline.startedAtIso);
      const again = await cdp.runHeapSample(cdp.parseArgs(["heapsample", "--ws", url, "--out-dir", dir]),
        { nowMs: () => atMs });
      assert.strictEqual(again.reason, "OUT_EXISTS");
      for (const bad of [["heapsample", "--ws", url, "--out-dir", dir, "--every-s", "0"],
        ["heapsample", "--ws", url], ["heapsample", "--ws", url, "--out-dir", dir, "--duration-s", "2", "--every-s", "3"],
        ["heapsample", "--ws", url, "--out-dir", dir, "--interval-bytes", "10"]]) {
        assert.strictEqual(await cdp.main(bad, { print: () => {} }), 2, bad.join(" "));
      }
      assert.strictEqual(cdp.profileSelfBytes({ head: { selfSize: 1, children: [{ selfSize: 2, children: [] }] } }), 3);
    }));

  test("HS3 cdp.js heapsample killed with SIGKILL after the 1st read: a 2nd run on the same target starts (the "
    + "closed session stopped the sampling)", () => withChild(async (url, _child, dir) => {
    const first = path.join(dir, "first");
    const tool = childProcess.spawn(process.execPath, [path.join(__dirname, "..", "..", "tools", "heapAudit", "cdp.js"),
      "heapsample", "--ws", url, "--out-dir", first, "--duration-s", "60", "--every-s", "1", "--no-gc",
      "--interval-bytes", "4096", "--min-free-mb", "0"], { stdio: "ignore" });
    const exited = new Promise((resolve) => tool.on("exit", resolve));
    const deadline = Date.now() + URL_WAIT_MS;
    const hasProfile = () => fs.existsSync(first) && fs.readdirSync(first).some((f) => f.endsWith(".heapprofile"));
    while (!hasProfile() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(hasProfile(), "the first run wrote a profile");
    const runArgs = (sub) => cdp.parseArgs(["heapsample", "--ws", url, "--out-dir", path.join(dir, sub),
      "--duration-s", "1", "--every-s", "1", "--no-gc", "--min-free-mb", "0"]);
    const busy = await cdp.runHeapSample(runArgs("busy"));
    assert.strictEqual(busy.reason, "SAMPLING_FAILED", JSON.stringify(busy));
    tool.kill("SIGKILL");
    await exited;
    const second = await cdp.runHeapSample(runArgs("second"));
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    assert.strictEqual(second.reads, 2);
  }));

  test("HA2 snapshotSummary on real snapshots: marker count, --diff delta, --anchor-keys reach, OVER_MEMORY, "
    + "BAD_SNAPSHOT", () => {
    const dir = tmpDir();
    try {
      const a = path.join(dir, "A.heapsnapshot");
      const b = path.join(dir, "B.heapsnapshot");
      writeSnapshot(a, 5000);
      writeSnapshot(b, 15000);
      const sa = summary.summarize(a, { top: 40 });
      assert.strictEqual(sa.ok, true, JSON.stringify(sa));
      const marker = sa.rows.find((r) => r.type === "object" && r.name === "HeapAuditMarker");
      assert.ok(marker && marker.count >= 5001, JSON.stringify(marker));
      assert.ok(sa.header.nodeCount > 0 && sa.header.byType.object.count > 0);

      const rows = summary.diffRows(summary.summarize(b, { resolveAll: true }), summary.summarize(a,
        { resolveAll: true }));
      const d = rows.find((r) => r.type === "object" && r.name === "HeapAuditMarker");
      assert.ok(d && d.deltaCount >= 10000, JSON.stringify(d));

      const report = summary.anchorReport(a, [["alpha", "beta"]], { maxAnchors: 5, maxMemMb: 1024 });
      assert.strictEqual(report.ok, true, JSON.stringify(report));
      const anchor = report.groups[0].anchors[0];
      const reach = (k) => anchor.reach.find((r) => r.key === k);
      assert.ok(reach("alpha").bytes >= 10 * reach("beta").bytes, JSON.stringify(anchor.reach));
      assert.ok(reach("alpha").nodes >= 5000);
      assert.ok(reach("union").bytes >= reach("alpha").bytes);
      assert.strictEqual(summary.anchorReport(a, [["alpha"]], { maxMemMb: 0 }).reason, "OVER_MEMORY");

      const cut = path.join(dir, "cut.heapsnapshot");
      const bytes = fs.readFileSync(a);
      fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
      assert.strictEqual(summary.summarize(cut).reason, "BAD_SNAPSHOT");
      assert.strictEqual(summary.summarize(path.join(dir, "missing")).reason, "READ_FAILED");

      const lines = [];
      assert.strictEqual(summary.main([b, "--diff", a, "--top", "5", "--anchor-keys", "alpha,beta"],
        (l) => lines.push(l)), 0);
      assert.ok(lines.some((l) => l.startsWith("| object | HeapAuditMarker |")));
      assert.ok(lines.some((l) => l.includes("upper bound of retained")));
      assert.strictEqual(summary.main([cut], () => {}), 1);
      assert.strictEqual(summary.parseArgs([]).reason, "USAGE");
    } finally {
      cleanup(dir);
    }
  });
};
