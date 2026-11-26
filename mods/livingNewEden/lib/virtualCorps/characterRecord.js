"use strict";

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

function filetimeOfMs(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new TypeError(`filetimeOfMs: expected a safe integer >= 0, got ${ms}`);
  }
  return (BigInt(ms) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET).toString();
}

function buildEmploymentHistory(corporationId, startTime) {
  return [
    {
      corporationID: corporationId,
      startDate: startTime,
      recordID: 0,
    },
  ];
}

function buildStandingData() {
  return {
    npcStandings: [],
    agentStandings: [],
    factionStandings: [],
  };
}

function buildVirtualCharacterRecord({
  identityKey,
  name,
  gender,
  bloodlineId,
  raceId,
  typeId,
  corporationId,
  stationId,
  systemId,
  constellationId,
  regionId,
  securityRating,
  nowMs,
}) {
  const ft = filetimeOfMs(nowMs);
  return {
    characterName: name,
    bloodlineID: bloodlineId,
    raceID: raceId,
    typeID: typeId,
    ancestryID: 0,
    gender,
    corporationID: corporationId,
    allianceID: 0,
    factionID: null,
    securityStatus: securityRating || 0.0,
    accountId: 0,
    skillPoints: 0,
    employmentHistory: buildEmploymentHistory(corporationId, ft),
    standingData: buildStandingData(),
    stationID: stationId || 0,
    solarSystemID: systemId || 0,
    constellationID: constellationId || 0,
    regionID: regionId || 0,
    shipID: 0,
    shipTypeID: 0,
    balance: 0,
    walletJournal: [],
    plexVaultTransactions: [],
    tutorialStep: 0,
    description: "Living New Eden virtual capsuleer.",
    lneIdentityKey: identityKey,
    lneVersion: 1,
    createDateTime: ft,
    startDateTime: ft,
    logoffDate: ft,
    creationDate: nowMs,
    lastLoginDate: nowMs,
    cloneName: "",
    cloneSkillPoints: 0,
    implants: [],
    jumpActivation: 0,
    jumpFatigue: 0,
    remoteStationID: 0,
    corporationRole: 0,
    corporationTitle: 0,
    intelligence: 0,
    memory: 0,
    charisma: 0,
    perception: 0,
    willpower: 0,
    skillQueue: [],
  };
}

function pickGender(characterId) {
  return (characterId & 1) ? "Male" : "Female";
}

module.exports = {
  buildVirtualCharacterRecord,
  buildCharacterRecord: buildVirtualCharacterRecord,
  buildEmploymentHistory,
  buildStandingData,
  filetimeOfMs,
  pickGender,
};