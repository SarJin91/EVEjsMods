# blueprintDrops

Loader mod for EveJS. Preload: `node --require /app/mods/blueprintDrops/loader.js .`
No EveJS file is changed. The mod wraps `npcLoot.rollNpcLootEntries` (first-load hook).

## 1. Blueprint drops

Every NPC wreck has a small chance to hold a blueprint: a copy (random runs/ME/TE), a T1 original
or a T2 original. Keys: `chanceSmall|Medium|Large|Other`, `copyShare`, `t1OriginalShare`,
`t2OriginalShare`, `copyMax*`, `log`.
The pool is every published blueprint (`lib/blueprintPool.js`); customTypes types (typeID 340000-349999)
are never in the pool, whatever their `published` flag.

One blueprint roll per wreck: a caller that rolls one wreck several times (Living New Eden
salvage anomaly wrecks) passes `{ extraRoll: true }` to `rollNpcLootEntries` for every roll after the
first; such calls skip the blueprint roll (`lib/lootRoll.js`). Native NPC wrecks roll once, unchanged.

### Salvaged wrecks keep blueprint copies

Salvaging a wreck that still holds loot turns it into a Cargo Container. EveJS
(`services/inventory/salvageItemCustody.js`) keeps only `singleton === true` there, so without
this fix a looted blueprint copy (singleton 2) becomes a packaged blueprint without industry state
that the client cannot open, and a copy marked by this mod becomes an original. The mod wraps
`transferNativeWreckLootToContainer` (first-load hook, `lib/salvageCopies.js`): a wreck with copies
gets them as copies (singleton 2 + blueprint state); any other wreck goes to EveJS unchanged.
Key `salvageCopyFix` (default `true`) works also with `enabled: false`. Repair of already broken items:
`tools/blueprintCopyRepair/fixBrokenBlueprintCopies.js` (server stopped, dry run by default).

## 2. Pirate NET Resonators, off by default

A pirate NPC of faction F leaves F's NET Resonator in its wreck (a second, independent roll):
Angel 83467, Blood Raider 83468, Guristas 83469, Mordu 83470, Sansha 83471, Serpentis 83472.
Every recognised pirate also rolls separately for the SoE NET Resonator 83473.
A wreck with resonators gets the generic hull components AIPS 57478 and LSBU 57486 only on a
separate `componentChance` roll; battleships/capitals roll for one CTR 57479 per wreck.

- Faction: `profile.factionID` when it is a pirate faction, else the NPC type's group from
  `data/pirateNpcGroups.json`. Hull size and tier (Commander/Officer = elite) always come from the group.
- The data file is built offline from the SDE: `node mods/blueprintDrops/tools/buildPirateNpcGroups.js`.
- Loot rolled without `options.source` (e.g. Living New Eden wreck anomalies) gets no resonators.

| key | default | meaning |
|---|---|---|
| `resonatorsEnabled` | `false` | master switch; env `EVEJS_BPDROPS_RESONATORS_ENABLED=1|0|true|false` wins |
| `resonatorChance` | frigate 0.10, destroyer 0.12, cruiser 0.15, BC 0.18, BS 0.25, capital 0.50, hauler 0 | chance per wreck by hull |
| `resonatorQuantity` | frigate [1,3], destroyer [1,4], cruiser [2,6], BC [3,8], BS [4,12], capital [40,80], hauler [0,0] | units per drop |
| `resonatorEliteChance` / `resonatorEliteQuantityMultiplier` | 0.50 / 3 | Commander/Officer groups |
| `resonatorComponentsEnabled` | `true` | AIPS/LSBU/CTR rolls on wrecks with resonators |
| `componentChance` | 0.30 | chance that a wreck with resonators gets AIPS/LSBU; 0 = never |
| `componentAipsPerResonator` / `componentLsbuPerResonator` | 0.5 / 0.25 | per resonator unit; probabilistic rounding: `floor(x)` + 1 with chance `x - floor(x)` |
| `componentCtrChance` / `componentCtrEliteChance` | BS 0.05, capital 1 / 0.25 | one CTR per wreck, own roll (not gated by `componentChance`) |
| `soeFromAllPirates` / `soeChanceMultiplier` | `true` / 0.25 | separate SoE roll, chance x multiplier |
| `resonatorLogDrops` | `false` | one log line per drop |
| `resonatorSummaryEvery` | 50 | summary line every N drops (0 = off) |

Table keys (`resonatorChance`, `resonatorQuantity`, `componentCtrChance`) merge per band with the defaults.
A bad config, bad data file or a resonator type missing from `ITEM_TYPES` turns only the resonators off
(log line with the reason); a missing component type turns only the components off. Blueprint drops keep working.
The data file and the config are checked at start (`resonators: off (BAD_CONFIG: ...)` right in the start line);
item types only at the first wreck (`resonators off: MISSING_TYPE ...`), so a start line `on (...)` says "types checked at the first wreck".
Resonators need the mod itself on (`enabled: true`).

### Resonator and component drop rates

Share of wrecks with a drop, earlier defaults -> current defaults (SoE on, multiplier 0.25; 1 000 000 simulated wrecks per row, seed 99).
The earlier defaults gave AIPS and LSBU on every wreck with a resonator.
The table is the output of `node mods/blueprintDrops/tools/dropRates.js` (it reads `lib/settings.js` DEFAULTS and `settings.json`;
`--wrecks N`, `--seed S`). Run it again after you change a chance and paste the new table here.

| hull | wreck with a resonator | wreck with AIPS | wreck with LSBU |
|---|---|---|---|
| frigate | 29.7% -> 12.3% (2.4x fewer) | 29.7% -> 3.1% (9.7x fewer) | 29.7% -> 1.9% (16.0x fewer) |
| destroyer | 35.3% -> 14.6% (2.4x fewer) | 35.3% -> 3.8% (9.2x fewer) | 35.3% -> 2.8% (12.6x fewer) |
| cruiser | 40.7% -> 18.2% (2.2x fewer) | 40.7% -> 5.5% (7.4x fewer) | 40.7% -> 4.7% (8.7x fewer) |
| battlecruiser | 46.0% -> 21.7% (2.1x fewer) | 46.0% -> 6.5% (7.1x fewer) | 46.0% -> 6.2% (7.4x fewer) |
| battleship | 56.3% -> 29.7% (1.9x fewer) | 56.3% -> 9.0% (6.3x fewer) | 56.3% -> 9.0% (6.3x fewer) |
| capital | 100.0% -> 56.3% (1.8x fewer) | 100.0% -> 16.9% (5.9x fewer) | 100.0% -> 16.9% (5.9x fewer) |
| elite battleship | 100.0% -> 56.3% (1.8x fewer) | 100.0% -> 16.8% (6.0x fewer) | 100.0% -> 16.8% (6.0x fewer) |

Units of AIPS/LSBU per resonator unit drop ~6.7x / ~6.7x (0.3 x 0.5 vs 1, 0.3 x 0.25 vs 0.5).
To tune, set the keys in `settings.json` (table keys merge per band).

## 3. Faction loot, off by default

Every NPC wreck can get 0-3 extra items of the NPC's faction, added at the end of the vendor roll (after the
blueprint and the resonators; nothing is removed, one roll per wreck, `{ extraRoll: true }` rolls skip it).
Pools per faction are built offline from the SDE into `data/factionLoot.json`:
`node mods/blueprintDrops/tools/buildFactionLoot.js` (`--check` = exit 1 when the file differs from the SDE; run it
after an EveJS/SDE update together with `lootRebalance.js --check`). Factions now: Guristas, Angel, Blood Raiders,
Sansha, Serpentis (tags, faction ammo, faction modules, deadspace modules), Rogue Drones (drone components) and the
four empire navies (insignia, navy ammo and modules). CONCORD gets nothing.

Seven more factions (17 in total in the start line):

| faction | uncommon | rare | epic |
|---|---|---|---|
| Ammatar 500007 | insignia "Ammatar ..." | modules "Ammatar Navy ..." | module BPCs |
| Khanid 500008 | insignia "Khanid ..." | modules "Khanid Navy ..." | module BPCs |
| Thukker 500015 | - | modules "Thukker ..." | - |
| Sisters 500016 | probes "Sisters ..." | modules "Sisters ..." | hull BPCs (Astero, Stratios, Nestor) |
| Mordu 500018 | - | - | hull BPCs (Garmur, Orthrus, Barghest, ...) |
| Drifters 500024 | materials of the group of Antikythera Element | - | - |
| Triglavian 500026 | Triglavian Data, Zero-Point Condensate, Crystalline Isogen-10 (no mutaplasmid residue) | - | - |

Sleepers (500021) and EDENCOM (500027) are recognised in the NPC groups but have no items (`skip ...: no items` in the
builder report, `NO_POOLS` at runtime; the vendor `loot_sleeper_blue_*` tables give the Sleeper blue loot). NPC groups
without a hull class in the name (`Triglavian Entities`, `EDENCOM Entities`, `Drifter Entities`, `Seeker Scouts`, ...)
get a band per NPC type (`npcTypeBands` in the data file: a class word of the type name, else a player hull name in
it, else the mass: < 2,000 t frigate, < 20,000 t cruiser, < 200,000 t battleship, else capital). Wrecks of the tables
in `factionLootSkipTables` (default the abyssal table) get neither faction loot nor the filler (`SKIPPED_TABLE`).

- Faction: `profile.factionID` (when it has pools), else the NPC group, else the alias of `source.factionName`.
  Hull band and tier (normal, deadspace, mission, commander, overseer, officer) come from the NPC group; a player hull
  (Living New Eden fleets) gives the band from its ship group. No band (sentries, structures, swarms) = no faction loot.
- Rarities, rolled one after the other, at most one item each: `epic` (a native blueprint copy, see below),
  `rare` (module; deadspace only commander and up), `uncommon` (tag, ammo, material). Item size follows the hull:
  frigate/destroyer small, cruiser/BC/hauler medium, battleship/capital large, plus size-less modules.
- Chance per wreck = `factionLootTierChance[tier][rarity]` x `factionLootBandScale[band]` x `factionLoot<Rarity>Scale`.

| tier | uncommon | rare | epic |
|---|---|---|---|
| normal | 0.05 | 0.003 | 0.0002 |
| deadspace | 0.08 | 0.006 | 0.0005 |
| mission | 0.04 | 0.002 | 0.0001 |
| commander | 0.40 | 0.04 | 0.004 |
| overseer | 0.50 | 0.06 | 0.008 |
| officer | 0.60 | 0.08 | 0.015 |

The epic chances already include a x4 blueprint boost (base values 1/4 of these: normal 0.00005 ... officer 0.00375);
they are not multiplied again. The economy ceiling is `factionLootEpicCapPerHour` (12 per hour, server-wide).

Epic: a blueprint copy (`singleton: 2` + the vendor `buildBlueprintCopyState`, ME 0, TE 0,
`quantity: 1`). `bpcModule` (weight 4) = a published blueprint whose product is in the faction's module/ammo pool,
of the hull size; `bpcHull` (weight 1) = a published blueprint of a faction hull (metaGroupID 4) of a hull size up to
the band, only on battleship/capital bands, or of any size for commander/overseer/officer. Runs from
`factionLootBpcRuns` (module [1,3], hull [1,1]), cut to the blueprint's `maxProductionLimit`. Deadspace modules have no
blueprints. Pirate factions have almost no published module blueprints (Guristas 1, Angel 1, others 0), so their
epic is mostly a hull. The copy is native: it never goes through the old `copySpec` marker, and a salvaged wreck
keeps it as a copy (`copyKind "native"`).

Known gap: the random blueprint drop of section 1 (`getPool()`) still takes every published blueprint, faction
blueprints included, also as an original. This gap is known and left as it is on purpose.

| key | default | meaning |
|---|---|---|
| `factionLootEnabled` | `false` | kill switch (needs `enabled: true`); env `EVEJS_BPDROPS_FACTION_LOOT_ENABLED=1|0|true|false` wins, the panel override wins over the env |
| `factionLootUncommonScale` / `factionLootRareScale` / `factionLootEpicScale` | 1 / 1 / 1 | global chance multipliers |
| `factionLootMaxEntriesPerWreck` | 3 | items of this layer per wreck (0..6) |
| `factionLootRareCapPerHour` | 120 | server-wide rare drops per hour (in memory, full after a restart); 0 = no rare |
| `factionLootEpicCapPerHour` | 12 | server-wide epic (blueprint copy) drops per hour, same rules; 0 = no epic |
| `factionLootBpcRuns` | bpcModule [1,3], bpcHull [1,1] | runs of an epic copy (cut to the blueprint's max runs) |
| `factionLootLog` / `factionLootSummaryEvery` | `false` / 100 | a line per drop (with the seed) / a summary every N drops |
| `factionLootSeedSalt` | `"factionLoot"` | seed salt (settings.json only) |
| `factionLootBandScale` | frigate 1, destroyer 1.2, cruiser 1.5, BC 2, BS 3, capital 6, hauler 0.5 | chance multiplier by band |
| `factionLootCategoryWeights` | uncommon tag 5, ammo 4, material 3; rare module 4, deadspace 1; epic bpcModule 4, bpcHull 1; common ammo 5, module 3, salvage 3 | category pick |
| `factionLootQuantity` / `factionLootTierQuantityMultiplier` | tag [1,2], ammo [10,40], material [1,4], modules 1 / commander x2, overseer x3, officer x3 | stack sizes |
| `factionLootSkipFactionIDs` | [500006] | factions without faction loot |
| `factionLootFillerEnabled` | `true` | T1 filler of empty placeholder tables (only with `factionLootEnabled`) |
| `factionLootFillerMaxEntries` / `factionLootFillerEntries` | 3 / [1,3] | filler ceiling (0..6, apart from `factionLootMaxEntriesPerWreck`) / entries rolled |
| `factionLootFillerExcludeTables` | abyssal, law enforcement, zero damage target shell, destructible sentry guns | placeholder tables without a filler |
| `factionLootSkipTables` | [`parity_abyssal_entities_pending_loot`] | loot tables without faction loot and filler |
| `factionLootFillerTierQuantity` | `false` | `false` = filler stacks from `factionLootQuantity` alone (ammo 10-40, salvage 1-5, also for officers); `true` = x `factionLootTierQuantityMultiplier` |

T1 filler: a wreck whose vendor table is a placeholder (`emptyRule` or `disableRandomLoot`, e.g. the
`parity_*_pending_loot` tables) and whose vendor roll gave 0 entries first gets 1-3 `common` entries: T1 ammo and
modules of the hull size or salvage (`data/factionLoot.json` `common`, weights `factionLootCategoryWeights.common`
ammo 5, module 3, salvage 3; salvage quantity [1,5]). The faction roll follows as usual. A belt table emptied by
`emptyChance` gets nothing.

Start line: `faction loot: off (factionLootEnabled: false)`, `faction loot: on (17 factions, ..., epicCap=12/h, ...,
bpc module/hull: caldari 22/14, ...)` or `faction loot: off (BAD_CONFIG: ...)`; at the first wreck
`faction loot: on (... types=N, missing=K)` (types missing from `ITEM_TYPES` are dropped). A bad config or data file
turns only this layer off; blueprints and resonators keep working. Without the vendor `buildBlueprintCopyState` the
log says `faction loot epic off (NO_COPY_STATE)` once and only the epic is off. With `factionLootLog` a drop line ends
with `epic=<name> runs=<n>` when it has an epic; the summary counts `drops` (wrecks with a faction drop) apart from
`filler` (wrecks with only the T1 filler).

### Enabling faction loot

- Layers of `factionLootEnabled` (a higher one wins): `DEFAULTS` (`false`) < `settings.json` (no key = `false`) < env
  `EVEJS_BPDROPS_FACTION_LOOT_ENABLED` (`1|true` on, `0|false` off, empty or another value = `settings.json`) < the
  in-game panel override (`settings.override.json` in the data volume). The layer is off by default. On Docker, turn
  it on through the env in `compose.yaml` (like `EVEJS_BPDROPS_RESONATORS_ENABLED`); without that line in
  `compose.yaml` the env never reaches the container (compose has no `env_file`).
- Config is read once at start: a panel change needs `docker compose restart server` (no build); `data/factionLoot.json`
  is loaded only when the flag was on at start.
- Override trap: the panel override wins over the env. After testing, set the scales back to 1 and delete the
  `factionLootEnabled` row in the panel (or leave it `true`); a leftover `false` hides env `1`.
- Turning it off: `EVEJS_BPDROPS_FACTION_LOOT_ENABLED=0` (or remove the compose line) and
  `docker compose up -d --force-recreate server`.
- Values for a quick in-game test (panel, test only): `factionLootUncommonScale 10`, `factionLootRareScale 50`,
  `factionLootEpicScale 200`, `factionLootLog true`, `factionLootSummaryEvery 10`; caps stay default.
- Checks after every EveJS/SDE update (both must exit 0):
  `node mods/blueprintDrops/tools/buildFactionLoot.js --check` and `node tools/lootRebalance/lootRebalance.js --check`.

### Faction loot rates

Output of `node mods/blueprintDrops/tools/dropRates.js --faction --wrecks 100000` (seed 99; raw chances as if
`factionLootEnabled` were true, no hourly caps, no filler; the last column = epic per hour at one such wreck every
10 s, before `factionLootEpicCapPerHour` 12). Rows with 0% epic = no blueprint of that kind for the faction and band.
The table covers the first 10 factions; run the command again for the other 7.

| faction | tier | hull | wreck with uncommon | wreck with rare | wreck with epic | epic/h at 1 wreck/10 s |
|---|---|---|---|---|---|---|
| caldari | normal | frigate | 5.12% | 0.29% | 0.02% | 0.09 |
| caldari | normal | cruiser | 7.47% | 0.47% | 0.02% | 0.06 |
| caldari | normal | battleship | 14.89% | 0.91% | 0.05% | 0.19 |
| caldari | commander | frigate | 39.73% | 4.06% | 0.41% | 1.49 |
| caldari | commander | cruiser | 60.02% | 6.10% | 0.59% | 2.14 |
| caldari | commander | battleship | 100.00% | 12.10% | 1.17% | 4.20 |
| caldari | officer | frigate | 59.87% | 8.14% | 1.50% | 5.42 |
| caldari | officer | cruiser | 90.00% | 12.02% | 2.24% | 8.08 |
| caldari | officer | battleship | 100.00% | 23.87% | 4.53% | 16.30 |
| minmatar | normal | frigate | 5.04% | 0.27% | 0.02% | 0.07 |
| minmatar | normal | cruiser | 7.51% | 0.44% | 0.03% | 0.11 |
| minmatar | normal | battleship | 14.96% | 0.95% | 0.06% | 0.23 |
| minmatar | commander | frigate | 40.01% | 4.00% | 0.40% | 1.43 |
| minmatar | commander | cruiser | 59.85% | 6.03% | 0.61% | 2.18 |
| minmatar | commander | battleship | 100.00% | 12.16% | 1.26% | 4.52 |
| minmatar | officer | frigate | 60.27% | 7.92% | 1.49% | 5.38 |
| minmatar | officer | cruiser | 90.01% | 12.08% | 2.20% | 7.90 |
| minmatar | officer | battleship | 100.00% | 24.04% | 4.52% | 16.28 |
| amarr | normal | frigate | 4.94% | 0.29% | 0.03% | 0.12 |
| amarr | normal | cruiser | 7.44% | 0.45% | 0.03% | 0.10 |
| amarr | normal | battleship | 15.19% | 0.89% | 0.07% | 0.24 |
| amarr | commander | frigate | 40.08% | 4.10% | 0.40% | 1.45 |
| amarr | commander | cruiser | 59.91% | 5.91% | 0.60% | 2.15 |
| amarr | commander | battleship | 100.00% | 11.94% | 1.19% | 4.28 |
| amarr | officer | frigate | 60.04% | 8.09% | 1.53% | 5.51 |
| amarr | officer | cruiser | 89.96% | 11.89% | 2.21% | 7.96 |
| amarr | officer | battleship | 100.00% | 24.02% | 4.46% | 16.04 |
| gallente | normal | frigate | 5.09% | 0.29% | 0.02% | 0.06 |
| gallente | normal | cruiser | 7.42% | 0.44% | 0.03% | 0.12 |
| gallente | normal | battleship | 15.01% | 0.90% | 0.06% | 0.21 |
| gallente | commander | frigate | 40.21% | 4.02% | 0.37% | 1.34 |
| gallente | commander | cruiser | 59.78% | 5.94% | 0.59% | 2.12 |
| gallente | commander | battleship | 100.00% | 12.05% | 1.22% | 4.38 |
| gallente | officer | frigate | 60.03% | 7.95% | 1.57% | 5.65 |
| gallente | officer | cruiser | 90.01% | 11.93% | 2.23% | 8.03 |
| gallente | officer | battleship | 100.00% | 24.23% | 4.41% | 15.89 |
| guristas | normal | frigate | 4.97% | 0.30% | 0.02% | 0.08 |
| guristas | normal | cruiser | 7.56% | 0.46% | 0.03% | 0.12 |
| guristas | normal | battleship | 15.04% | 0.94% | 0.06% | 0.21 |
| guristas | commander | frigate | 39.98% | 4.03% | 0.42% | 1.50 |
| guristas | commander | cruiser | 59.93% | 5.90% | 0.62% | 2.22 |
| guristas | commander | battleship | 100.00% | 11.97% | 1.17% | 4.20 |
| guristas | officer | frigate | 60.13% | 8.06% | 1.53% | 5.51 |
| guristas | officer | cruiser | 90.15% | 12.11% | 2.23% | 8.04 |
| guristas | officer | battleship | 100.00% | 23.89% | 4.49% | 16.17 |
| angel | normal | frigate | 5.07% | 0.31% | 0.02% | 0.08 |
| angel | normal | cruiser | 7.61% | 0.50% | 0.03% | 0.10 |
| angel | normal | battleship | 15.05% | 0.88% | 0.05% | 0.17 |
| angel | commander | frigate | 39.96% | 4.09% | 0.41% | 1.48 |
| angel | commander | cruiser | 60.09% | 6.00% | 0.56% | 2.03 |
| angel | commander | battleship | 100.00% | 11.95% | 1.21% | 4.37 |
| angel | officer | frigate | 59.91% | 8.03% | 1.48% | 5.32 |
| angel | officer | cruiser | 90.02% | 11.83% | 2.31% | 8.33 |
| angel | officer | battleship | 100.00% | 24.02% | 4.53% | 16.30 |
| blood_raider | normal | frigate | 4.96% | 0.30% | 0.00% | 0.00 |
| blood_raider | normal | cruiser | 7.54% | 0.43% | 0.00% | 0.00 |
| blood_raider | normal | battleship | 15.13% | 0.91% | 0.06% | 0.21 |
| blood_raider | commander | frigate | 39.80% | 4.04% | 0.38% | 1.35 |
| blood_raider | commander | cruiser | 60.28% | 6.13% | 0.61% | 2.20 |
| blood_raider | commander | battleship | 100.00% | 12.08% | 1.22% | 4.40 |
| blood_raider | officer | frigate | 60.04% | 7.78% | 1.46% | 5.27 |
| blood_raider | officer | cruiser | 89.94% | 11.98% | 2.27% | 8.18 |
| blood_raider | officer | battleship | 100.00% | 24.16% | 4.49% | 16.16 |
| sansha | normal | frigate | 5.05% | 0.30% | 0.00% | 0.00 |
| sansha | normal | cruiser | 7.52% | 0.45% | 0.00% | 0.00 |
| sansha | normal | battleship | 15.03% | 0.85% | 0.06% | 0.21 |
| sansha | commander | frigate | 39.81% | 4.02% | 0.41% | 1.47 |
| sansha | commander | cruiser | 59.91% | 5.98% | 0.58% | 2.10 |
| sansha | commander | battleship | 100.00% | 12.04% | 1.21% | 4.36 |
| sansha | officer | frigate | 60.03% | 8.13% | 1.54% | 5.55 |
| sansha | officer | cruiser | 90.02% | 12.06% | 2.28% | 8.21 |
| sansha | officer | battleship | 100.00% | 23.95% | 4.50% | 16.20 |
| serpentis | normal | frigate | 4.94% | 0.30% | 0.00% | 0.00 |
| serpentis | normal | cruiser | 7.51% | 0.44% | 0.00% | 0.00 |
| serpentis | normal | battleship | 14.88% | 0.88% | 0.06% | 0.21 |
| serpentis | commander | frigate | 39.95% | 4.03% | 0.39% | 1.40 |
| serpentis | commander | cruiser | 59.66% | 6.21% | 0.59% | 2.11 |
| serpentis | commander | battleship | 100.00% | 12.14% | 1.21% | 4.35 |
| serpentis | officer | frigate | 59.85% | 7.92% | 1.54% | 5.54 |
| serpentis | officer | cruiser | 89.95% | 12.23% | 2.23% | 8.03 |
| serpentis | officer | battleship | 100.00% | 23.94% | 4.44% | 15.97 |
| rogue_drones | normal | frigate | 4.95% | 0.00% | 0.00% | 0.00 |
| rogue_drones | normal | cruiser | 7.38% | 0.00% | 0.00% | 0.00 |
| rogue_drones | normal | battleship | 15.09% | 0.00% | 0.00% | 0.00 |
| rogue_drones | commander | frigate | 40.10% | 0.00% | 0.00% | 0.00 |
| rogue_drones | commander | cruiser | 60.12% | 0.00% | 0.00% | 0.00 |
| rogue_drones | commander | battleship | 100.00% | 0.00% | 0.00% | 0.00 |
| rogue_drones | officer | frigate | 59.84% | 0.00% | 0.00% | 0.00 |
| rogue_drones | officer | cruiser | 90.10% | 0.00% | 0.00% | 0.00 |
| rogue_drones | officer | battleship | 100.00% | 0.00% | 0.00% | 0.00 |

Tests: `node mods/blueprintDrops/test/run.js` (or `RunTests.bat`).
