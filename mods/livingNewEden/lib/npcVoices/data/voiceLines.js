"use strict";

const CONTEXTS = Object.freeze(["CHATTER", "ADDRESS", "SITE_ARRIVAL", "SITE_BANTER"]);
const FAME_CONTEXTS = Object.freeze(["FAME_LEGEND", "FAME_ENEMY"]);
const PLACEHOLDERS = Object.freeze(["system", "pilot"]);

const CONTEXT_HINTS = Object.freeze({
  CHATTER: "the crew of an NPC fleet talking among themselves on the Local channel of a star system",
  ADDRESS: "an NPC fleet pilot speaking to a capsuleer who is in the same star system, on Local",
  SITE_ARRIVAL: "an NPC pilot reacting when a capsuleer warps into the combat site the NPCs guard",
  SITE_BANTER: "NPC pilots in a combat site talking to each other while a capsuleer is there",
  FAME_LEGEND: "an NPC pilot on Local recognizing a famous capsuleer, a hero of the pilot's own faction, in the same "
    + "star system",
  FAME_ENEMY: "an NPC pilot on Local recognizing a capsuleer the pilot's faction has declared a public enemy, in the "
    + "same star system",
});

const TEXTS = {
  GURISTAS: {
    CHATTER: [
      "Quiet night in {system}. Too quiet for honest pirates.",
      "Who left the cargo scanner on? It keeps pinging empty haulers.",
      "Boss says the next Caldari convoy is ours. Boss says a lot of things.",
      "If anyone sees a shiny Raven, call it in. Finders keepers.",
    ],
    ADDRESS: [
      "Hey {pilot}, nice ship. Would be a shame if it changed owners.",
      "{pilot}, you look lost. Guristas give directions for a small fee.",
      "Smile, {pilot}. You are on the Guristas wanted list now.",
      "Fly safe in {system}. Or do not, we like loot either way.",
    ],
    SITE_ARRIVAL: [
      "Look who warped in. Lock that one up, boys.",
      "{pilot} brought us a present. It is called a hull.",
      "Uninvited guest on grid. Guristas hospitality, everyone!",
    ],
    SITE_BANTER: [
      "Is that a capsuleer or just a very lost miner?",
      "Keep the missiles warm, this one looks expensive.",
      "Last guy who tried this is now a nice wreck field.",
    ],
  },
  ANGEL: {
    CHATTER: [
      "Dominations wants the take from {system} by downtime. No excuses.",
      "Salvation pays well for clean salvage. Do not scratch the wrecks.",
      "Our Archangels are bored. Find them something to shoot.",
    ],
    ADDRESS: [
      "{pilot}, the Cartel owns this lane. Pay or burn.",
      "Nothing personal, {pilot}. You just have too much ISK.",
      "Turn around, {pilot}. The Cartel does not do second warnings.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. Price just went up.",
      "{pilot} wants to die rich. Help them with the second part.",
      "Weapons free. The Cartel collects.",
    ],
    SITE_BANTER: [
      "Watch the flank, they always come from the gate side.",
      "Whoever gets the kill buys the drinks on Serpentis turf.",
      "Keep it tight. We have done this a hundred times.",
    ],
  },
  BLOOD: {
    CHATTER: [
      "The harvest in {system} was thin. Omir will not be pleased.",
      "Keep the vats sealed. The blood must stay warm.",
      "The Covenant sees every ship that passes through {system}.",
    ],
    ADDRESS: [
      "{pilot}, your blood would honour the Covenant.",
      "We can hear your heartbeat, {pilot}. So steady. For now.",
      "Do not run, {pilot}. It only thins the blood.",
    ],
    SITE_ARRIVAL: [
      "A fresh vessel arrives. Prepare the collectors.",
      "{pilot} came willingly. How generous.",
      "Another offering for the altar. Bring it closer.",
    ],
    SITE_BANTER: [
      "Mind the pods. Clones keep the blood fresh for us.",
      "The harvest begins. Sing, brothers.",
      "Leave the hull intact. The crew is what we need.",
    ],
  },
  SANSHA: {
    CHATTER: [
      "We are many in {system}. We are one in purpose.",
      "The Master watches. The Nation grows.",
      "Each new voice joins the chorus. None are lost.",
    ],
    ADDRESS: [
      "{pilot}, you will be welcomed into the Nation.",
      "Your loneliness ends soon, {pilot}. We are coming.",
      "Resistance is a habit, {pilot}. Habits can be removed.",
    ],
    SITE_ARRIVAL: [
      "A new mind approaches. Prepare the embrace.",
      "{pilot}, you have been expected.",
      "The Nation greets you. You will not leave alone.",
    ],
    SITE_BANTER: [
      "We think as one. Flank as one.",
      "Another voice for the chorus. Take it gently.",
      "The Master is pleased with this harvest.",
    ],
  },
  SERPENTIS: {
    CHATTER: [
      "Fresh shipment of boosters on the way to {system}. Discreetly.",
      "The Corporation thanks you for your continued silence.",
      "Labs are running hot tonight. Keep the customs scans away.",
    ],
    ADDRESS: [
      "{pilot}, interested in a little performance boost? First dose is cheap.",
      "We see everything you haul, {pilot}. Shall we talk business?",
      "No need for violence, {pilot}. Just leave the cargo and go.",
    ],
    SITE_ARRIVAL: [
      "Unexpected visitor. Please hold still for the scan.",
      "{pilot}, this is a private facility. Leave or be removed.",
      "Security, we have a capsuleer in the lab wing.",
    ],
    SITE_BANTER: [
      "Keep them away from the drug lab, that stock is expensive.",
      "Professional work, gentlemen. No mess.",
      "Salvador said no witnesses. Act accordingly.",
    ],
  },
  DEATHLESS: {
    CHATTER: [
      "Empires send patrols to {system}. Zarzakh sends them back in pieces.",
      "The Circle remembers every debt. Pay yours.",
      "Keep the gate camp tight. Nobody passes without our word.",
    ],
    ADDRESS: [
      "{pilot}, you are far from imperial protection.",
      "No law here, {pilot}. Only the Circle.",
      "Keep moving, {pilot}. Or stay and learn our rules.",
    ],
    SITE_ARRIVAL: [
      "Outsider on grid. Bring them down.",
      "{pilot} walked into Circle space. Bad choice.",
      "The Deathless do not take prisoners. Engage.",
    ],
    SITE_BANTER: [
      "Hold the line. Zarzakh is watching.",
      "Another empire dog. Same end.",
      "Strip the wreck after. The Circle wastes nothing.",
    ],
  },
  AMARR: {
    CHATTER: [
      "Patrol of {system} complete. The Empress keeps her peace.",
      "Prayers at the hour of watch. Order is maintained.",
      "All holders report loyal. God watches over the Empire.",
    ],
    ADDRESS: [
      "Capsuleer {pilot}, you fly under the sight of the Empress.",
      "{pilot}, Amarr space welcomes the faithful and the lawful.",
      "Remember the Scriptures, {pilot}. The faithful prosper.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. State your purpose before the Empire.",
      "{pilot}, you enter a site under imperial guard.",
      "Hold your fire. The Navy will judge your intent.",
    ],
    SITE_BANTER: [
      "Formation holds. The Lord guides our guns.",
      "Report to command. A capsuleer is present.",
      "Remain vigilant. Heretics hide in such places.",
    ],
  },
  CALDARI: {
    CHATTER: [
      "Sector {system} secure. Efficiency rating nominal.",
      "Convoy schedule confirmed. Delays are not tolerated.",
      "The State expects every pilot to meet quota.",
    ],
    ADDRESS: [
      "Capsuleer {pilot}, comply with State traffic regulations.",
      "{pilot}, Caldari space is a place of order and contract.",
      "Your business in {system} is noted, {pilot}.",
    ],
    SITE_ARRIVAL: [
      "Unregistered capsuleer on grid. Identify yourself.",
      "{pilot}, this operation is under State authority.",
      "Contact logged. Weapons on standby.",
    ],
    SITE_BANTER: [
      "Hold formation. The Navy does not improvise.",
      "Log the contact. Command wants a full report.",
      "Stay on task. The contract comes first.",
    ],
  },
  GALLENTE: {
    CHATTER: [
      "Liberty patrol in {system} reports all clear.",
      "Remember, the Federation stands for every free citizen.",
      "Election broadcasts tonight. Vote early, fly safe.",
    ],
    ADDRESS: [
      "Welcome, {pilot}. The Federation protects free pilots.",
      "{pilot}, freedom is a shared duty. Fly with care.",
      "Federation space is open to all, {pilot}. Respect the law.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. The Navy has this site under control.",
      "{pilot}, please keep a respectful distance.",
      "Visitor detected. Be civil and we will be too.",
    ],
    SITE_BANTER: [
      "Keep it professional, the press is always watching.",
      "Hold position. Liberty does not rush.",
      "Report the capsuleer. Command likes paperwork.",
    ],
  },
  MINMATAR: {
    CHATTER: [
      "The clans keep watch over {system}. No slaver passes.",
      "Freedom was not given to us. We took it.",
      "Tribal fleet on station. The Republic stands.",
    ],
    ADDRESS: [
      "{pilot}, Republic space is free space. Keep it that way.",
      "Fly proud, {pilot}. The clans remember their friends.",
      "No chains here, {pilot}. Only the open sky.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. Friend or slaver?",
      "{pilot}, show your colours.",
      "Contact. The clans will decide.",
    ],
    SITE_BANTER: [
      "Rust and guts, brothers. Hold the line.",
      "If they are Amarr, no mercy.",
      "Keep the guns loud. The Republic hears us.",
    ],
  },
  CONCORD: {
    CHATTER: [
      "Routine patrol in {system}. All parties within regulations.",
      "Reminder: unlawful aggression in secure space is answered.",
      "DED reports normal traffic. Stay vigilant.",
    ],
    ADDRESS: [
      "Capsuleer {pilot}, CONCORD reminds you of the law in {system}.",
      "{pilot}, aggression in secure space carries consequences.",
      "Your security status is noted, {pilot}. Fly lawfully.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. This area is under CONCORD supervision.",
      "{pilot}, maintain lawful conduct.",
      "Presence logged. Proceed with caution.",
    ],
    SITE_BANTER: [
      "Record all engagements for review.",
      "Unit two, hold position. No unlawful fire.",
      "Regulations apply here as everywhere.",
    ],
  },
  TRIGLAVIAN: {
    CHATTER: [
      "The flow of {system} is weak. It will be proven.",
      "Clade speaks. Proving continues.",
      "Many voices, one trial. The Collective endures.",
    ],
    ADDRESS: [
      "{pilot}, you are subject of proving.",
      "Unproven one, {pilot}. Trial awaits.",
      "Your strength is question, {pilot}. We answer it.",
    ],
    SITE_ARRIVAL: [
      "Unproven arrives. Begin the trial.",
      "{pilot} enters the proving. Good.",
      "Flow shifts. Engage.",
    ],
    SITE_BANTER: [
      "Clade voice: test this one fully.",
      "Proving is honour. Do not waste it.",
      "Strip the weakness. Keep the strength.",
    ],
  },
  INDEPENDENT: {
    CHATTER: [
      "Anyone know the market in {system} today? Ore looks soft.",
      "Long haul ahead. Coffee is running low again.",
      "Contract done, pay is in. Not bad for a Tuesday.",
    ],
    ADDRESS: [
      "Evening, {pilot}. Busy lanes today.",
      "{pilot}, if you see pirates on the gate, shout.",
      "Fly safe, {pilot}. We are just passing through.",
    ],
    SITE_ARRIVAL: [
      "Capsuleer on grid. We want no trouble.",
      "{pilot}, this one is our contract. Find your own.",
      "Visitor. Keep your guns cold and so will we.",
    ],
    SITE_BANTER: [
      "Watch the capsuleer, they never pay for damage.",
      "Finish the job and let us go home.",
      "Nice and steady, no heroics today.",
    ],
  },
};

const FAME_TEXTS = {
  GURISTAS: {
    FAME_LEGEND: [
      "Whoa, {pilot} is here. The Guristas still tell stories about you.",
      "Boys, that is {pilot}. Show some respect, for once.",
      "{pilot} in {system}? Drinks are on the Guristas tonight.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Guristas never forget a face. Especially yours.",
      "Look alive, that is {pilot}. Wanted by every Guristas boss.",
      "Your bounty keeps growing, {pilot}. We keep counting.",
    ],
  },
  ANGEL: {
    FAME_LEGEND: [
      "The Cartel salutes you, {pilot}. Your name is worth gold here.",
      "{pilot} on Local. Even the Archangels stand up straight.",
      "Clear the lane for {pilot}. The Cartel owes you.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Cartel has a price on your head. A big one.",
      "That is {pilot}. Every Angel in {system} knows that ship.",
      "Run while you can, {pilot}. The Cartel wants you burned.",
    ],
  },
  BLOOD: {
    FAME_LEGEND: [
      "{pilot}, the Covenant sings of your deeds.",
      "Brothers, {pilot} is among us. The blood is honoured.",
      "Omir himself speaks well of you, {pilot}.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Covenant has marked your blood for the altar.",
      "We smell you, {pilot}. Every Raider knows your name.",
      "Your heartbeat is ours to stop, {pilot}. Soon.",
    ],
  },
  SANSHA: {
    FAME_LEGEND: [
      "{pilot}, the Nation knows you. The Master is pleased.",
      "We sing your name, {pilot}. You are almost one of us.",
      "The chorus greets {pilot}. Welcome, friend of the Nation.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Master has spoken your name. It was not kind.",
      "Every mind of the Nation hunts {pilot}. You cannot hide.",
      "Resistance has a face, and it is yours, {pilot}.",
    ],
  },
  SERPENTIS: {
    FAME_LEGEND: [
      "{pilot}, the Corporation values a friend like you.",
      "Salvador sends his regards, {pilot}. Business is good.",
      "VIP on Local, gentlemen. {pilot} gets the good boosters.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Corporation has terminated your contract. Permanently.",
      "Security, {pilot} is in {system}. Shoot on sight.",
      "Your file is very thick, {pilot}. Salvador read all of it.",
    ],
  },
  DEATHLESS: {
    FAME_LEGEND: [
      "{pilot}, the Circle remembers your help. Fly free.",
      "Zarzakh owes {pilot} a debt. The Circle pays its debts.",
      "Make way for {pilot}. The Deathless honour this one.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Circle has written your name in red.",
      "No safe passage for {pilot}. Not here, not anywhere.",
      "Your debt to the Circle is due, {pilot}. We collect.",
    ],
  },
  AMARR: {
    FAME_LEGEND: [
      "Glory to the Empire, {pilot}. Your service is known.",
      "{pilot}, the Navy of {system} salutes a true champion.",
      "The Empress herself has heard of you, {pilot}.",
    ],
    FAME_ENEMY: [
      "{pilot}, you are named an enemy of the Empire.",
      "Heretic {pilot} is in {system}. Hold your ground.",
      "The Empire does not forgive, {pilot}. Repent or burn.",
    ],
  },
  CALDARI: {
    FAME_LEGEND: [
      "{pilot}, the State recognizes your outstanding record.",
      "Priority clearance for {pilot}. Efficiency rating exemplary.",
      "Command sends its compliments, {pilot}.",
    ],
    FAME_ENEMY: [
      "{pilot}, you are listed as a hostile of the State.",
      "Alert: {pilot} is in {system}. Weapons free on contact.",
      "The State has closed your account, {pilot}.",
    ],
  },
  GALLENTE: {
    FAME_LEGEND: [
      "{pilot}! The Federation is proud of you.",
      "Look, it is {pilot}. Liberty has a hero after all.",
      "The press loves you, {pilot}. So does the Navy.",
    ],
    FAME_ENEMY: [
      "{pilot}, the Federation has declared you a public enemy.",
      "All units, {pilot} is in {system}. Proceed with caution.",
      "Freedom has limits, {pilot}. You found them.",
    ],
  },
  MINMATAR: {
    FAME_LEGEND: [
      "{pilot}, the clans sing of you around the fires.",
      "A friend of the Republic, {pilot}. Fly proud.",
      "Brothers, {pilot} is here. Raise the colours.",
    ],
    FAME_ENEMY: [
      "{pilot}, the clans have named you an enemy.",
      "No friend of the Republic, {pilot}. Leave {system}.",
      "The tribes remember what you did, {pilot}.",
    ],
  },
  CONCORD: {
    FAME_LEGEND: [
      "Capsuleer {pilot}, CONCORD notes your exemplary record.",
      "{pilot}, DED thanks you for your service in secure space.",
      "Commendation on file for {pilot}. Fly lawfully.",
    ],
    FAME_ENEMY: [
      "{pilot}, you are flagged as a public enemy by CONCORD.",
      "DED alert: {pilot} is present in {system}.",
      "Your record is noted, {pilot}. Every unit is watching.",
    ],
  },
  TRIGLAVIAN: {
    FAME_LEGEND: [
      "{pilot} is proven. Clade speaks your name with honour.",
      "Proven one, {pilot}. The flow favours you.",
      "Clade voice greets {pilot}. Strength recognized.",
    ],
    FAME_ENEMY: [
      "{pilot} is marked. Trial without end awaits.",
      "Clade has judged {pilot}. Judgement is final.",
      "Your flow ends here, {pilot}. Clade has spoken.",
    ],
  },
  INDEPENDENT: {
    FAME_LEGEND: [
      "Hey, that is {pilot}! Heard a lot about you.",
      "{pilot} in {system}? Now that is a famous name.",
      "Fly safe, {pilot}. Big fan of your work.",
    ],
    FAME_ENEMY: [
      "Uh oh, {pilot} is here. Everyone keep your heads down.",
      "{pilot}, half the cluster wants you dead. Not us, though.",
      "Is that {pilot}? I am not getting involved.",
    ],
  },
};

const linesOf = (voice, ctx, texts) => Object.freeze((texts || [])
  .map((text, i) => Object.freeze({ id: `fv.${voice}.${ctx}.${i + 1}`, text })));

const LINES = Object.freeze(Object.fromEntries(Object.entries(TEXTS).map(([voice, byContext]) => [voice,
  Object.freeze(Object.fromEntries([...CONTEXTS.map((ctx) => [ctx, linesOf(voice, ctx, byContext[ctx])]),
    ...FAME_CONTEXTS.map((ctx) => [ctx, linesOf(voice, ctx, (FAME_TEXTS[voice] || {})[ctx])])]))])));

module.exports = { CONTEXTS, FAME_CONTEXTS, PLACEHOLDERS, CONTEXT_HINTS, LINES };
