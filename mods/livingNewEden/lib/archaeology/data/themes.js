"use strict";

const THEMES = Object.freeze({
  JOVE: Object.freeze({
    analyzer: "data",
    adjective: Object.freeze({ en: "Jovian", pl: "jowiański" }),
    containerLabel: Object.freeze({ en: "Jovian Archive", pl: "Archiwum jowiańskie" }),
    siteLabel: "Jovian Signal Source",
    archiveLabel: Object.freeze({ stage: "Jovian Archive Fragment", final: "Jovian Archive Core" }),
  }),
  DRIFTER: Object.freeze({
    analyzer: "relic",
    adjective: Object.freeze({ en: "Drifter", pl: "Drifterów" }),
    containerLabel: Object.freeze({ en: "Drifter Cache", pl: "Skrytka Drifterów" }),
    siteLabel: "Drifter Lattice Remnant",
    archiveLabel: Object.freeze({ stage: "Drifter Lattice Node", final: "Drifter Lattice Core" }),
  }),
});

const LORE = Object.freeze({
  JOVE: Object.freeze({
    en: Object.freeze([
      "The record speaks of a sickness carried in the blood, passed from parent to child, that no gene-craft could mend.",
      "A council of the old empire voted to close the gates. The vote is logged; the names of those who voted are erased.",
      "Fragment of a star chart: a route through systems that no longer appear on any modern map.",
      "A scholar writes that the empire did not fall. It simply stopped speaking to everyone else.",
      "The archive lists ships by the number of generations they served, not by the years.",
      "An entry on gene-sculpting: every improvement left a debt, and the debt came due in the third generation.",
      "Coordinates of a laboratory, followed by a single line: 'Seal it. Let nobody learn what we learned here.'",
      "A child's lesson about the first colonists who crossed the gate and never looked back.",
      "The data hints at a second migration, quieter than the first, towards somewhere unnamed.",
      "A list of observatories, each marked 'silent'. The last one is marked 'still listening'.",
      "A lament for a language with no living speakers, written in that same language.",
      "The final line of this fragment reads: 'Those who come after us will call this an ending. It is not.'",
    ]),
    pl: Object.freeze([
      "Zapis mówi o chorobie niesionej we krwi, przekazywanej z rodzica na dziecko, której żadna inżynieria genów nie uleczyła.",
      "Rada dawnego imperium przegłosowała zamknięcie bram. Głosowanie jest w rejestrze, nazwiska głosujących wymazano.",
      "Fragment mapy gwiezdnej: trasa przez układy, których nie ma już na żadnej współczesnej mapie.",
      "Uczony pisze, że imperium nie upadło. Po prostu przestało rozmawiać z resztą świata.",
      "Archiwum liczy służbę okrętów w pokoleniach, a nie w latach.",
      "Wpis o rzeźbieniu genów: każde ulepszenie zostawiało dług, a dług przychodził do spłaty w trzecim pokoleniu.",
      "Współrzędne laboratorium i jedna linia: 'Zapieczętować. Niech nikt nie pozna tego, czego tu się dowiedzieliśmy'.",
      "Lekcja dla dziecka o pierwszych osadnikach, którzy przeszli przez bramę i nigdy się nie obejrzeli.",
      "Dane sugerują drugą migrację, cichszą od pierwszej, w nienazwane miejsce.",
      "Lista obserwatoriów, każde oznaczone 'milczy'. Ostatnie oznaczono 'wciąż nasłuchuje'.",
      "Lament nad językiem, którym nikt już nie mówi, zapisany w tym samym języku.",
      "Ostatnia linia fragmentu: 'Ci, którzy przyjdą po nas, nazwą to końcem. To nie jest koniec'.",
    ]),
  }),
  DRIFTER: Object.freeze({
    en: Object.freeze([
      "The lattice hums with a pattern that repeats every few seconds, like a heartbeat slowed to a crawl.",
      "A node holds a map of wormhole connections, drawn as if the drawer could see all of them at once.",
      "Something here was grown rather than built. The structure branches like coral under black water.",
      "The relic stores a voice. It does not speak a language; it counts, and the count never ends.",
      "Traces of a battle long before the capsule: the hull scars match no weapon known today.",
      "A memory of the old empire seen from the outside, cold and patient, waiting for the gates to fail.",
      "The node refers to its makers as 'the ones who went inward'. It does not say where inward is.",
      "Fragments of a fleet roster. Every ship is listed twice: once as it was, once as it became.",
      "A recorded warning, repeated in many voices: 'Do not follow us into the unlit space.'",
      "The lattice keeps time by the decay of a single star, measured to an absurd precision.",
      "A diagram of a mind, or of a city. The archive treats the two as the same thing.",
      "The last pulse of the node says only: 'We were never gone. We were waiting for you to look.'",
    ]),
    pl: Object.freeze([
      "Sieć brzęczy wzorem, który powtarza się co kilka sekund, jak serce zwolnione do granic.",
      "Węzeł przechowuje mapę połączeń wormhole narysowaną tak, jakby rysujący widział je wszystkie naraz.",
      "To coś wyhodowano, a nie zbudowano. Struktura rozgałęzia się jak koral w czarnej wodzie.",
      "Relikt zapisał głos. Nie mówi w żadnym języku; liczy, a liczenie nigdy się nie kończy.",
      "Ślady bitwy sprzed czasów kapsuły: blizny na kadłubach nie pasują do żadnej znanej dziś broni.",
      "Wspomnienie dawnego imperium widziane z zewnątrz, zimne i cierpliwe, czekające, aż bramy zawiodą.",
      "Węzeł nazywa swoich twórców 'tymi, którzy odeszli do wewnątrz'. Nie mówi, gdzie jest to wnętrze.",
      "Fragmenty spisu floty. Każdy okręt wpisano dwa razy: raz taki, jaki był, raz taki, jakim się stał.",
      "Nagrane ostrzeżenie, powtarzane wieloma głosami: 'Nie idźcie za nami w nieoświetloną przestrzeń'.",
      "Sieć odmierza czas rozpadem jednej gwiazdy, z absurdalną dokładnością.",
      "Schemat umysłu albo miasta. Archiwum traktuje jedno i drugie jako to samo.",
      "Ostatni impuls węzła mówi tylko: 'Nigdy nie odeszliśmy. Czekaliśmy, aż spojrzysz'.",
    ]),
  }),
});

const TEXTS = Object.freeze({
  en: Object.freeze({
    start: "Your analyzer caught a faint {theme} signal. Details follow by mail.",
    hint: "{theme} archive {n}/{N}: {system} ({region}, nullsec{hostile}). It wakes when you are within {r} jump(s). "
      + "The trail fades on {deadline} UTC.",
    hostile: ", held by hostile forces",
    reply: "Relic: {theme} trail, archive {n}/{N}: {system} ({region}), {kind}, {state}. Fades {deadline} UTC.",
    replyShort: "Relic: trail active, archive {n}/{N}. Details in your mail.",
    none: "Relic: no active trail.",
    failed: "Relic: unavailable.",
    kind: Object.freeze({ NULL: "nullsec", HOSTILE_NULL: "hostile nullsec", WH: "wormhole" }),
    state: Object.freeze({ REVEALED: "revealed", SITE_PENDING: "waiting", SITE_ACTIVE: "awake", FOUND: "found" }),
    found: "Archive fragment decoded. Details follow by mail.",
    lore: "{theme} archive {n}/{N} decoded: {lore}",
    stolen: "Someone else decoded the archive first. The signal moved. ",
    end: "{theme} trail complete: all {N} archives decoded.",
    hintWh: "{theme} archive {n}/{N}: through a wormhole in {system} ({region}). The passage closes about {closes} UTC. "
      + "The trail fades on {deadline} UTC.",
    whClosed: "The passage closed. The signal moved. ",
    stolenEnd: "Someone else decoded the last {theme} archive first. The trail is lost.",
  }),
  pl: Object.freeze({
    start: "Analizator złapał słaby sygnał {theme}. Szczegóły w poczcie.",
    hint: "Trop {theme} {n}/{N}: {system} ({region}, nullsec{hostile}). Budzi się, gdy jesteś w promieniu {r} skok(ów). "
      + "Trop wygasa {deadline} UTC.",
    hostile: ", w rękach wrogich sił",
    reply: "Relikt: trop {theme}, archiwum {n}/{N}: {system} ({region}), {kind}, {state}. Wygasa {deadline} UTC.",
    replyShort: "Relikt: trop aktywny, archiwum {n}/{N}. Szczegóły w poczcie.",
    none: "Relikt: brak aktywnego tropu.",
    failed: "Relikt: niedostępne.",
    kind: Object.freeze({ NULL: "nullsec", HOSTILE_NULL: "wrogi nullsec", WH: "wormhole" }),
    state: Object.freeze({ REVEALED: "odkryty", SITE_PENDING: "czeka", SITE_ACTIVE: "aktywny", FOUND: "znaleziony" }),
    found: "Fragment archiwum odszyfrowany. Szczegóły w poczcie.",
    lore: "Archiwum {theme} {n}/{N} odszyfrowane: {lore}",
    stolen: "Ktoś inny odszyfrował archiwum pierwszy. Sygnał się przeniósł. ",
    end: "Trop {theme} ukończony: wszystkie {N} archiwa odszyfrowane.",
    hintWh: "Trop {theme} {n}/{N}: przez wormhole w {system} ({region}). Przejście zamyka się około {closes} UTC. "
      + "Trop wygasa {deadline} UTC.",
    whClosed: "Przejście się zamknęło. Sygnał się przesunął. ",
    stolenEnd: "Ktoś inny pierwszy odszyfrował ostatnie archiwum {theme}. Trop przepadł.",
  }),
});

module.exports = { THEMES, TEXTS, LORE };
