"use strict";

const S = require("./schema");
const defaultRepo = require("./repository");
const { THEMES } = require("./data/themes");

const MAX_DIFFICULTY = 5;
const NONE = Object.freeze({ ok: true, containers: Object.freeze([]) });
const RETRY = Object.freeze({ ok: false, retry: true });

function archiveSpecOf(chain, P) {
  const theme = THEMES[chain.theme];
  if (!theme) return null;
  const final = chain.stageNo >= chain.stageCount;
  return {
    key: S.ARCHIVE_KEY,
    analyzer: theme.analyzer,
    label: final ? theme.archiveLabel.final : theme.archiveLabel.stage,
    hackingDifficulty: Math.min(MAX_DIFFICULTY, P.archiveDifficultyStart + (chain.stageNo - 1) * P.archiveDifficultyStep),
    offsetMeters: P.archiveOffsetMeters,
    explicitLoot: final && Array.isArray(chain.reward) ? chain.reward.map((e) => ({ typeId: e.typeId,
      quantity: e.quantity, ...(e.runs ? { runs: e.runs } : {}) })) : [],
  };
}

function createArchiveContentProvider(deps) {
  const { store, settings: P } = deps;
  const repo = deps.repository || defaultRepo;

  function build(eventId, _slot) {
    const id = S.parseStageEventId(eventId);
    if (!id) return NONE;
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) return RETRY;
    const r = store.transaction("archaeology.content", (tx) => repo.getByIdInTx(tx, id.chainId));
    if (!r || r.ok !== true) return RETRY;
    const chain = r.value;
    if (!chain || chain.state !== S.CHAIN_STATE.ACTIVE || chain.stageNo !== id.stageNo
      || chain.stageSpawnNo !== id.spawnNo) return NONE;
    const spec = archiveSpecOf(chain, P);
    return spec ? { ok: true, containers: [spec] } : NONE;
  }

  return Object.freeze({ prefix: S.CHAIN_ID_PREFIX, build });
}

module.exports = { createArchiveContentProvider, archiveSpecOf };
