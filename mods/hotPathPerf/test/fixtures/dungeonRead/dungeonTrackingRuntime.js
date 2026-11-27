"use strict";

let dungeonAuthority = null;

function resolveTemplate(instance) {
  return dungeonAuthority.getTemplateByID(instance.templateID);
}

function guideSiteOfShip(instance) {
  return resolveTemplate(instance);
}

function processGuideApproachTexts(scene, instance) {
  return {
    viaResolve: resolveTemplate(instance),
    direct: dungeonAuthority.getTemplateByID(instance.templateID),
    viaGuideSite: guideSiteOfShip(instance),
  };
}

function setDeps(authority) {
  dungeonAuthority = authority;
}

module.exports = { guideSiteOfShip, processGuideApproachTexts, resolveTemplate, setDeps };
