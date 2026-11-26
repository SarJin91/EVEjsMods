"use strict";

const path = require("node:path");

const GAMESTORE_SEARCH_MAX_DEPTH = 6;
const GAMESTORE_ENTRY = path.join("gameStore", "index.js");
const SRC_DIR_NAME = "src";
const SERVER_DIR_NAME = "server";

function hasOwn(value, property) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && Object.prototype.hasOwnProperty.call(value, property);
}

function findServerSrcInCache(cache, startFile, maxDepth) {
  if (!cache || typeof startFile !== "string" || startFile === "") {
    return { ok: false, reason: "gamestore_not_cached" };
  }
  let dir = path.dirname(startFile);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const srcDir of [dir, path.join(dir, SRC_DIR_NAME)]) {
      const key = path.join(srcDir, GAMESTORE_ENTRY);
      if (hasOwn(cache, key)) {
        const entry = cache[key];
        return { ok: true, srcDir, gameStoreExports: entry ? entry.exports : undefined };
      }
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }
  return { ok: false, reason: "gamestore_not_cached" };
}

function findServerSrcOnDisk(startDir, maxDepth, existsSync) {
  if (typeof startDir !== "string" || startDir === "" || typeof existsSync !== "function") {
    return { ok: false, reason: "server_src_not_found" };
  }
  let dir = startDir;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const srcDir = path.join(dir, SERVER_DIR_NAME, SRC_DIR_NAME);
    if (existsSync(path.join(srcDir, GAMESTORE_ENTRY))) return { ok: true, srcDir };
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }
  return { ok: false, reason: "server_src_not_found" };
}

function findCachedProcessRole(cache, startFile, maxDepth) {
  const found = findServerSrcInCache(cache, startFile, maxDepth);
  if (!found.ok) return found;
  const exportsObject = found.gameStoreExports;
  return {
    ok: true,
    processRole: hasOwn(exportsObject, "_processRole") ? exportsObject._processRole : undefined,
    srcDir: found.srcDir,
  };
}

function processRoleFromWorld(world) {
  if (!hasOwn(world, "database") || world.database === null || typeof world.database !== "object") {
    return { ok: false, reason: "world_invalid" };
  }
  const database = world.database;
  return { ok: true, processRole: hasOwn(database, "_processRole") ? database._processRole : undefined };
}

module.exports = {
  GAMESTORE_SEARCH_MAX_DEPTH,
  findServerSrcInCache,
  findServerSrcOnDisk,
  findCachedProcessRole,
  processRoleFromWorld,
};
