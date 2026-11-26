# Industry Orphan Cleanup (EveJS loader mod)

EveJS 0.12.9 `characterDeletionRuntime.deleteCharacter` destroys the items of a
deleted character (NPC corporation member) but leaves the
`industryBlueprintState` records of its destroyed blueprints. Every server start
then tries to settle their finished jobs and logs
`INDUSTRY_BLUEPRINT_SETTLEMENT_POSTCONDITION_FAILED`.

This mod wraps `deleteCharacter` and, after a **successful** deletion, removes
those records with the vendor `industryRuntimeState.removeBlueprintState`.

## What is removed

A blueprint state record of a blueprint the deleted character used in a job is
removed only when all of these hold (same filter as
`tools/industryOrphanBlueprintState/fixOrphanBlueprintState.js`):

- the blueprint item no longer exists,
- the record links a job the start-up recovery would replay,
- the record has no active job,
- every job on that blueprint is DELIVERED or CANCELLED (none pending),
- every linked job belongs to the deleted character.

Anything else is skipped and logged with a reason (`STATE_HAS_ACTIVE_JOB`,
`JOB_NOT_TERMINAL`, `OWNER_NOT_DELETED_CHARACTER`). Jobs stay as history.
A member of a player corporation keeps the items (they move to the corp), so
nothing is removed for them.

Orphans that already exist are not touched at start; use the repair script.

## Safety

- The preload never requires game code; a `Module._load` hook wraps the export
  on the first load (charService destructures it).
- A text probe of the v0.12.9 files runs first; any mismatch (DRIFT) leaves the
  mod inert (vanilla).
- A failing deletion propagates unchanged and nothing is cleaned up; the
  vendor result is returned as the same object; a cleanup error is logged and
  never reaches the server.
- The removal is debounced by gameStore (2 s); a crash in that window leaves an
  orphan the repair script removes.

## Configuration

See `.env.example`: `EVEJS_INDUSTRY_ORPHAN_CLEANUP` (default 1),
`EVEJS_INDUSTRY_ORPHAN_CLEANUP_LOG` (default 1). Kill switch:
`EVEJS_INDUSTRY_ORPHAN_CLEANUP_NO_INSTALL=1`.

Counters: `globalThis[Symbol.for("evejs.industryOrphanCleanup")].stats()`.

## Install (Docker)

`docker/entrypoint.sh` has `--require /app/mods/industryOrphanCleanup/loader.js`
in both server blocks.
