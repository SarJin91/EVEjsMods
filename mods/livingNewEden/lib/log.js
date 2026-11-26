"use strict";

const LOG_PREFIX = "[LivingNewEden]";

let debugOn = false;

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, err) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (err && err.stack) console.error(err.stack);
  else if (err !== undefined) console.error(String(err));
}

function debug(message) {
  if (debugOn) console.log(`${LOG_PREFIX} [debug] ${message}`);
}

function setDebug(on) {
  debugOn = on === true;
}

module.exports = { LOG_PREFIX, log, logError, debug, setDebug };
