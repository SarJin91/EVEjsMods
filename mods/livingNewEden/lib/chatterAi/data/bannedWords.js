"use strict";

const BANNED = Object.freeze({
  en: Object.freeze({
    meta: Object.freeze([
      "ai", "a i", "artificial intelligence", "language model", "assistant", "prompt", "openai", "nvidia", "chatgpt",
      "gpt", "llm", "llama", "chatbot", "as a bot",
      "ccp", "discord", "reddit", "twitch", "youtube", "twitter", "facebook",
    ]),
    slurs: Object.freeze([
      "cunt", "whore", "slut", "rape", "nigger", "nigga", "faggot", "fag", "retard", "retarded", "nazi", "kys",
      "kill yourself",
    ]),
    strong: Object.freeze(["fuck", "fucking", "fucker", "shit", "bitch", "bastard"]),
    mild: Object.freeze(["damn", "hell", "crap", "bloody"]),
  }),
  pl: Object.freeze({
    meta: Object.freeze(["sztuczna inteligencja", "sztucznej inteligencji", "model językowy", "asystent*", "czatbot*",
      "chatbot*"]),
    slurs: Object.freeze(["*gwałc*", "zabij się", "powieś się", "dziwk*", "cip*", "czarnuch*", "pedał*", "ciota",
      "cioty", "*cwel*", "nazist*"]),
    strong: Object.freeze(["*kurw*", "*chuj*", "*pierdol*", "*jeb*", "*pizd*"]),
    mild: Object.freeze(["choler*", "kurde", "psiakrew"]),
  }),
});

const BANNED_WORDS = Object.freeze([...BANNED.en.meta, ...BANNED.en.slurs, ...BANNED.en.strong]);

module.exports = { BANNED, BANNED_WORDS };
