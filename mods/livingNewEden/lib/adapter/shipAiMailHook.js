"use strict";

const WRAPPED = Symbol.for("livingNewEden.shipAiMail");
const METHOD = "sendMailSentNotification";

const listeners = new Set();
let installed = false;
let listenerCalls = 0;
let listenerErrors = 0;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function notify(characterID, message) {
  try {
    if (listeners.size === 0 || !message || typeof message !== "object") return;
    const characterId = positiveInt(characterID);
    const messageId = positiveInt(message.messageID);
    const senderId = positiveInt(message.senderID);
    if (characterId === null || messageId === null || characterId === senderId) return;
    const facts = Object.freeze({ characterId, messageId, senderId });
    for (const fn of [...listeners]) {
      listenerCalls += 1;
      try {
        fn(facts);
      } catch (_err) {
        listenerErrors += 1;
      }
    }
  } catch (_err) {
  }
}

function makeWrapper(original) {
  const wrapper = function livingNewEdenShipAiMail(characterID, message, _statusMask, _options) {
    try {
      return original.apply(this, arguments);
    } finally {
      notify(characterID, message);
    }
  };
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_${METHOD}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== WRAPPED) wrapper[s] = original[s];
  }
  wrapper[WRAPPED] = true;
  return wrapper;
}

function install(mailNotificationsExports) {
  const e = mailNotificationsExports;
  if (!e || (typeof e !== "object" && typeof e !== "function")
    || !Object.prototype.hasOwnProperty.call(e, METHOD) || typeof e[METHOD] !== "function") {
    return { ok: false, reason: "PRIMARY_MISSING" };
  }
  if (e[METHOD][WRAPPED] === true) {
    installed = true;
    return { ok: true, installed: true, alreadyInstalled: true };
  }
  const desc = Object.getOwnPropertyDescriptor(e, METHOD);
  if (Object.isFrozen(e) || !desc || (desc.writable !== true && typeof desc.set !== "function")) {
    return { ok: false, reason: "SEAM_NOT_WRITABLE" };
  }
  e[METHOD] = makeWrapper(e[METHOD]);
  installed = true;
  return { ok: true, installed: true };
}

function addListener(fn) {
  if (typeof fn !== "function") return { ok: false, reason: "LISTENER_INVALID" };
  listeners.add(fn);
  return { ok: true, remove: () => removeListener(fn) };
}

function removeListener(fn) {
  return listeners.delete(fn);
}

function isInstalled() {
  return installed;
}

function listenerStats() {
  return { listeners: listeners.size, listenerCalls, listenerErrors };
}

module.exports = { install, addListener, removeListener, isInstalled, listenerStats, WRAPPED, METHOD };
