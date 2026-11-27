"use strict";

const { startStallWatch } = require("../../lib/stallWatch");

const busyMs = Number(process.argv[2]) || 2500;
const exitInPause = process.argv.includes("--exit-in-pause");

const started = startStallWatch({
  thresholdMs: 500, sampleEveryMs: 1000, maxSamples: 5, frames: 12, windowMs: 60000, heartbeatMs: 50,
  serverRoot: null, log: (line) => console.log(`[hotPathPerf] ${line}`), testExitInPause: exitInPause,
});
if (!started.ok) {
  console.log(`fixture: start failed ${started.reason}`);
  process.exit(3);
}
const watch = started.watch;
watch.breadcrumb("call:schedule:test.type");

function busyCulpritFn(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += 1;
  return x;
}

setTimeout(() => {
  busyCulpritFn(busyMs);
  console.log("fixture: busy done");
  if (exitInPause) return;
  setTimeout(() => watch.stop("test"), 400);
}, 200);
