"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { arcOf, fillTemplate } = require("./data/arcs");
const { ROLES } = require("./data/factions");
const { arcFitsFaction } = require("./siteTemplates");

function templateProposal(offer, seed, S) {
  const rng = createRng(deriveSeed(seed, "template"));
  const arcs = (offer && Array.isArray(offer.arcs) ? offer.arcs : []).map(arcOf).filter((a) => a !== null);
  const total = arcs.reduce((sum, a) => sum + Math.max(0, a.weight), 0);
  if (arcs.length === 0 || total <= 0) return { ok: false, reason: "NO_TEMPLATE" };
  let roll = rng.nextInt(0, total - 1);
  let arc = arcs[arcs.length - 1];
  for (const a of arcs) {
    roll -= Math.max(0, a.weight);
    if (roll < 0) {
      arc = a;
      break;
    }
  }
  const pirates = offer.factions.filter((f) => f.role === ROLES.PIRATE && arcFitsFaction(arc, f.factionId));
  const actors = offer.factions.filter((f) => f.role === ROLES.ACTOR);
  const places = offer.places.filter((p) => arc.securityClasses.includes(p.secClass));
  if (pirates.length === 0 || places.length === 0 || (arc.needsActor && actors.length === 0)) {
    return { ok: false, reason: "NO_TEMPLATE" };
  }
  const faction = rng.pick(pirates);
  const actor = arc.needsActor ? rng.pick(actors) : null;
  const place = rng.pick(places);
  const offered = new Set(offer.stepKinds.map((k) => k.type));
  const names = { system: place.name, region: place.regionName, faction: faction.name, actor: actor ? actor.name : "" };
  const en = arc.texts.en;
  const steps = arc.templateSteps.filter((s) => offered.has(s.t)).slice(0, S.maxStepsPerThread).map((s) => {
    if (s.t === "NOTICE") return { t: "NOTICE", text: fillTemplate(en.notice, names) };
    if (s.t === "SITE") return { t: "SITE", site: arc.siteTemplate, place: place.ref, hours: s.hours };
    return { ...s };
  });
  if (steps.length === 0) return { ok: false, reason: "NO_TEMPLATE" };
  const proposal = { v: 1, arc: arc.key, faction: faction.key, ...(actor ? { actor: actor.key } : {}),
    place: place.ref, title: fillTemplate(en.title, names), hook: fillTemplate(en.hook, names), steps,
    end: { won: fillTemplate(en.won, names), lost: fillTemplate(en.lost, names) } };
  return { ok: true, raw: JSON.stringify(proposal) };
}

module.exports = { templateProposal };
