"use strict";

const crypto = require("node:crypto");
const { fingerprintFunctions } = require("./essRepositoryFast");
const { methodBody } = require("./starmapOverlay");

const CONSUMER = "devIndices.client";
const SERVICE_PATH = "services/map/devIndexManagerService";
const STATE_PATH = "services/sovereignty/sovState";
const PAYLOADS_PATH = "services/sovereignty/sovPayloads";
const CONSTANTS_PATH = "services/sovereignty/sovConstants";
const SYSTEM_METHOD = "Handle_GetDevelopmentIndicesForSystem";
const ALL_METHOD = "Handle_GetAllDevelopmentIndices";
const METHODS = Object.freeze([SYSTEM_METHOD, ALL_METHOD]);
const MARKER = Symbol.for("livingNewEden.devIndexClient");

const METHOD_SHA1 = Object.freeze({
  [SYSTEM_METHOD]: "1c218d45ded8135c71b7a8856aa91100e5f1d1ee",
  [ALL_METHOD]: "8b073d480d223e3c810f90813a877ebe2540a4a8",
});
const PAYLOAD_SHA1 = Object.freeze({
  buildDevelopmentIndicesForSystemPayload: "aa9a09880f7b2892b3ad8455d24630ed1cffa2db",
  buildAllDevelopmentIndicesPayload: "28cd4bb6da1c7863e96cfe0f6f9f90a8ec4d9da4",
});
const STATE_SHA1 = Object.freeze({
  getSystemState: "e2222314b9fdbb570d7a8002e7b241837e5e1b06",
  getDevelopmentIndicesForSystem: "1a68f65db1e7f35b640f1cfcd22d82cf83350148",
  listAllDevelopmentIndices: "c28883710860aa2a027f30fb61d64e7c6cf224fd",
  listAllAllianceSystems: "9fe89fd1ab49152e429ab4fbed984d3a0dcfe262",
});
const SERVICE_EXPORT_LINE = "module.exports = DevIndexManagerService;";
const SERVICE_STATE_REQUIRE = ["} = require", "(\"../sovereignty/sovState\");"].join("");
const SERVICE_PAYLOADS_REQUIRE = ["} = require", "(\"../sovereignty/sovPayloads\");"].join("");
const CONSTANT_LINES = Object.freeze(["const ATTRIBUTE_DEV_INDEX_MILITARY = 1583;",
  "const ATTRIBUTE_DEV_INDEX_INDUSTRIAL = 1584;", "const DEV_INDEX_LEVEL_WIDTH = 100000 * 96;"]);
const VENDOR_FUNCTIONS = Object.freeze(["getSystemState", "getDevelopmentIndicesForSystem",
  "listAllDevelopmentIndices", "listAllAllianceSystems", "buildSystemPayload", "buildAllPayload"]);
const STATE = Object.freeze({ OFF: "off", ACTIVE: "active", REFUSED: "refused" });

const client = { state: STATE.OFF, reason: null, served: 0, claimed: 0, failed: 0, target: null, entries: [],
  slot: null };

const lf = (text) => String(text).replace(/\r\n/g, "\n");
const sha1Of = (text) => (text === null ? null : crypto.createHash("sha1").update(text).digest("hex"));
const refuse = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) });

function driftDetail(texts) {
  const t = texts || {};
  const svcFile = `${SERVICE_PATH}.js`;
  if (typeof t.service !== "string") return `${svcFile}:missing`;
  const service = lf(t.service);
  for (const name of METHODS) {
    if (sha1Of(methodBody(service, name)) !== METHOD_SHA1[name]) return `${svcFile}:${name}`;
  }
  if (!service.includes(SERVICE_EXPORT_LINE)) return `${svcFile}:module.exports`;
  if (!service.includes(SERVICE_STATE_REQUIRE) || !service.includes(SERVICE_PAYLOADS_REQUIRE)) {
    return `${svcFile}:destructuring`;
  }
  for (const [rel, text, table] of [[PAYLOADS_PATH, t.payloads, PAYLOAD_SHA1], [STATE_PATH, t.state, STATE_SHA1]]) {
    if (typeof text !== "string") return `${rel}.js:missing`;
    const got = fingerprintFunctions(lf(text), Object.keys(table));
    for (const name of Object.keys(table)) {
      if (got.get(name) !== table[name]) return `${rel}.js:${name}`;
    }
  }
  if (typeof t.constants !== "string") return `${CONSTANTS_PATH}.js:missing`;
  const constants = lf(t.constants);
  for (const line of CONSTANT_LINES) {
    if (!constants.includes(line)) return `${CONSTANTS_PATH}.js:${line.split(" ")[1]}`;
  }
  return null;
}

function event(name) {
  client[name] += 1;
  const fn = client.slot && client.slot.onEvent;
  if (typeof fn !== "function") return;
  try {
    fn(name);
  } catch (_err) {
  }
}

function makeSystemWrapper(original, slot) {
  return function Handle_GetDevelopmentIndicesForSystem(args, session) {
    if (!slot.active) return original.apply(this, arguments);
    let payload = null;
    try {
      const solarSystemID =
        Number(
          args && args.length > 0
            ? args[0]
            : session && (session.solarsystemid2 || session.solarsystemid),
        ) || 0;
      const st = slot.vendor.getSystemState(solarSystemID);
      if (st && Number(st.allianceID) > 0) {
        event("claimed");
      } else {
        const vendorIdx = slot.vendor.getDevelopmentIndicesForSystem(solarSystemID);
        const out = slot.provider.projectSystem(solarSystemID, vendorIdx, slot.K);
        if (out !== null && out !== undefined) {
          payload = slot.vendor.buildSystemPayload(out);
          event("served");
        }
      }
    } catch (_err) {
      payload = null;
      event("failed");
    }
    return payload !== null && payload !== undefined ? payload : original.apply(this, arguments);
  };
}

function makeAllWrapper(original, slot) {
  return function Handle_GetAllDevelopmentIndices(args, session) {
    if (!slot.active) return original.apply(this, arguments);
    let payload = null;
    try {
      const vendor = slot.vendor.listAllDevelopmentIndices();
      const alliances = slot.vendor.listAllAllianceSystems();
      const claimed = new Set((Array.isArray(alliances) ? alliances : []).map((r) => Number(r && r.solarSystemID)));
      const recs = slot.provider.projectAll(Array.isArray(vendor) ? vendor : [], claimed, slot.K);
      if (Array.isArray(recs)) {
        payload = slot.vendor.buildAllPayload(recs);
        event("served");
      }
    } catch (_err) {
      payload = null;
      event("failed");
    }
    return payload !== null && payload !== undefined ? payload : original.apply(this, arguments);
  };
}

function wrapPrototype(proto, name, makeWrapper) {
  const original = proto[name];
  if (typeof original !== "function" || original[MARKER]) return { ok: false };
  const wrapper = makeWrapper(original);
  Object.defineProperty(wrapper, MARKER, { value: true });
  proto[name] = wrapper;
  return proto[name] === wrapper ? { ok: true, original, wrapper } : { ok: false };
}

function restore(target, entries) {
  for (const e of entries) {
    try {
      if (target[e.name] === e.wrapper) target[e.name] = e.original;
    } catch (_err) {
    }
  }
}

function refused(reason, detail) {
  if (reason !== "HOOK_ALREADY_INSTALLED") Object.assign(client, { state: STATE.REFUSED, reason });
  return refuse(reason, detail);
}

function installWrappers(serviceClass, provider, vendor, K, onEvent) {
  if (client.state === STATE.ACTIVE) return refuse("HOOK_ALREADY_INSTALLED");
  const proto = serviceClass && serviceClass.prototype;
  if (typeof serviceClass !== "function" || !proto || METHODS.some((m) => typeof proto[m] !== "function")) {
    return refused("DEV_CLIENT_SEAM_UNAVAILABLE", "devIndexManagerService handlers");
  }
  if (METHODS.some((m) => proto[m][MARKER])) return refuse("HOOK_ALREADY_INSTALLED");
  const slot = { active: true, provider, vendor, K, onEvent: typeof onEvent === "function" ? onEvent : null };
  const entries = [];
  for (const [name, make] of [[SYSTEM_METHOD, makeSystemWrapper], [ALL_METHOD, makeAllWrapper]]) {
    const w = wrapPrototype(proto, name, (original) => make(original, slot));
    if (!w.ok) {
      slot.active = false;
      restore(proto, entries);
      return refused("DEV_CLIENT_SEAM_UNAVAILABLE", `${name} not writable`);
    }
    entries.push({ name, original: w.original, wrapper: w.wrapper });
  }
  Object.assign(client, { state: STATE.ACTIVE, reason: null, target: proto, entries, slot });
  return { ok: true };
}

function installDevIndexClient(serviceClass, provider, opts) {
  if (client.state === STATE.ACTIVE) return refuse("HOOK_ALREADY_INSTALLED");
  const o = opts || {};
  try {
    if (!provider || typeof provider.projectSystem !== "function" || typeof provider.projectAll !== "function") {
      return refused("DEV_CLIENT_SEAM_UNAVAILABLE", "no provider");
    }
    const vendor = o.vendor || {};
    const missing = VENDOR_FUNCTIONS.find((n) => typeof vendor[n] !== "function");
    if (missing) return refused("DEV_CLIENT_SEAM_UNAVAILABLE", missing);
    const K = o.K || {};
    if (!Number.isSafeInteger(K.levelWidth) || K.levelWidth < 1 || !Number.isSafeInteger(K.militaryAttr)
      || !Number.isSafeInteger(K.industrialAttr)) return refused("DEV_CLIENT_SEAM_UNAVAILABLE", "sovConstants");
    const proto = typeof serviceClass === "function" ? serviceClass.prototype : null;
    if (!proto || METHODS.some((m) => typeof proto[m] !== "function")) {
      return refused("DEV_CLIENT_SEAM_UNAVAILABLE", "devIndexManagerService handlers");
    }
    if (METHODS.some((m) => proto[m][MARKER])) return refuse("HOOK_ALREADY_INSTALLED");
    const drift = driftDetail(o.texts);
    if (drift !== null) return refused("DEV_CLIENT_DRIFT", drift);
    const service = lf(o.texts.service);
    for (const name of METHODS) {
      if (lf(Function.prototype.toString.call(proto[name])) !== methodBody(service, name)) {
        return refused("DEV_CLIENT_DRIFT", `${SERVICE_PATH}.js:${name} not the vendor method`);
      }
    }
    return installWrappers(serviceClass, provider, Object.freeze({ ...vendor }), Object.freeze({ ...K }),
      provider.onEvent);
  } catch (err) {
    return refused("DEV_CLIENT_SEAM_UNAVAILABLE", (err && err.message) || err);
  }
}

function uninstallDevIndexClient() {
  if (client.state !== STATE.ACTIVE) return { ok: true };
  client.slot.active = false;
  restore(client.target, client.entries);
  Object.assign(client, { state: STATE.OFF, reason: null, target: null, entries: [], slot: null });
  return { ok: true };
}

function devIndexClientStatus() {
  const state = client.state === STATE.REFUSED ? `${STATE.REFUSED}:${client.reason}` : client.state;
  return { state, served: client.served, claimed: client.claimed, failed: client.failed };
}

module.exports = { CONSUMER, SERVICE_PATH, STATE_PATH, PAYLOADS_PATH, CONSTANTS_PATH, SYSTEM_METHOD, ALL_METHOD,
  METHODS, MARKER, METHOD_SHA1, PAYLOAD_SHA1, STATE_SHA1, driftDetail, wrapPrototype, makeSystemWrapper,
  makeAllWrapper, installWrappers, installDevIndexClient, uninstallDevIndexClient, devIndexClientStatus };
