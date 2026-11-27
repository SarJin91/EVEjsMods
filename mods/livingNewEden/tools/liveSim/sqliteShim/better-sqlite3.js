"use strict";

const { DatabaseSync } = require("node:sqlite");

const PRIMARY = { 1: "ERROR", 2: "INTERNAL", 3: "PERM", 4: "ABORT", 5: "BUSY", 6: "LOCKED", 7: "NOMEM", 8: "READONLY",
  9: "INTERRUPT", 10: "IOERR", 11: "CORRUPT", 12: "NOTFOUND", 13: "FULL", 14: "CANTOPEN", 15: "PROTOCOL", 16: "EMPTY",
  17: "SCHEMA", 18: "TOOBIG", 19: "CONSTRAINT", 20: "MISMATCH", 21: "MISUSE", 22: "NOLFS", 23: "AUTH", 24: "FORMAT",
  25: "RANGE", 26: "NOTADB" };
const EXTENDED = { 261: "BUSY_RECOVERY", 517: "BUSY_SNAPSHOT", 773: "BUSY_TIMEOUT", 262: "LOCKED_SHAREDCACHE",
  275: "CONSTRAINT_CHECK", 531: "CONSTRAINT_COMMITHOOK", 787: "CONSTRAINT_FOREIGNKEY", 1043: "CONSTRAINT_FUNCTION",
  1299: "CONSTRAINT_NOTNULL", 1555: "CONSTRAINT_PRIMARYKEY", 1811: "CONSTRAINT_TRIGGER", 2067: "CONSTRAINT_UNIQUE",
  2323: "CONSTRAINT_VTAB", 2579: "CONSTRAINT_ROWID", 2835: "CONSTRAINT_PINNED", 3091: "CONSTRAINT_DATATYPE",
  1032: "READONLY_DBMOVED" };

function codeOf(errcode) {
  if (!Number.isInteger(errcode)) return "SQLITE_ERROR";
  if (EXTENDED[errcode]) return `SQLITE_${EXTENDED[errcode]}`;
  return `SQLITE_${PRIMARY[errcode & 0xff] || "ERROR"}`;
}

function convert(err) {
  if (!err || typeof err !== "object" || err.code !== "ERR_SQLITE_ERROR") return err;
  const out = new Error(err.message);
  out.name = "SqliteError";
  out.code = codeOf(err.errcode);
  out.errcode = err.errcode;
  return out;
}

function guard(fn) {
  try {
    return fn();
  } catch (err) {
    throw convert(err);
  }
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v)
  && !(v instanceof Uint8Array);
const bindValue = (v) => (typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v);

function argsOf(args) {
  const flat = [];
  let named = null;
  for (const a of args) {
    if (Array.isArray(a)) flat.push(...a);
    else if (isPlain(a)) named = a;
    else flat.push(a);
  }
  const anon = flat.map(bindValue);
  if (!named) return anon;
  const n = {};
  for (const k of Object.keys(named)) n[k] = bindValue(named[k]);
  return [n, ...anon];
}

class Statement {
  constructor(db, sql) {
    this.database = db;
    this.source = sql;
    this._s = guard(() => db._raw.prepare(sql));
    this._pluck = false;
  }

  pluck(on) {
    this._pluck = on !== false;
    return this;
  }

  _row(row) {
    if (row === undefined || row === null) return undefined;
    if (this._pluck) {
      const keys = Object.keys(row);
      return keys.length > 0 ? row[keys[0]] : undefined;
    }
    return { ...row };
  }

  get(...args) {
    return this._row(guard(() => this._s.get(...argsOf(args))));
  }

  all(...args) {
    return guard(() => this._s.all(...argsOf(args))).map((r) => this._row(r));
  }

  run(...args) {
    const r = guard(() => this._s.run(...argsOf(args)));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  *iterate(...args) {
    for (const row of this.all(...args)) yield row;
  }
}

class Database {
  constructor(filename, options) {
    const file = filename === undefined || filename === null || filename === "" ? ":memory:" : String(filename);
    const opts = options || {};
    this.name = file;
    this.memory = file === ":memory:";
    this.readonly = opts.readonly === true;
    this._raw = guard(() => new DatabaseSync(file, { readOnly: this.readonly }));
    this._depth = 0;
    this._raw.exec(`PRAGMA busy_timeout = ${Number.isInteger(opts.timeout) ? opts.timeout : 5000}`);
  }

  get open() {
    return this._raw.isOpen;
  }

  get inTransaction() {
    return this._raw.isOpen && this._raw.isTransaction;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  exec(sql) {
    guard(() => this._raw.exec(sql));
    return this;
  }

  pragma(source, options) {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    if (options && options.simple) {
      const first = rows[0];
      if (!first) return undefined;
      return first[Object.keys(first)[0]];
    }
    return rows;
  }

  transaction(fn) {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const db = this;
    const make = (begin) => function shimTransaction(...args) {
      if (db.inTransaction) {
        db._depth += 1;
        const sp = `"shim_sp_${db._depth}"`;
        try {
          db.exec(`SAVEPOINT ${sp}`);
          let r;
          try {
            r = fn.apply(this, args);
            if (r && typeof r.then === "function") {
              throw new TypeError("Transaction function cannot return a promise");
            }
          } catch (err) {
            if (db.inTransaction) {
              db.exec(`ROLLBACK TO ${sp}`);
              db.exec(`RELEASE ${sp}`);
            }
            throw err;
          }
          db.exec(`RELEASE ${sp}`);
          return r;
        } finally {
          db._depth -= 1;
        }
      }
      db.exec(begin);
      let r;
      try {
        r = fn.apply(this, args);
        if (r && typeof r.then === "function") throw new TypeError("Transaction function cannot return a promise");
      } catch (err) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw err;
      }
      try {
        db.exec("COMMIT");
      } catch (err) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw err;
      }
      return r;
    };
    const t = make("BEGIN");
    t.deferred = t;
    t.default = t;
    t.immediate = make("BEGIN IMMEDIATE");
    t.exclusive = make("BEGIN EXCLUSIVE");
    t.database = db;
    return t;
  }

  close() {
    if (this._raw.isOpen) guard(() => this._raw.close());
    return this;
  }
}

module.exports = Database;
module.exports.default = Database;
module.exports.Database = Database;
