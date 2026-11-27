"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { CALIBRATION_METHOD } = require("./method");

const F = CALIBRATION_METHOD.fetch;
const DAY_RE = /^\d{8}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { out: null, days: [], totals: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--totals") args.totals = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--out" && argv[i + 1]) { args.out = path.resolve(argv[i + 1]); i += 1; }
    else if (arg === "--days" && argv[i + 1]) { args.days = argv[i + 1].split(",").filter(Boolean); i += 1; }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.out) throw new Error("--out is required");
  for (const day of args.days) if (!DAY_RE.test(day)) throw new Error(`bad day ${day} (YYYYMMDD)`);
  if (!args.totals && args.days.length === 0) throw new Error("--totals or --days required");
  return args;
}

let lastRequestAt = 0;

async function download(url, file) {
  let lastError = null;
  for (let attempt = 1; attempt <= F.attempts; attempt += 1) {
    const wait = lastRequestAt + F.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { redirect: "follow",
        headers: { "User-Agent": F.userAgent, "Accept-Encoding": "gzip", Accept: "application/json" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      const tmp = `${file}.part`;
      const source = Readable.fromWeb(res.body);
      source.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
      await pipeline(source, fs.createWriteStream(tmp));
      fs.renameSync(tmp, file);
      return { url: res.url || url, status: res.status, bytes, sha256: hash.digest("hex"),
        contentType: res.headers.get("content-type") };
    } catch (err) {
      lastError = err;
      process.stderr.write(`fetch ${url} attempt ${attempt}/${F.attempts}: ${err.message}\n`);
      if (attempt < F.attempts) await sleep(F.retryPauseMs);
    }
  }
  throw new Error(`${url}: ${lastError && lastError.message}`);
}

function readManifest(file) {
  if (!fs.existsSync(file)) return { v: 1, userAgent: F.userAgent, entries: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main(argv) {
  const args = parseArgs(argv);
  const rawDir = path.join(args.out, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const manifestFile = path.join(args.out, "manifest.json");
  const manifest = readManifest(manifestFile);
  const record = (entry) => {
    manifest.entries = manifest.entries.filter((e) => e.file !== entry.file);
    manifest.entries.push(entry);
    manifest.entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const jobs = [];
  if (args.totals) jobs.push({ url: F.totalsUrl, file: path.join(args.out, "totals.json"), day: null });
  for (const day of args.days) jobs.push({ url: F.rawUrl.replace("{day}", day), file: path.join(rawDir, `${day}.json`), day });
  for (const job of jobs) {
    if (fs.existsSync(job.file) && !args.force) {
      process.stdout.write(`skip ${path.basename(job.file)} (exists, --force to overwrite)\n`);
      continue;
    }
    const got = await download(job.url, job.file);
    record({ file: path.relative(args.out, job.file).split(path.sep).join("/"), day: job.day, ...got,
      fetchedAt: new Date().toISOString(), userAgent: F.userAgent });
    process.stdout.write(`${path.basename(job.file)}: ${got.bytes} bytes sha256 ${got.sha256}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.stdout.write("calibration: OK\n");
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`${(err && err.stack) || err}\n`);
  process.stdout.write(`calibration: FAIL ${(err && err.message) || err}\n`);
  process.exitCode = 1;
});
