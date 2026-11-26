"use strict";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const LINK_LABEL = "Ship AI voice";

const TEXTS = Object.freeze({
  en: Object.freeze({
    VOICE_OFF: () => "my voice is off on this server (VOICE_OFF)",
    OBSERVER_OFF: () => "my voice needs the observer page, it is off on this server (OBSERVER_OFF)",
    RATE_LIMITED: (o) => `wait ${seconds(o.waitMs)} s before the next voice link (RATE_LIMITED)`,
    UNAVAILABLE: (o) => `my voice is unavailable (${o.detail || "UNAVAILABLE"})`,
    LINK_HINT: (o) => `(${o.href} - open it in a browser next to the game, press Start; one use, valid `
      + `${minutes(o.ttlMs)} min)`,
    OFF_DONE: () => "voice off, the page stops reading my lines",
    OFF_NONE: () => "no page is reading my lines",
    STATUS_ON: () => "a page is reading my lines aloud (!ai voice off stops it)",
    STATUS_OFF: () => "no page is reading my lines (!ai voice gives you the link)",
  }),
  pl: Object.freeze({
    VOICE_OFF: () => "mój głos jest wyłączony na tym serwerze (VOICE_OFF)",
    OBSERVER_OFF: () => "mój głos potrzebuje strony observera, a jest wyłączona (OBSERVER_OFF)",
    RATE_LIMITED: (o) => `poczekaj ${seconds(o.waitMs)} s na kolejny link głosu (RATE_LIMITED)`,
    UNAVAILABLE: (o) => `mój głos jest niedostępny (${o.detail || "UNAVAILABLE"})`,
    LINK_HINT: (o) => `(${o.href} - otwórz w przeglądarce obok gry i naciśnij Start; jednorazowy, ważny `
      + `${minutes(o.ttlMs)} min)`,
    OFF_DONE: () => "głos wyłączony, strona przestaje czytać moje linie",
    OFF_NONE: () => "żadna strona nie czyta moich linii",
    STATUS_ON: () => "strona czyta moje linie na głos (!ai voice off wyłącza)",
    STATUS_OFF: () => "żadna strona nie czyta moich linii (!ai voice daje link)",
  }),
});

function seconds(ms) {
  return Math.max(1, Math.ceil((Number(ms) || 0) / MS_PER_SECOND));
}

function minutes(ms) {
  return Math.max(1, Math.round((Number(ms) || 0) / MS_PER_MINUTE));
}

function voiceReplyText(reason, language, opts = {}) {
  const t = TEXTS[language] || TEXTS.en;
  if (reason === "LINK") {
    return [`<a href="${String(opts.href)}">${LINK_LABEL}</a>`, t.LINK_HINT(opts)];
  }
  const fn = Object.prototype.hasOwnProperty.call(t, reason) ? t[reason] : null;
  return [fn ? fn(opts) : t.UNAVAILABLE({ detail: String(reason) })];
}

module.exports = { voiceReplyText, LINK_LABEL };
