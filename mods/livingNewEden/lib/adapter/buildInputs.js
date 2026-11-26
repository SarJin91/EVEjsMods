"use strict";

const path = require("node:path");

const MANIFEST_SCHEMA = "lne.build-inputs.v1";
const MANIFEST_REL_PARTS = Object.freeze(["docker", "build-inputs.json"]);

function isSafeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath === "") return false;
  if (relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath) || relPath.includes("\\")) return false;
  return relPath.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function manifestProblem(manifest, maxFiles) {
  if (!manifest || typeof manifest !== "object" || manifest.schema !== MANIFEST_SCHEMA) return "MANIFEST_SCHEMA";
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.guardedRoots)) return "MANIFEST_SCHEMA";
  if (manifest.files.length > maxFiles) return "MANIFEST_TOO_LARGE";
  if (!manifest.guardedRoots.every(isSafeRelPath)) return "MANIFEST_SCHEMA";
  for (const file of manifest.files) {
    if (!file || !isSafeRelPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) {
      return "MANIFEST_SCHEMA";
    }
  }
  return null;
}

function readBuildInputsFrom(input) {
  const { dropDirectory, contentPackManager, fs, maxFiles } = input || {};
  if (typeof dropDirectory !== "string" || dropDirectory === "" || !path.isAbsolute(dropDirectory)) {
    return { ok: false, reason: "APP_ROOT_UNKNOWN", detail: "DROP_DIRECTORY" };
  }
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.statSync !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "fs" };
  }
  try {
    const appRoot = path.dirname(dropDirectory);
    let manifest = null;
    let manifestReason = null;
    let text = null;
    try {
      text = fs.readFileSync(path.join(appRoot, ...MANIFEST_REL_PARTS), "utf8");
    } catch (_err) {
      manifestReason = "MANIFEST_MISSING";
    }
    if (text !== null) {
      try {
        manifest = JSON.parse(text);
      } catch (_err) {
        manifestReason = "MANIFEST_JSON";
      }
    }
    if (manifest !== null) {
      manifestReason = manifestProblem(manifest, maxFiles);
      if (manifestReason !== null) manifest = null;
    }
    const observed = [];
    for (const file of manifest ? manifest.files : []) {
      let size = null;
      try {
        const stat = fs.statSync(path.join(appRoot, ...file.path.split("/")));
        size = stat.isFile() ? stat.size : null;
      } catch (_err) {
        size = null;
      }
      observed.push({ path: file.path, size });
    }
    let dropFiles = [];
    try {
      dropFiles = fs.readdirSync(dropDirectory).filter((name) => /\.json$/i.test(name)).sort();
    } catch (_err) {
      dropFiles = [];
    }
    let activePacks = null;
    try {
      const registry = contentPackManager && typeof contentPackManager.readRegistry === "function"
        ? contentPackManager.readRegistry() : null;
      if (registry && Array.isArray(registry.installed)) {
        activePacks = registry.installed.map((e) => ({ id: String(e && e.id), version: String(e && e.version) }));
      }
    } catch (_err) {
      activePacks = null;
    }
    return { ok: true, manifest, manifestReason, observed, dropFiles, activePacks };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
}

module.exports = { MANIFEST_SCHEMA, readBuildInputsFrom };
