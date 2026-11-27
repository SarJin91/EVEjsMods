"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const H3 = Object.freeze({
  EVEJS_LNE_VIRTUALCORPS_ENABLED: "1",
  EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_GANK_ENABLED: "1",
  EVEJS_LNE_NOTICES_ENABLED: "1",
});

const CIVILIANS = Object.freeze({
  EVEJS_LNE_VIRTUALCORPS_ENABLED: "1",
  EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1",
});

const W = Object.freeze({
  W1: "highsecLife.enabled and highsecLife.civilians.enabled must both be on",
  W2: "highsecLife.civilians.enabled without localPilots.enabled or modules.virtualCorps",
  W3chatter: "highsecLife.chatter.enabled without the civilians",
  W3traffic: "highsecLife.traffic.enabled without the civilians",
  W3gank: "highsecLife.gank.enabled without the civilians",
  W4: "highsecLife.gank.enabled without wrecks.enabled",
  W5: "highsecLife.gank.enabled without highsecLife.chatter.enabled",
  W6: "highsecLife.chatter.enabled without notices.enabled",
});

function resolve(env) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
  return r;
}

const chainLines = (warnings) => warnings.filter((w) => Object.values(W).some((s) => w.startsWith(s)));

module.exports = ({ test }) => {
  test("HE1 highsec life enable: the H3 config has no error and no highsecLife warning", () => {
    const r = resolve({ ...H3 });
    const c = r.config;
    assert.deepStrictEqual([config.isModuleEnabled(c, "virtualCorps"), config.isModuleEnabled(c, "world"),
      c.wrecks.enabled, c.localPilots.enabled, c.highsecLife.gank.enabled], [true, true, true, true, true]);
    const lines = r.warnings.filter((w) => w.includes("highsecLife"));
    assert.deepStrictEqual(lines, [], lines.join("; "));
  });

  test("HE2 highsec life enable: W1-W6 one line per case, the defaults give none", () => {
    const CASES = [
      ["W1 enabled without civilians", { EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1", EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1" },
        [W.W1]],
      ["W2 civilians without local pilots", { EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1",
        EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1" }, [W.W2]],
      ["W2 civilians without virtualCorps", { ...CIVILIANS, EVEJS_LNE_VIRTUALCORPS_ENABLED: "0" }, [W.W2]],
      ["W3 chatter without the civilians", { EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1",
        EVEJS_LNE_NOTICES_ENABLED: "1" }, [W.W3chatter]],
      ["W3 traffic and gank without the civilians", { EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ENABLED: "1",
        EVEJS_LNE_HIGHSEC_LIFE_GANK_ENABLED: "1", EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1",
        EVEJS_LNE_NOTICES_ENABLED: "1" }, [W.W3chatter, W.W3traffic, W.W3gank]],
      ["W4 gank without wrecks", { ...CIVILIANS, EVEJS_LNE_HIGHSEC_LIFE_GANK_ENABLED: "1",
        EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1", EVEJS_LNE_WRECKS_ENABLED: "0" },
      [W.W4]],
      ["W5 gank without chatter", { ...CIVILIANS, EVEJS_LNE_HIGHSEC_LIFE_GANK_ENABLED: "1" }, [W.W5]],
      ["W6 chatter without notices", { ...CIVILIANS, EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1" }, [W.W6]],
      ["defaults", {}, []],
    ];
    for (const [name, env, want] of CASES) {
      const got = chainLines(resolve(env).warnings);
      const starts = got.map((w) => Object.values(W).find((s) => w.startsWith(s)));
      assert.deepStrictEqual(starts.slice().sort(), want.slice().sort(), `${name}: ${got.join("; ")}`);
    }
  });
};
