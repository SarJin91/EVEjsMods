"use strict";

let dungeonRuntime = null;
let dungeonTrackingRuntime = null;
const sink = {};

function processPaidMissionMiningObjective(scene, instance) {
  sink.a1 = instance;
}

function maybeAdvanceExplicitlySatisfiedObjective(instance) {
  sink.advanceArg = instance;
  sink.advanceInner = dungeonRuntime.getInstance(instance.instanceID) || instance;
}

function processGateDefenseHazards(scene, instance) {
  sink.gate = dungeonRuntime.getInstance(instance.instanceID);
}

function otherSiteFunction(instance) {
  sink.otherFunction = dungeonRuntime.getInstance(instance.instanceID);
}

function tickSceneSiteBehaviors(scene, instance) {
  sink.nonAnchor = dungeonRuntime.getInstance(instance.instanceID) || instance;
  processPaidMissionMiningObjective(scene, dungeonRuntime.getInstance(instance.instanceID) || instance,
    null, {});
  const refreshedForObjective =
    dungeonRuntime.getInstance(instance.instanceID) || instance;
  sink.a2 = refreshedForObjective;
  maybeAdvanceExplicitlySatisfiedObjective(refreshedForObjective);
  dungeonTrackingRuntime.processGuideApproachTexts(scene, dungeonRuntime.getInstance(instance.instanceID) || instance);
  processGateDefenseHazards(scene, instance);
  return sink;
}

function setDeps(runtime, tracking) {
  dungeonRuntime = runtime;
  dungeonTrackingRuntime = tracking;
}

module.exports = {
  maybeAdvanceExplicitlySatisfiedObjective,
  otherSiteFunction,
  processGateDefenseHazards,
  setDeps,
  sink,
  tickSceneSiteBehaviors,
};
