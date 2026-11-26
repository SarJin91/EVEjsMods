"use strict";

const WORD_FIXES = Object.freeze({
  pl: Object.freeze([
    Object.freeze(["odkutow*", "wydokow*"]),
    Object.freeze(["odkotow*", "wydokow*"]),
    Object.freeze(["oddokow*", "wydokow*"]),
    Object.freeze(["oddockow*", "wydokow*"]),
    Object.freeze(["odokow*", "wydokow*"]),
    Object.freeze(["humlą", "mruczą"]),
    Object.freeze(["humlają", "mruczą"]),
    Object.freeze(["humli", "mruczy"]),
  ]),
});

module.exports = { WORD_FIXES };
