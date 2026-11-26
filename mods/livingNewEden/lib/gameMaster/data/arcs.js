"use strict";

const ARCS = Object.freeze({
  DEFECTOR: Object.freeze({
    key: "DEFECTOR",
    weight: 2,
    needsActor: true,
    stepKinds: Object.freeze(["NEWS", "NOTICE", "SITE", "WAIT"]),
    requiredKinds: Object.freeze(["SITE"]),
    securityClasses: Object.freeze(["lowsec", "nullsec"]),
    labelNoun: "Kidnappers Complex",
    siteTemplate: "ded_complex",
    templateSteps: Object.freeze([Object.freeze({ t: "NEWS" }), Object.freeze({ t: "NOTICE" }),
      Object.freeze({ t: "SITE", hours: 8 })]),
    texts: Object.freeze({
      en: Object.freeze({
        title: "A defector near {system}",
        hook: "A scientist of the {actor} fled and {faction} raiders took the ship near {system}.",
        notice: "Scouts traced the kidnappers to a complex near {system}.",
        won: "The scientist is free and on the way home to the {actor}.",
        lost: "The kidnappers left {region} with the scientist.",
      }),
      pl: Object.freeze({
        title: "Uciekinier w pobliżu {system}",
        hook: "Naukowiec {actor} uciekł, a piraci {faction} przejęli jego statek w pobliżu {system}.",
        notice: "Zwiadowcy wytropili porywaczy w kompleksie w pobliżu {system}.",
        won: "Naukowiec jest wolny i wraca do {actor}.",
        lost: "Porywacze opuścili {region} razem z naukowcem.",
      }),
    }),
  }),
  MUTINY: Object.freeze({
    key: "MUTINY",
    weight: 3,
    needsActor: false,
    stepKinds: Object.freeze(["NEWS", "NOTICE", "SITE", "WAIT"]),
    requiredKinds: Object.freeze(["SITE"]),
    securityClasses: Object.freeze(["lowsec", "nullsec"]),
    labelNoun: "Mutineer Hideout",
    siteTemplate: "pirate_outpost",
    templateSteps: Object.freeze([Object.freeze({ t: "NEWS" }), Object.freeze({ t: "NOTICE" }),
      Object.freeze({ t: "SITE", hours: 6 }), Object.freeze({ t: "WAIT", hours: 2 })]),
    texts: Object.freeze({
      en: Object.freeze({
        title: "Mutiny in the {faction} fleet",
        hook: "A {faction} crew turned on its officers near {system}.",
        notice: "Pilots report the mutineers hiding in a hideout near {system}.",
        won: "The mutineers near {system} are gone.",
        lost: "The mutineers escaped into deep space.",
      }),
      pl: Object.freeze({
        title: "Bunt we flocie {faction}",
        hook: "Załoga {faction} zbuntowała się przeciw oficerom w pobliżu {system}.",
        notice: "Piloci donoszą, że buntownicy ukrywają się w kryjówce w pobliżu {system}.",
        won: "Buntowników w pobliżu {system} już nie ma.",
        lost: "Buntownicy uciekli w głęboki kosmos.",
      }),
    }),
  }),
  SMUGGLER_CACHE: Object.freeze({
    key: "SMUGGLER_CACHE",
    weight: 2,
    needsActor: false,
    stepKinds: Object.freeze(["NEWS", "NOTICE", "SITE"]),
    requiredKinds: Object.freeze(["SITE"]),
    securityClasses: Object.freeze(["lowsec", "nullsec"]),
    labelNoun: "Smuggler Cache",
    siteTemplate: "battle_relics",
    templateSteps: Object.freeze([Object.freeze({ t: "NEWS" }), Object.freeze({ t: "SITE", hours: 6 })]),
    texts: Object.freeze({
      en: Object.freeze({
        title: "A smuggler cache near {system}",
        hook: "Smugglers of the {faction} hid a cache somewhere near {system}.",
        notice: "The cache near {system} will not stay hidden for long.",
        won: "The cache near {system} is empty now.",
        lost: "The smugglers moved the cache out of {region}.",
      }),
      pl: Object.freeze({
        title: "Skrytka przemytników w pobliżu {system}",
        hook: "Przemytnicy {faction} ukryli skrytkę gdzieś w pobliżu {system}.",
        notice: "Skrytka w pobliżu {system} nie pozostanie długo ukryta.",
        won: "Skrytka w pobliżu {system} jest już pusta.",
        lost: "Przemytnicy wywieźli skrytkę poza {region}.",
      }),
    }),
  }),
  WAR_RUMOUR: Object.freeze({
    key: "WAR_RUMOUR",
    weight: 1,
    needsActor: false,
    stepKinds: Object.freeze(["NEWS", "NOTICE", "WAIT"]),
    requiredKinds: Object.freeze([]),
    securityClasses: Object.freeze(["highsec", "lowsec", "nullsec"]),
    labelNoun: "War Rumour",
    siteTemplate: null,
    templateSteps: Object.freeze([Object.freeze({ t: "NEWS" }), Object.freeze({ t: "NOTICE" }),
      Object.freeze({ t: "WAIT", hours: 6 })]),
    texts: Object.freeze({
      en: Object.freeze({
        title: "War rumours near {system}",
        hook: "Pilots in {system} speak of a {faction} fleet gathering somewhere in {region}.",
        notice: "Scouts near {system} report more {faction} ships on the gates.",
        won: "The {faction} fleet never came to {system}. The rumour fades.",
        lost: "The rumour about the {faction} near {system} goes quiet.",
      }),
      pl: Object.freeze({
        title: "Plotki o wojnie w pobliżu {system}",
        hook: "Piloci w {system} mówią o flocie {faction} zbierającej się gdzieś w {region}.",
        notice: "Zwiadowcy w pobliżu {system} widzą coraz więcej statków {faction} na bramach.",
        won: "Flota {faction} nie przyleciała do {system}. Plotka cichnie.",
        lost: "Plotka o {faction} w pobliżu {system} ucichła.",
      }),
    }),
  }),
});

function arcOf(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(ARCS, key) ? ARCS[key] : null;
}

function fillTemplate(template, names) {
  return String(template).replace(/\{(system|region|faction|actor)\}/g, (_m, k) => {
    const v = names && typeof names[k] === "string" ? names[k] : "";
    return v;
  });
}

module.exports = { ARCS, arcOf, fillTemplate };
