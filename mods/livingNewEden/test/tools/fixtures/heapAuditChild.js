"use strict";

const inspector = require("node:inspector");
const v8 = require("node:v8");

class HeapAuditMarker {
  constructor(i) {
    this.i = i;
    this.label = `marker-${i}`;
  }
}

const [mode, file, count] = process.argv.slice(2);
if (mode === "serve") {
  process.stdout.write(`${inspector.url()}\n`);
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else if (mode === "write") {
  const n = Number(count);
  const alpha = [];
  for (let i = 0; i < n; i += 1) alpha.push(new HeapAuditMarker(i));
  globalThis.__lneHeapAudit = { alpha, beta: [new HeapAuditMarker(-1)] };
  v8.writeHeapSnapshot(file);
} else {
  process.stderr.write("usage: heapAuditChild.js serve | write <file> <n>\n");
  process.exitCode = 2;
}
