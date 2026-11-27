"use strict";

const { isMainThread, threadId } = require("node:worker_threads");

const line = {
  probe: "LNE-PRELOAD",
  pid: process.pid,
  isMainThread,
  threadId,
  hasProcessSend: typeof process.send === "function",
  roleAtPreload: process.env.EVEJS_GAMESTORE_OWNER_ROLE || null,
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS || null,
  argv1: process.argv[1] ? require("node:path").basename(process.argv[1]) : null,
};

process.stdout.write(`${JSON.stringify(line)}\n`);
