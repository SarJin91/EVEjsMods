"use strict";

const FAX_CLASS = "force_auxiliary";

const REPAIR_FAMILY_BY_TYPE = Object.freeze({
  37604: "remoteArmor",
  37607: "remoteArmor",
  42242: "remoteArmor",
  37605: "remoteShield",
  37606: "remoteShield",
  45645: "remoteShield",
});

const DEFAULT_FAMILY = "remoteArmor";

const FX_GUID_BY_FAMILY = Object.freeze({
  remoteArmor: "effects.RemoteArmourRepair",
  remoteShield: "effects.ShieldTransfer",
});

module.exports = { FAX_CLASS, REPAIR_FAMILY_BY_TYPE, DEFAULT_FAMILY, FX_GUID_BY_FAMILY };
