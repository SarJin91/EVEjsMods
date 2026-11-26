"use strict";

const ESCALATION_VERSION = 1;

const step = (role, source) => Object.freeze({ role, source });

const ESCALATION_STEPS = Object.freeze({
  patrol: Object.freeze([step("patrol", "templates"), step("invasion", "templates"),
    step("invasion", "stockTemplates")]),
  invasion: Object.freeze([step("invasion", "templates"), step("invasion", "stockTemplates")]),
  garrison: Object.freeze([step("garrison", "templates"), step("garrison", "stockTemplates"),
    step("invasion", "templates"), step("invasion", "stockTemplates")]),
});

module.exports = { ESCALATION_VERSION, ESCALATION_STEPS };
