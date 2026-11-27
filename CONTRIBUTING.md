# Contributing

Pull requests are welcome. These rules keep the mods safe to run on a live
EveJS server and keep review short.

## Start from the current repository

- Fork this repository and branch from the current `main`. Do not send a copy
  of a mod folder taken from a release ZIP or from your server: the mods change
  often, and a folder copy cannot be merged.
- Keep one topic per pull request. Small pull requests are reviewed faster.
- Say which EveJS version you tested on. The target version is the one in the
  root [README](README.md) (`server/package.json` of EveJS). A mod declares the
  versions it supports in `compatibility.evejsVersions` of its
  `evejs-launcher.mod.json`.

## Design rules

- **New features are behind a flag that is off by default.** Add the key with a
  short English description to the mod's `.env.example` (and to the launcher
  settings in the manifest when it should be visible in **Configure**). With
  the flag off, the mod must behave exactly as before.
- **Only the adapter knows EveJS.** In Living New Eden every `require` of
  `server/src/**` goes through `lib/adapter/`. The other modules talk to the
  adapter. When EveJS code that a mod hooks does not match, the mod logs
  `DRIFT` and stays inactive; it never crashes the server.
- **Every limit is a configuration key.** No magic numbers in logic: budgets,
  caps, timeouts and chances come from `config.js` with a default.
- **Seeded randomness.** Use the mod's seeded RNG helpers, not `Math.random()`,
  so results can be reproduced in tests.
- **No EveJS files are edited.** Mods integrate through their loader (preload
  and module hooks) only.
- **Persistent state** goes under the data root (`EVEJS_DATA_ROOT`), never into
  the mod folder.

## Tests

Each mod has its own suite, for example:

```sh
node mods/livingNewEden/test/run.js
node mods/shipWing/test/run.js
```

Most suites load the real EveJS modules, so run them with this repository's
`mods/` folder placed inside an EveJS installation (next to `server/`). A few
tests also read the mod's `settings.json` (copy `settings.example.json`) or
the Docker files of the installation (`compose.yaml`, `docker/entrypoint.sh`);
without those files they fail or are skipped, so compare with a run on `main`
in the same setup. The suite of every mod you touch must not get new
failures, and new behaviour needs a test. Tests must be fast: no sleeps, no
benchmarks.

## Clean code

- Code, log messages, error texts and test names are in English.
- Comments only where the code would otherwise mislead; one short sentence.
  No change history in comments.
- No ticket numbers, decision numbers or personal names in code, strings or
  file names.
- Keep licence and attribution headers. Code ported from another project needs
  a line in the mod's `CREDITS.md` (source, licence, files) and must be
  compatible with AGPL-3.0.
- Never commit `.env`, `settings.json` with your local values, API keys, logs
  or local paths.

## Licence

By sending a pull request you agree that your contribution is released under
the repository licence, AGPL-3.0 (see [`LICENSE`](LICENSE)).
