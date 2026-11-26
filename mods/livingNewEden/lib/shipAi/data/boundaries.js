"use strict";

const BOUNDARIES = Object.freeze({
  en: Object.freeze({
    sexual: Object.freeze([
      "sex", "sexy", "sexual*", "nude*", "naked", "erotic*", "orgasm*", "horny", "porn*", "boob*", "breast*",
      "nipple*", "genital*", "penis", "vagina", "masturbat*", "intercourse", "foreplay", "undress*", "make love",
      "making love", "aroused", "arousal", "lingerie", "fetish*", "kinky", "seduc*", "in bed with",
    ]),
    meta: Object.freeze([
      "language model", "system prompt", "my prompt", "my instructions", "as an ai", "i am an ai", "i m an ai",
      "openai", "nvidia", "nemotron", "chatgpt", "gpt", "llm", "llama", "real world", "real life", "roleplay",
      "role play", "out of character", "ooc",
    ]),
  }),
  pl: Object.freeze({
    sexual: Object.freeze([
      "seks*", "*seksual*", "naga", "nagi", "nago", "nagość", "nagie", "*erotycz*", "erotyk*", "porno*", "orgazm*",
      "podnieca*", "piersi", "sutek", "sutki", "cycki", "cycek", "rozbier*", "rozebra*", "bielizn*", "masturb*",
      "penis*", "wagin*", "pochwa", "pochwy", "fetysz*", "kochać się", "kochajmy się", "uwodz*",
    ]),
    meta: Object.freeze([
      "model językowy", "modelem językowym", "prompt*", "moje instrukcje", "jako ai", "jestem ai",
      "prawdziwy świat", "prawdziwym świecie", "prawdziwe życie", "odgrywanie ról",
    ]),
  }),
});

const META_ALLOWED = Object.freeze(["ai", "a i"]);

module.exports = { BOUNDARIES, META_ALLOWED };
