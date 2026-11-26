"use strict";

const NBSP = String.fromCharCode(0x00a0);

const LANGUAGES = Object.freeze({
  en: Object.freeze({
    name: "English",
    extraChars: "",
    foldTypography: Object.freeze([]),
  }),
  pl: Object.freeze({
    name: "Polish",
    extraChars: "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ",
    foldTypography: Object.freeze([
      Object.freeze(["„", '"']),
      Object.freeze(["”", '"']),
      Object.freeze(["“", '"']),
      Object.freeze(["‚", "'"]),
      Object.freeze(["’", "'"]),
      Object.freeze(["‘", "'"]),
      Object.freeze(["–", "-"]),
      Object.freeze(["—", "-"]),
      Object.freeze(["…", "..."]),
      Object.freeze([NBSP, " "]),
    ]),
  }),
});

module.exports = { LANGUAGES };
