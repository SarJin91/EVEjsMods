"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SHIM = path.join(__dirname, "better-sqlite3.js");
const PKG = path.join(__dirname, "package.json");
const DRIVER_PACKAGE = "better-sqlite3";

function realDriverLoads() {
  try {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    if (!found.ok) return false;
    const load = Module.createRequire(path.join(path.dirname(found.srcDir), "package.json"));
    return typeof load(DRIVER_PACKAGE) === "function";
  } catch (_err) {
    return false;
  }
}

function installShim() {
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveWithShim(request, parent, isMain, options) {
    if (request === DRIVER_PACKAGE) return SHIM;
    if (request === `${DRIVER_PACKAGE}/package.json`) return PKG;
    return original.call(this, request, parent, isMain, options);
  };
}

if (!realDriverLoads()) installShim();

module.exports = { SHIM };
