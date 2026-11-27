"use strict";

const fs = require("node:fs");
const inspector = require("node:inspector");

class HeapProfileMarker {
  constructor(i) {
    this.i = i;
    this.label = `heap-profile-marker-${i}`;
    this.payload = [i, i + 1, i + 2, i + 3];
  }
}

function holdMarkers(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(new HeapProfileMarker(i));
  return out;
}

const [file, count] = process.argv.slice(2);
const session = new inspector.Session();
session.connect();
const fail = (err) => {
  process.stderr.write(`heapProfileChild: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
};
session.post("HeapProfiler.enable", (e1) => {
  if (e1) return fail(e1);
  session.post("HeapProfiler.startSampling", { samplingInterval: 1024 }, (e2) => {
    if (e2) return fail(e2);
    globalThis.__lneHeapProfile = holdMarkers(Number(count));
    session.post("HeapProfiler.getSamplingProfile", (e3, res) => {
      if (e3) return fail(e3);
      fs.writeFileSync(file, JSON.stringify(res.profile));
      session.post("HeapProfiler.stopSampling", () => session.disconnect());
      return undefined;
    });
    return undefined;
  });
  return undefined;
});
