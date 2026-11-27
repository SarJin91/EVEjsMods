"use strict";

const HOOK_TIMEOUT_MS = 10000;

function createShutdownHooks({ timeoutMs = HOOK_TIMEOUT_MS, setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout } = {}) {
  const hooks = new Map();
  let running = null;

  function registerShutdownHook(name, handler) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName || typeof handler !== "function") {
      throw new TypeError("shutdown hooks require a name and function");
    }
    if (hooks.has(normalizedName)) throw new Error(`shutdown hook already registered: ${normalizedName}`);
    hooks.set(normalizedName, handler);
    return () => hooks.delete(normalizedName);
  }

  async function runAll(signal) {
    const results = [];
    let success = true;
    for (const [name, handler] of hooks.entries()) {
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => handler(signal)),
          new Promise((_, reject) => {
            timer = setTimeoutFn(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        results.push({ name, success: true, error: null });
      } catch (err) {
        success = false;
        results.push({ name, success: false, error: String((err && err.message) || err) });
      } finally {
        if (timer !== null) clearTimeoutFn(timer);
      }
    }
    return { success, results };
  }

  function run(signal) {
    if (running === null) running = runAll(String(signal));
    return running;
  }

  return Object.freeze({ gameStoreLike: Object.freeze({ registerShutdownHook }), run, size: () => hooks.size });
}

module.exports = { createShutdownHooks, HOOK_TIMEOUT_MS };
