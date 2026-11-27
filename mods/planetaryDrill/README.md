# planetaryDrill

A vanilla **Orbital Skyhook (81080)** anchored at a planet **outside sov
null-sec** (high-sec, low-sec) becomes a drill: it mines the **P0** of that
planet into its secured bay, and *Extract* moves it to the ship cargo. Only P0:
processing P0 into P1 and higher is done by the PI blueprints of
`mods/customTypes`.

Requires `mods/skyhookOrphanFix` (loaded before this mod).

## How it works

EveJS builds the sovereignty planet definitions (reagents of a Skyhook) for
sov null-sec only, so a high-sec Skyhook has no product: the window shows an
ON toggle, and the client crashes in `GetProduct` (`'NoneType' object is not
iterable`).

The mod wraps `sovStaticData.getSovereigntyStaticSnapshot` and adds one planet
definition per drill to the memoised snapshot:

- `planetDefinitionsByPlanetID` (the Map) gets the row, so the vendor
  sovereignty bootstrap creates the Skyhook record with `reagentDefinitions`
  and `reagentSimulations`. Every gateway payload is built from that record:
  `GetRequest`, `GetAllLocal`, `GetAllByCorporation`, the `AllInSolarSystem`
  and `ReagentSimulations` notices (`reagent_definitions`,
  `reagent_simulations`, `active`). skyhookOrphanFix's chained `get` calls the
  Map's own `get` first, so it returns the drill row; other non-sov planets
  still get its empty definition.
- `planetDefinitions[]` (the client definition list, `GetAllDefinitions` /
  `GetDefinitionsVersion`) gets the same row, and the definitions version gets
  the prerelease tags `["pdrill", <hash>]`. The Skyhook payload carries that
  version (`planet_resources_definitions_version`), so a client with cached
  definitions fetches them again and finds the planet.
- `planetsBySolarSystemID` is not touched: sov upgrade power/workforce stay
  vanilla (`power`/`workforce` of the row are 0).

Harvest (`settleSkyhookHarvest`, analytic from the persisted `lastCycleMs`,
no timer), Extract (reservation + idempotent receipt), access (owner
corporation or orbital ACL) and the online toggle are vanilla EveJS. The mod
has no own state and writes no table.

The overlay is rebuilt only when the deployed-skyhook revision of
`planetOrbitalState` changes (O(1) check otherwise; the snapshot is read on
every sovereignty access).

### Which P0

The P0 is chosen by the item you launch (the client has no Rename
for a Skyhook in space, and chat commands are not used):

- **Planetary Drill (<P0>)** variants 340102-340116 (one per P0, see the table
  below): the drill mines that P0, fixed at launch (the P0 is kept in the
  launch ledger, `p0TypeID`, and survives a restart). Log `pick=variant`. A
  variant launched at a planet without its P0 is **refused** (see "Planetary
  Drill items" below). Nobody can change the P0 of a drill after launch.
- **Planetary Drill** 340100 (auto): the planet resource with the highest
  quality (tie: lower typeID). Log `pick=auto`.
- Legacy: a tag `[PI:<typeID>]` in the name of an auto drill still
  selects that P0 if the planet has it (`pick=tag tag=used`, otherwise
  `tag=ignored`); the client cannot set such a name, so this is only kept for
  compatibility. A `[P1]` tag is ignored. A variant P0 wins over a tag.
- A ledger P0 the planet does not have (edited file, changed static data):
  tag or auto, log `pick=variant-ignored` and
  `WARN skyhook=... variant=2268 not on planet - mining <P0>`.
- Amount per cycle = floor(`BASE_UNITS_PER_HOUR` x `CYCLE_SECONDS`/3600 x
  quality(selected) / sum of the planet's qualities). Secured capacity =
  amount x `STORAGE_CYCLES`; nothing is unsecured (nothing to steal).

### Limits (`MAX_PER_SYSTEM`, `MAX_PER_CORPORATION`)

- Skyhooks are taken in skyhookID order. Only a skyhook whose planet has a P0
  (the pick above succeeds) counts against the limits.
- A skyhook over a limit still gets its planet row with the same P0 and
  secured capacity, but `amountPerCycle: 0`: the window shows the product
  (ON does not crash the client), nothing is mined. Stock already in the bay
  stays (capacity unchanged) and can be extracted. When a slot frees up (a
  lower skyhookID is removed or the limit is raised) it mines again from the
  next orbital change. Log: `... mode=P0 amount=0 reason=limit`.
- A planet without P0 resources gets no row (skyhookOrphanFix's empty
  definition stays; log `skipped reason=NO_RESOURCES`).

## Configuration (`EVEJS_PDRILL_*`)

| key | default | notes |
|---|---|---|
| `ENABLED` | `0` (Docker compose: `1`) | **Danger:** switching off later empties the stock of every drill (see Stock loss) |
| `BASE_UNITS_PER_HOUR` | `20000` | 1..10000000 |
| `CYCLE_SECONDS` | `3600` | 60..86400 |
| `STORAGE_CYCLES` | `168` | 1..10000 |
| `MAX_PER_SYSTEM` | `3` | 0 = no limit |
| `MAX_PER_CORPORATION` | `10` | 0 = no limit |
| `LAUNCH_TYPE_ID` | `340100` | the Planetary Drill (auto) item launched as a Skyhook; `0` = conversion off (also for the variants 340102-340116), otherwise 340000..349999 |
| `DRILL_ITEMS_ONLY` | `0` | **Danger:** `1` = only Skyhooks launched from the drill item mine (see below) |

See `.env.example`. An invalid value: the mod logs it and installs nothing.

### Stock loss

The vendor rebuilds a Skyhook's reagent simulations from its planet
definition and merges the old ones by `reagentTypeID`; a simulation whose
reagent is no longer in the definition is dropped together with its stock.
The Skyhook record itself stays (with empty reagents). Stock is lost when:

- **the mod is switched off** (or inert after a DRIFT): at the next
  sovereignty bootstrap every drill gets skyhookOrphanFix's empty definition,
  the record stays with empty reagents and all drill stock is gone;
- **the P0 changes**: a legacy `[PI:<typeID>]` tag in the name of an auto
  drill changes (effective at the next deployed-skyhook revision change or
  restart), or **the launch ledger file is lost / unreadable** - a
  variant drill then mines auto (until the next rebuild that reads the file
  again) and, if auto is another P0, the stock of the variant P0 is gone;
- **the planet has no P0 resources** (`skipped reason=NO_RESOURCES`): the
  drill has no row, nothing is mined or stored.

A drill over a limit keeps its row and its stock. Extract everything
before switching the mod off or renaming a drill. While the server runs, the
mod logs a `WARN` line when a drill of the previous overlay changes its P0 or
leaves the overlay (not across a restart - the overlay keeps no own state):

```
[planetaryDrill] WARN skyhook=1000000123 planet=40242000 reagent=2268->2267 - stock of 2268 will be lost
[planetaryDrill] WARN skyhook=1000000456 planet=40242010 reagent=2267 left the overlay reason=gone - no longer produced, stock of 2267 will be lost
```

`reason` is a skip reason (`NO_RESOURCES`) or `gone` (skyhook removed,
destroyed, being replaced).

## Planetary Drill items (340100 and the variants 340102-340116)

`mods/customTypes` (pack `data/planetary-drill.json` v4) adds the item
"Planetary Drill" 340100 (auto) and 15 "Planetary Drill (<P0>)" variants, all
clones of the Orbital Skyhook 81080, each with its blueprint (340101,
340202-340216). EveJS sends a launched orbital down the Skyhook path only for
typeID 81080, so this mod wraps `orbitalLaunchRuntime.launchOrbitalsFromShip`
(first load):

| item | blueprint | mines (P0) | planet classes |
|---|---|---|---|
| 340102 | 340202 | 2073 Microorganisms | Temperate, Ice, Oceanic, Barren |
| 340103 | 340203 | 2267 Base Metals | Gas, Lava, Barren, Storm, Plasma |
| 340104 | 340204 | 2268 Aqueous Liquids | Temperate, Ice, Gas, Oceanic, Barren, Storm |
| 340105 | 340205 | 2270 Noble Metals | Barren, Plasma |
| 340106 | 340206 | 2272 Heavy Metals | Ice, Lava, Plasma |
| 340107 | 340207 | 2286 Planktic Colonies | Ice, Oceanic |
| 340108 | 340208 | 2287 Complex Organisms | Temperate, Oceanic |
| 340109 | 340209 | 2288 Carbon Compounds | Temperate, Oceanic, Barren |
| 340110 | 340210 | 2305 Autotrophs | Temperate |
| 340111 | 340211 | 2306 Non-CS Crystals | Lava, Plasma |
| 340112 | 340212 | 2307 Felsic Magma | Lava |
| 340113 | 340213 | 2308 Suspended Plasma | Lava, Storm, Plasma |
| 340114 | 340214 | 2309 Ionic Solutions | Gas, Storm |
| 340115 | 340215 | 2310 Noble Gas | Ice, Gas, Storm |
| 340116 | 340216 | 2311 Reactive Gas | Gas |

(Classes = `planetStaticData.PLANET_RESOURCES_BY_TYPE_ID`, checked by test
T-V5; `lib/variants.js`.)

- **Variant pre-check:** before anything is converted, the planet of
  the launch is found with the EveJS rule of the Skyhook deployment
  (`findNearestPlanetID` of the launch position, `buildOrbitalSpawnState`).
  A planet without the variant's P0, or a server that cannot check the
  planet, **refuses** the launch: the item stays in the cargo hold unchanged,
  it is removed from the EveJS request (EveJS is not called at all when
  nothing else is left; result `NO_VALID_ORBITALS`), and the error is appended
  to the EveJS result: `errors` and a `CustomNotify` entry in `response`, the
  same path as EveJS's own launch errors (`PLANET_ALREADY_HAS_ORBITAL`), so
  the client shows the text (not verified in a live client).
  Log `launch source=<id> type=<typeID> result=REFUSED reason=P0_NOT_ON_PLANET|P0_TOO_POOR|PRECHECK_UNAVAILABLE planet=<id>`,
  `stats().launchRefused` (one line and one count per refused item).
  `P0_TOO_POOR`: the planet has the P0, but with quality 0 or with 0 units
  per cycle, so the client text says its deposits are too poor to mine. A planet in sov null-sec is not refused: there the
  drill is an ordinary Skyhook.
- **Launch:** every requested drill item (340100 or a variant, not refused) in
  the cargo hold of the active ship is turned into 81080 just before the EveJS
  call; EveJS then deploys an ordinary Skyhook (role Station Manager etc. as
  for 81080). The object in space is 81080 and keeps the item name. It is
  recorded in the launch ledger (`drills`, with the variant `p0TypeID`).
- **Revert:** the rest of a stack (EveJS launches one piece, a new itemID) and
  a failed launch (`SKYHOOK_DEPLOYMENT_REQUIRES_STATION_MANAGER`,
  `PLANET_ALREADY_HAS_ORBITAL`, an EveJS exception, ...) go back to the
  launched item type (340100 or the variant); the cargo view of the pilot is
  synchronised. The EveJS result is returned unchanged, unless a variant was
  refused: the refused items are removed from the request and their errors
  appended.
- **Saga:** while the EveJS Skyhook deployment saga still holds the source
  (intent without a launched item, retried every second) the item stays 81080
  and `pending` - a revert would make custody reject the retry forever
  When the saga ends, the next sweep settles it: launched -> `drills`,
  abandoned -> back to the launched item type where the item lies now.
- **Sweep:** on every drill launch and once after the server start (first
  overlay rebuild in the process that owns the launch). It also prunes
  `drills` whose orbital is gone and whose item no longer exists.
- Not supported: no conversion back to 340100 or the variant when
  a drill is unanchored or scooped (it stays a Skyhook 81080); a drill item
  launched at a sov null-sec planet is a full vanilla Skyhook.
- `ENABLED=0` or `LAUNCH_TYPE_ID=0`: no conversion, 340100 and the variants take the generic
  EveJS orbital path (usually `PLANET_ALREADY_HAS_ORBITAL`). A launch `DRIFT`
  (EveJS changed one of the launch seams) switches only the conversion off,
  the overlay keeps working.

**Launch ledger**: `<EVEJS_DATA_ROOT>/mods/planetaryDrill/launch-ledger.json`
(Docker `/var/lib/evejs/mods/planetaryDrill/`, native `_local/mods/planetaryDrill/`),
never in the mod folder. `{ v: 1, pending: {sourceItemID: {atMs, typeID, p0TypeID}},
drills: {launchedItemID: {atMs, sourceItemID, p0TypeID}} }` (`p0TypeID`: the
variant P0, `null` or missing = auto; older files work unchanged; the overlay
reads the file once per rebuild), written atomically (tmp +
fsync + rename). An unreadable file is logged as ERROR, treated as empty and
kept as `.bad-<ms>` at the next write. If the file is lost (or a write failed)
and the server dies in the middle of a launch, the item stays a Skyhook 81080.

**`DRILL_ITEMS_ONLY=1` (danger):** a Skyhook outside sov null-sec that is
not in the ledger (`drills`, or the deployment intent of a `pending` drill)
gets an amount 0 row (`reason=NOT_DRILL_ITEM`): its window has a product, the
stock already in the bay stays and can be extracted, nothing is mined, and it
takes no `MAX_PER_*` slot. **Every Skyhook anchored before this feature (or
from a plain 81080) stops mining** when you switch it on; a drill scooped and
relaunched under a new itemID loses its drill status. Default `0`: every
Skyhook mines, as before.

```
[planetaryDrill] v1.1.0 wrapped orbitalLaunchRuntime.launchOrbitalsFromShip (item 340100 and variants 340102-340116 launch as Skyhook 81080, drillItemsOnly=false)
[planetaryDrill] launch source=990001 type=340100->81080 result=LAUNCHED 990001
[planetaryDrill] launch source=990005 type=340104->81080 result=LAUNCHED 990005
[planetaryDrill] launch source=990006 type=340104 result=REFUSED reason=P0_NOT_ON_PLANET planet=40242030
[planetaryDrill] launch source=990002 type=340100->81080 result=LAUNCHED 990777 REVERTED
[planetaryDrill] launch source=990003 type=340100->81080 result=REVERTED
[planetaryDrill] launch source=990004 type=340100->81080 result=HELD
[planetaryDrill] launch source=990004 sweep result=REVERTED
```

## Deployment

1. Load order: after `skyhookOrphanFix` and before `livingNewEden`. With
   Docker, add to both blocks of `docker/entrypoint.sh`:
   `--require /app/mods/planetaryDrill/loader.js \`
2. To pass the switch to a Docker server container, add to `compose.yaml`
   `services.server.environment`:
   `EVEJS_PDRILL_ENABLED: ${EVEJS_PDRILL_ENABLED:-1}` - this makes it **on by
   default in Docker**; `EVEJS_PDRILL_ENABLED=0` in the shell / `.env` of compose
   turns it off (mind the stock loss above). A mod `.env` file is usually not in
   the image (`.dockerignore` drops `**/.env`). Native (launcher) default is off.
3. Rebuild and restart the server (`docker compose build init`, `docker compose up -d`).

Log lines:

```
[planetaryDrill] v1.1.0 active - wrapped sovStaticData.getSovereigntyStaticSnapshot (probe ok, enabled=true)
[planetaryDrill] overlay rev=3 drills=1 planets=[40242000] hash=1a2b3c4d
[planetaryDrill] skyhook=1000000123 planet=40242000 reagent=2268 mode=P0 amount=15000 pick=variant
[planetaryDrill] overlay rev=4 drills=3 limited=1 planets=[...] hash=5e6f7a8b
[planetaryDrill] skyhook=1000000456 planet=40242010 reagent=2267 mode=P0 amount=0 reason=limit pick=auto tag=none
```

`DRIFT ...` = an EveJS update changed a seam: the mod is inert (vanilla).

## Tests

`node mods/planetaryDrill/test/run.js` (or `RunTests.bat`).
