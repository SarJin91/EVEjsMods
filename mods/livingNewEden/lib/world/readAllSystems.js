"use strict";

function readAllSystems(store, repository, opts) {
  return store.transaction(opts.label, (tx) => {
    const systems = [];
    let after = 0;
    for (;;) {
      const page = repository.listSystems(tx, { afterSystemId: after, limit: opts.maxListLimit,
        includeInfluence: opts.includeInfluence !== false });
      if (!page.ok) return page;
      systems.push(...page.systems);
      if (page.nextAfterSystemId === null) return { ok: true, systems };
      after = page.nextAfterSystemId;
    }
  });
}

module.exports = { readAllSystems };
