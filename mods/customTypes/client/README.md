# customTypes client data

The EVE client must know every custom type the `customTypes` mod adds on the
server, with **identical** blueprint data: the server rejects an industry job
whose materials, time or cost differ from what the client computed
(`MISMATCH_MATERIAL`, `MISMATCH_TIME`, `MISMATCH_COST`). This tool writes the
client half from the same pack files the server reads (every
`mods/customTypes/data/*.json`: `archaeology-relics.json`,
`heavy-sentries.json`, `listening-post.json`, `mobile-sentries.json`,
`officer-blueprints.json`, `pi-blueprints.json`, `planetary-drill.json`,
`season-trophies.json` and `trig-bridge.json`), so both sides come from one
source. All packs go to the client **together**, in one plan, one apply, one
index backup and one rollback: one command does it all.

## What it changes in the client

| Client resource | Change |
|---|---|
| `res:/staticdata/types.fsdbinary`, `typedogma.fsdbinary` | per pack type, a clone of its source type (for example Spatial Attunement Unit Blueprint 33196 for the 68 PI blueprints 340365-340435, Orbital Skyhook 81080 for 340100 and the 15 Planetary Drill (<P0>) variants 340102-340116, 33196 with group 1045 for 340101 and the variant blueprints 340202-340216, the small starbase batteries 16631/16690/17167/16696 for Mobile Sentry 340500-340503 (group kept; no iconID in the source, so the client keeps the battery look) and 33196 with the battery blueprint groups 854/855/853/871 for 340510-340513, 33196 with the parent module's blueprint group and the officer's icon for the 593 officer blueprints 341000-341592, Organic Mortar Applicators 2870 (group kept) for Triglavian Conduit Core 341640 and 33196 for its blueprint 341641; every source needs a `typeDogma` record, the tool refuses one without it up front: `source <id> has no typeDogma record`) with the new typeID, name ID, group and base price, compiled by the tool's own encoder (`fsd/`) and read back by the client's own FSD loader before anything is written |
| `res:/localizationfsd/localization_fsd_*.pickle` | the name and description of the new type (message IDs from 2000000) |
| `res:/staticdata/blueprints.static` (SQLite) | one `cache` row per blueprint (clone of the 971 row: the pack's activities only, `blueprintTypeID`, `maxProductionLimit`) and one `indexes` row `productTypeID.<product>` |
| `tq/resfileindex.txt`, `tq/resfileindex_prefetch.txt` | the entries above point at the new files (new hash and size) |

New payloads are new content-addressed files under `ResFiles\`; no existing
file in `ResFiles\` is changed. Only the two index files are replaced, after a
backup.

The tool is standalone: the cFSD reader and encoder, the resource index, the
localization patch and the native read-back live in `fsd/` (ported from the
Elysian FSD and Item Forge tools shipped with EveJS, see `../CREDITS.md`); it
imports nothing from `tools\` or another mod. It does not touch EveJS server
data or the market database.

## Client builds (profiles)

The tool writes only to a client build it has a profile for:
`profiles/build-<build>.json` (the build number comes from `tq\start.ini`).
A profile lists the five item tables (`types`, `typedogma`,
`requiredskillsfortypes`, `typematerials`, `iconids`) with their logical
path, generated loader and schema fingerprint, and the result of the encoder
proof. `plan`/`apply` refuse a build without a profile, a table whose loader,
path or fingerprint differs from the profile, and a fingerprint the encoder
has no native layout for:

- `REFUSED: no profile for client build <n> ... run ApplyClientData.bat profile`
- `REFUSED: client build <n> is not supported: typedogma: schema fingerprint ... has no known native layout`

Shipped: 3396210 (24.01) and 3724492 (24.02). Build 3724492 has 151 FSD
tables (149 in 3396210; new `academyship`, `fittings`; changed schema
`dungeons`, `itemtraderrecipes`, `missions`, `spacecomponentsbytype`), but the
five item tables keep the 3396210 schemas, loaders and content hash.

After a client update to a new build, derive its profile (writes only to
`profiles\`, nothing to the client; about 20 s):

```bat
ApplyClientData.bat profile --client "D:\EVE Online"
```

`profile` checks the layouts and the stored content hash of each table, then
clones type 447 (and icon 3433) into all five tables twice in a temporary
folder and reads the copies back with the client's own loaders (identity,
dogma overrides, effects, skills, materials, icon file). A changed schema
fingerprint is refused: that build needs a code change in `fsd/`, not only a
profile.

## Before you start

- Close the EVE client (and the launcher). The tool refuses while
  `exefile.exe` runs.
- Python 3.11+ with Pillow: `ApplyClientData.bat` uses `CUSTOMTYPES_PYTHON`
  or `tools\.elysian-suite\venv` (start `tools\Launch-Elysian-Tools.bat` once
  if it is missing).
- Python 2.7 for the client loaders (native read-back): `--python27 <exe>`,
  env `EVEJS_CLIENT_PYTHON27`, default
  `tools\.elysian-suite\runtime\python27\python.exe`.
- Disk: about 600 MB free in `_local\customTypes-client\` during a run (the
  localization files are staged there; removed after the run) and about 600 MB
  in the client's `ResFiles\` (the new payloads).

## Commands

Run from `mods\customTypes\client\` (paths are examples):

```bat
ApplyClientData.bat plan  --client "D:\EVE Online"
ApplyClientData.bat apply --client "D:\EVE Online"
ApplyClientData.bat status
ApplyClientData.bat rollback
```

- `plan` builds everything, checks it (build profile, native read of the new
  types), writes `plan.json`, the new index files and the new
  `blueprints.static` under `_local\customTypes-client\plan-<time>\`.
  **Nothing is written to the client.**
- `apply` does the same, then backs up both index files to
  `_local\customTypes-client\backup-<time>\`, writes the new payload files and
  the new index files. The state is in `_local\customTypes-client\state.json`
  with the client build. A state of another build (the client was updated
  since) is moved to `state.<build>.json` by the next `apply`, which then
  starts fresh. See "Re-apply" for a second `apply`.
- `status` shows what is applied and whether the client index still matches.
- `rollback` puts the backed-up index files back (the client sees vanilla data
  again) and deletes the payload files the tool created. It refuses when the
  index changed after `apply` (client update, launcher repair, another tool),
  because the backup would undo that change. `--force` overrides it. A state
  of another client build is never rolled back, not even with `--force` (its
  backup is an index of the old build).
- `profile` derives `profiles/build-<build>.json` (see "Client builds").

Options: `--client <dir>` (default: env `EVEJS_CLIENT_PATH`), `--pack <file>`
(repeatable; only these packs instead of every `data/*.json`),
`--state-dir <dir>`, `--dogma-overlays <file>` (default: `dogma-overlays.json`
next to the tool), `--sde <dir>` (SDE folder for the dogma overlay, see
below), `--skip-proof` (skip the native read of the compiled tables; not
recommended), `--force` (rollback, and the rollback step of a re-apply, even
when the index changed after apply), `--python27 <exe>`, `--profiles-dir <dir>`.

Two packs that declare the same typeID, packID or blueprint product are refused
together before anything is built (the server would refuse the later one).

## Re-apply

`apply` while a previous apply is active:

- same pack files (packID and content, sha256) and the index still as applied:
  `Already applied ... nothing to do`, nothing written;
- otherwise (a pack added, removed or edited, or another `--pack` set): the
  tool runs `rollback` first (same drift refusal, `--force` overrides), then a
  fresh apply of all selected packs from the vanilla index. An in-place
  rewrite is not possible: the encoder and `blueprints.static` refuse a type
  or a blueprint already in the client data. If the fresh apply fails after the
  rollback, the client is left with vanilla data (state `rolled_back` or
  `failed`); fix the cause and run `apply` again.

A state file of the older single-pack version (`pi-blueprints` only) is read
too: the next `apply` rolls it back and applies all packs.

Every new pack, every new pack version and every regeneration of a generated
pack (spec change, new SDE, `--allocate`) changes the pack sha256: rebuild the
server image and run `ApplyClientData.bat apply` again; it rolls back and
applies all packs. Without it (and without a server restart) the Industry
window shows `MISMATCH_MATERIAL` / `MISMATCH_TIME`.

`plan` warns `type 34050x: source has no iconID, the client keeps the source's
look` for the 4 Mobile Sentries (expected: the batteries carry no iconID; the
pack's `iconID` only feeds the server row).

**Speed**: the types, typedogma, requiredskillsfortypes, typematerials and
iconids tables are cloned in one batch per table (one split and one content
hash per table instead of one per type), so `plan`/`apply` cost about one pass
over each table instead of one per type. `plan.json` has `timings` (seconds
per phase: `encoder`, `nativeCheck`, `dogmaOverlays`, `localization`,
`blueprints`, `indexes`, `total`); `plan` prints them, `apply` prints them
after `Applied packs`. Measured on client 3396210 with about 700 types:
`apply` 141 s total (encoder 48 s, nativeCheck 0.8 s, dogmaOverlays 18 s,
localization 64 s, blueprints 0.2 s, indexes 3.4 s); on client 3724492 with
the 9 packs and the SMB overlay: `apply` (on a copy) 109 s.

`plan` while an apply is active reads the current (already patched) index and
therefore refuses the applied types; use it on a vanilla client or after
`rollback`.

## Known limits

- **PI blueprints** (`pi-blueprints.json`, generated): clones of Spatial
  Attunement Unit Blueprint 33196 (group 447). Its client record has an
  `iconID`, so each PI blueprint gets its product's icon (`plan` on client
  3396210: no icon warning, native read OK). It has no market group, so the PI
  blueprints have none on either side. The blueprint row in
  `blueprints.static` is still a clone of the Vexor Blueprint 971 row (only the
  row template; activities come from the pack).
- **Sources need a `typeDogma` record**: the encoder clones the `typedogma`
  record of every source (`compile_tables`), so a source without one
  (e.g. Orbital Skyhook Blueprint 81086, SDE 3396210) is refused before
  encoding: `REFUSED: source 81086 has no typeDogma record - ...`. The drill
  blueprint 340101 is therefore a clone of 33196 with `groupID` 1045
  (Sovereignty Structure Blueprint), like the PI blueprints; `plan` on client
  3396210 with the default pack set: native read OK.
- **Icon (drill pack)**: the Orbital Skyhook record in the client has no
  `iconID` (the client draws it from `graphicID`), and the encoder can only
  change fields the source record carries. "Planetary Drill" therefore looks
  like an Orbital Skyhook in the hangar; `plan` prints this as a warning. The
  blueprint 340101 (source 33196) gets icon 26063. The packs still need an
  `overrides.iconID` (the tool requires one).
- **Market group (drill pack)**: the encoder cannot clear a market group, so
  the client keeps the source's for the drill (1410 Orbital Skyhook); 33196
  has none, so the blueprint has none on either side. There are no orders.
- `res:/staticdata/blueprintsbymaterialtypeids.pickle` ("used in" lists in Show
  Info) is not updated: cosmetic.
- A client update or "repair" from the CCP launcher replaces the index files:
  run `apply` again afterwards (`status` shows `CHANGED since apply`). After
  an update to a new build, `apply` moves the old state aside itself (a new
  build without a profile needs `profile` first); after a repair of the same
  build, `rollback --force` only if the backup is still the right base,
  otherwise delete `state.json` and apply again.
- Item Forge / Serenity bundles applied **after** this tool make `rollback`
  refuse (drift). Roll back in reverse order.

## Dogma overlays (Ship Maintenance Bay for every ship)

`dogma-overlays.json` (next to this README, **not** in `data/`: the server
never reads it) changes attributes of existing client records. Today it has
one overlay, the client half of the "SMB for every ship" option of the
`soloProgressionBalance` mod:

```json
{ "schema": 1, "smbForEveryShip": { "enabled": false, "ratioPermille": 750, "excludedGroupIds": [29], "maxCapacityM3": 0 } }
```

With `"enabled": true`, `plan`/`apply` set on every ship record (category 6
from the SDE, except the excluded groups) of `typedogma.fsdbinary`:
attribute 907 `hasShipMaintenanceBay` = 1 and 908
`shipMaintenanceBayCapacity` = `max(type value, floor(volume x ratioPermille / 1000))`
(limit `maxCapacityM3` > 0 never cuts the type value) - the same rule as the
server. Myrmidon: 202 500 m3; Orca: 7 687 500 m3. Ships without a typedogma
record are skipped (count in `plan.json`, `dogmaOverlays`). The ship list and
volumes come from the SDE of the client build (`--sde <dir>`, default
`_local\sde\eve-online-static-data-<client build>-jsonl`). After the overlay, the
changed records are read back (all of them by the tool, up to 40 by the
client's own FSD loader).

- The overlay goes into the same apply as the packs (one backup, one
  rollback). It is recorded in `state.json` as pack `overlay:smbForEveryShip`
  with the sha256 of `dogma-overlays.json`, so changing the file (ratio,
  enabled) makes the next `apply` roll back and apply again (see Re-apply).
- **Same ratio on both sides.** The server ratio is
  `EVEJS_SOLO_SMB_RATIO_PERMILLE` (root `.env`, default 750). `plan` warns
  (does not refuse) when the root `.env` has a different value. The window's
  capacity and fill come from the server; a different client ratio only
  changes Show Info and the client's own space check.
- A disabled overlay changes nothing: the same bytes as without it.

### Commands (the EVE client and the launcher closed)

From the repo root (paths are examples):

```bat
rem 1. turn the overlay on: in mods\customTypes\client\dogma-overlays.json set "enabled": true
rem 2. look first (writes only to _local\customTypes-client\plan-<time>\):
mods\customTypes\client\ApplyClientData.bat plan  --client "D:\EVE Online"
rem 3. write to the client (rolls back the previous apply of the packs first, then applies packs + overlay):
mods\customTypes\client\ApplyClientData.bat apply --client "D:\EVE Online"
mods\customTypes\client\ApplyClientData.bat status
rem undo everything this tool applied (packs and overlay) - vanilla client index:
mods\customTypes\client\ApplyClientData.bat rollback
rem undo only the overlay, keep the packs: set "enabled": false, then
mods\customTypes\client\ApplyClientData.bat apply --client "D:\EVE Online"
```

`plan` on a client with an active apply refuses the applied pack types (see
Re-apply); to look at the overlay alone there, use `apply` directly or
`rollback` first.

## Pack v2: dogma, fields, icons

Pack keys are a closed list; any other key (top level, type, `overrides`,
`dogma`, blueprint, icon) is refused before anything is built, by name
(`unknown key foo`), because a field only one side understands would give a
client/server mismatch:

- pack: `packID, version, types, blueprints, icons, source, description`
- type: `typeID, sourceTypeID, overrides, dogma`
- `overrides`: `name, groupID, iconID, basePrice, published, marketGroupID,
  description, mass, volume, capacity, radius`
- `dogma`: `attributes`; blueprint: `blueprintTypeID, productTypeID,
  maxProductionLimit, activities, shop` (`shop` is server only)

New in v2:

- `overrides.mass/volume/capacity/radius` (finite numbers > 0) are written
  into the cloned `types` record and compared on the native read (with
  `groupID` and `basePrice`).
- `dogma.attributes` (`{"<attributeID>": value}`) overwrites attributes of the
  cloned typeDogma record. Only attributes the source record already carries:
  `REFUSED: type <id>: dogma.attributes <ids> not on source <id> - only
  attributes the source record carries can be overridden`. Every value is read
  back from the result before staging.
- `icons[]` (`iconID` 950000-959999, `templateIconID` = an existing client
  icon, usually the source's, `file` relative to this folder, e.g.
  `icons/950000.png`, `sha256`): a 64x64 RGBA PNG. The tool clones the
  template's `iconids` record to the new iconID with
  `iconFile = res:/ui/texture/icons/customtypes/<iconID>.png`, writes the PNG
  as a new ResFiles payload and adds one line to `resfileindex.txt` (not to the
  prefetch index). `rollback` removes both like every other payload. A type
  uses its icon with `overrides.iconID` = that iconID; every icon must be used
  by a type of its pack. Refused: wrong size, no alpha, a sha256 different
  from the file, an iconID already in the client, a template not in the client,
  a source type without an `iconID` (ships keep their 3D picture from
  `graphicID`; `overrides.iconID: null` is allowed for them and stays a
  warning).
- The pack's sha256 covers the icons' sha256, so a new PNG (with its new sha
  in the pack) makes the next `apply` roll back and apply again.

## Changing the pack

Server and client must change together: edit the pack, rebuild the server
image, then `apply` here (it rolls the old apply back itself, see Re-apply).
A pack applied to only one side gives `MISMATCH_*` refusals in the Industry
window.

## Tests

`tools\.elysian-suite\venv\Scripts\python.exe -B mods\customTypes\client\test_apply_client_data.py`
(from the repo root, about 1 s): default pack set and order,
the Planetary Drill Blueprint client row, refusal of a typeID or product in
two packs, re-apply detection (also for an old single-pack state), the SMB
dogma overlay on a synthetic typedogma table (CO1-CO4: attributes added in
order and byte-identical to `append_type_dogma_attributes`, larger value kept,
disabled overlay = same bytes, overlay file change = re-apply), pack v2
(CT1-CT6: batch clones byte-identical to a sequence of single
`clone_integer_record` calls, unknown keys refused, dogma overrides only on
carried attributes, icon PNG checks and the new index line, icon change =
re-apply), standalone (ST1: no `elysian*` import), build profiles (BP1-BP3:
unknown build, changed layout or loader refused, shipped profiles), state per
build (SB1), and with a 3724492 client at `EVEJS_CLIENT_PATH` (default
`H:\EVE Online - 3396210`, skipped without it) an encoder round trip on its
`typedogma` and `types` tables (CB1).
