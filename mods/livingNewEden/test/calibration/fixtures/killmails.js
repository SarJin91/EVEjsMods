"use strict";

const X = 99000001;
const Y = 99000002;
const THIRD = 98000003;
const CORP_X = 98000001;
const CORP_Y = 98000002;
const SYS_HIGH = 30000001;
const SYS_NULL = 30000002;
const T0 = Date.parse("2026-10-10T12:00:00Z");

const pilot = (id, ship, extra = {}) => {
  const ally = id >= 21 ? null : id >= 11 ? Y : X;
  const corp = id >= 21 ? THIRD : id >= 11 ? CORP_Y : CORP_X;
  return { character_id: id, corporation_id: corp, ...(ally ? { alliance_id: ally } : {}), ship_type_id: ship, ...extra };
};
const atk = (id, ship, fb = false) => pilot(id, ship, { damage_done: 100, final_blow: fb, security_status: 0 });
const km = (id, sec, system, victim, attackers) => ({ killmail_id: id, killmail_time: new Date(T0 + sec * 1000)
  .toISOString().replace(".000Z", "Z"), solar_system_id: system, victim: { ...victim, damage_taken: 500, items: [] },
attackers });

function records() {
  return [
    km(101, 0, SYS_HIGH, pilot(11, 587), [atk(1, 620, true), atk(2, 587)]),
    km(102, 60, SYS_HIGH, pilot(1, 620), [atk(12, 620, true), atk(13, 587), atk(17, 587)]),
    km(103, 120, SYS_HIGH, pilot(12, 620), [atk(2, 587, true), atk(3, 620)]),
    km(104, 150, SYS_HIGH, pilot(17, 587), [atk(21, 587, true)]),
    km(105, 180, SYS_HIGH, pilot(11, 670), [atk(2, 587, true)]),
    km(106, 200, SYS_HIGH, { corporation_id: 1000125, ship_type_id: 587 }, [atk(3, 620, true)]),
    km(107, 240, SYS_HIGH, pilot(13, 35832), [atk(4, 587, true)]),
    km(108, 300, SYS_HIGH, pilot(13, 99999), [atk(4, 587, true), atk(5, 23055)]),
    km(109, 330, SYS_HIGH, pilot(14, 587), [{ corporation_id: 1000125, damage_done: 300, final_blow: true,
      security_status: 0, ship_type_id: 587 }]),
    { killmail_id: 110, zkb: { npc: true }, esi: km(110, 360, SYS_HIGH, pilot(14, 587), [atk(4, 587, true)]) },
    km(111, 2000, SYS_HIGH, pilot(14, 587), [atk(3, 620, true)]),
    km(201, 5000, SYS_NULL, pilot(15, 620), [atk(6, 620, true), atk(1, 587)]),
    km(202, 5030, SYS_NULL, pilot(6, 620), [atk(16, 620, true), atk(14, 587)]),
    km(203, 5090, SYS_NULL, pilot(16, 620), [atk(1, 587, true), atk(2, 587)]),
  ];
}

const TYPE_GROUP = [[587, 25], [620, 26], [670, 29], [35832, 1657], [23055, 1652]];
const GROUP_CATEGORY = [[25, 6], [26, 6], [29, 6], [1657, 65], [1652, 87]];
const SYSTEM_SEC = [[SYS_HIGH, 0.9], [SYS_NULL, -0.2]];

module.exports = { records, TYPE_GROUP, GROUP_CATEGORY, SYSTEM_SEC, SYS_HIGH, SYS_NULL };
