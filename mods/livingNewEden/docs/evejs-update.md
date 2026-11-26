# EveJS update checklist: Living New Eden

Checklist for a change of the EveJS server version (`server/**`). We do not edit `server/**`. Fixes go only into `mods/**`.

Items marked "manual check" need Docker or an operator decision.

## 0. Before the update

- [ ] Write down the current version: `server/package.json`, field `version` (for example `261115.2`).
- [ ] Make a cold archive of the `evejs-data` volume (`docs/operator-runbook.md`, section 3.1).
- [ ] Work in a separate worktree. Do not overwrite `server/` on the main branch before the tests are green.

## 1. Image tag without the mod (`baseline-nolne`)

The image `evejs-local:baseline-nolne` is the server image without the LNE line in `docker/entrypoint.sh`. Rollback and the variant A bench use this image: put `image: evejs-local:baseline-nolne` under `services.server` in `compose.override.yaml`, then `docker compose up -d server`; remove the line to go back.

- [ ] After updating `server/`, rebuild the tag from the new tree without the mod. Manual check.
  1. Temporarily remove the line `--require /app/mods/livingNewEden/loader.js` from both blocks of `docker/entrypoint.sh`.
  2. `docker compose build init`, then `docker tag evejs-local evejs-local:baseline-nolne`.
  3. Restore the LNE line in both blocks of `docker/entrypoint.sh`.
  4. Run `docker compose build init` again.
- [ ] **Warning:** do not skip steps 3 and 4. Without them `evejs-local:latest` stays an image without the mod, and `docker compose up -d` starts the server without Living New Eden.
- [ ] Write down the image ID and the tag date in the update notes.

## 2. Loot tables (`lootRebalance`)

An EveJS update replaces the static tables `tools/DatabaseCreator/staticTables/npcLootTables` and `npcProfiles`. The loot rebalance must then be done again.

How the tool works (`tools/lootRebalance/lootRebalance.js`):

- The original tables are in `tools/lootRebalance/backup/` (`npcLootTables.data.json`, `npcProfiles.data.json`).
- The tool writes a file into `backup/` only when that file does not exist. An existing file stays unchanged.
- The rebalance always starts from the files in `backup/`, not from the tables in `staticTables/`.
- `tools/lootRebalance/` is tracked in git (`.gitignore`, line `!/tools/lootRebalance/`). The files `backup/*.json` are tracked too.

Steps:

1. Check the state: `node tools/lootRebalance/lootRebalance.js --check`. Exit code 1 = the tables are not rebalanced.
2. When the exit code is 1: move `tools/lootRebalance/backup/` to `tools/lootRebalance/backup-<old version>/`. Name pattern: `backup-0.12.9/`, `backup-261018.1/`, `backup-261028.1/`. Add the new directory `backup-<old version>/` to the root `.gitignore`, next to the existing `backup-*` lines.
3. Run: `node tools/lootRebalance/lootRebalance.js`. The tool does not find `backup/`. It writes the new EveJS originals from `staticTables/` there, then rebalances the tables.
4. Check again: `node tools/lootRebalance/lootRebalance.js --check`. Expected: `OK (rebalanced)`.
5. Run the tool tests on a machine with the full SDE: `node tools/lootRebalance/test/run.js`. Expected: all PASS, 0 SKIP.
   - T9 after an EveJS update (name prefixes of faction items): `node tools/lootRebalance/test/run.js --only T9`. T9 rolls the LNE event reward tables (`mods/livingNewEden/lib/adapter/rewardLoot.js`) with the real `rollNpcLootEntries`. FAIL "no faction item" = EveJS changed the faction item names or the rule pool logic (`npcLoot.js`). Reward crates then hold only T1 filler. Fix the prefixes in the LNE event catalog or open an issue. Write the `T9 default weights` line into the update notes.
6. Add the new files `tools/lootRebalance/backup/*.json` to the update commit.
7. Rebuild the Docker image. The server copies the tables into the gameStore at every start.

**Warning:** do not skip step 2. Without step 2 the tool computes the rebalance from the old originals in `backup/`. The result overwrites the new EveJS tables `npcLootTables` and `npcProfiles`. The EveJS changes in these tables disappear without a message. `--check` then shows `OK (rebalanced)`, because it compares the tables with a rebalance of the same old originals.

## 3. Hashes and data generated from the SDE

- [ ] Ship strength catalog: `node mods/livingNewEden/tools/buildStrengthCatalog.js --sde <SDE jsonl directory>`. The header `evejsVersion` must equal `server/package.json`, field `version` (test S4a in `test/battle/strength.test.js`).
- [ ] Resolver golden hashes: `GOLDEN_FAST_HASH` and `GOLDEN_DETERMINISM_HASH` in `test/battle/resolver.test.js`. The hashes depend on `catalogSourceHash`. A new catalog gives new hashes without a model change. Change a hash only when the resolver model is unchanged. Write this down in the update notes.
- [ ] Other SDE generators: run each with `--check` (`buildFactionCatalog.js`, `buildHullRecipes.js`, `buildHullTradeTypes.js`, `buildIndustryCatalog.js`, `buildOreTypes.js`). Exit code 1 = the data differs from the generated data. Then generate the data again and describe the difference.
- [ ] When the SDE build changes too: update `FACTION_CATALOG_SDE` (generator output) and check the factions with `sdeHqSystemId` 30005286 (the registry overrides the HQ for 500025 and 500026).

## 4. Vendor fact tests and the probe

- [ ] `node mods/livingNewEden/test/run.js --only loader/facts`: EveJS facts (T5a, A3, F1, F4 and others).
- [ ] `node mods/livingNewEden/test/run.js --bench`: also the full facts that give SKIP without `--bench` (for example P2full, T3full, P1 presence).
- [ ] For every red assertion: find the upstream change (`file:line` in the new `server/src`). Decide whether the behavior changed or only the shape of the code.
  - Shape only: update the fact or the test.
  - Behavior change: fix the mod adapter or loader and add a test.
- [ ] Static probe of `GAME_MODULES` (`lib/adapter/gameModules.js`): every path and every symbol exists in the new `server/src`. Write the probe as a throwaway script outside the repo.
- [ ] Files removed upstream: `git status --porcelain server | grep '^ D'`. No file in `lib/**` or `loader.js` may refer to them.
- [ ] Tests of the other mods: `node mods/<mod>/test/run.js` for every mod with a `test/run.js`.
- [ ] Empire fleet in anomalies (`world.siteNavy`): `grep -rn sentryGuns server/src` should give only `defaultEmpireScenery.js`. A new consumer of `populationHints.sentryGuns` = pirate sentry guns next to the empire fleet. Also check that `npcService.spawnNpcBatchInSystem` still calls `nativeNpcService.spawnNativeDefinitionsInContext(` through the module object (test SN5).

## 5. Full suite and gate

- [ ] `node mods/livingNewEden/test/run.js`: all PASS. On Node 24 in the image with `better-sqlite3`. Locally through the `node:sqlite` shim.
- [ ] `node tools/lne-check/cli.js --gate` gives `LNE-CHECK OK`. Manual check (the dependencies may be missing locally).

## 6. Docker

- [ ] `docker compose build init`, then `docker compose up -d`.
- [ ] Log: `probe passed (...)`, no `probe DRIFT` and no `probe MISSING`.
- [ ] Log: every service is `running` or `disabled_by_config`.
- [ ] Observer: the "status" panel has the `ok` badge.
- [ ] The game works: login, undock, warp, kill an NPC on a belt.

## 7. After the update

- [ ] Update the server version in the mod README header.
- [ ] Write down the result of the update and the decisions taken in the project notes.
