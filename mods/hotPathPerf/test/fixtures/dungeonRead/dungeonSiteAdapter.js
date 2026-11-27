"use strict";

let dungeonAuthority = null;

function resolveTemplateForSite(templateID) {
  const get = (name, value) => dungeonAuthority[name](value);
  return get("getTemplateByID", templateID);
}

function enrichSiteWithDungeonRuntime(site) {
  return {
    direct: dungeonAuthority.getTemplateByID(site.templateID),
    viaGet: resolveTemplateForSite(site.templateID),
  };
}

function setDeps(authority) {
  dungeonAuthority = authority;
}

module.exports = { enrichSiteWithDungeonRuntime, resolveTemplateForSite, setDeps };
