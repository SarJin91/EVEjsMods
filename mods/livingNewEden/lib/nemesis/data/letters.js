"use strict";

const FRAMES = Object.freeze({
  CREATED: "{nick}, {title} of {gang}, to {pilot}: {body}",
  WON: "{nick}, {title} of {gang}, to {pilot}: {body}",
  DEFEATED: "Last words of {nick}, {title} of {gang}, to {pilot}: {body}",
  RETURN: "{nick} of {gang}: {body}",
});

const TEMPLATES = Object.freeze({
  CREATED: Object.freeze(["You killed my boss and I lived. I will find you again.",
    "Remember my name. You will see my guns again.", "This is not over. I am coming for you."]),
  WON: Object.freeze(["Again you fall. Every loss of yours makes me stronger.",
    "You lost to me once more. Fly while you still can."]),
  DEFEATED: Object.freeze(["You got me at last. Others will finish what I started.",
    "Well flown. My gang will not forget your name."]),
});

const EVENT_PHRASES = Object.freeze({
  CREATED: "fought and survived, and have now sworn to hunt down",
  WON: "have just beaten in battle again",
  DEFEATED: "finally lost to, with your last breath",
  RETURN: "are coming back for right now",
});

const PILOT_FALLBACK = "capsuleer";
const NICK_FALLBACK = "A captain";

module.exports = { FRAMES, TEMPLATES, EVENT_PHRASES, PILOT_FALLBACK, NICK_FALLBACK };
