"use strict";

const { runSegmentOne } = require("../benchCampaign");

function send(message) {
  return new Promise((resolve) => {
    if (typeof process.send !== "function") {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

process.once("message", (m) => {
  if (!m || m.type !== "start") {
    process.exit(2);
    return;
  }
  runSegmentOne(m.opts, send)
    .catch((err) => send({ type: "refused", reason: "SEGMENT_THREW", detail: String((err && err.stack) || err) }))
    .then(() => process.exit(0));
});
