// Ported with changes from X-Eve xEveLedger.js (stableValue, fingerprint); the change is the strict plain-JSON validation and the cycle check (see CREDITS.md).

"use strict";

const crypto = require("node:crypto");

function describe(value) {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const proto = Object.getPrototypeOf(value);
  return proto && proto.constructor && proto.constructor.name ? proto.constructor.name : "object";
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value, pathText, stack) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`stableJson: ${pathText} is not a finite number (${value})`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`stableJson: ${pathText} is ${typeof value}, not JSON data`);
  }
  if (stack.includes(value)) throw new TypeError(`stableJson: ${pathText} is a cycle`);
  stack.push(value);
  try {
    if (Array.isArray(value)) {
      const parts = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          throw new TypeError(`stableJson: ${pathText}[${i}] is a hole`);
        }
        parts.push(encode(value[i], `${pathText}[${i}]`, stack));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(value)) throw new TypeError(`stableJson: ${pathText} is ${describe(value)}, not a plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`stableJson: ${pathText} has a symbol key`);
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${encode(value[key], `${pathText}.${key}`, stack)}`);
    return `{${parts.join(",")}}`;
  } finally {
    stack.pop();
  }
}

function stableJson(value) {
  return encode(value, "$", []);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function fingerprintWithPayloadJson(head, payloadJson) {
  if (head === null || typeof head !== "object" || Array.isArray(head) || !isPlainObject(head)) {
    throw new TypeError(`fingerprintWithPayloadJson: head is ${describe(head)}, not a plain object`);
  }
  if (Object.getOwnPropertySymbols(head).length > 0) {
    throw new TypeError("fingerprintWithPayloadJson: head has a symbol key");
  }
  if (Object.prototype.hasOwnProperty.call(head, "payload")) {
    throw new TypeError("fingerprintWithPayloadJson: head has a \"payload\" key");
  }
  if (typeof payloadJson !== "string") throw new TypeError("fingerprintWithPayloadJson: payloadJson is not a string");
  const stack = [head];
  const keys = [...Object.keys(head), "payload"].sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${key === "payload"
    ? payloadJson : encode(head[key], `$.${key}`, stack)}`);
  return crypto.createHash("sha256").update(`{${parts.join(",")}}`).digest("hex");
}

module.exports = { stableJson, fingerprint, fingerprintWithPayloadJson };
