# Mission Structure Restore (EveJS loader mod)

After a server restart, a mission whose objective is a destructible structure
of a wave that had already spawned gets that structure back the next time the
site is materialized (warp to the mission, acceleration gate, session attach).
Destroying it then completes the objective as usual. Example: "Avenge A Fallen
Comrade - Caldari lvl 1" (`client-dungeon:283`), Habitation Module
`structure_015` in the second pocket.

## Why vanilla loses the structure

- Wave structures (`entityKind: killableStructure`) live only in the scene:
  `spawnEncounterKillableStructures` adds them with `scene.addStaticEntity`
  (`server/src/services/dungeon/dungeonUniverseSiteService.js`).
- After a restart, `rematerializeStoredDungeonEncounterEntities` brings back
  NPCs and wrecks only; `rehydrateMissingEncounterStates` skips a completed
  wave and a wave with a living NPC; `spawnEncounterPlan` returns early for a
  wave with `spawnedAtMs > 0`.
- So the objective target never comes back and a mission with
  `completion.mode = objective_targets_destroyed` cannot be completed.

## What it does

Wraps the static `DungeonUniverseSiteService.ensureSiteContentsMaterialized`
(post-hook, the vanilla result object is returned unchanged). After a
successful call for a mission instance (`siteFamily` or `siteKind` "mission",
or `metadata.missionRuntime`) whose objective is not yet satisfied:

1. For every wave that already spawned, the killable structure entries that
   are mission objective targets are checked against the scene (an ID of the
   wave state with the same content key and instance).
2. A missing one is spawned through the vendor port
   (`homefrontPorts.structure`) at the wave's room anchor plus the entry's
   `positionOffset`, with the vendor progress flags
   (`dungeonObjectiveProgressTarget`, `dungeonObjectiveTargetKey`,
   `dungeonEncounterBlocksProgress`).
3. Its new ID is appended to the wave state (`spawnedEntityIDs`,
   `objectiveBlockingEntityIDs`, `nonBlockingEntityIDs` or
   `remainingEntityIDs`, `spawnedIdentitiesByEntityID`), so the vendor kill
   path counts its destruction. `spawnedAtMs` / `completedAtMs` are never
   changed. If that write fails, the structure is removed again.

One log line per restored structure:

```text
[missionStructureRestore] restored instance=80521 template=client-dungeon:283 plan=wave_01 entry=structure_015 entity=<id> room=room:13850
```

A second warp in the same server run finds the structure present and does
nothing. No own storage: "already destroyed" comes from the vendor's durable
markers (`objectiveSatisfiedAtMs`, `metadata.objectiveTargetsDestroyed`).

No game code is required at preload. A `Module._load` hook wraps the export
when `dungeonUniverseSiteService.js` loads. A text probe of the vendor files
runs first; if a seam changed (DRIFT) or an export is missing at load, the mod
logs `DRIFT ...` and stays inert: vanilla EveJS.

## What it does not do

- Structures that are not a mission objective, and non-mission sites.
- Hit points: a restored structure has full HP.
- A wave whose room has no position in the template (`NO_ROOM_ANCHOR`), other
  than the entry room.
- Internal vendor paths that do not go through the export
  (`spawnTemplateForSession`, `handleSceneCreated`).
- A session that enters the pocket without a warp, gate or auto attach does
  not trigger materialization; the structure comes back on the next warp.

## Settings

Environment variables (a real variable wins over
`mods/missionStructureRestore/.env`; see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `EVEJS_MISSION_STRUCTURE_RESTORE` | `1` | whole mod on/off |
| `EVEJS_MISSION_STRUCTURE_RESTORE_LOG` | `1` | one line per restored structure |
| `EVEJS_MISSION_STRUCTURE_RESTORE_NO_INSTALL` | empty | any value: the preload installs nothing |

Counters: `globalThis[Symbol.for("evejs.missionStructureRestore")].stats()`.

## Install

Docker: `docker/entrypoint.sh` preloads
`--require /app/mods/missionStructureRestore/loader.js` in both server blocks.
Native launcher: activate as a loader mod (`loader_rename`).


## After an EveJS update

If upstream starts restoring these structures itself, check the changelog:
a vendor restore that does not record the new ID in the wave state would give
a duplicate. Turn the mod off (`EVEJS_MISSION_STRUCTURE_RESTORE=0`) once the
vendor fix is in.
