"use strict";

const assert = require("node:assert");
const { createFormationStore, FORMATION_FILE_NAME } = require("../../lib/store/formationStore");
const { FORMATIONS } = require("../../lib/core/formation");

const FILE = `/data/mods/shipWing/${FORMATION_FILE_NAME}`;

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

function make(fs, maxPilots = 10) {
  return createFormationStore({ filePath: FILE, fs, now: () => 777, maxPilots,
    isKnown: (name) => FORMATIONS.includes(name) });
}

module.exports = ({ test }) => {
  test("FM-S1 set -> flush -> load -> get; none removes the entry; a corrupt file is quarantined and the store starts "
    + "empty; an unknown name is dropped alone; a new pilot above maxPilots -> FULL", () => {
    const fs = fakeFs();
    const a = make(fs);
    assert.deepStrictEqual(a.load(), { ok: true, dropped: 0, readOnly: false });
    assert.strictEqual(a.get(90000001), "none");
    assert.deepStrictEqual(a.set(90000001, "wedge"), { ok: true, changed: true });
    assert.deepStrictEqual(a.set(90000001, "wedge"), { ok: true, changed: false });
    assert.deepStrictEqual(a.set(90000002, "sphere"), { ok: true, changed: true });
    assert.deepStrictEqual(a.flush(), { ok: true, written: true });
    assert.deepStrictEqual(a.flush(), { ok: true, written: false }, "clean = no write");
    const b = make(fs);
    b.load();
    assert.deepStrictEqual([b.get(90000001), b.get(90000002)], ["wedge", "sphere"]);
    assert.deepStrictEqual(b.set(90000002, "none"), { ok: true, changed: true });
    b.flush();
    assert.deepStrictEqual(JSON.parse(fs.files.get(FILE)), { schemaVersion: 1, pilots: { 90000001: "wedge" } });

    const full = make(fakeFs(), 1);
    full.load();
    full.set(1, "line");
    assert.deepStrictEqual(full.set(2, "line"), { ok: false, reason: "FULL" });
    assert.strictEqual(full.stats().counters["formation.store.full"], 1);

    fs.files.set(FILE, JSON.stringify({ schemaVersion: 1, pilots: { 90000001: "column", 90000003: "foo" } }));
    const c = make(fs);
    assert.strictEqual(c.load().dropped, 1);
    assert.deepStrictEqual([c.get(90000001), c.get(90000003)], ["column", "none"]);
    assert.strictEqual(c.stats().dirty, true, "the next flush writes the file without the dropped entry");

    fs.files.set(FILE, JSON.stringify("x"));
    const d = make(fs);
    const loaded = d.load();
    assert.deepStrictEqual(loaded.recovered, { reason: "bad_shape", movedTo: `${FILE}.corrupt-777` });
    assert.ok(fs.files.has(`${FILE}.corrupt-777`) && !fs.files.has(FILE));
    assert.strictEqual(d.get(90000001), "none");
    assert.deepStrictEqual(d.set(90000001, "line"), { ok: true, changed: true });
    assert.deepStrictEqual(d.flush(), { ok: true, written: true });

    const stuck = fakeFs(new Map([[FILE, "{bad"]]));
    stuck.renameSync = () => { throw new Error("EPERM"); };
    const e = make(stuck);
    assert.strictEqual(e.load().readOnly, true);
    assert.deepStrictEqual(e.set(90000001, "line"), { ok: false, reason: "READ_ONLY" });
    assert.strictEqual(e.get(90000001), "none");
  });
};
