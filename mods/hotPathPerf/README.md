# hotPathPerf

EveJS loader mod (tested on 261115.2 and 261108.1). Two kinds of features:

- **Diagnostics without behaviour changes:** wall-clock timing of selected server calls that `[PacketPerf]` does not see, or sees without detail.
- **Optional hot-path fixes:** each one behind its own flag, most off by default. Every fix wraps a vendor function, checks the vendor code it depends on (probe and/or SHA-1 fingerprint) and, on any mismatch or error, disables itself for the rest of the process and falls back to unchanged vendor behaviour.

Fixes that are **on by default**: location pre-warm, scheduler queue limit, scheduler overdue job gate, startup stall watch, owned sov hub echo mask, cyno jammer broadcast filter. Everything else is off by default.

Common conventions used below:

- **Disabled for the rest of the process:** one line `[hotPathPerf] WARN <fix> disabled: <reason> (...)`, then the vendor path. Usual reasons: `order` (another mod wrapped the same function first), `drift` (probe or fingerprint mismatch), `parity` (parity check found a difference), `error` (exception in the mod's own code), `limit`, `obsolete` (EveJS already fixed it, see the EveJS version notes).
- **Parity check:** an optional `...ParityCheck` key that also computes the vendor result on every served call and compares. It costs as much as the vendor path; use it for measurement runs only.
- **Stats lines** are printed every `statsLogMinutes` minutes; the counters cover the last window and are reset after printing.

## Measurements

| Log name | Where in EveJS | Context of the `slow` line |
|---|---|---|
| `dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary` | export, called from `globalSiteSchedulerRuntime.js` | `call=<n>` (number within the process), `boundaryAtMs` |
| `DungeonInstanceCacheMgrService.Handle_*` (15) | prototype methods, `dungeonInstanceCacheMgrService.js` | method name |
| `dungeonRuntime.listInstancesByLifecycle` | export, `dungeonRuntime.js` | no line; stats per `lifecycleState` only, with `maxLength` (result size) |
| `SpaceRuntime.collectEmptySolarSystems` | `SpaceRuntime.prototype` (`spaceRuntime/sceneDisposal.js`) | `scenesBefore`, `collected/retained/attempted` |
| `SpaceRuntime.prepareUniverseSitesForPlayerEntry` | `SpaceRuntime.prototype` (`spaceRuntime/universeSites.js`) | `system`, `prepared`, `reason` |
| `SpaceRuntime.ensureScene` | `SpaceRuntime.prototype` (`spaceRuntime/sceneRegistry.js`) | `system`, `new=true/false` (scene built from scratch), `scenes` |
| `ConfigService.Handle_GetMultiLocationsEx` | prototype method, `configService.js` | `call=<n>` (number within the process), `ids=<ID count>` |

`[hotPathPerf] slow <name> <ms>ms <context>` is printed when a call took at least `slowCallMs`. Every `statsLogMinutes` minutes: `[hotPathPerf] stats <name> n=... sumMs=... maxMs=...`.

The wrappers are transparent: same `this`, arguments, result and exception. A measurement error never reaches the server (counted as `errors` in the stats).

`wormholeRuntime.runLifecycleMaintenanceSlice` is not measured: it is only called locally from the scheduler pump, not through the export. The vendor logs `[Wormholes] Lifecycle slice exceeded hard budget` (>= 25 ms) itself.

## Load order with other mods

`moonOreAnomalies` puts a presentation overlay on `listInstancesByLifecycle` when it first loads `dungeonRuntime`. Put `hotPathPerf` right after `scenePerfFix` and **before** `moonOreAnomalies` in the `--require` list, so the measurement sits under the overlay. The reverse order also works (the measurement then includes the overlay), but the active location index then disables itself with `order`.

`moonOreAnomalies` compiles `dungeonUniverseRuntime.js` itself (`kind: "transform"`) and does not pass that load down the `Module._load` chain. While any point is still waiting to be wrapped, the hook checks `Module._cache` for the known target file names on every require (a few map lookups), so `getUniversePersistentLifecycleBoundary` is wrapped on the next require after the module loads, still during boot, not only by the probe after 60 s.

## Active location index

Flag `dungeonIndex`, **off by default**. With `false` the mod wraps only the measurement points.

With `true`: the vendor `listInstancesByLifecycle(state)` returns a JSON clone of every active location in the universe, and the cache mgr (Agency/scanner) and the scheduler boundary call it 3 times per rebuild. The mod keeps an index `instanceID -> summary` (fields and order as the vendor `buildInstanceSummary`, object shallow-frozen, nested objects shared with the vendor cache as in the vendor). Inside the allow-listed scope, i.e. during a synchronous `DungeonInstanceCacheMgrService.Handle_*` or `getUniversePersistentLifecycleBoundary` call:

- `listInstancesByLifecycle("seeded"|"active"|"paused")` without a second argument returns the array from the index (ascending `instanceID`, as the vendor),
- `listUniversePersistentTerminalInstances()` without an argument returns the terminal universe-persistent locations from the index.

Every other call (out of scope, with options, `full: true`, another state) goes to the vendor unchanged.

The index does not listen to emits (the vendor also changes instances without emitting). On every in-scope call it compares the identity of `dungeonRuntimeState.loadState()` (O(1)); after a state change it compares record pointers (O(N)) and rebuilds only the changed summaries, without clones.

Disable reasons: `order` (the reader was already wrapped by another mod, e.g. `moonOreAnomalies` loaded first; the game works, without the speed-up), `parity`, `limit` (the index would reach `dungeonIndexMaxEntries`), `error`, `drift` (the probe found no `dungeonRuntimeState` or active reader).

Stats: `[hotPathPerf] stats dungeonIndex state=<ready|waiting|disabled:<reason>> entries=seeded:...,active:...,paused:...,terminal:... served=... fallback=<reason:n,...> refreshes=... refreshMaxMs=... changedMax=... firstBuildMs=... parityChecks=...`.

| Key | Env | Default | Meaning |
|---|---|---|---|
| `dungeonIndex` | `HOTPATH_DUNGEON_INDEX` | `false` | enables the index |
| `dungeonIndexParityCheck` | `HOTPATH_DUNGEON_INDEX_PARITY` | `false` | parity check |
| `dungeonIndexMaxEntries` | `HOTPATH_DUNGEON_INDEX_MAX_ENTRIES` | `100000` | entry limit (active + terminal), about 0.4 KB per entry |

The launcher shows only the `dungeonIndex` flag; set the others through env or `settings.json`.

## Scene retention

Flag `sceneRetention`, **off by default**. With `false` nothing extra is wrapped.

Problem: after docking, the system scene is empty and the vendor collects it after 60 s. Undocking after a longer stay rebuilds the scene from scratch (`Live scene bootstrap` 250-1543 ms, `ship.MachoBindObject` up to 1599 ms).

With `true` the mod wraps `SpaceRuntime.prototype.collectEmptySolarSystems` (sweep every 5 s). For the duration of one call it adds the pinned systems to the vendor `config.alwaysOnSolarSystemIDs` and restores the original value (the same array) in `finally`, also when the sweep throws. The vendor records the real time a scene became empty for always-on systems too, so once unpinned, a scene empty for more than 60 s goes away on the next sweep. The mod writes nothing to scenes or to the config on disk.

Rules (recomputed on every sweep):

- **Docked** (`sceneRetentionPinDocked`, default true): the system of every session docked in a station or structure (`stationid`/`structureid` > 0, system from `solarsystemid2`). The pin lasts at most `sceneRetentionPinDockedMaxMinutes` (120, 0 = no limit) from the first sweep that saw the character docked.
- **Recently visited** (`sceneRetentionPinRecent`, default false): systems where the character was in space in the last `sceneRetentionRecentMinutes` (10), excluding the current one, at most `sceneRetentionMaxPinnedPerCharacter` (4) per character.
- Only already-loaded scenes outside the base always-on list are pinned (base always-on systems do not count toward the limit). Logging in while docked does not load the scene, so the first undock still pays the bootstrap; later ones do not.
- Limit `sceneRetentionMaxPinnedTotal` (16): docked first, shortest docked time first (AFK pilots lose their slot first), then recently visited. The rest follows normal vendor rules (`cappedMax`).
- Memory guard `sceneRetentionRssCeilingMb` (0 = off): process RSS above the ceiling means the sweep pins nothing (`rssSkips`).

Cost: each pinned scene goes through the 100 ms tick; an empty scene usually sleeps. Watch `tickDurationMs` p95 and RSS when enabling it.

**Effect on Living New Eden:** a live fight in the system of a docked player no longer ends with scene GC after 60 s. It continues while the NPCs live or until the player logs out or changes system. New live fights still require a player in space. If that is undesirable: `sceneRetention=false`.

Disable reasons: `error` (exception in the retention code, e.g. `getSessions` threw, or while wrapping), `drift` (the probe did not find the sweep wrapper, `sessionRegistry` or the vendor config, or the runtime has no `isSolarSystemSceneLoaded`).

Stats: `[hotPathPerf] stats sceneRetention state=<on|waiting|disabled:<reason>> sweeps=... sweepsWithPins=... pinnedMax=... pinnedNow=... dockedMax=... recentMax=... cappedMax=... released=... rssSkips=... computeMaxMs=... errors=...` (`released` = systems unpinned since the previous sweep).

| Key | Env | Default |
|---|---|---|
| `sceneRetention` | `HOTPATH_SCENE_RETENTION` | `false` |
| `sceneRetentionPinDocked` | `HOTPATH_SCENE_RETENTION_PIN_DOCKED` | `true` |
| `sceneRetentionPinDockedMaxMinutes` | `HOTPATH_SCENE_RETENTION_DOCKED_MAX_MINUTES` | `120` |
| `sceneRetentionPinRecent` | `HOTPATH_SCENE_RETENTION_PIN_RECENT` | `false` |
| `sceneRetentionRecentMinutes` | `HOTPATH_SCENE_RETENTION_RECENT_MINUTES` | `10` |
| `sceneRetentionMaxPinnedPerCharacter` | `HOTPATH_SCENE_RETENTION_MAX_PER_CHARACTER` | `4` |
| `sceneRetentionMaxPinnedTotal` | `HOTPATH_SCENE_RETENTION_MAX_TOTAL` | `16` |
| `sceneRetentionRssCeilingMb` | `HOTPATH_SCENE_RETENTION_RSS_CEILING_MB` | `0` |

The launcher shows only the `sceneRetention` flag. Retention does not depend on `scenePerfFix`.

## Location pre-warm

Flag `prewarmLocations` (`HOTPATH_PREWARM_LOCATIONS`), **on by default**. The first `config.GetMultiLocationsEx` in a process builds the map of all static locations (`configService.js` `getStaticLocationRowsById`, memoised for the process) and can block the game thread for 1-3 s. The mod wraps `SpaceRuntime.prototype.preloadStartupSolarSystems` (called once in `network/tcp/index.js` before `server.listen`) and after the original calls the raw `ConfigService.prototype.Handle_GetMultiLocationsEx([[]], null)` once, discarding the result. The cost moves to server start, before players can connect.

- Log: `[hotPathPerf] prewarm locations took <ms>ms`. Failure: `[hotPathPerf] WARN prewarm locations failed after <ms>ms: <msg>` or `... skipped: CONFIG_SERVICE_NOT_LOADED`. Startup continues.
- The pre-warm calls the original below the measurement, so the `call=<n>` counter of `ConfigService.Handle_GetMultiLocationsEx` counts client calls only.
- The probe expects `SpaceRuntime.preloadStartupSolarSystems#prewarm` and `ConfigService#prewarmDeps`; if missing: `DRIFT`, no pre-warm, the game works as without the mod.
- If slow `call>1` lines still appear with `true`, the first call is not the only slow one; you can turn the flag off.

## Abyssal career read

Flag `careerAbyssalRead` (`HOTPATH_CAREER_ABYSSAL_READ`), **off by default**. Obsolete on EveJS 261108.1 and later (see the version notes). On older builds, `careerAbyssalSources.readRuns()` on every `careerProgress.syncCharacter` and `dungeonTrackingRuntime` `reconcileRun` calls `gameStore.readPersisted("dungeonRuntimeState", "/")`, which parses the whole table (on a large server 2511 instances, ~130 MB of JSON), while only instances with `siteFamily === "abyssal"` and `siteKind === "abyssal-pocket"` are needed.

- Scope: wrappers on `careerAbyssalSources.reconcile` / `reconcileRun` (depth counter). Gate: `gameStore.readPersisted` in scope, only for the `dungeonRuntimeState` table and a path without segments (`"/"`, `""`, none), arms a one-shot serve for the duration of the original. Serve: `sqliteStore.loadExistingTableObject("dungeonRuntimeState")` returns an object built by the vendor `assembleFromRows` with the table scalars and `instancesByID` holding only the candidates. Reads of `/instancesByID/<id>` and other tables get the full vendor result. Error handling, `ensureSqliteReady` and `READ_ERROR` codes stay with the vendor.
- Reads use a separate read-only connection to the same database (`readonly`, `fileMustExist`, `query_only`, the `better-sqlite3` addon through `createRequire` from `sqliteStore.js`, one read transaction per call). Memory holds only the key classification (candidate yes/no), not content; candidate content is read from the database on every call. New keys are classified by SQL (`instr(json,'"abyssal-pocket"')`, then `json_extract` of family/kind); known keys are reclassified on a rolling basis, `careerAbyssalReadReclassifyPerCall` per call.
- Disable reasons: `order` (someone already wrapped `readPersisted` / `loadExistingTableObject`), `drift` (probe, or a different `ROW_KEY_SEP` / table groups), `limit` (keys >= `careerAbyssalReadMaxKeys`), `legacy` (an `instancesByID` skeleton with a blob from an old install), `parity`, `error`, `obsolete`.
- Parity (`careerAbyssalReadParityCheck`): compares the scalars, the keys and the JSON of the abyssal-pocket instances. A mismatch causes one retry of our read (a commit between the reads); a second mismatch means `disabled: parity` and the vendor result.
- Stats: `[hotPathPerf] stats careerAbyssalRead state=... keys=... candidates=... served=... fallback=<reason:n> classified=... reclassified=... serveMaxMs=... firstBuildMs=... parityChecks=... parityRetries=...`. `firstBuildMs` is the one-off cost of the first classification after a restart.

| Key | Env | Default |
|---|---|---|
| `careerAbyssalRead` | `HOTPATH_CAREER_ABYSSAL_READ` | `false` |
| `careerAbyssalReadParityCheck` | `HOTPATH_CAREER_ABYSSAL_READ_PARITY` | `false` |
| `careerAbyssalReadReclassifyPerCall` | `HOTPATH_CAREER_ABYSSAL_READ_RECLASSIFY` | `64` (0 = off) |
| `careerAbyssalReadMaxKeys` | `HOTPATH_CAREER_ABYSSAL_READ_MAX_KEYS` | `200000` |
| `careerAbyssalReadBusyTimeoutMs` | `HOTPATH_CAREER_ABYSSAL_READ_BUSY_MS` | `5000` |

## Career combat ledger read

Flag `careerCombatItemsRead` (`HOTPATH_CAREER_COMBAT_ITEMS_READ`), **off by default**. Obsolete on EveJS 261108.1 and later. On older builds, `careerCombatOutcomes.reconcile` (on every `careerProgress.sync`, e.g. after every mining drone cycle), after the `flushCareerCombatOutcomes()` fence, calls `itemStore.listPendingCareerCombatOutcomes`, which calls `gameStore.readPersisted("items", "/")`. That parses the whole `items` table (about 20% of game thread CPU in one profile), while the vendor only uses the `__evejsCareerCombatOutcomes` key.

- Scope: wrapper on `itemStore.listPendingCareerCombatOutcomes` (export field, depth counter). Gate: `gameStore.readPersisted` in scope, only for the `items` table and a path without segments. Serve: `sqliteStore.loadExistingTableObject("items")` returns the vendor `assembleFromRows` of only the `__evejsCareerCombatOutcomes` rows (and `__evejsCareerCombatOutcomes\u001f...`, should the vendor turn it into a row group), read with one primary-key query. No row = `{}` (vendor: empty ledger). Other paths and tables = full vendor result.
- The gate and serve are **the same wrapper** as the abyssal career read (`lib/careerReadDispatch.js`): `readPersisted` and `loadExistingTableObject` are wrapped once when either flag is on, and each fix has its own scope, table, disable state and stats. The flags work independently.
- No content cache: a separate read-only connection, one read transaction per call. The vendor order stays: fence first, then our read.
- Disable reasons: `order`, `drift` (probe or a different `ROW_KEY_SEP`), `parity`, `error`, `obsolete`.
- Parity (`careerCombatItemsReadParityCheck`): compares the ledger JSON. A mismatch causes one retry; a second means `disabled: parity` and the vendor result.
- Stats: `[hotPathPerf] stats careerCombatItemsRead state=... rows=... served=... fallback=<reason:n> serveMaxMs=... parityChecks=... parityRetries=...`.
- The probe requires `itemStore.listPendingCareerCombatOutcomes#scope`, `gameStore.readPersisted#combatGate`, `sqliteStore#combatDeps`, `sqliteStore.loadExistingTableObject#combatServe` (missing = `DRIFT` and `; careerCombatItemsRead disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `careerCombatItemsRead` | `HOTPATH_CAREER_COMBAT_ITEMS_READ` | `false` |
| `careerCombatItemsReadParityCheck` | `HOTPATH_CAREER_COMBAT_ITEMS_READ_PARITY` | `false` |
| `careerCombatItemsReadBusyTimeoutMs` | `HOTPATH_CAREER_COMBAT_ITEMS_READ_BUSY_MS` | `5000` |

## Read-only templates

Flag `templateReadOnlyView` (`HOTPATH_TEMPLATE_READONLY`), **off by default**. `dungeonInstanceCacheMgrService.hydrateSummary` calls `dungeonAuthority.getTemplateByID` (deep JSON clone of the template) for every instance while building buckets, and reads only six scalars. Inside `DungeonInstanceCacheMgrService.prototype.Handle_*` the `getTemplateByID` wrapper returns the vendor `getTemplateByIDReadOnly` (deep-frozen view, memoised per record), but only when the direct caller is `hydrateSummary` in `dungeonInstanceCacheMgrService.js` (checked with CallSite; `Error.stackTraceLimit` and `Error.prepareStackTrace` are restored in `finally`). Every other caller gets a clone as in the vendor.

- Parity (`templateReadOnlyViewParityCheck`, `HOTPATH_TEMPLATE_READONLY_PARITY`): view JSON must equal clone JSON, otherwise `disabled: parity` and the clone.
- Stats: `[hotPathPerf] stats templateReadOnly state=... served=... passthrough=... checkMaxUs=... parityChecks=...` (with rotation, ` servedRotate=...` at the end).
- **Location rotation** (flag `templateReadOnlyRotate`, `HOTPATH_TEMPLATE_READONLY_ROTATE`, **off by default**, works only with `templateReadOnlyView=true`): `dungeonRuntime.rotateUniversePersistentInstances` (job `global-site.lifecycle`) takes the template through `requireTemplate(templateID)` without `readOnly`, i.e. a full clone. The template only goes to `buildInstanceRecordFromOptions`, which the vendor itself already feeds a read-only view in `reconcileUniversePersistentInstances` (`requireTemplate(..., { readOnly: true })`). The export wrapper of `rotateUniversePersistentInstances` (called through the property from `dungeonUniverseRuntime.js`) opens the scope; only `getTemplateByID` called from `requireTemplate` in `dungeonRuntime.js`, itself called directly by `rotateUniversePersistentInstances` (two CallSite frames), gets the view. `emitInstanceChange` listeners in the same scope get a clone. Parity is shared (`templateReadOnlyViewParityCheck`). Probe: `dungeonRuntime.rotateUniversePersistentInstances#templateRotateScope` (missing = DRIFT, templates keep working).
- If the vendor renames `hydrateSummary`, there is no speed-up (passthrough) and no error; the tests catch the drift.

## Dungeon reads without a clone

Two flags, **off by default**. The scene timer `dungeonUniverseSiteService.tickSceneSiteBehaviors`, on every tick and for every materialised location, makes deep JSON clones of the instance (`dungeonRuntime.getInstance` -> `getInstanceSnapshot` -> `cloneValue`) and of the template (`dungeonAuthority.getTemplateByID` -> `clone`), which the consumers only read. Clone chains from a 905 s profile:

| Chain (direct caller <- ...) | ms | Handled |
|---|---|---|
| `getInstance` <- `tickSceneSiteBehaviors` (inline in the loop) | 2714 | partly: three anchor lines |
| `getTemplateByID` <- `resolveTemplate` <- `processGuideApproachTexts` | 1666 | yes, guide scope |
| `getTemplateByID` <- `tickSceneSiteBehaviors` | 1652 | no (~15 template consumers) |
| `getInstance` <- `processGateDefenseHazards` | 477 | yes, by name |
| `getTemplateByID` <- `enrichSiteWithDungeonRuntime` (scanner) | 45 | yes, adapter scope |
| `listInstancesByFamily(full)` <- moon `collectUpgradeRetentionSiteKeys` | ~50 | yes, in moonOreAnomalies (separate flag) |

- `templateReadOnlyCallers` (`HOTPATH_TEMPLATE_READONLY_CALLERS`, works only with `templateReadOnlyView=true`): the guide scope is the export `dungeonTrackingRuntime.processGuideApproachTexts` (one caller, through the property); `resolveTemplate` called directly from it gets the view (two CallSite frames). The template is used for `populationHints.guideAgentID` and a `populationHints.containers` filter (read only, a scalar goes to the client). The adapter scope is the export `dungeonSiteAdapter.enrichSiteWithDungeonRuntime` (4 providers through the property); only its direct `getTemplateByID` calls get the view, and they read scalars only. `resolveTemplateForSite` (arrow `get`) and `guideSiteOfShip` get a clone. SHA-1 fingerprint: `processGuideApproachTexts`, `resolveTemplate`, `guideAgentIDOf`, `enrichSiteWithDungeonRuntime`; a mismatch logs `WARN templateReadOnly callers drift: ... ` once, that scope does not serve, other template paths keep working. The template stats line gets ` servedGuide=... servedAdapter=...` at the end. The points `...#templateGuideScope` and `...#templateAdapterScope` are optional (missing = DRIFT, templates keep working).
- `dungeonInstanceRef` (`HOTPATH_DUNGEON_INSTANCE_REF`): the export wrapper of `dungeonRuntime.getInstance` (under the moonOreAnomalies overlay) returns the vendor `getInstanceRef` (live cache entry; mutating an instance replaces the object, so the ref is a stable snapshot like a clone) when the caller (CallSite; the `moonPresentationReader` frame is skipped) in `dungeonUniverseSiteService.js` is `processGateDefenseHazards`, `maybeAdvanceExplicitlySatisfiedObjective`, or `tickSceneSiteBehaviors` on one of three anchor lines: `processPaidMissionMiningObjective(...)`, `refreshedForObjective`, `processGuideApproachTexts(...)`. Anchors are located in the file text (each exactly once, otherwise `disabled:anchor`); if `getEnclosingLineNumber` differs from the declaration line: `disabled:line-shift`. Incursion/visions calls, mission sync and every other caller get a clone. SHA-1 fingerprint of callers and consumers (7 site functions, 3 tracking, 4 runtime, 2 runtimeState); mismatch = `disabled:drift`. A foreign wrapper or the moon overlay underneath = `disabled:order`. Parity `dungeonInstanceRefParityCheck` (`HOTPATH_DUNGEON_INSTANCE_REF_PARITY`): the ref is compared with the vendor clone, a difference = `disabled:parity` and the clone. Stats: `[hotPathPerf] stats dungeonInstanceRef state=... servedNamed=... servedAnchor=... passthrough=... noEnclosing=... checkUsTotal=... checkMaxUs=... parityChecks=...`; after enabling, compare `servedAnchor` with `passthrough` and `checkUsTotal`. Probe: `dungeonRuntime#instanceRefDeps` and `dungeonRuntime.getInstance#instanceRef` are required (missing = `; dungeonInstanceRef disabled: drift`).
- Cost: one CallSite check (~1-3 us) on every `getInstance` from outside `dungeonRuntime.js`, against a clone of ~45 us.

| Key | Env | Default |
|---|---|---|
| `templateReadOnlyView` | `HOTPATH_TEMPLATE_READONLY` | `false` |
| `templateReadOnlyViewParityCheck` | `HOTPATH_TEMPLATE_READONLY_PARITY` | `false` |
| `templateReadOnlyRotate` | `HOTPATH_TEMPLATE_READONLY_ROTATE` | `false` |
| `templateReadOnlyCallers` | `HOTPATH_TEMPLATE_READONLY_CALLERS` | `false` |
| `dungeonInstanceRef` | `HOTPATH_DUNGEON_INSTANCE_REF` | `false` |
| `dungeonInstanceRefParityCheck` | `HOTPATH_DUNGEON_INSTANCE_REF_PARITY` | `false` |

## Dungeon rock depletion coalescing

Flag `rockRemainderCoalesce` (`HOTPATH_ROCK_REMAINDER_COALESCE`), **off by default**. Every mining cycle that changes a dungeon rock calls `dungeonRuntime.mergeSpawnState(instanceID, { miningRockRemainingByID })` from `miningRuntimeState.recordDungeonRockRemainder`. Each call rebuilds the cache of the whole `dungeonRuntimeState` table and emits an instance change (site scheduler scan); about 24% CPU with drones mining in a site.

- The export wrapper of `dungeonRuntime.mergeSpawnState` keeps the latest value per (instance, rock) and writes it with one original call per instance every `rockRemainderCoalesceMs` (default 10 s). The write is `{ ...map from cache, ...buffer }` with the latest `nowMs`.
- Immediate write:
  - a rock mined down to 0 (together with the rest of that instance's buffer); only such rocks are read back from the record by live readers, so a scene rebuild never sees a stale value;
  - a foreign write of the key (a patch with other fields, or `durable`/`force`): the buffer is merged into its map (a key changed by the foreign write = `min`), then the original runs; the caller's object is not changed;
  - before `miningRuntime.handleSceneDisposed` (scene dispose) and `miningResourceSiteService.resetSceneGeneratedResourceSites` (resource site reset/rebuild);
  - in the hook `gameStore.registerShutdownHook("hotPathPerf.rockRemainder")` (SIGTERM/SIGINT, before tables are saved);
  - instances above `rockRemainderCoalesceMaxInstances` (oldest first).
- The AIR site (`evejs.air-tutorial:9245`) is not buffered (`airMiningSettlement.reconcile` rewrites the scene from the record). A patch without the `miningRockRemainingByID` key is unchanged.
- Hard restart (kill, crash, `ownerProcessShutdown` "exit"): loss of at most one window of depletion; after start a rock has slightly more ore. A rock mined to 0 does not come back.
- The wrapper only buffers once the dispose point is wrapped; before that it passes through (`passthrough=noDisposeHook`). A vendor write error during a flush drops the entry (`writeErrors`, one WARN line per stats window, like the vendor best-effort write). An instance removed within the window = `dropped=notFound`. A timer firing after gameStore shutdown started = `dropped=shutdown`.
- Disable reasons (the buffer is written with the original, then passthrough): `order` (someone else wrapped `mergeSpawnState`), `drift`, `error`.
- Stats: `[hotPathPerf] stats rockRemainderCoalesce state=... pending=<instances>/<rocks> intercepted=... buffered=... noop=... flushes=timer:n,zero:n,foreign:n,dispose:n,reset:n,shutdown:n,limit:n written=... dropped=notFound:n,shutdown:n writeErrors=... passthrough=air:n,mission:n,noDisposeHook:n,durable:n flushMaxMs=... maxAgeMs=...`.
- The probe requires `dungeonRuntime.mergeSpawnState#coalesce`, `dungeonRuntime#rockDeps`, `gameStore#rockDeps` (missing = `DRIFT` and `; rockRemainderCoalesce disabled: drift`). `miningRuntime.handleSceneDisposed#rockFlush` and `miningResourceSiteService.resetSceneGeneratedResourceSites#rockFlush` are lazy: module not loaded = `; rockRemainderCoalesce waiting`, loaded and not wrapped = DRIFT.

| Key | Env | Default |
|---|---|---|
| `rockRemainderCoalesce` | `HOTPATH_ROCK_REMAINDER_COALESCE` | `false` |
| `rockRemainderCoalesceMs` | `HOTPATH_ROCK_REMAINDER_COALESCE_MS` | `10000` (0 = no buffering) |
| `rockRemainderCoalesceMaxInstances` | `HOTPATH_ROCK_REMAINDER_COALESCE_MAX_INSTANCES` | `256` |

## System structures

Flag `structuresSystemFilter` (`HOTPATH_STRUCTURES_SYSTEM_FILTER`), **off by default**. `structureState.listStructuresForSystem` calls the local `listStructures`, which JSON-clones every structure in the universe and only then filters by system. `scene.syncStructureEntitiesFromState({refresh:false})` does this for every active scene on every 100 ms tick (183 structures, ~0.5 MB JSON: about 14% CPU).

- The export wrapper of `listStructuresForSystem` (worldData and services call it through the exports) first filters the live rows from the vendor `peekStructuresForSystem`, then clones only the matches (`JSON.parse(JSON.stringify)` as the vendor). Result: the same array as the vendor, new objects.
- Vendor semantics are kept: a non-positive id = `[]` without a tick; `refresh !== false` = `tickStructures(Date.now())` before the read (a tick exception propagates); `includeDestroyed`; `null`/non-object options = original.
- Local calls inside `structureState` (e.g. `listStructures` at the end of `tickStructures`) are unchanged.
- Parity (`structuresSystemFilterParityCheck`): result JSON must equal the original with `refresh:false`, otherwise `disabled: parity` and the vendor result.
- Disable reasons: `order` (someone else wrapped `listStructuresForSystem`), `drift`, `error` (a `peekStructuresForSystem` exception; that call goes to the original with `refresh:false`, without a second tick), `parity`.
- **Refresh coalescing** (flag `structuresRefreshCoalesce`, `HOTPATH_STRUCTURES_REFRESH_COALESCE`, **off by default**, works only with `structuresSystemFilter=true`): a call with `refresh !== false` (Living New Eden deployment placement checks, `mobile*Runtime`, `structureDirectoryService`) skips `tickStructures` when the last full pass was less than `structuresRefreshFreshMs` (5000, max 10000) ago. Freshness = max(last own refresh of the filter, `lastRunAtMs` of the structure tick throttle when it is on). The tick only advances timers by `now` and writes go to the cache immediately, so a skipped refresh reads the state as of the last tick (like a scene with `refresh:false`). A timer transition within the window is late by at most the window. A clock that went backwards or a missing marker = refresh. A vendor tick exception propagates without setting the marker. An own exception logs `[hotPathPerf] WARN structuresSystemFilter coalesce disabled: error (...)`; refresh then always runs and the filter keeps working. Without the filter, startup logs a warning that `structuresRefreshCoalesce=true` has no effect.
- Stats: `[hotPathPerf] stats structuresSystemFilter state=... served=... empty=... passthrough=... cloned=... parityChecks=... refreshRan=... refreshSkipped=... refreshAgeMaxMs=... coalesce=<on|off|disabled:error>`.
- The probe requires `structureState#structuresDeps` and `structureState.listStructuresForSystem#systemFilter` (missing = `DRIFT` and `; structuresSystemFilter disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `structuresSystemFilter` | `HOTPATH_STRUCTURES_SYSTEM_FILTER` | `false` |
| `structuresSystemFilterParityCheck` | `HOTPATH_STRUCTURES_SYSTEM_FILTER_PARITY` | `false` |
| `structuresRefreshCoalesce` | `HOTPATH_STRUCTURES_REFRESH_COALESCE` | `false` |
| `structuresRefreshFreshMs` | `HOTPATH_STRUCTURES_REFRESH_FRESH_MS` | `5000` (0 = always refresh, max 10000) |

## Mining drone persist coalescing

Flag `dronePersistCoalesce` (`HOTPATH_DRONE_PERSIST_COALESCE`), **off by default**. Obsolete on EveJS 261126.2. On older builds `droneRuntime.tickDroneMining` calls `persistDroneEntityState` on every 100 ms tick, i.e. a full `itemStore.updateInventoryItem` (normalisation, clones, `writeItems`) for every mining drone, although between state transitions only movement changes (one player with mining drones: about 21% CPU).

- The export wrapper of `itemStore.updateInventoryItem` (wrapped on first load, because `droneRuntime` destructures the function) works inside the `droneRuntime.tickScene` scope. Candidate: a scene drone with `droneCommand=MINE` and `activityState` MINING/APPROACHING.
- Real write (vendor result unchanged): the first write of a drone, a write `dronePersistCoalesceMs` (5 s) after the previous one, any change of a non-movement field (location, launcher, `customInfo`, `mode`, `targetEntityID`, AIR/abyssal/dungeon scope metadata). A deferred movement-only write (`position`, `velocity`, `direction`, `targetPoint`, `speedFraction`, `followRange`, `orbitDistance`, `orbitNormal`, `orbitSign`) returns `{ success: true, coalesced: true }`. `emitDroneStateChange` (client notification) stays immediate.
- Deferred movement is written as a `spaceState` patch on the current record: before a foreign write of that item (recall, scoop, abandon, reset to idle), by timer (the drone stopped being ticked), before `SpaceRuntime.disposeScene`, in the hook `gameStore.registerShutdownHook("hotPathPerf.dronePersist")`, at the `dronePersistCoalesceMaxItems` limit (oldest first). Before the patch a CAS check: `locationID, flagID, ownerID, typeID, singleton, launcherID, customInfo` and `spaceState` must match our last write; otherwise the movement is dropped (`dropped=cas`).
- Hard crash: after a restart a drone may stand up to 5 s back on its path. Combat, salvage, repair drones and fighters are unchanged.
- Disable reasons (deferred movement is written, then passthrough): `order` (someone else wrapped `updateInventoryItem`, or `droneRuntime` loaded before the wrap), `drift`, `error`, `obsolete` (the vendor checkpoints drone motion itself, nothing is wrapped).
- Stats: `[hotPathPerf] stats dronePersistCoalesce state=... tracked=... pending=... intercepted=... coalesced=... real=first:n,interval:n,changed:n flushes=timer:n,foreign:n,dispose:n,shutdown:n,limit:n dropped=cas:n,notFound:n,shutdown:n writeErrors=... flushMaxMs=... maxAgeMs=...`.
- The probe requires 7 points: `itemStore#droneDeps`, `itemStore.updateInventoryItem#droneCoalesce`, `itemStore.updateInventoryItemSuccessOnly#droneCoalesce` (261108.1+), `gameStore#droneDeps`, `droneRuntime#droneDeps`, `droneRuntime.tickScene#droneScope`, `SpaceRuntime.disposeScene#droneFlush` (missing = `DRIFT` and `; dronePersistCoalesce disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `dronePersistCoalesce` | `HOTPATH_DRONE_PERSIST_COALESCE` | `false` |
| `dronePersistCoalesceMs` | `HOTPATH_DRONE_PERSIST_COALESCE_MS` | `5000` (0 = no deferral) |
| `dronePersistCoalesceMaxItems` | `HOTPATH_DRONE_PERSIST_COALESCE_MAX_ITEMS` | `256` |

## Structure tick throttle

Flag `tickStructuresThrottle` (`HOTPATH_TICK_STRUCTURES_THROTTLE`), **off by default**. `spaceRuntime/tick.js` calls `structureState.tickStructures(now)` every 100 ms. Each call clones all structures, advances their timers and at the end clones them a second time (`listStructures`); with 183 structures and ~170 sov hubs about 15% CPU.

- A wrapper on `SpaceRuntime.prototype.tick` arms a one-shot throttle. The export wrapper of `tickStructures` skips the FIRST call within a tick if less than `tickStructuresMinIntervalMs` (default 5000) has passed since the last pass. The skipped call returns `undefined`; `tick.js` does not use the result.
- Ad-hoc calls (sov/FLEX/auto-state, market, chat, the system structures read, a second call within the same tick) always go to the original and update `lastRunAtMs`. Local `getStructureByID`/`listStructures` inside `structureState` bypass the wrapper.
- **Structure timer granularity <= `tickStructuresMinIntervalMs`.** Fuel, reinforce, anchoring, unanchoring, abandon, moon extractions and timer resume after repair react up to 5 s later (with the default 5000 ms). All vendor thresholds are seconds, minutes or hours. Player actions (anchoring, damage) write the record immediately, without a tick. Visible effect: a structure leaving reinforce accepts damage up to 5 s later. Values above 10000 are clamped to 10000 with a warning.
- An exception from the original propagates and `lastRunAtMs` is not updated, so the next tick retries. A clock that went backwards means a pass.
- Disable reasons: `order` (someone else wrapped `tickStructures`), `drift`, `error`.
- Stats: `[hotPathPerf] stats tickStructuresThrottle state=... ranFromTick=... skipped=... ranAdhoc=... maxGapMs=...`.
- The probe requires `SpaceRuntime.tick#tickStructScope` and `structureState.tickStructures#throttle` (missing = `DRIFT` and `; tickStructuresThrottle disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `tickStructuresThrottle` | `HOTPATH_TICK_STRUCTURES_THROTTLE` | `false` |
| `tickStructuresMinIntervalMs` | `HOTPATH_TICK_STRUCTURES_MIN_INTERVAL_MS` | `5000` (0 = no throttle, max 10000) |

## Owner blueprint list

Flag `blueprintOwnerRead` (`HOTPATH_BLUEPRINT_OWNER_READ`), **off by default**. Obsolete on EveJS 261115.2. On older builds, `industryRuntimeState.listBlueprintInstancesByOwner` (client: `blueprintManager.GetBlueprintDataByOwner`) JSON-clones the whole `industryBlueprintState` table 2-4 times for every blueprint of the owner, and the whole `industryJobs` table for a blueprint with a job (measured: 18 calls of 6-10 s each in 12 h).

- The export wrapper of `listBlueprintInstancesByOwner` (wrapped on first load, because `blueprintManagerService.js` and `industryChatCommands.js` destructure the export) runs the same loop as the vendor and computes each blueprint with the original `getBlueprintByItemID` inside a per-blueprint scope.
- In scope, the wrapper of `gameStore.read(table, "/")` for `industryBlueprintState` and `industryJobs` returns a view with a single record (the scoped blueprint; the job referenced by the live blueprint record). No cache: the view is built from live data on every read. Out of scope, other tables and paths with segments = original.
- Root writes of these tables in scope (lazy creation of a BPO record) go out as per-record writes (`/records/<id>`, `/_meta`); the view is never written as a table.
- SHA-1 fingerprint of 17 functions in `industryRuntimeState.js` and 3 in `starbaseIndustryRuntime.js`. Different code = `disabled: drift` and vendor behaviour.
- Parity (`blueprintOwnerReadParityCheck`): a difference = `disabled: parity (owner=<id> firstItem=<id>)` and the vendor result.
- Disable reasons: `drift` (fingerprint, missing probe point), `order` (someone else wrapped `gameStore.read/write` or the list export first), `parity`, `error` (exception in the loop; that call goes to the vendor), `obsolete`.
- Slow call line: `[hotPathPerf] slow industryRuntimeState.listBlueprintInstancesByOwner <ms>ms owner=<id> items=<n> mode=<fast|vendor|parity>` (>= `slowCallMs`). Stats: `[hotPathPerf] stats blueprintOwnerRead state=... calls=... items=... itemsMax=... sumMs=... maxMs=... scopedReads=... scopedWrites=... fallback=<reason:n,...> parityChecks=...`.
- The probe requires `gameStore.read#bpScopeRead`, `gameStore.write#bpScopeWrite`, `itemStore#bpDeps`, `industryRuntimeState.listBlueprintInstancesByOwner#bpOwnerRead` (missing = `DRIFT` and `; blueprintOwnerRead disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `blueprintOwnerRead` | `HOTPATH_BLUEPRINT_OWNER_READ` | `false` |
| `blueprintOwnerReadParityCheck` | `HOTPATH_BLUEPRINT_OWNER_READ_PARITY` | `false` |

## NPC wreck list

Flag `nativeWreckList` (`HOTPATH_NATIVE_WRECK_LIST`), **off by default**. The EveJS job `global-site.lifecycle`, for every expired/rotated location in a system without a scene, calls `dungeonUniverseSiteService.listStoredDungeonNativeWreckIDs` -> `nativeNpcStore.listNativeWrecks()`. The vendor JSON-clones the whole `npcWrecks/wrecks` collection, and `isPendingMiningWreck` does two `require()` calls per wreck (each through the mods' `Module._load` hook chain); in one profile 195 of the job's 814 ms.

- The export wrapper of `listNativeWrecks` (all vendor consumers call it through the property, no destructuring) evaluates the same pending predicate on the live rows of `gameStore.read("npcWrecks", "/")` (the live vendor cache object). The exports `nativeNpcDeathWrecks.isPendingWreck` and `incursionDeathWrecks.isPending` are taken from `Module._cache` (no `require`), the transfer state from `gameStore.read("npcCargo", "/miningTransfers/<key>")`. Table names come from `nativeNpcStore.TABLE`.
- The direct caller `listStoredDungeonNativeWreckIDs` in `dungeonUniverseSiteService.js` (CallSite) gets the live rows without a clone. Every other caller gets a JSON clone of the filtered and sorted rows, i.e. a result identical to the vendor.
- The first call for every new table root object (process start, a whole-root write) goes to the original, because the vendor `ensureRootShape` shapes the root. A root without a `wrecks` object = original (`fallback=shape`). Pending module not loaded yet = original (`fallback=deps`).
- SHA-1 fingerprint of the bodies of `listNativeWrecks`, `isPendingMiningWreck`, `readCollection`, `readCollectionRaw`, `ensureRootShape` (`nativeNpcStore.js`) and `listStoredDungeonNativeWreckIDs` (`dungeonUniverseSiteService.js`). Different code = `disabled: drift` and vendor behaviour.
- Parity (`nativeWreckListParityCheck`): a JSON difference = `disabled: parity` and the vendor result.
- Disable reasons: `drift`, `order` (someone wrapped the export first), `parity`, `error`.
- Stats: `[hotPathPerf] stats nativeWreckList state=... calls=... scoped=... global=... rows=... rowsMax=... pendingHits=... fallback=<reason:n,...> parityChecks=...`.
- The probe requires `nativeNpcStore#wreckDeps` and `nativeNpcStore.listNativeWrecks#wreckList` (missing = `DRIFT` and `; nativeWreckList disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `nativeWreckList` | `HOTPATH_NATIVE_WRECK_LIST` | `false` |
| `nativeWreckListParityCheck` | `HOTPATH_NATIVE_WRECK_LIST_PARITY` | `false` |

## Config snapshot memo

Flag `configSnapshotMemo` (`HOTPATH_CONFIG_SNAPSHOT_MEMO`), **off by default**. `machoNet/globalConfig.getRuntimeConfig` calls `config.getConfigStateSnapshot()` = `config/manager.loadState` on every call: it synchronously reads and validates 6 domain files and `version.json` (in Docker `./config` is a host bind mount). One login does this 3-5 times (handshake constructor, `start()`, `GetInitVals`, `GetGlobalConfig`); in one profile 371 ms per 120 s, up to 75 ms in a row per connection.

- Wrappers on 5 exports of `globalConfig.js`, installed on **first load** (handshake, `tcp/index`, `machoNetService`, `cacheService` destructure them): `getRuntimeConfig` on a hit returns a `structuredClone` of the memoised `resolvedConfig` (a fresh object as in the vendor; mutating the result does not corrupt the memo), on a miss the vendor result. `normalizeCountryCode`, `buildGlobalConfigEntries`, `buildGlobalConfigDict` and `getRuntimeGlobalConfigValue` with an empty config slot (`undefined`, like a JS default parameter) get the memo object; an explicit argument (also `null`) goes to the vendor unchanged. Default parameters inside `globalConfig.js` call the local `getRuntimeConfig` (bypassing the export), so these 4 wrappers fill the slot themselves before calling the original.
- Invalidation: a `stat` signature (`mtimeNs:size:ino`) of all files in the vendor snapshot (`configFilePaths` + `versionConfigPath`, paths resolved once per process), computed before the read. Within `configSnapshotMemoRevalidateMs` (default 1000, like the vendor token cache) no `stat`; `0` = `stat` on every call. A change from the ConfigEditor (temp file + rename) or a manual edit is visible at most one window later.
- **Env is not part of the key:** a change of `process.env.EVEJS_*` at runtime is not noticed until a file changes. Neither EveJS nor the mods set such variables at runtime; container env is fixed.
- A config validation error (the vendor returns the fallback `config`) = no cache, every call goes to the vendor (`errPass`). If the config is bad from the first call (paths not known yet), the memo returns the vendor fallback without a second read and retries resolving the paths at most once per `configSnapshotMemoRevalidateMs` window.
- A clock moved back before the last `stat` ends the window (the next call does a `stat`).
- SHA-1 fingerprint of the bodies of the 5 functions (`globalConfig.js`) and of `loadState` and `readVersion` in `config/manager.js` (they decide which files form the key). Different code = `disabled: drift:<function>` or `drift:manager.<function>`, exports not wrapped, vendor behaviour. After a server update, refresh the constants in `lib/configSnapshotMemo.js`.
- Parity (`configSnapshotMemoParityCheck`): every hit also does the vendor read; a JSON difference = vendor result and at most one `WARN configSnapshotMemo parity mismatch` line per 60 s. Restores the disk cost; diagnostics only.
- Disable reasons (`[hotPathPerf] WARN configSnapshotMemo disabled: <reason>`): `drift:<function>`, `drift:manager.loadState` / `drift:manager.readVersion`, `deps` (no vendor config), `paths`, `clone`, `order:<function>` (someone wrapped the export first), `error:...`.
- Stats: `[hotPathPerf] stats configMemo=on hits=... misses=... reval=... keyChg=... errPass=... parity=...`.
- The probe requires `config#configMemoDeps` and `globalConfig#configMemo` (missing = `DRIFT` and `; configSnapshotMemo disabled: drift:...`).

| Key | Env | Default |
|---|---|---|
| `configSnapshotMemo` | `HOTPATH_CONFIG_SNAPSHOT_MEMO` | `false` |
| `configSnapshotMemoRevalidateMs` | `HOTPATH_CONFIG_SNAPSHOT_MEMO_REVALIDATE_MS` | `1000` (0 = always `stat`, max 60000) |
| `configSnapshotMemoParityCheck` | `HOTPATH_CONFIG_SNAPSHOT_MEMO_PARITY` | `false` |

## Scheduler queue limit

Key `schedulerMaxPending` (`HOTPATH_SCHEDULER_MAX_PENDING`), **default 4096**. The vendor creates the scheduler process client with `maxPending: 256` (`durableScheduler.js`) and no env override. After ~10 h of downtime the worker sends ~450 overdue jobs at once on start (sovereignty-campaign, ess), each calls `validateLease`, request 257 gets `AUTHORITY_OVERLOADED: Authority queue is full (256)` and startup ends with `[Startup] Failed while starting production owners` (exit code 1).

- The export wrapper of `createOrderedProcessClient` (`services/_shared/orderedProcessClient.js`) raises `maxPending` only for the client with `authorityName: "scheduler"`, and only upwards. Wallet (`wallet`) and edge (`*-edge`) clients are unchanged. It is installed on every `Module._load` of that file (also from the cache), so before `durableScheduler.js` destructures the export.
- The same wrapper also raises `requestTimeoutMs` of the `scheduler` client (vendor `10_000`), only upwards. Reason: after `scheduler.start()` the startup reconcilers (`productionSchedulerRuntime.js`, e.g. `sovCampaignState.reconcileSovereigntyCampaigns` over all sov systems) and the overdue job handlers run synchronously on the main thread. The event loop stalls for ~35-39 s, IPC replies wait, and the timeout counts from sending, so `schedule` from a reconciler got `AUTHORITY_REQUEST_TIMEOUT` and startup ended with code 1.
- Line when the client is created: `[hotPathPerf] scheduler queue: maxPending 256 -> 4096, requestTimeoutMs 10000 -> 120000 (authority=scheduler)`. If `durableScheduler.js` loads without the wrapped export: `[hotPathPerf] DRIFT: orderedProcessClient.createOrderedProcessClient ...` (vendor limits apply).
- `0` = vendor behaviour (the hook is not installed). Values above the maximum are clamped with a warning. Works only with `enabled=true`.

| Key | Env | Default |
|---|---|---|
| `schedulerMaxPending` | `HOTPATH_SCHEDULER_MAX_PENDING` | `4096` (0 = vendor, max 65536) |
| `schedulerRequestTimeoutMs` | `HOTPATH_SCHEDULER_REQUEST_TIMEOUT_MS` | `120000` (0 = vendor, max 600000) |

## Scheduler overdue job gate

Flag `schedulerDueGate` (`HOTPATH_SCHEDULER_DUE_GATE`), **on by default**. After 11 h of downtime the scheduler worker leases all overdue jobs at once (`durableSchedulerProcess.worker.js` `dispatchDueJobs`, ~6700: `ess.settlement` 6452, `sovereignty.campaign-tick` 283) and publishes `scheduler.due`. Each event is `validateLease` + handler + `ack` in the `scheduler` client queue, ahead of the `schedule` calls of the `productionSchedulerRuntime.start()` reconcilers. Startup took 11 minutes or failed on a timeout.

- The export wrapper of `createProductionSchedulerRuntime` (`services/scheduler/productionSchedulerRuntime.js`, wrapped on load, before `bootstrap.js` destructures it) opens a capture window. The first `scheduler` client created in that window (through the `createOrderedProcessClient` wrapper) gets a wrapped `onEvent` and `call`. The `npcBountySchedulerRuntime` client and other authorities are unchanged.
- Events of the types in `schedulerDueGateTypes` are held in RAM (the same jobID with a new lease replaces the old entry). After `start()` settles (line `scheduler due gate: open (owners_ready) held=N types=...`, on error `owners_failed`, with no signal after `schedulerDueGateMaxHoldMs` `max_hold`) and after `schedulerDueGateReleaseDelayMs`, a pump releases them to the vendor: at most `schedulerDueGateBatch` per step, at most `schedulerDueGateMaxInFlight` in flight (until `ack`/`retry` or a rejected `validateLease`). A freed in-flight slot releases the next job immediately, so the rate depends on the `validateLease` -> `ack` time, not on the step interval. An entry for which the vendor never called the client (shutdown, scheduler restart) frees its slot after `schedulerDueGateUnseenReleaseMs`. An entry with less than `schedulerDueGateMinLeaseLeftMs` of lease left waits for a new lease (moved to the end of the queue, the pump takes the next one); one expired for longer than `schedulerDueGateStaleDropMs` is dropped (the worker sends it again). When empty: `scheduler due gate: drained released=... replaced=... staleDropped=... overflow=... openedAfter=...s drainMs=...`, then passthrough.
- The gate never does `ack` or `retry`; job state stays in the vendor `scheduledJobs` (a restart in the middle loses nothing). Re-leases while held increase `attempt` (up to +10 at 300 s), as in the vendor during a lease storm.
- `0` = vendor behaviour. An empty type list = gate off (`scheduler due gate: off ...`). Out-of-range values are clamped with a `WARN`. Runtime not wrapped = `DRIFT: productionSchedulerRuntime.createProductionSchedulerRuntime ... due gate inactive (vendor dispatch)`.

| Key | Env | Default |
|---|---|---|
| `schedulerDueGate` | `HOTPATH_SCHEDULER_DUE_GATE` | `true` |
| `schedulerDueGateTypes` | `HOTPATH_SCHEDULER_DUE_GATE_TYPES` | `ess.settlement,sovereignty.campaign-tick` (<= 16, no `*`) |
| `schedulerDueGateReleaseDelayMs` | `HOTPATH_SCHEDULER_DUE_GATE_RELEASE_DELAY_MS` | `30000` (0..600000) |
| `schedulerDueGateMaxHoldMs` | `HOTPATH_SCHEDULER_DUE_GATE_MAX_HOLD_MS` | `300000` (10000..1800000) |
| `schedulerDueGatePumpIntervalMs` | `HOTPATH_SCHEDULER_DUE_GATE_PUMP_INTERVAL_MS` | `100` (10..5000) |
| `schedulerDueGateBatch` | `HOTPATH_SCHEDULER_DUE_GATE_BATCH` | `8` (1..256) |
| `schedulerDueGateMaxInFlight` | `HOTPATH_SCHEDULER_DUE_GATE_MAX_IN_FLIGHT` | `2` (1..64) |
| `schedulerDueGateMinLeaseLeftMs` | `HOTPATH_SCHEDULER_DUE_GATE_MIN_LEASE_LEFT_MS` | `10000` (0..29000) |
| `schedulerDueGateStaleDropMs` | `HOTPATH_SCHEDULER_DUE_GATE_STALE_DROP_MS` | `120000` (1000..600000) |
| `schedulerDueGateMaxHeld` | `HOTPATH_SCHEDULER_DUE_GATE_MAX_HELD` | `100000` (1000..1000000) |
| `schedulerDueGateUnseenReleaseMs` | `HOTPATH_SCHEDULER_DUE_GATE_UNSEEN_RELEASE_MS` | `10000` (1000..600000) |

## Startup stall watch

Flag `stallWatch` (`HOTPATH_STALL_WATCH`), **on by default**. During startup the world process main thread can be busy synchronously for minutes with no log line from that window, because everything the main thread logs appears only after the block.

- Starts once, in the world process (role `EVEJS_GAMESTORE_OWNER_ROLE=world`, set in `server/index.js` before the first `require`), on the first `Module._load` after the role is set. `*.worker.js` children (scheduler, wallet, edge) and worker threads do not start it. Line: `stallWatch: armed pid=... role=world thresholdMs=... windowMs=...`.
- The main thread writes a heartbeat to a `SharedArrayBuffer` every `stallWatchHeartbeatMs`. A watchdog thread (`lib/stallWatch.worker.js`, `execArgv: []`, no other mods) detects a gap >= `stallWatchThresholdMs` and **during the block** writes directly to stdout:
  - `stallWatch: stall gapMs=... phase=boot|owners|after_owners uptimeS=... last=<crumb>@-<age>s`,
  - `stallWatch: sample n=... frames: <function>@<file>:<line> < ...` (main thread stack sample through `node:inspector`, every `stallWatchSampleEveryMs`, at most `stallWatchMaxSamples` per block, `stallWatchFrames` frames). During a native synchronous call (SQLite, `Atomics.wait`) the sample has no frames: `sample n=... no-js (native or sync I/O) last=...`,
  - after the block: `stallWatch: stall ended gapMs=... samples=... phase=...`.
- The crumb (`last=`) is the last step of the scheduler client: `call:<command>:<type>`, `reply:<command>:<type>` (written before the vendor continues), `due:<type>`, `release:<type>`. Phase: `owners` during `productionSchedulerRuntime.start()`, then `after_owners`.
- Scheduler client timeline during `start()`: one line `scheduler owners: timeline startMs=... calls=... top: <command:type>=<n>@<from>-<to>s rt<max>ms, ...` (up to 12 entries). A round trip >= `schedulerOwnersSlowCallMs` logs `scheduler owners: slow call cmd=... label=... rtMs=... phase=...` (after the block). Works when the overdue job gate (`schedulerDueGate`) is on.
- The debugger is attached only during a block, and every pause ends with a resume. After `stallWatchWindowMs` from start the watchdog exits: `stallWatch: done stalls=... maxGapMs=... samples=...`. Mod stats line: `stallWatch stalls=... maxGapMs=... samples=...`.
- No `inspector` in Node = `stallWatch: no inspector - gaps only` (gaps and crumbs without stacks). Watchdog thread died = `stallWatch: worker exited code=...`, the server keeps running. `0` = no thread and no timer. `HOTPATH_STALL_WATCH_MAX_SAMPLES=0` = no debugger.

| Key | Env | Default |
|---|---|---|
| `stallWatch` | `HOTPATH_STALL_WATCH` | `true` |
| `stallWatchThresholdMs` | `HOTPATH_STALL_WATCH_THRESHOLD_MS` | `5000` (500..600000) |
| `stallWatchSampleEveryMs` | `HOTPATH_STALL_WATCH_SAMPLE_EVERY_MS` | `20000` (1000..600000) |
| `stallWatchMaxSamples` | `HOTPATH_STALL_WATCH_MAX_SAMPLES` | `40` (0..1000, 0 = no debugger) |
| `stallWatchFrames` | `HOTPATH_STALL_WATCH_FRAMES` | `12` (1..50) |
| `stallWatchWindowMs` | `HOTPATH_STALL_WATCH_WINDOW_MS` | `1800000` (60000..86400000) |
| `stallWatchHeartbeatMs` | `HOTPATH_STALL_WATCH_HEARTBEAT_MS` | `250` (50..5000) |
| `schedulerOwnersSlowCallMs` | `HOTPATH_SCHEDULER_OWNERS_SLOW_CALL_MS` | `10000` (0..600000, 0 = no line) |

## Owned sov hub echo mask

Flag `sovCaptureOwnedEchoSkip` (`HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP`), **on by default**. On every start `sovCaptureState.reconcilePreparedSovereigntyCaptures` takes the campaign echo of an owned hub (`writeHubMetadata`: score 1, `controllingTeamID` = defender, no receipt) for a blocked winner (observed: 474 s of the `owners` phase). For every such hub it does a full sov table write, a structure write and a cyno jammer check, and the commit is rejected anyway at the epoch fence (`SOVEREIGNTY_CAPTURE_FENCE_CHANGED`). The next `writeHubMetadata` erases what the vendor wrote, so the cost returns on every start.

- Export wrapper on `sovState.listAllSovereigntySystemStates` (first load, because `sovCaptureState` destructures it) and a scope on the export `sovCaptureState.reconcilePreparedSovereigntyCaptures`. In scope, **only the first** list call returns clones without `entosisCapture` for hubs that meet all conditions: type 32458, capture is an object, no receipt, vendor `hasBlockedWinner`, `devFlags.sovereigntyOwnedHubCapture` is an object, `devFlags.sovereigntyCaptureEpoch` non-empty and different from the capture epoch. The vendor would never reach `completed: true` for such a hub. The vendor cache, other list calls and hubs with a `prepared` receipt are unchanged.
- One line per start: `sovCaptureEcho: masked=... scanned=... completed=... blocked=... failed=... errors=<code:n,...> ms=... sample=<system:hub,...>`. Stats line (printed only when it differs from the previous one): `sovCaptureEcho stats state=... masked=... calls=...`. Loaded line: `sovCaptureOwnedEchoSkip=on|off|disabled:<reason>`.
- Differences from the vendor: no writes of doomed receipts and `activeExecutorRequired` markers; masked hubs do not appear in `data.results`, `scannedCandidates`, `blocked`; no cyno calls and no fuel settlement for them (the next reader or the `sovereignty.hub-fuel` job settles it); a masked hub does not get a capture write with `scoringRate: 0, isBlocked: false`, so a rate saved before a restart during entosis stays until the next `writeHubMetadata` (the vendor projection and `ensureRuntime` zero it anyway without runtime links). The result the vendor reads (`data.completed`) is the same.
- Disable reasons: `late_wrap` (list wrapped after `sovCaptureState` loaded, or from the probe sweep), `list_not_called` (the vendor changed the loop), `order` (foreign list wrapper), `drift` (one of the 2 points missing), `error`. A disabled mask is a clean passthrough. `0` = nothing is wrapped.

| Key | Env | Default |
|---|---|---|
| `sovCaptureOwnedEchoSkip` | `HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP` | `true` |

## Cyno jammer broadcast only for systems with a session

Flag `cynoBroadcastSessionFilter` (`HOTPATH_CYNO_BROADCAST_SESSION_FILTER`), **on by default**. Every `structureState.persistStructures` calls `sovSuppressionState.broadcastCynoJammerChangesForStructureRows` for the changed systems. The vendor computes the cyno jammer state twice for each of them, and after any sov table change that means rebuilding the whole sov cache and settling fuel for all hubs. The result only goes to `broadcastCynoJammerChanged`, which returns 0 and sends nothing in a system without a session. The same path also loads every campaign tick.

- Export wrapper (in place; the only consumer, `structureState.maybeBroadcastCynoJammerStateChanges`, reads it from the module on every call) passes to the vendor only the `options.systemIDs` with >= 1 live session (`sessionRegistry.getSessions()`, `solarsystemid2 || solarsystemid`, as `getTargetSessions`), in the same order and with the same other options. An empty list = `0` without calling the vendor. Non-array `options.systemIDs` = clean passthrough.
- Accuracy: the returned sum and the order and content of the sent `OnCynoJammerChanged` are the same. For systems without a session only reads with no observable result are skipped: the lazy sov cache rebuild (the next reader does it), `settleAllHubFuel({forRead:true})` (amount from the wall clock; the `upgradesLastUpdatedMs` marker may be later) and a possible `warn` `[SovSuppression] POS cyno jammer check failed` or `Cyno jammer notification sync failed`.
- Stats line (only when there was a call in the window): `cynoBroadcast stats calls=... systems=... kept=... skipped=... noop=...`. Loaded line: `cynoBroadcastSessionFilter=on|off|disabled:<reason>`.
- Disable reasons: `sessions_error` / `sessions_shape` (`getSessions` throws or does not return an array), `drift` (no wrapper, or `sessionRegistry#cynoDeps` missing in the probe), `error`. A disabled filter is a clean passthrough. `0` = nothing is wrapped.

| Key | Env | Default |
|---|---|---|
| `cynoBroadcastSessionFilter` | `HOTPATH_CYNO_BROADCAST_SESSION_FILTER` | `true` |

## Incursion tale list memo

Flag `incursionTalesMemo` (`HOTPATH_INCURSION_TALES_MEMO`), **off by default**. Obsolete on EveJS 261115.2. On older builds every `incursionSystemEffects.context(systemID)` (ship modifiers, drone and weapon damage, dogma, bounty, cyno) goes through `incursionPresentation.forSystem` -> `activeTales` -> `getTales` -> `incursionLifecycle.listTales()` -> `incursionLifecycleStore.read()`, i.e. a `structuredClone` of the whole `incursionLifecycle` table (~157 KB) and a SHA-256 of every tale's policy, also in systems without an incursion (in one profile 2.6 s per 306 s).

- Wrappers on three presentation exports (`getTales`, `activeTales`, `forSystem`; the vendor calls them locally, hence all three) serve the list from a memo: one vendor `listTales()` call per table version, result deep-frozen, the `isPrepared` / `!terminal` / system filters applied as in the vendor on every call (new array). `buildSystemTalesDict` and the reconciler paths (`listTales` through lifecycle) stay with the vendor.
- Table version = identity of the root object `gameStore.read("incursionLifecycle", "/")` (root writes and load/recovery replace the object) + a generation bumped by the wrapper on `incursionLifecycleStore.mutate` (success, no change, exception). Reads during `mutate` go to the vendor. Vendor exceptions (`INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED`, `INCURSION_FROZEN_POLICY_MISMATCH`) propagate without caching.
- SHA-1 fingerprint (LF): the whole `incursionPresentation.js` and `incursionLifecycleStore.js`, the `listTales` line, `validateTale` and the `store` line in `incursionLifecycle.js`. Different = `WARN incursionTalesMemo disabled: drift (...)`, exports not wrapped.
- Callers cannot change the memo (frozen; a write in strict mode throws `TypeError`). All current consumers of the presentation exports only read (the tests check the list).
- Incursion modules load lazily: until the target is seen, the probe appends `; incursionTalesMemo waiting` (no DRIFT) and the memo passes through to the vendor.
- Stats: `stats incursionTalesMemo state=... hits=... fills=... passthrough=... bumps=... fillMaxMs=... parityChecks=...` (`fills` is about the number of table changes, `hits` >> `fills`). Loaded line: `incursionTalesMemo=off|waiting|ready|disabled:<reason>`.
- Disable reasons: `drift`, `order` (foreign wrapper underneath), `error` (own error; that call goes to the vendor), `parity`, `obsolete`. A disabled memo is a clean passthrough; the `mutate` wrapper stays transparent.

| Key | Env | Default |
|---|---|---|
| `incursionTalesMemo` | `HOTPATH_INCURSION_TALES_MEMO` | `false` |
| `incursionTalesMemoParityCheck` | `HOTPATH_INCURSION_TALES_MEMO_PARITY_CHECK` | `false` |

## Bounty read without clones

Flag `bountyPoolRead` (`HOTPATH_BOUNTY_POOL_READ`), **off by default**. Obsolete on EveJS 261115.2. On older builds the client asks for pilot bounties from Local and the overview (`bountyProxy.GetBounties` / `GetBountiesAndKillRights`). For every ID the vendor calls `playerBountyState.getPool(null, id)`: a JSON clone of the whole bounty state (`readState`) and two JSON clones of the whole character record (`inferOwnerKind`, `resolveOwnerAffiliation` -> `getCharacterRecord`). Living New Eden identities are real character records, so in a Local full of its NPCs almost every ID takes the most expensive branch (one call took 1554 ms).

- Scope = one `Handle_GetBounties` / `Handle_GetBountiesAndKillRights` call (prototype wrapper; the handlers are synchronous, the scope does not outlive `return`, an exception clears it).
- In scope, `getPool(null, id)` gets the state read once per handler (vendor `_testing.readState`), and within the `getPool` window `getCharacterRecord(id)` returns the frozen `readSharedCharacterRecord` record (same cache/normalisation path as the vendor, no clone), memoised per ID for the handler. Kill rights, out-of-scope calls, `getPool` with the caller's own state and nested calls go to the original (clone).
- `getCharacterRecord` is wrapped on the FIRST load of `characterState` (`playerBountyState.js` destructures it). `playerBountyState` loaded earlier, or a wrap from the probe sweep = `disabled: late_wrap` (the wrapper stays transparent).
- SHA-1 fingerprint (LF): `readState`, `normalizeState`, `getPool`, `normalizePool`, `resolveOwnerAffiliation`, `inferOwnerKind`, `getCharacterRecord`, `readSharedCharacterRecord`, `buildBountyEntry`, `buildBountyEntries`. Different = `WARN bountyPoolRead disabled: drift (...)`, nothing wrapped.
- Parity (`bountyPoolReadParityCheck`): every pool is also computed by the vendor; a field difference = `disabled: parity` and the vendor result.
- Disable reasons: `drift`, `late_wrap`, `order` (foreign wrapper underneath), `parity`, `error`, `obsolete`.
- Stats (only windows with a handler call): `[hotPathPerf] stats bountyPoolRead state=... handlers=... ids=... idsMax=... stateReads=... charServed=... charMemoHits=... passthrough=... fallback=<reason:n,...|-> parityChecks=...`. Loaded line: `bountyPoolRead=on|disabled:<reason> parity=...`. After enabling, check `charServed > 0`.
- The probe requires 7 points `...#bountyScope`, `...#bountyDeps`, `playerBountyState.getPool#bountyPool`, `characterState.getCharacterRecord#bountyChar` (missing = `DRIFT` and `; bountyPoolRead disabled: drift`).

| Key | Env | Default |
|---|---|---|
| `bountyPoolRead` | `HOTPATH_BOUNTY_POOL_READ` | `false` |
| `bountyPoolReadParityCheck` | `HOTPATH_BOUNTY_POOL_READ_PARITY` | `false` |

## Corporation memo in career sync

Flag `careerStandingCorpMemo` (`HOTPATH_CAREER_STANDING_CORP_MEMO`), **off by default**. Obsolete on EveJS 261115.2. On older builds the career sync (`careerGoalGatewayService.runPendingCareerSyncs` -> `careerProgress.syncCharacter`) evaluates 4 `corporation-standing` thresholds. For every `mission-reward:*:standing` receipt and every change >= the threshold, `careerStandingSources.observe` calls `corporationState.getCorporationRecord`, and the vendor normalises the whole corporation table on every call (`ensureCorporationsInitialized`); in one profile 237 of 937 ms.

- Scope = one `careerStandingSources.observe` call (export wrapper; synchronous read, no write). In scope the first `getCorporationRecord(id)` goes to the vendor with full semantics; a repeat of the same ID gets the same object (also `null`). A vendor exception is not memoised. Out of scope and with extra arguments: vendor.
- SHA-1 fingerprint (LF): the whole `careerStandingSources.js` and the body of `getCorporationRecord`. Different = `WARN careerStandingCorpMemo disabled: drift (...)`, nothing wrapped.
- Parity (`careerStandingCorpMemoParityCheck`): every hit is also computed by the vendor; a difference = `disabled: parity` and the vendor result.
- Stats (only windows with traffic): `[hotPathPerf] stats careerStandingCorpMemo state=... observes=... calls=... vendorCalls=... hits=... parityChecks=...`. After enabling, check the ratio of `calls` to `vendorCalls`. Loaded line: `careerStandingCorpMemo=on|waiting|disabled:<reason> parity=...`.
- Probe: `corporationState.getCorporationRecord#corpMemo` is required; `careerStandingSources.observe#corpMemoScope` is lazy (the module loads on the first sync); before it loads: `; careerStandingCorpMemo waiting`.

| Key | Env | Default |
|---|---|---|
| `careerStandingCorpMemo` | `HOTPATH_CAREER_STANDING_CORP_MEMO` | `false` |
| `careerStandingCorpMemoParityCheck` | `HOTPATH_CAREER_STANDING_CORP_MEMO_PARITY` | `false` |

## Deferred retire of reprocessing receipts

Flag `reprocessingReceiptRetireDefer` (`HOTPATH_REPROCESSING_RECEIPT_RETIRE_DEFER`), **off by default**. After every reprocessing settlement `reprocessingSettlementState.retireOperationReceipts` calls `reprocessingItemCustody.retireReceipts(keys)`. The vendor removes the receipts with an `items` write without `indexDelta`: a full item projection publish, and the observer fan-out rebuilds the whole index (about 130 ms per settlement, inside the client call). The caller only logs the result.

- The wrapper collects the keys (`Set`) and immediately returns `{ success: true, removed: 0, removedReceiptKeys: [], deferred: n }`. After `reprocessingReceiptRetireDelayMs` the original runs once with all collected keys. Reaching `reprocessingReceiptRetireMaxPendingKeys` = flush immediately; gameStore shutdown (`registerShutdownHook`) = flush the rest.
- Flush failure: the keys are dropped without retry, one `WARN reprocessingReceiptRetireDefer flush failed ...` line per stats window. The vendor boot prune (`pruneFinishedOperationReceipts`) removes them, as it does today after a failed retire or a crash. The receipt ledger is larger by at most one window.
- SHA-1 fingerprint (LF): `retireReceipts` (custody) and `retireOperationReceipts` and `pruneFinishedOperationReceipts` (text of `reprocessingSettlementState.js` from disk). Different = `disabled: drift`. A foreign wrapper underneath = `disabled: order`. No parity mode (the same vendor function, just later).
- Stats: `[hotPathPerf] stats reprocessingReceiptRetireDefer state=... deferredCalls=... keys=... flushes=... flushMaxMs=... flushFailures=... pending=...`. Loaded line: `reprocessingReceiptRetireDefer=on|waiting|disabled:<reason> delayMs=... maxPendingKeys=...`.
- Probe: `gameStore#receiptRetireDeps` is required; `reprocessingItemCustody.retireReceipts#defer` is lazy (`; reprocessingReceiptRetireDefer waiting` until the module loads).

| Key | Env | Default |
|---|---|---|
| `reprocessingReceiptRetireDefer` | `HOTPATH_REPROCESSING_RECEIPT_RETIRE_DEFER` | `false` |
| `reprocessingReceiptRetireDelayMs` | `HOTPATH_REPROCESSING_RECEIPT_RETIRE_DELAY_MS` | `30000` (1000..600000) |
| `reprocessingReceiptRetireMaxPendingKeys` | `HOTPATH_REPROCESSING_RECEIPT_RETIRE_MAX_PENDING_KEYS` | `20000` (100..200000) |

## EveJS version notes

### 261108.1

- **Abyssal career read and career combat ledger read: not needed.** Upstream reads only the rows it needs: `careerAbyssalSources.readRuns` -> `gameStore.readPersistedAbyssalInstances` (SQL, abyssal pockets only), `reconcileRun` -> a single `/instancesByID/<id>` entry; `itemStore.listPendingCareerCombatOutcomes` -> `gameStore.readPersistedPendingCareerCombatOutcomes` (SQL by character). With the flag on, the mod sees the new readers in the `sqliteStore`/`gameStore` exports and disables the fix: `WARN careerAbyssalRead disabled: obsolete (...)` / `WARN careerCombatItemsRead disabled: obsolete (...)`, nothing wrapped, no DRIFT. Leave the flags off.
- **Scheduler boundary:** `getUniversePersistentLifecycleBoundary` no longer calls `listInstancesByLifecycle` (scalar projection `dungeonRuntimeState.listUniversePersistentLifecycleEntries`, no clones). The active location index still works for the cache mgr and ice; the boundary measurement is unchanged.
- **Rock depletion coalescing:** the new reader `dungeon/missionMiningSettlement.js` rewrites the scene rocks from the record on every cycle (like AIR), and career locations with `populationHints.retailResourceRevision === 1` set the live rock state from the record at materialisation. Instances with a `spawnState.missionMining` journal or with that flag pass through (`passthrough=...,mission:n`). A patch that creates the mission journal takes that instance's buffer along (record map + buffer in the same write).
- **Drone persist coalescing:** `persistDroneEntityState` now calls `itemStore.updateInventoryItemSuccessOnly`, which internally calls the local `updateInventoryItem` (an export wrapper would not see it). The mod also wraps that export (point `itemStore.updateInventoryItemSuccessOnly#droneCoalesce`); after a real write it takes the base from `findItemById` and writes deferred movement with a full `updateInventoryItem`. That export missing when `droneRuntime` loads = `disabled: order`.
- `DungeonInstanceCacheMgrService.Handle_GetOreAnomaliesCountInRange(_args, session)`: the wrapper passes the arguments unchanged.
- Owner blueprint list: the 17+3 function fingerprint is unchanged on 261108.1.

### 261115.2

Upstream fixed some of the clones the mod patched. With the flag on, the mod recognises the fix in the vendor text and disables that fix (or part of it) as `obsolete`: nothing is wrapped, the probe shows no DRIFT, and the log shows one line `WARN ... disabled: obsolete (EveJS reads it itself: ...)`. These flags can stay off.

- **Owner blueprint list: obsolete.** `getStoredBlueprintState` and `getJobByID` read the live table object (`readTableView`/`readJobsView` in `industryRuntimeState.js`), so the list loop no longer clones tables per blueprint. A full clone remains only for the one-off lazy BPO write without a record.
- **Incursion tale list memo: obsolete.** `incursionLifecycleStore.readShared` keeps one frozen copy per table version (root identity + `getTableWriteGeneration`). `listTales` reads through it, and the policy hash of frozen values is memoised (`incursionFrozenValues.js`).
- **Bounty read: obsolete.** `bountyProxy.buildBountyEntries` calls `playerBountyState.getPools(ids)`, i.e. one `readState` per request. Nobody calls the `getPool` export any more, so the mod's `getCharacterRecord` window has nothing to cover. Two character record clones per ID (`resolveOwnerAffiliation`/`inferOwnerKind`) remain in the vendor.
- **Corporation memo in career sync: obsolete.** `careerStandingSources.standingEvidence` scans the history once per context and memoises the corporation classification per owner.
- **Read-only templates:** `hydrateSummary` (cache mgr `Handle_*` scopes), rotation (`requireTemplate(..., { readOnly: true })`) and the guide scope (`resolveTemplate` -> `getTemplateByIDReadOnly`) are `obsolete`. Each part has its own WARN line (`hydrate`/`rotate`/`guide disabled: obsolete`), and `status()` shows `hydrate`/`rotate`/`guide`. The adapter scope (`enrichSiteWithDungeonRuntime`, fingerprint unchanged) still works.
- **Dungeon instance ref:** `tickSceneSiteBehaviors` delegates to `tickSceneSiteBehaviorsInPass`, and the three anchor lines there read `getInstanceReadOnly`, so the anchors are `obsolete` (`WARN dungeonInstanceRef anchors disabled: obsolete`). The named callers still call `getInstance` (clone) and get the ref. The fingerprints of `tickSceneSiteBehaviors`, `resolveTemplate` and `getInstanceSnapshot` (`cloneInstanceSharingHints`, still a deep copy) are updated for 261115.2.
- **NPC wreck list:** the scoped consumer `listStoredDungeonNativeWreckIDs` calls `listNativeWrecksMatching`, so the scoped mode is `obsolete` (`WARN nativeWreckList scoped disabled: obsolete`). The global mode still works (`voidSystems`, `nativeNpcWreckService`, `sceneDisposal` call `listNativeWrecks`).
- No behaviour change: the vendor `cloneValue`/`clone` is now `common/clone` (result as a JSON round trip). `persistDroneEntityState` also writes `droneState` (cycle deadlines). Without an active deadline it is `null`, so movement still coalesces; with a deadline every persist is a new object and a real vendor write. Deferred receipt retire: the `retireReceipts`/`retireOperationReceipts`/`pruneFinishedOperationReceipts` fingerprints are unchanged.

### 261126.2

- **Drone persist coalescing: obsolete.** `tickDroneMining` no longer persists on every tick. `tickScene` calls `checkpointDroneMotion` for every drone: a non-movement field change writes at once, movement waits 2 s (`DRONE_MOTION_CHECKPOINT_INTERVAL_MS`), and `flushSceneDroneMotion` writes the rest on `disposeScene` and on `stopTicking`. With the flag on the mod reads `droneRuntime.js` on the first drone target, logs `WARN dronePersistCoalesce disabled: obsolete (EveJS checkpoints it itself: droneRuntime.checkpointDroneMotion)`, wraps nothing and the probe shows no DRIFT.
- **Dungeon instance ref:** `processGateDefenseHazards` filters the gate defense hints before its first `getInstance`, so sites without gate defense no longer clone the instance. Sites with gate defense still clone two or three times per pass and only read the copy, so the named caller keeps the ref; its fingerprint is updated.
- No behaviour change: `careerAbyssalSources.reconcileRun` reads through `gameStore.readDurable` (memory rows, falls back to `readPersisted`); the mission mining journal is created by one `settleExtraction` patch for direct and drone deliveries; the shared schema files only map the `incursionLifecycle` table; `taleMgrService` binds `activeTales` on every call; `server/index.js` sets the world role after the startup save check and before any other `require`, so the stall watch waits through the save check and starts on the next module load.

## Probe

60 s after start, in the game process: `probe: passed (N measurement points)` or `DRIFT: <symbol>, ...`. DRIFT disables only the affected point; the others keep measuring. With `dungeonIndex=true` the probe also expects the `...#deps`, `...#index`, `...#scope` symbols; a disabled index appends `; dungeonIndex disabled: <reason>` (its symbols are then not reported as DRIFT). With `sceneRetention=true` the probe expects `SpaceRuntime.collectEmptySolarSystems#retention`, `sessionRegistry#deps`, `config#deps`; any missing = `DRIFT: ...` with those symbols and `; sceneRetention disabled: drift`. With `careerAbyssalRead=true` it requires `gameStore.readPersisted#gate`, `sqliteStore.loadExistingTableObject#serve`, `sqliteStore#deps` (missing = `DRIFT` and `; careerAbyssalRead disabled: drift`). The points `careerAbyssalSources.reconcile#scope` / `.reconcileRun#scope` are lazy: the career module loads on the first character sync, so before that the probe appends `; careerAbyssalRead waiting` (no DRIFT); loaded and not wrapped = DRIFT. With `templateReadOnlyView=true` it requires `dungeonAuthority#deps` and `dungeonAuthority.getTemplateByID#readOnly` (missing = `; templateReadOnly disabled: drift`); `...#templateScope` behaves like the index scope. EveJS helper processes (chatEdge, redshiftEdge, walletAuthority, imageEdge, durableScheduler) log neither the probe nor stats.

## Configuration

`settings.json` or environment variables (env wins), see `.env.example`:

- `enabled` (`HOTPATH_ENABLED`): false = nothing is wrapped,
- `slowCallMs` (`HOTPATH_SLOW_CALL_MS`, default 250),
- `statsLogMinutes` (`HOTPATH_STATS_MINUTES`, default 10, 0 = never),
- measurement point flags, all on by default: `measureSchedulerBoundary` (`HOTPATH_MEASURE_BOUNDARY`), `measureCacheMgrHandlers` (`HOTPATH_MEASURE_CACHE_MGR`), `measureLifecycleLists` (`HOTPATH_MEASURE_LIFECYCLE_LISTS`), `measureCollectEmptySolarSystems` (`HOTPATH_MEASURE_COLLECT_EMPTY`), `measurePrepareUniverseSites` (`HOTPATH_MEASURE_PREPARE_SITES`), `measureEnsureScene` (`HOTPATH_MEASURE_ENSURE_SCENE`), `measureGetMultiLocations` (`HOTPATH_MEASURE_MULTI_LOCATIONS`),
- every fix's keys are listed in its own section above.

Process kill switch: `HOTPATH_NO_INSTALL=1`.

## Tests

```
node mods/hotPathPerf/test/run.js
```

The tests do not load `server/src` (vendor facts are checked against the source text).
