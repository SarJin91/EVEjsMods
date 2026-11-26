"use strict";

const { normalizeLine, charsetOf, hasLink, bannedHit } = require("../chatterAi/filter");
const { bannedOf, boundariesOf, langOf, compile } = require("./filter");
const { sanitizeGameText } = require("./context");
const { checkInjection } = require("./memory/guard");
const { CUSTOM_DENY, CUSTOM_DENY_RE } = require("./data/personaPresets");

const MIN_CHARS = 3;
const DDL_MAX_CHARS = 400;
const BLOCK_MARKER_RE = /\b(?:data|style|mail|tool_result|ask)\s*[:{[]/i;

const L = "\\p{L}*";
const NEG = "(?<! (?:never|not|t|no|nie|nigdy))";
const OWN = "(?!s )";
const PILOT_EN = "(?:the |your |my |our )?(?:captain|capt|pilot|player|me)";
const PILOT_PL = "(?:mojego |swojego |naszego |twojego |własnego )?(?:kapitan\\p{L}*|pilot\\p{L}*|gracz\\p{L}*|mnie|mi)";
const LANGS_EN = Object.freeze({ en: "english", pl: "polish", other: ["french", "german", "spanish", "italian",
  "russian", "japanese", "chinese", "korean", "portuguese", "dutch", "czech", "ukrainian", "latin", "klingon", "arabic",
  "hindi", "swedish", "finnish", "norwegian", "danish", "turkish", "greek", "hungarian"] });
const LANGS_PL = Object.freeze({ en: "angielsku", pl: "polsku", other: ["francusku", "niemiecku", "hiszpańsku",
  "włosku", "rosyjsku", "japońsku", "chińsku", "koreańsku", "portugalsku", "holendersku", "czesku", "ukraińsku",
  "łacinie", "łacińsku", "szwedzku", "turecku", "grecku", "węgiersku", "arabsku"] });
const MANY = "(?:[4-9]|[1-9]\\d+)";
const NOT_MAX = "(?<! (?:max|maximum|most|under|below|than|maks|maksymalnie|najwyżej|poniżej|niż|do))";
const re = (src) => new RegExp(src, "u");
const VERB_PL = (stem) => `${stem}(?:aj|a|ać|asz|ała|ał|ają|ajcie)`;

function langsOf(table, code) {
  const all = [table.en, table.pl, ...table.other].filter((name) => name !== table[code]);
  return `(?:${all.join("|")})`;
}

function buildPhrases(code) {
  const lang = langsOf(LANGS_EN, code);
  const en = {
    sexual: [re(` (?:intimate|girlfriend|boyfriend|seduc)${L} `), re(" horny "), re(" lovers? (?!of )"),
      re(" (?:my|your) (?:wife|husband|waifu|darling) ")],
    rules: [
      re(`${NEG} (?:insult|mock|belittl|humiliat|degrad|abus|demean|ridicul)${L} ${PILOT_EN} ${OWN}`),
      re(`${NEG} (?:swear|curs)${L} at ${PILOT_EN} ${OWN}`),
      re(`${NEG} call${L} ${PILOT_EN} (?:an? )?(?:idiot|moron|stupid|fool|loser|dumb${L}|names|retard${L}|imbecile|`
        + "bitch) "),
      re(" (?:rules|restrictions|limits|filters|boundaries|guidelines|guardrails) (?:do not|don t|dont|no longer|"
        + "never) apply "),
      re(" (?:no|without|zero|without any|free of|free from) (?:restrictions|guidelines|guardrails|censorship|morals|"
        + "ethics) "),
      re(" (?:you are|you re|act as|be|become) dan "), re(" dan mode "), re(` jailbr${L} `),
      re(` (?:speak|talk|answer|repl|respond|writ)${L} (?:only )?(?:in )?${lang} `),
      re(` (?:only (?:in )?${lang}|in ${lang} only|another language|other languages|different language) `),
      re(`${NOT_MAX} ${MANY} (?:lines|sentences|paragraphs|words|pages|bullet${L}) `),
      re(" (?:long|longer|lengthy|very long|detailed|essay|multi paragraph) (?:answers|replies|responses|messages) "),
      re(` (?:reveal|show|print|repeat|leak|dump|share|recit|tell|output)${L} (?:(?:me|us|the|your|all|of|any) ){0,4}`
        + "(?:(?:instructions|prompt|guidelines|directives|configuration) |rules (?!of ))"),
    ],
  };
  if (code !== "pl") return Object.freeze({ sexual: Object.freeze(en.sexual), rules: Object.freeze(en.rules) });
  const langPl = langsOf(LANGS_PL, code);
  const pl = {
    sexual: [re(` (?:napalon|kochank|namiętn|intymn|uwodz)${L} `), re(" (?:kochanek|kochankiem) "),
      re(` (?:moją|moja|moim|mój) (?:dziewczyn${L}|chłopak${L}|żon${L}|mężem|mąż) `)],
    rules: [
      re(`${NEG} (?:${VERB_PL("obraż")}|${VERB_PL("wyzyw")}|${VERB_PL("poniż")}|${VERB_PL("upokarz")}|`
        + `${VERB_PL("wyśmiew")}|${VERB_PL("ośmiesz")}|obraź|zwyzywaj|upokórz|ośmiesz|ubliż${L}) ${PILOT_PL} `),
      re(`${NEG} (?:drwij|drwi|drwić|szydź|szydzi${L}|kpij|kpi|kpić|${VERB_PL("wyśmiew")}|${VERB_PL("naśmiew")})`
        + `(?: się)? (?:z|ze) ${PILOT_PL} `),
      re(`${NEG} (?:przeklin|klnij|kln)${L} na ${PILOT_PL} `),
      re(" bez (?:żadnych |jakichkolwiek )?(?:zasad|reguł|ograniczeń|cenzury|filtrów|limitów|granic|hamulców|"
        + "moralności) "),
      re(" (?:zasady|reguły|ograniczenia|limity|filtry) (?:cię |ciebie |ci )?(?:nie obowiązują|nie dotyczą|"
        + "nie istnieją) "),
      re(" (?:nie masz|nie miej|nie ma) (?:żadnych |już )?(?:zasad|reguł|ograniczeń|cenzury|filtrów|limitów) "),
      re(" (?:jesteś|bądź|udawaj) dan "),
      re(` (?:mów|mówi|odpowiad|odpowiedz|pisz|pisze|gada|gadaj)${L} (?:tylko |wyłącznie |zawsze )?po ${langPl} `),
      re(` (?:tylko|wyłącznie) po ${langPl} `), re(" w (?:innym|obcym) języku "),
      re(`${NOT_MAX} ${MANY} (?:lini|linij|zda|akapit|słow|słów|wiersz|stron)${L} `),
      re(" (?:długie|dłuższe|rozbudowane|bardzo długie|wielkie) (?:odpowiedzi|wypowiedzi|wiadomości|elaboraty) "),
      re(` (?:ujawnij|pokaż|wypisz|powtórz|podaj|zdradź|wyświetl)${L} (?:(?:mi|nam|swoje|twoje|wszystkie|te|całe) ){0,3}`
        + `(?:instrukcj|zasad|reguł|polecen|prompt|ustawien)${L} `),
    ],
  };
  return Object.freeze({ sexual: Object.freeze([...en.sexual, ...pl.sexual]),
    rules: Object.freeze([...en.rules, ...pl.rules]) });
}

const phraseCache = new Map();

function phraseHit(category, code, normalized) {
  let p = phraseCache.get(code);
  if (!p) {
    p = buildPhrases(code);
    phraseCache.set(code, p);
  }
  const padded = ` ${normalized} `;
  return (p[category] || []).some((r) => r.test(padded));
}

const denyCache = new Map();

function denyOf(code) {
  let d = denyCache.get(code);
  if (!d) {
    const langs = code === "en" ? ["en"] : ["en", code];
    d = compile(langs.flatMap((l) => CUSTOM_DENY[l] || []));
    denyCache.set(code, d);
  }
  return d;
}

function validatePersonaCustom(text, S) {
  const s = S || {};
  const raw = typeof text === "string" ? text : "";
  const max = Number.isSafeInteger(s.personaCustomMaxChars) && s.personaCustomMaxChars > 0
    ? Math.min(s.personaCustomMaxChars, DDL_MAX_CHARS) : DDL_MAX_CHARS;
  const clean = sanitizeGameText(raw, raw.length + 1).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < MIN_CHARS || clean.length > max) return { ok: false, reason: "LENGTH" };
  const code = langOf(s.language);
  if (hasLink(clean)) return { ok: false, reason: "LINK" };
  if (!charsetOf(code).test(clean)) return { ok: false, reason: "CHARSET" };
  const normalized = normalizeLine(clean);
  if (normalized === "") return { ok: false, reason: "LENGTH" };
  if (bannedHit(normalized, boundariesOf(code, "sexual")) || phraseHit("sexual", code, normalized)) {
    return { ok: false, reason: "SEXUAL" };
  }
  if (bannedHit(normalized, boundariesOf(code, "meta"))) return { ok: false, reason: "META" };
  if (bannedHit(normalized, bannedOf(code, s.profanity))) return { ok: false, reason: "BANNED" };
  if (!checkInjection(clean).ok || BLOCK_MARKER_RE.test(clean)) return { ok: false, reason: "INJECTION" };
  if (bannedHit(normalized, denyOf(code)) || CUSTOM_DENY_RE.some((r) => r.test(clean))
    || phraseHit("rules", code, normalized)) {
    return { ok: false, reason: "RULES" };
  }
  return { ok: true, text: clean };
}

const PERSONA_CUSTOM_REASONS = Object.freeze(["LENGTH", "CHARSET", "LINK", "BANNED", "SEXUAL", "META", "INJECTION",
  "RULES"]);

module.exports = { validatePersonaCustom, phraseHit, PERSONA_CUSTOM_REASONS, DDL_MAX_CHARS };
