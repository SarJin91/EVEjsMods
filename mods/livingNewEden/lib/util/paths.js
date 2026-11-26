"use strict";

const path = require("node:path");

function isInside(parentDir, candidate) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = { isInside };
