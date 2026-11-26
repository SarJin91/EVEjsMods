# Game Master

Developer note on the AI Game Master of Living New Eden (`lib/gameMaster/`). The Game Master starts at most one short story thread per cycle. A thread is a plan of steps (news fact, EVE mail, site, wait) around one place. The plan comes from an LLM proposal (`gameMaster.aiEnabled`) or from an arc template (`gameMaster.templateFallback`). A thread changes nothing in the world: it tells a story around one place, and a site cleared by pilots is a win.

## AI Game Master: hint sources and steps

### Model and states

One thread per cycle (`cycleHours` 24, boundary at `cycleStartHourUtc` 16 UTC plus `settleDelayMs`). A cycle goes `DRAFTING` to `STARTED` or `SKIPPED`. A thread goes `ACTIVE` to `ENDED` (outcome `WON`, `LOST`, `NEUTRAL` or `EXPIRED`) or to `CANCELLED`. Built-in step kinds: `WAIT`, `NOTICE`, `NEWS`, `SITE`. A thread has at most `maxStepsPerThread` 5 steps, of them at most `maxSiteStepsPerThread` 2 SITE steps, and a thread deadline of `maxThreadMs` 48 h. Arcs: `MUTINY`, `DEFECTOR`, `SMUGGLER_CACHE`, `WAR_RUMOUR` (`arcsCsv`, data in `lib/gameMaster/data/arcs.js`). Tables `world_gm_cycles`, `world_gm_threads`, `world_gm_activity` (wiped at a world reset, retention `retentionMs` 30 days).

The outcome of an ended thread comes from its last SITE step: a cleared site = `WON`, an expired or failed site = `LOST`, no SITE step = `NEUTRAL`. A thread past its deadline ends `EXPIRED`.

### Offer and places

Each cycle the Game Master builds an offer (`lib/gameMaster/digest.js`): allowed arcs (minus the arcs and systems in cooldown, `arcCooldownCycles`, `systemCooldownCycles`), the registered step kinds, the factions, up to `maxPlaces` places, recent news facts, pilot activity per region and the lines of the hint sources. Places are lowsec and nullsec systems with the refs `P1`, `P2`, ... `Pn`. The LLM answer and the template both name a place only by its ref, never by an ID. The validator (`lib/gameMaster/validate.js`) checks the proposal against the offer; a refusal is counted as `rejected.<reason>` (for example `PLACE_UNKNOWN`, `STEP_KIND`, `TOO_LONG`).

### Turning it on

`EVEJS_LNE_GAMEMASTER_ENABLED=1` (plus `EVEJS_LNE_NOTICES_ENABLED=1` for the mail, `EVEJS_LNE_NEWS_ENABLED=1` for the news facts, and the modules `events` and `sites` for the SITE step). With `EVEJS_LNE_GAMEMASTER_AI_ENABLED=1` you also need `EVEJS_LNE_CHATTER_AI_ENABLED=1` and an API key; without them threads come only from the template. An env change needs `docker compose up -d --force-recreate`. Every `gameMaster.*` and `chatterAi.plot*` key has a line in `compose.yaml` (empty = mod default, flags default off with `:-0`).

### LLM cost

About 2,000 input tokens plus `chatterAi.plotMaxTokens` 700 output tokens per attempt, at most `aiAttemptsPerCycle` 2 attempts per cycle, so at most about 5,400 tokens per day. The `plot` lane has the share `chatterAi.plotTokenSharePermille` 100 (10% of `dailyTokenBudget`), one request at a time, timeout `chatterAi.plotTimeoutMs` 90 s, and shares the chatterAi breaker. The database records an attempt before the request, so a restart does not repeat it.

### What the player sees

- News facts `GM_THREAD_STARTED` and `GM_THREAD_ENDED` (and the `NEWS` step) in the galactic news issue (`news.enabled`).
- EVE mail (the hook, the `NOTICE` step, the epilog) only for players online within `noticeRadiusJumps` 3 jumps of the thread place, at most `maxNoticeRecipients` recipients (`notices.enabled`).
- A row of the in-game board in the Nearby section (source `story`, `boardEnabled`).
- The site of a SITE step with the arc label (scanner or anomaly window); cleared = `WON`, expired = `LOST`.
- The observer panel `game-master` (codes and counts, no texts).

### Privacy and logs

The prompt holds no player IDs or names, no `PLAYER_*` or `BOUNTY_*` facts and no corporations. Activity is sampled per region without character IDs. The log and the status hold only codes, never the prompt or the answer. The text fields of the answer go through the chatterAi filter (CHARSET, LINK, DIGITS, COMMAND, BANNED). The owner of a hint source guarantees its content (contract below); the Game Master also drops every hint line with a run of 6 or more digits.

### Turning it off with an open thread

`EVEJS_LNE_GAMEMASTER_ENABLED=0` plus a restart: the drain runs in one transaction at the start of the service (`maxStepsPerPass` threads per start, the rest at the next start), log `gameMaster: drained N thread(s) - CANCELLED`. The SITE site goes away through `cleanupSitesInTx`. The drain knows only the step kinds registered before the start of the `gameMaster` service (rule 3 below).

### Contract for modules: ctx.gmSteps

`lib/runtime/services.js` creates the registry before every service (also with `gameMaster.enabled=false`). Limits (`lib/gameMaster/registry.js`): `MAX_KINDS` 16, `MAX_HINT_SOURCES` 6, `RESERVED` = `NEWS`, `NOTICE`, `SITE`, `WAIT`; `type` matches `/^[A-Z][A-Z0-9_]{2,23}$/`, a source key matches `/^[a-z][A-Za-z0-9_]{1,31}$/`, `promptHint` is ASCII up to 160 chars, `owner` up to 32 chars, `maxPerThread` 1 to 3.

```js
/**
 * @typedef {object} GmStepKind
 * @property {string} type            /^[A-Z][A-Z0-9_]{2,23}$/, unique, not RESERVED
 * @property {string} owner           service name (status), 1..32 chars
 * @property {number} version         >= 1; a new params shape = a new version
 * @property {string} promptHint      ASCII <= 160 ("BOSS: a roaming boss appears at place")
 * @property {number} maxPerThread    1..3
 * @property {{minMs:number, maxMs:number}} duration   0 <= minMs <= maxMs (the validator clamps, TOO_LONG on the sum)
 * @property {(params:object, v:{offer:object, arc:object}) => ({ok:true, params:object}|{ok:false, reason:string})} validate   pure
 * @property {(tx:object, s:GmStepCtx) => ({ok:true, handle:object, dueAt:number}|{ok:false, reason:string, retry:boolean})} startInTx
 * @property {(tx:object, s:GmStepCtx) => ({state:"RUNNING", dueAt:number}|{state:"DONE", outcome:"WON"|"LOST"|"NEUTRAL"})} pollInTx
 * @property {(tx:object, s:GmStepCtx, reason:"DISABLED"|"DEADLINE"|"CANCELLED") => {ok:boolean}} cancelInTx
 * GmStepCtx = {threadId, stepNo, stepKey:`gm:<threadId>:<stepNo>`, params, handle, factionId, systemId, now, seed}
 */
ctx.gmSteps.register(kind)            // {ok:true, unregister()} | {ok:false, reason:"BAD_KIND"|"RESERVED"|"DUPLICATE"|"FULL"}
ctx.gmSteps.get(type)                 // GmStepKind | null
ctx.gmSteps.list()                    // frozen [{type, owner, version, promptHint, maxPerThread}] sorted by type
ctx.gmSteps.registerHintSource(src)   // {ok:true, unregister()} | {ok:false, reason:"BAD_SOURCE"|"DUPLICATE"|"FULL"}
ctx.gmSteps.listHintSources()         // frozen [{key, read}] sorted by key

/**
 * @typedef {object} GmHintSource
 * @property {string} key    /^[a-z][A-Za-z0-9_]{1,31}$/ (e.g. "seasons", "devIndices")
 * @property {() => ({lines:string[], arcBias?:string[]} | null)} read
 *   GUARANTEE OF THE SOURCE - the Game Master cannot check it:
 *   - lines are built only from names of systems, constellations, regions and factions (graph / readFactionNames)
 *     and from the module's own small numbers (stage, level, days); NEVER a character, corporation or alliance name,
 *     a chat text, or any ID (characterID, itemID, typeID, systemID);
 *   - <= 3 lines, each printable ASCII <= 160 (longer / non-ASCII / non-string lines are dropped, not cut);
 *   - synchronous, RAM only: no transaction, no SQL, no adapter call, no network; never throws (a throw = the source
 *     is skipped for that prompt);
 *   - arcBias: arc keys only (unknown keys dropped).
 *   Defense in depth: readHints drops any line with a run of >= 6 digits.
 */
```

Example of a hint source registration (pattern: `lib/seasons/index.js`):

```js
// in start(): ctx.gmSteps exists before every service (services.js), also with gameMaster.enabled=false
const reg = ctx.gmSteps && typeof ctx.gmSteps.registerHintSource === "function"
  ? ctx.gmSteps.registerHintSource({ key: "myModule", read: () => hintOf(stateInRam, names) })
  : { ok: false, reason: "NO_REGISTRY" };
if (!reg.ok) telemetry.count("myModule.hintRefused");   // FULL / DUPLICATE: the module keeps working
// in stop():
if (reg.ok) reg.unregister();
```

Rules for a step kind:
1. Register in `start`, unregister in `stop`. The Game Master reads the registry at every pass. A kind that is missing when its step starts gives `SKIPPED(KIND_GONE)`, and the thread goes on.
2. `startInTx`, `pollInTx` and `cancelInTx` run in the savepoint of the thread. A throw = the step is `FAILED(THROW)`. The functions do not open their own transaction, and `await` is not allowed.
3. Drain: with `gameMaster.enabled=false` the drain runs in `start` of the `gameMaster` service and calls `cancelInTx` only for the kinds registered **before** that start (the built-in kinds and those of services earlier in `services.js`). Later services (`seasons` and others) are not registered yet: their thread gets `CANCELLED` without `cancelInTx`. The owner of a kind cleans up its own handles by the `gm:` prefix of `stepKey` (for example with its own TTL or an `expiresAt` in the handle). SITE does this: the site ends by itself after `expiresAt`.
4. Version 1: arcs are data in `lib/gameMaster/data/arcs.js`. An external kind reaches the prompt (`promptHint`), but no arc allows it (`arc.stepKinds`), so a proposal that uses it gets `rejected.STEP_KIND`. Using it needs a change of the arc catalog.
5. Bump `version` when the shape of `params` changes: the plan is frozen in `plan_json`, and a step whose kind version differs from the frozen one is skipped as `KIND_GONE`.

Consumers today: `seasons` (source `seasons`, flag `seasons.hintEnabled`), `devIndices` (source `devIndices`, flag `devIndices.gmHintEnabled`), `worldBosses` (step kind `BOSS` and source `worldBosses`, flag `worldBosses.gm.enabled`; no arc allows `BOSS` yet, see rule 4). Every new hint consumer needs a "no player names" test (pattern: GMC3 in `test/gameMaster/closure.test.js`).

### Flags and warnings

`gameMaster.enabled` (default `false`), `aiEnabled` (default `false`), `templateFallback` (default `true`), `boardEnabled` (default `true`). Config warnings:
- Without `modules.events` and `modules.sites`: only the arc `WAR_RUMOUR` (no SITE step).
- `aiEnabled` without `chatterAi.enabled`, with `plotTokenSharePermille=0`, or with `promptMaxChars` above `chatterAi.plotMaxPromptChars`: every thread comes from the template.
- `aiEnabled=false` and `templateFallback=false`: no thread is ever started.
- Without `notices.enabled`: no mail of a thread.
- Without `news.enabled`: no news facts of a thread.
- `maxSiteStepsPerThread x siteMaxHours + waitMaxHours x min(2, the other steps)` above `maxThreadMs`: the validator refuses such proposals with `TOO_LONG` (informative; NOTICE and NEWS take 0 ms). With the defaults 2 x 12 + 2 x 12 = 48 h, no warning.
- `draftWindowMs + settleDelayMs` not below the cycle: the draft ends after the next boundary.
- `retentionMs` shorter than `maxThreadMs` or the cooldown windows.

### Diagnostics

`/api/views/game-master` (cycles, threads, steps, reasons), `/api/views/status` (service `gameMaster`, counters `gameMaster.*`), channel `gameMaster` in `telemetry/latest.json`.

### liveSim (a fast template thread)

`node tools/liveSim.js --seed 7 --speed 60 --set gameMaster.enabled=true --set gameMaster.cycleHours=1 --set gameMaster.settleDelayMs=0 --set gameMaster.draftWindowMs=600000 --set gameMaster.arcsCsv=WAR_RUMOUR --set gameMaster.waitMaxHours=1 --set gameMaster.passIntervalMs=5000`. liveSim always forces `gameMaster.aiEnabled=false` (no network; the line `liveSim: forced gameMaster.aiEnabled=false (...)` appears only when the profile had `aiEnabled=true`). The warnings about notices and news (forced off or turned off) and about `events` / `sites` are informative. After about 2 wall-clock minutes `/api/views/game-master` shows a thread `ENDED/NEUTRAL` (NEWS, then NOTICE with 0 recipients, then WAIT 1 h), and the channel `gameMaster` in `telemetry/latest.json` shows `cycles >= 1`, `threads.started.template >= 1`, `threads.ended.NEUTRAL >= 1`. Further cycles before the thread ends get `skipped.OPEN_LIMIT` (`maxOpenThreads` 1). The Game Master poller runs on wall-clock time, hence `passIntervalMs=5000`.

### Manual checks

- P1 (server): `ENABLED=1`, `AI_ENABLED=0`, `NOTICES_ENABLED=1`: after the cycle boundary (16:10 UTC) a template thread shows in `/api/views/game-master`, and a pilot within 3 jumps gets the EVE mail with the hook.
- P2 (server, one week): `AI_ENABLED=1` plus chatterAi with a key: after 7 cycles compare `ai.accepted` with `rejected.*` and `textFallback.*` in the status; judge the texts in the game; `docker logs` holds no prompt and no answer (`grep -i "prompt\|\"title\""` = 0).
- P3 (client): the thread site (SITE) is visible in the scanner or the anomaly window; clearing it gives `WON` and the epilog (mail and news).
- P4 (client): the row on the Nearby board (source `story`); Polish letters in the title with `chatterAi.language=pl`.
- P5 (server): `ENABLED=0` with an open thread plus a restart: log `drained 1 thread(s) - CANCELLED`, the SITE site goes away.
