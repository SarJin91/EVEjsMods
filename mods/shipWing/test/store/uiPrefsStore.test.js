"use strict";

const assert = require("node:assert");
const { createUiPrefsStore, UI_PREFS_FILE_NAME } = require("../../lib/store/uiPrefsStore");

const FILE = `/data/mods/shipWing/${UI_PREFS_FILE_NAME}`;

function fakeFs(files = new Map()) {
  const open = new Map();
  let fd = 0;
  return {
    files,
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(file);
    },
    mkdirSync() {},
    openSync(file) {
      fd += 1;
      open.set(fd, { file, text: "" });
      return fd;
    },
    writeFileSync(handle, text) {
      open.get(handle).text = text;
    },
    fsyncSync() {},
    closeSync(handle) {
      const f = open.get(handle);
      files.set(f.file, f.text);
      open.delete(handle);
    },
    renameSync(from, to) {
      if (!files.has(from)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function make(fs, maxPilots = 2) {
  return createUiPrefsStore({ filePath: FILE, fs, now: () => 777, maxPilots });
}

module.exports = ({ test }) => {
  test("UP-S1 set -> flush -> load -> get; off removes the entry; FULL above maxPilots; a corrupt file is moved to "
    + ".corrupt-<ms> and the store starts empty", () => {
    const fs = fakeFs();
    const a = make(fs);
    assert.deepStrictEqual(a.load(), { ok: true, dropped: 0, readOnly: false });
    assert.strictEqual(a.get(90000001), false);
    assert.deepStrictEqual(a.set(90000001, true), { ok: true, changed: true, persisted: true });
    assert.deepStrictEqual(a.set(90000001, true), { ok: true, changed: false, persisted: true });
    assert.deepStrictEqual(a.set(90000002, true), { ok: true, changed: true, persisted: true });
    assert.deepStrictEqual(a.set(90000003, true), { ok: false, reason: "FULL" });
    assert.deepStrictEqual(a.set(0, true), { ok: false, reason: "INVALID" });
    assert.strictEqual(fs.files.has(FILE), false, "no write per change");
    assert.deepStrictEqual(a.flush(), { ok: true, written: true });
    assert.deepStrictEqual(a.flush(), { ok: true, written: false });
    assert.deepStrictEqual(JSON.parse(fs.files.get(FILE)), { schemaVersion: 1, pilots: {
      90000001: { openAtLogin: true }, 90000002: { openAtLogin: true } } });
    assert.deepStrictEqual(a.set(90000002, false), { ok: true, changed: true, persisted: true });
    a.flush();

    const b = make(fs);
    b.load();
    assert.strictEqual(b.get(90000001), true);
    assert.strictEqual(b.get(90000002), false);

    fs.files.set(FILE, "{not json");
    const c = make(fs);
    const loaded = c.load();
    assert.strictEqual(loaded.recovered.reason, "bad_json");
    assert.strictEqual(loaded.recovered.movedTo, `${FILE}.corrupt-777`);
    assert.strictEqual(fs.files.get(`${FILE}.corrupt-777`), "{not json");
    assert.strictEqual(c.get(90000001), false);
    assert.strictEqual(c.stats().counters["uiPrefs.store.load.corrupt"], 1);
  });
};
