"use strict";

const CUSTOM_TYPE_ID_MIN = 340000;
const CUSTOM_TYPE_ID_MAX = 349999;
const BLUEPRINT_CATEGORY_ID = 9;

function isDropPoolBlueprint(itemType) {
  if (itemType === null || typeof itemType !== "object") return false;
  if (itemType.categoryID !== BLUEPRINT_CATEGORY_ID || itemType.published === false) return false;
  const typeID = Number(itemType.typeID);
  return !(typeID >= CUSTOM_TYPE_ID_MIN && typeID <= CUSTOM_TYPE_ID_MAX);
}

module.exports = { CUSTOM_TYPE_ID_MIN, CUSTOM_TYPE_ID_MAX, isDropPoolBlueprint };
