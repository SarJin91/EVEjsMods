"use strict";

const PACK_ROOT = "content-packs";

function rootOf(relPath, roots) {
  let best = null;
  for (const root of roots) {
    const fits = relPath === root || relPath.startsWith(`${root}/`);
    if (fits && (best === null || root.length > best.length)) best = root;
  }
  return best === null ? relPath.split("/")[0] : best;
}

function emptyResult(state, reason, degraded) {
  return { state, reason, degraded, manifest: null, missing: 0, sizeMismatch: 0, byRoot: {}, first: [],
    packs: { expectedFiles: null, presentFiles: 0, active: null } };
}

function evaluateBuildInputs(input) {
  const read = input && input.read;
  const requireManifest = Boolean(input && input.requireManifest === true);
  const listLimit = input && Number.isSafeInteger(input.listLimit) && input.listLimit > 0 ? input.listLimit : 1;
  if (!read || read.ok !== true) {
    const out = emptyResult("unverified", String((read && read.reason) || "SEAM_UNAVAILABLE"), requireManifest);
    if (read && read.detail) out.detail = String(read.detail);
    return out;
  }
  const active = Array.isArray(read.activePacks) ? read.activePacks.length : null;
  const dropCount = Array.isArray(read.dropFiles) ? read.dropFiles.length : 0;
  if (!read.manifest) {
    const out = emptyResult("unverified", String(read.manifestReason || "MANIFEST_MISSING"), requireManifest);
    out.packs = { expectedFiles: null, presentFiles: dropCount, active };
    return out;
  }
  const manifest = read.manifest;
  const roots = Array.isArray(manifest.guardedRoots) ? manifest.guardedRoots : [];
  const sizes = new Map((read.observed || []).map((o) => [o.path, o.size]));
  const byRoot = {};
  for (const root of roots) byRoot[root] = { expected: 0, missing: 0 };
  const missingPaths = [];
  const sizePaths = [];
  let expectedPacks = 0;
  let presentPacks = 0;
  for (const file of manifest.files) {
    const root = rootOf(file.path, roots);
    if (!byRoot[root]) byRoot[root] = { expected: 0, missing: 0 };
    byRoot[root].expected += 1;
    const size = sizes.has(file.path) ? sizes.get(file.path) : null;
    const isPack = file.path.startsWith(`${PACK_ROOT}/`);
    if (isPack) expectedPacks += 1;
    if (size === null || size === undefined) {
      missingPaths.push(file.path);
      byRoot[root].missing += 1;
    } else {
      if (isPack) presentPacks += 1;
      if (size !== file.size) sizePaths.push(file.path);
    }
  }
  const bad = missingPaths.length + sizePaths.length;
  return {
    state: bad > 0 ? "missing" : "ok",
    reason: bad > 0 ? (missingPaths.length > 0 ? "FILES_MISSING" : "SIZE_MISMATCH") : null,
    degraded: bad > 0,
    manifest: {
      commit: typeof manifest.contextCommit === "string" ? manifest.contextCommit : null,
      generatedAt: typeof manifest.generatedAt === "string" ? manifest.generatedAt : null,
      files: manifest.files.length,
    },
    missing: missingPaths.length,
    sizeMismatch: sizePaths.length,
    byRoot,
    first: [...missingPaths, ...sizePaths].sort().slice(0, listLimit),
    packs: { expectedFiles: expectedPacks, presentFiles: presentPacks, active },
  };
}

function formatBuildInputsLine(result, opts = {}) {
  if (!result || result.state === "skipped") return "buildInputs: disabled_by_config";
  const packs = result.packs || {};
  if (result.state === "ok") {
    const commit = result.manifest && result.manifest.commit ? result.manifest.commit.slice(0, 7) : "unknown";
    const active = packs.active === null ? "?" : packs.active;
    return `buildInputs: ok - ${result.manifest.files} files match docker/build-inputs.json (commit ${commit}, `
      + `content packs ${packs.presentFiles}/${packs.expectedFiles}, active ${active})`;
  }
  if (result.state === "missing") {
    const parts = Object.keys(result.byRoot).sort()
      .filter((root) => root === PACK_ROOT || result.byRoot[root].missing > 0)
      .map((root) => {
        const r = result.byRoot[root];
        return root === PACK_ROOT ? `${root} ${packs.presentFiles}/${packs.expectedFiles}` : `${root} ${r.missing}`;
      });
    const size = result.sizeMismatch > 0 ? `, ${result.sizeMismatch} with another size` : "";
    const when = result.manifest ? ` (manifest commit ${String(result.manifest.commit || "unknown").slice(0, 7)} `
      + `${result.manifest.generatedAt || ""})` : "";
    return `buildInputs: ERROR ${result.missing} file(s) missing from the image (${parts.join(", ")})${size}${when} `
      + `first: ${result.first.join(", ")} - image built without the full overlay, rebuild with tools/deploy (README)`;
  }
  const detail = result.detail ? `: ${result.detail}` : "";
  if (result.reason === "SEAM_UNAVAILABLE" || result.reason === "APP_ROOT_UNKNOWN") {
    return `buildInputs: seam unavailable (${result.reason}${detail}) - inputs unverified`;
  }
  if (opts.requireManifest) {
    return `buildInputs: ERROR no build manifest (${result.reason}) - image not built by tools/deploy, `
      + "inputs unverified";
  }
  return `buildInputs: unverified (${result.reason})`;
}

function buildInputsProblem(result) {
  if (!result || result.degraded !== true) return null;
  const packs = result.packs || {};
  const packText = packs.expectedFiles === null || packs.expectedFiles === undefined ? ""
    : ` (content-packs ${packs.presentFiles}/${packs.expectedFiles})`;
  return `build inputs: ${result.state} - ${result.missing} missing${packText}`
    + (result.state === "unverified" ? ` [${result.reason}]` : "");
}

module.exports = { evaluateBuildInputs, formatBuildInputsLine, buildInputsProblem };
