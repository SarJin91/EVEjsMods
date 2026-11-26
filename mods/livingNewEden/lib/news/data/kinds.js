"use strict";

const { KIND } = require("../schema");

const PLACEHOLDERS = Object.freeze(["system", "region", "a", "b", "hull", "n", "m"]);

const BATTLE_WEIGHT = Object.freeze({ base: 20, cap: 60 });
const CAPITAL_WEIGHT = Object.freeze({
  [KIND.CAPITAL_STARTED]: Object.freeze({ titan: 90, supercarrier: 70, other: 40 }),
  [KIND.CAPITAL_DELIVERED]: Object.freeze({ titan: 95, supercarrier: 75, other: 45 }),
});

const HULL_LABELS = Object.freeze({
  titan: Object.freeze({ en: "titan", pl: "tytan" }),
  supercarrier: Object.freeze({ en: "supercarrier", pl: "superlotniskowiec" }),
  dreadnought: Object.freeze({ en: "dreadnought", pl: "drednot" }),
  carrier: Object.freeze({ en: "carrier", pl: "lotniskowiec" }),
  force_auxiliary: Object.freeze({ en: "force auxiliary", pl: "okręt wsparcia (FAX)" }),
});

const UNKNOWN = Object.freeze({
  system: Object.freeze({ en: "unknown system", pl: "nieznany system" }),
  region: Object.freeze({ en: "unknown region", pl: "nieznany region" }),
  a: Object.freeze({ en: "unknown forces", pl: "nieznane siły" }),
  b: Object.freeze({ en: "the local holder", pl: "dotychczasowy właściciel" }),
  hull: Object.freeze({ en: "capital ship", pl: "okręt kapitałowy" }),
  n: Object.freeze({ en: "0", pl: "0" }),
  m: Object.freeze({ en: "0", pl: "0" }),
});

function entry(weight, labelEn, labelPl, en, pl) {
  return Object.freeze({ weight, label: Object.freeze({ en: labelEn, pl: labelPl }),
    template: Object.freeze({ en, pl }) });
}

const KIND_DATA = Object.freeze({
  [KIND.SYSTEM_CAPTURED]: entry(80, "System captured", "System przejęty",
    "{system} ({region}): {a} took control of the system from {b}.",
    "{system} ({region}): {a} przejmuje kontrolę nad systemem, wcześniej {b}."),
  [KIND.ATTACK_REPELLED]: entry(60, "Attack repelled", "Atak odparty",
    "{system} ({region}): {b} held the system against {a}.",
    "{system} ({region}): {b} utrzymuje system mimo ataku, napastnik: {a}."),
  [KIND.SYSTEM_RELEASED]: entry(50, "Control lost", "Utrata kontroli",
    "{system} ({region}): {b} lost control of the system.",
    "{system} ({region}): {b} traci kontrolę nad systemem."),
  [KIND.ATTACK_STARTED]: entry(40, "Attack begins", "Początek ataku",
    "{system} ({region}): {a} launched an attack against {b}.",
    "{system} ({region}): {a} rozpoczyna atak, obrońca: {b}."),
  [KIND.SIEGE_STARTED]: entry(55, "Station under siege", "Oblężenie stacji",
    "{system} ({region}): {a} laid siege to a station of {b}.",
    "{system} ({region}): {a} oblega stację, właściciel: {b}."),
  [KIND.SIEGE_ENDED]: entry(65, "Siege over", "Koniec oblężenia",
    "{system} ({region}): the siege by {a} came to an end.",
    "{system} ({region}): oblężenie prowadzone przez {a} dobiegło końca."),
  [KIND.STRUCTURE_SIEGE_STARTED]: entry(70, "Capsuleer structure attacked", "Atak na strukturę kapsulerów",
    "{system} ({region}): {a} attacked a capsuleer structure.",
    "{system} ({region}): {a} atakuje strukturę kapsulerów."),
  [KIND.STRUCTURE_SIEGE_ENDED]: entry(70, "Structure siege over", "Koniec oblężenia struktury",
    "{system} ({region}): the siege of a capsuleer structure by {a} ended.",
    "{system} ({region}): oblężenie struktury kapsulerów przez {a} dobiegło końca."),
  [KIND.PLAYER_SOV_SIEGE]: entry(70, "Sovereignty hub besieged", "Oblężenie centrum suwerenności",
    "{system} ({region}): {a} besieged a capsuleer sovereignty hub.",
    "{system} ({region}): {a} oblega centrum suwerenności kapsulerów."),
  [KIND.PLAYER_SOV_REINFORCED]: entry(70, "Sovereignty hub reinforced", "Centrum suwerenności w reinforce",
    "{system} ({region}): {a} forced a capsuleer sovereignty hub into reinforcement.",
    "{system} ({region}): {a} wprowadza centrum suwerenności kapsulerów w stan reinforce."),
  [KIND.PLAYER_SOV_LOST]: entry(70, "Capsuleer sovereignty lost", "Utrata suwerenności kapsulerów",
    "{system} ({region}): {a} retook the system from the capsuleers.",
    "{system} ({region}): {a} odbiera system kapsulerom."),
  [KIND.HEAVY_EVENT_STARTED]: entry(45, "Major hostile presence", "Duża obecność wroga",
    "{system} ({region}): {a} gathered a major force in the system.",
    "{system} ({region}): {a} gromadzi w systemie duże siły."),
  [KIND.BATTLE]: entry(BATTLE_WEIGHT.base, "Heavy fighting", "Ciężkie walki",
    "{system} ({region}): fighting between {a} and {b}, {n} ships destroyed.",
    "{system} ({region}): walki, strony: {a} i {b}, zniszczone statki: {n}."),
  [KIND.CAPITAL_STARTED]: entry(CAPITAL_WEIGHT[KIND.CAPITAL_STARTED].other, "Capital construction",
    "Budowa okrętu kapitałowego",
    "{a} began the construction of a {hull}.",
    "{a} rozpoczyna budowę, typ kadłuba: {hull}."),
  [KIND.CAPITAL_DELIVERED]: entry(CAPITAL_WEIGHT[KIND.CAPITAL_DELIVERED].other, "Capital ship completed",
    "Okręt kapitałowy ukończony",
    "{a} completed a {hull}.",
    "{a} kończy budowę, typ kadłuba: {hull}."),
  [KIND.TREASURY_CRISIS]: entry(75, "Treasury crisis", "Kryzys skarbca",
    "{a} entered a treasury crisis and cut its spending.",
    "{a} wpada w kryzys skarbca i tnie wydatki."),
  [KIND.TREASURY_RECOVERED]: entry(35, "Treasury recovered", "Skarbiec odbudowany",
    "{a} recovered from its treasury crisis.",
    "{a} wychodzi z kryzysu skarbca."),
  [KIND.INVASION_STARTED]: entry(85, "Invasion", "Inwazja",
    "{system} ({region}): an invasion by {a} began.",
    "{system} ({region}): rozpoczyna się inwazja, najeźdźca: {a}."),
  [KIND.INVASION_ENDED]: entry(50, "Invasion over", "Koniec inwazji",
    "{system} ({region}): the invasion by {a} ended.",
    "{system} ({region}): inwazja, najeźdźca: {a}, dobiegła końca."),
  [KIND.TRUCE_AGREED]: entry(60, "Truce", "Rozejm",
    "Truce: {a} and {b} stop fighting ({a} asked for it).",
    "Rozejm: {a} i {b} wstrzymują walki (o rozejm prosi {a})."),
  [KIND.STATION_RETURNED]: entry(55, "Station returned", "Stacja odzyskana",
    "{system} ({region}): the station returns to {a}; {b} loses its base there.",
    "{system} ({region}): stacja wraca do {a}, {b} traci tam bazę."),
  [KIND.BOUNTY_CLAIMED]: entry(30, "Bounties claimed", "Nagrody wypłacone",
    "Bounty hunters brought down wanted outlaws this cycle: {n}.",
    "Łowcy nagród dopadli poszukiwanych przestępców, liczba: {n}."),
  [KIND.SITUATION_RESOLVED]: entry(25, "Calls for help", "Wołania o pomoc",
    "Pilots answered calls for help this cycle: {n} pilots saved, {m} lost.",
    "Piloci odpowiadali na wołania o pomoc: uratowani {n}, straceni {m}."),
  [KIND.FAME_LEGEND]: entry(20, "A living legend", "Żywa legenda",
    "{a} hails a capsuleer as a living legend.",
    "{a} ogłasza jednego z kapsulerów żywą legendą."),
  [KIND.FAME_PUBLIC_ENEMY]: entry(30, "Public enemy", "Wróg publiczny",
    "{a} declares a capsuleer a public enemy.",
    "{a} ogłasza jednego z kapsulerów wrogiem publicznym."),
  [KIND.FAME_BOUNTY]: entry(30, "A price on a head", "Nagroda za głowę",
    "{a} puts a price on a capsuleer's head.",
    "{a} wyznacza nagrodę za głowę jednego z kapsulerów."),
  [KIND.SEASON_STARTED]: entry(95, "A new season", "Nowy sezon",
    "Season {n}: {a} begins a galactic offensive.",
    "Sezon {n}: {a} rozpoczyna galaktyczną ofensywę."),
  [KIND.SEASON_STAGE]: entry(70, "The crisis deepens", "Kryzys narasta",
    "Season {n}, stage {m}: the {a} crisis deepens.",
    "Sezon {n}, etap {m}: kryzys narasta, siła: {a}."),
  [KIND.SEASON_FINALE]: entry(90, "Season finale", "Finał sezonu",
    "Season {n} enters its finale against {a}.",
    "Sezon {n} wchodzi w finał, przeciwnik: {a}."),
  [KIND.SEASON_ENDED]: entry(95, "Season over", "Koniec sezonu",
    "Season {n} is over: the {a} crisis ends.",
    "Sezon {n} dobiegł końca, kryzys zakończony, siła: {a}."),
  [KIND.GM_THREAD_STARTED]: entry(45, "Unrest", "Niepokój",
    "{system} ({region}): unrest around {a}.",
    "{system} ({region}): niepokój wokół {a}."),
  [KIND.GM_THREAD_ENDED]: entry(35, "Unrest over", "Koniec niepokoju",
    "{system} ({region}): the unrest around {a} is over.",
    "{system} ({region}): niepokój wokół {a} dobiegł końca."),
  [KIND.WORLD_BOSS_EMERGED]: entry(75, "A world boss appears", "Pojawia się boss świata",
    "{system} ({region}): a great {a} force has appeared and roams the region.",
    "{system} ({region}): pojawiła się wielka siła, frakcja: {a}, i krąży po regionie."),
  [KIND.WORLD_BOSS_DEFEATED]: entry(85, "World boss defeated", "Boss świata pokonany",
    "{system} ({region}): {a} destroyed the roaming {b} force.",
    "{system} ({region}): {a} niszczy krążącą siłę, frakcja: {b}."),
  [KIND.WORLD_BOSS_SLAIN]: entry(90, "Capsuleers slay a world boss", "Kapsulerzy pokonują bossa świata",
    "{system} ({region}): capsuleers destroyed the roaming {a} force.",
    "{system} ({region}): kapsulerzy niszczą krążącą siłę, frakcja: {a}."),
  [KIND.WORLD_BOSS_WITHDREW]: entry(40, "World boss withdraws", "Boss świata się wycofuje",
    "{system} ({region}): the roaming {a} force withdrew.",
    "{system} ({region}): krążąca siła, frakcja: {a}, wycofuje się."),
  [KIND.NATIVE_INCURSION_DEFEATED]: entry(70, "Incursion broken", "Incursja rozbita",
    "{system} ({region}): capsuleers broke the Sansha incursion.",
    "{system} ({region}): kapsulerzy rozbijają incursję Sanshy."),
  [KIND.NATIVE_INCURSION_HELD]: entry(50, "Incursion holds", "Incursja utrzymana",
    "{system} ({region}): the Sansha incursion held its ground, {a} gains in the constellation.",
    "{system} ({region}): incursja Sanshy utrzymała pozycje, {a} zyskuje w konstelacji."),
  [KIND.FACTION_INCURSION_DEFEATED]: entry(70, "Incursion broken", "Incursja rozbita",
    "{system} ({region}): capsuleers broke the {a} incursion.",
    "{system} ({region}): kapsulerzy rozbijają incursję, frakcja: {a}."),
  [KIND.FACTION_INCURSION_HELD]: entry(50, "Incursion holds", "Incursja utrzymana",
    "{system} ({region}): the {a} incursion held its ground and gains in the constellation.",
    "{system} ({region}): incursja utrzymuje pozycje, frakcja: {a}, zyskuje w konstelacji."),
});

function weightOf(kind, data) {
  const d = data || {};
  if (kind === KIND.BATTLE) {
    const destroyed = Number.isSafeInteger(d.destroyed) && d.destroyed > 0 ? d.destroyed : 0;
    return BATTLE_WEIGHT.base + Math.min(BATTLE_WEIGHT.cap, destroyed);
  }
  const capital = CAPITAL_WEIGHT[kind];
  if (capital) return capital[d.hullClass] !== undefined ? capital[d.hullClass] : capital.other;
  const e = KIND_DATA[kind];
  return e ? e.weight : 0;
}

module.exports = { KIND_DATA, PLACEHOLDERS, HULL_LABELS, UNKNOWN, BATTLE_WEIGHT, CAPITAL_WEIGHT, weightOf };
