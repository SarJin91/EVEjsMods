"use strict";

const { fork } = require("node:child_process");
const { Worker, isMainThread, workerData } = require("node:worker_threads");

function report(kind) {
  process.stdout.write(`${JSON.stringify({
    probe: "LNE-AFTER-START",
    kind,
    pid: process.pid,
    isMainThread,
    hasProcessSend: typeof process.send === "function",
    roleAfterStart: process.env.EVEJS_GAMESTORE_OWNER_ROLE || null,
    workerData: workerData || null,
  })}\n`);
}

function runWorkers() {
  return Promise.all([
    new Promise((resolve) => {
      const w = new Worker(__filename);
      w.on("exit", resolve);
    }),
    new Promise((resolve) => {
      const w = new Worker(__filename, { workerData: { style: "persistenceWorker" } });
      w.on("exit", resolve);
    }),
  ]);
}

if (!isMainThread) {
  report("worker-thread");
} else if (process.argv.includes("--child")) {
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";
  report("forked-child");
  if (typeof process.send === "function") process.send({ ok: true });
  process.disconnect();
} else {
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = "world";
  report("parent-world");
  const child = fork(__filename, ["--child"], {
    cwd: process.cwd(),
    env: { ...process.env },
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  child.on("exit", () => {
    runWorkers().then(() => {
      process.stdout.write(`${JSON.stringify({ probe: "LNE-DONE", node: process.version })}\n`);
    });
  });
}
