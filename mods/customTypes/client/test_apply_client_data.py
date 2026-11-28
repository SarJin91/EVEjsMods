"""Tests of the client tool (nothing written outside a temp dir).

The client tests read EVEJS_CLIENT_PATH (default H:\\EVE Online - 3396210) and are skipped without it.
    tools\\.elysian-suite\\venv\\Scripts\\python.exe -B mods\\customTypes\\client\\test_apply_client_data.py
"""

from __future__ import annotations

import ast
import contextlib
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_client_data as tool
from fsd import profile as fsd_profile
from fsd.cfsd import _split, clone_integer_record, clone_record_in_body, contains_root_key
from fsd.items import _patch_dogma, append_type_dogma_attributes
from PIL import Image

CLIENT_TOOL_DIR = Path(__file__).resolve().parent
REAL_CLIENT = Path(os.environ.get("EVEJS_CLIENT_PATH") or r"H:\EVE Online - 3396210")

VEXOR_MINERALS = [
    {"typeID": 34, "quantity": 540000}, {"typeID": 35, "quantity": 180000}, {"typeID": 36, "quantity": 36000},
    {"typeID": 37, "quantity": 10000}, {"typeID": 38, "quantity": 1500}, {"typeID": 39, "quantity": 350},
    {"typeID": 40, "quantity": 140},
]


def write_pack(directory: Path, name: str, pack: dict) -> Path:
    path = directory / name
    path.write_text(json.dumps(pack), "utf-8")
    return path


class MultiPack(unittest.TestCase):
    def test_default_is_every_shipped_pack_in_server_order(self) -> None:
        paths = tool.default_pack_paths()
        self.assertEqual([path.name for path in paths],
                         ["archaeology-relics.json", "heavy-sentries.json", "listening-post.json", "mobile-sentries.json",
                          "officer-blueprints.json", "pi-blueprints.json", "planetary-drill.json", "season-trophies.json",
                          "trig-bridge.json"])
        packs = tool.load_packs(paths)
        self.assertEqual(packs["packIDs"], ["archaeology-relics", "heavy-sentries", "listening-post", "mobile-sentries",
                                            "officer-blueprints", "pi-blueprints", "planetary-drill", "season-trophies",
                                            "trig-bridge"])
        all_type_ids = [entry["typeID"] for _, entry in packs["types"]]
        self.assertEqual(all_type_ids[:6], list(range(341600, 341606)))
        all_type_ids = all_type_ids[6:]
        self.assertEqual(all_type_ids[:10], list(range(340522, 340530)) + [340520, 340521])
        type_ids = all_type_ids[10:]
        sentries = [340500, 340501, 340502, 340503]
        sentry_blueprints = [340510, 340511, 340512, 340513]
        officer_blueprints = list(range(341000, 341593))
        variants = list(range(340102, 340117))
        variant_blueprints = [type_id + 100 for type_id in variants]
        trophies = [341620, 341621, 341622, 341623]
        self.assertEqual(len(type_ids), 108 + 593 + 4 + 2)
        self.assertEqual(type_ids[:8], sentries + sentry_blueprints)
        self.assertEqual(type_ids[8:601], officer_blueprints)
        self.assertEqual((type_ids[601], type_ids[668:]),
                         (340365, [340435, 340100, 340101] + variants + variant_blueprints + trophies
                          + [341640, 341641]))
        self.assertIn(340431, type_ids)
        blueprint_ids = [entry["blueprintTypeID"] for entry in packs["blueprints"]]
        self.assertEqual(blueprint_ids[:2], [341601, 341603])
        blueprint_ids = blueprint_ids[2:]
        self.assertEqual(blueprint_ids[:5], [340526, 340527, 340528, 340529, 340521])
        blueprint_ids = blueprint_ids[5:]
        self.assertEqual(len(blueprint_ids), 88 + 593 + 1)
        self.assertEqual(blueprint_ids,
                         sentry_blueprints + officer_blueprints + type_ids[601:669] + [340101] + variant_blueprints + [341641])
        self.assertTrue(all(entry["overrides"].get("iconID") for _, entry in packs["types"]))

    def test_drill_blueprint_client_row(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())
        drill = next(entry for entry in packs["blueprints"] if entry["blueprintTypeID"] == 340101)
        template = {"activities": {"invention": {"time": 1}}, "blueprintTypeID": 971, "maxProductionLimit": 10}
        row = tool.client_blueprint_row(template, drill)
        self.assertEqual(sorted(row["activities"]), ["copying", "manufacturing", "research_material", "research_time"])
        manufacturing = row["activities"]["manufacturing"]
        self.assertEqual(list(manufacturing), ["skills", "materials", "products", "time"])
        self.assertEqual(manufacturing["materials"], VEXOR_MINERALS)
        self.assertEqual(manufacturing["time"], 12000)
        self.assertEqual(row["activities"]["copying"], {"time": 9600})
        self.assertEqual((row["blueprintTypeID"], row["maxProductionLimit"]), (340101, 10))
        self.assertEqual(tool.product_type_ids(row), [340100])
        variant = next(entry for entry in packs["blueprints"] if entry["blueprintTypeID"] == 340204)
        variant_row = tool.client_blueprint_row(template, variant)
        self.assertEqual(variant_row["activities"]["manufacturing"]["materials"], VEXOR_MINERALS)
        self.assertEqual(tool.product_type_ids(variant_row), [340104])

    def test_mobile_sentry_laser_blueprint_plain_minerals(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())
        sentry = next(entry for entry in packs["blueprints"] if entry["blueprintTypeID"] == 340512)
        template = {"activities": {"invention": {"time": 1}}, "blueprintTypeID": 2826, "maxProductionLimit": 30}
        row = tool.client_blueprint_row(template, sentry)
        manufacturing = row["activities"]["manufacturing"]
        self.assertEqual(list(manufacturing), ["skills", "materials", "products", "time"])
        self.assertEqual(manufacturing["materials"], [{"quantity": 7200, "typeID": 34},
                                                      {"quantity": 3309, "typeID": 35},
                                                      {"quantity": 621, "typeID": 36}])
        self.assertEqual(manufacturing["time"], 6000)
        self.assertEqual(tool.product_type_ids(row), [340502])

    def test_type_or_product_in_two_packs_refuses_the_set(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            base = {"packID": "a", "types": [{"typeID": 340900, "sourceTypeID": 971, "overrides": {"iconID": 1}}]}
            first = write_pack(directory, "a.json", base)
            second = write_pack(directory, "b.json", {**base, "packID": "b"})
            with self.assertRaisesRegex(tool.ToolError, "type 340900 declared by packs a and b"):
                tool.load_packs([first, second])
            product = {"blueprintTypeID": 340901, "productTypeID": 626, "maxProductionLimit": 1, "activities": {}}
            third = write_pack(directory, "c.json", {"packID": "c", "types": [
                {"typeID": 340901, "sourceTypeID": 971}], "blueprints": [product]})
            fourth = write_pack(directory, "d.json", {"packID": "d", "types": [
                {"typeID": 340902, "sourceTypeID": 971}], "blueprints": [{**product, "blueprintTypeID": 340902}]})
            with self.assertRaisesRegex(tool.ToolError, "product 626 has blueprints in packs c and d"):
                tool.load_packs([third, fourth])

    def test_source_without_dogma_record_is_refused_by_name(self) -> None:
        def request(source: int, target: int) -> tool.ItemCloneRequest:
            return tool.ItemCloneRequest(
                source_type_id=source, target_type_id=target, name_message_id=1, description_message_id=2,
                icon_id=26063, market_group_id=None, published=True, field_overrides={},
            )

        with_dogma = {33196, 81080}
        seen: list[tuple[int, int]] = []

        def has_record(payload: bytes, key: int, stride: int) -> bool:
            seen.append((key, stride))
            return key in with_dogma

        requests = [request(81080, 340100), request(81086, 340101), request(81086, 340102)]
        with self.assertRaisesRegex(tool.ToolError, r"^source 81086 has no typeDogma record - "):
            tool.require_dogma_sources(b"", requests, has_record)
        self.assertEqual({stride for _, stride in seen}, {tool.TYPEDOGMA_STRIDE})
        tool.require_dogma_sources(b"", [request(81080, 340100), request(33196, 340101)], has_record)

    def test_shipped_drill_blueprint_uses_a_source_with_dogma(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())
        drill = {entry["typeID"]: entry for _, entry in packs["types"] if 340100 <= entry["typeID"] <= 340216}
        self.assertEqual(drill[340101]["sourceTypeID"], 33196)
        self.assertEqual(drill[340101]["overrides"]["groupID"], 1045)
        self.assertEqual(drill[340100]["sourceTypeID"], 81080)
        for type_id in range(340102, 340117):
            self.assertEqual(drill[type_id]["sourceTypeID"], 81080)
            self.assertEqual((drill[type_id + 100]["sourceTypeID"], drill[type_id + 100]["overrides"]["groupID"]), (33196, 1045))

    def test_item_description_from_override_or_default(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())
        drill = next(entry for _, entry in packs["types"] if entry["typeID"] == 340100)
        self.assertEqual(tool.item_description("planetary-drill", drill, "Planetary Drill"),
                         drill["overrides"]["description"])
        self.assertIn("Planetary Drill (Aqueous Liquids)", drill["overrides"]["description"])
        self.assertEqual([entry["typeID"] for _, entry in packs["types"]
                          if "[PI:" in entry["overrides"].get("description", "")], [])
        plain = {"typeID": 340431, "overrides": {"name": "Bacteria Blueprint"}}
        self.assertEqual(tool.item_description("pi-blueprints", plain, "Bacteria Blueprint"),
                         "Bacteria Blueprint. Custom type 340431 (customTypes pack pi-blueprints).")

    def test_same_packs_reads_old_single_pack_states(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())["packs"]
        self.assertTrue(tool.same_packs({"packs": list(reversed(packs))}, packs))
        pi = next(pack for pack in packs if pack["packID"] == "pi-blueprints")
        old ={"packID": "pi-blueprints", "packFile": pi["file"], "packSha256": pi["sha256"]}
        self.assertTrue(tool.same_packs(old, [pi]))
        self.assertFalse(tool.same_packs(old, packs), "a new pack forces a re-apply")
        self.assertFalse(tool.same_packs({"packs": [{**pi, "sha256": "0"}]}, [pi]), "a changed pack forces a re-apply")


SMB_CONFIG = {"ratioPermille": 750, "excludedGroupIds": frozenset({29}), "maxCapacityM3": 0}
DOGMA_BUCKETS = 4


def dogma_table(records: dict[int, list[tuple[float, int]]], stride: int = tool.TYPEDOGMA_STRIDE) -> bytes:
    """Synthetic typedogma payload in the layout of tools/ElysianFSD/tests/test_dogma_attribute_append.py:
    per bucket its count, the 24-byte records, then each record's attributes and (empty) effects vectors.
    stride > 24: the same record padded with zero bytes (CT1 stride-32 variant)."""
    body = bytearray(struct.pack("<QQQ", 24, len(records), DOGMA_BUCKETS))
    body.extend(bytes(8 * DOGMA_BUCKETS))
    offsets = []
    for bucket in range(DOGMA_BUCKETS):
        keys = sorted(key for key in records if key % DOGMA_BUCKETS == bucket)
        body.extend(struct.pack("<Q", len(keys)))
        offsets.append(len(body))
        first = len(body)
        body.extend(bytes(stride * len(keys)))
        for position, key in enumerate(keys):
            body.extend(struct.pack("<Q", len(records[key])))
            attributes = len(body)
            body.extend(b"".join(struct.pack("<dII", value, attribute_id, 0) for value, attribute_id in records[key]))
            body.extend(struct.pack("<Q", 0))
            effects = len(body)
            struct.pack_into("<IIQQ", body, first + position * stride, key, 0, attributes, effects)
    struct.pack_into(f"<{DOGMA_BUCKETS}Q", body, 24, *offsets)
    return bytes(bytes(range(16)) + bytes(8) + struct.pack("<Q", len(body)) + body)


def vector(payload: bytes, key: int) -> list[tuple[float, int]]:
    """One record's attributes in stored order."""
    body = payload[32:]
    record = tool._dogma_record(body, key)
    pointer = struct.unpack_from("<Q", body, record + 8)[0]
    count = struct.unpack_from("<Q", body, pointer - 8)[0]
    return [struct.unpack_from("<dII", body, pointer + index * 16)[:2] for index in range(count)]


def write_overlay(directory: Path, **smb: object) -> Path:
    path = directory / "dogma-overlays.json"
    settings = {"enabled": True, "ratioPermille": 750, "excludedGroupIds": [29], "maxCapacityM3": 0, **smb}
    path.write_text(json.dumps({"schema": 1, "smbForEveryShip": settings}), "utf-8")
    return path


class DogmaOverlays(unittest.TestCase):
    def test_co1_record_without_smb_gets_both_attributes_sorted(self) -> None:
        table = dogma_table({24700: [(0.0, 3), (400.0, 38)], 24702: [(1.0, 1000)], 5: [(25.0, 6)]})
        ships = {24700: (419, 270000.0), 24702: (419, 4000.0)}
        payload, report = tool.apply_smb_overlay(table, ships, SMB_CONFIG)
        self.assertEqual(vector(payload, 24700), [(0.0, 3), (400.0, 38), (1.0, 907), (202500.0, 908)])
        self.assertEqual(vector(payload, 24702), [(1.0, 907), (3000.0, 908), (1.0, 1000)])
        self.assertEqual(vector(payload, 5), [(25.0, 6)])
        self.assertEqual(tool.integer_root_keys(payload, tool.TYPEDOGMA_STRIDE), (5, 24700, 24702))
        self.assertEqual((report["changed"], report["changedTypeIDs"]), (2, [24700, 24702]))
        sequential = append_type_dogma_attributes(table, 24700, {907: 1.0, 908: 202500.0})
        sequential = append_type_dogma_attributes(sequential, 24702, {907: 1.0, 908: 3000.0})
        self.assertEqual(payload, sequential)

    def test_co2_existing_bay_takes_the_larger_value(self) -> None:
        table = dogma_table({28606: [(1.0, 907), (400000.0, 908)], 24701: [(1.0, 907), (9000000.0, 908)],
                             670: [(5.0, 9)]})
        ships = {28606: (941, 10250000.0), 24701: (419, 270000.0), 670: (29, 1000.0), 33: (419, 5.0)}
        payload, report = tool.apply_smb_overlay(table, ships, SMB_CONFIG)
        self.assertEqual(vector(payload, 28606), [(1.0, 907), (7687500.0, 908)])
        self.assertEqual(vector(payload, 24701), [(1.0, 907), (9000000.0, 908)])
        self.assertEqual(vector(payload, 670), [(5.0, 9)], "capsule group excluded")
        self.assertEqual({key: report[key] for key in ("changed", "unchanged", "excluded", "withoutDogmaRecord")},
                         {"changed": 1, "unchanged": 1, "excluded": 1, "withoutDogmaRecord": 1})
        unchanged_only = dogma_table({24701: [(1.0, 907), (9000000.0, 908)]})
        self.assertIs(tool.apply_smb_overlay(unchanged_only, {24701: (419, 270000.0)}, SMB_CONFIG)[0], unchanged_only)

    def test_co3_disabled_overlay_changes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = write_overlay(Path(temporary), enabled=False)
            overlay = tool.load_dogma_overlays(path)
        self.assertIsNone(overlay)
        table = dogma_table({24700: [(400.0, 38)]})

        def no_sde(_path: Path) -> dict:
            raise AssertionError("the SDE is not read for a disabled overlay")

        payload, report = tool.apply_dogma_overlays(table, overlay, Path("missing"), no_sde)
        self.assertIs(payload, table)
        self.assertIsNone(report)
        packs = tool.load_packs(tool.default_pack_paths())["packs"] + tool.overlay_pack_entries(overlay)
        self.assertEqual([entry["packID"] for entry in packs if entry["packID"].startswith("overlay:")], [])

    def test_co5_shipped_overlay_file_parses(self) -> None:
        overlay = tool.load_dogma_overlays(tool.DOGMA_OVERLAYS_FILE)
        self.assertTrue(overlay is None or isinstance(overlay, dict))

    def test_co4_overlay_file_change_forces_reapply(self) -> None:
        packs = tool.load_packs(tool.default_pack_paths())["packs"]
        with tempfile.TemporaryDirectory() as temporary:
            path = write_overlay(Path(temporary))
            applied = packs + tool.overlay_pack_entries(tool.load_dogma_overlays(path))
            state = {"packs": applied}
            self.assertEqual(applied[-1]["packID"], tool.SMB_OVERLAY_ID)
            self.assertTrue(tool.same_packs(state, packs + tool.overlay_pack_entries(tool.load_dogma_overlays(path))))
            write_overlay(Path(temporary), ratioPermille=800)
            self.assertFalse(tool.same_packs(state, packs + tool.overlay_pack_entries(tool.load_dogma_overlays(path))))
            self.assertFalse(tool.same_packs(state, packs), "disabling the overlay forces a re-apply too")


SOURCES = {24700: [(0.0, 3), (400.0, 38)], 24702: [(1.0, 1000)], 5: [(25.0, 6), (2.0, 38)]}


def request(source: int, target: int, icon_id: int = 21, **extra: object) -> tool.ItemCloneRequest:
    return tool.ItemCloneRequest(source_type_id=source, target_type_id=target, name_message_id=2000001,
                                 description_message_id=2000002, icon_id=icon_id, market_group_id=None, **extra)


def png(size: tuple[int, int] = (64, 64), mode: str = "RGBA") -> bytes:
    output = io.BytesIO()
    Image.new(mode, size).save(output, "PNG")
    return output.getvalue()


def icon_pack(directory: Path, payload: bytes, icon_id: int = 950000) -> Path:
    (directory / "icons").mkdir(exist_ok=True)
    (directory / "icons" / f"{icon_id}.png").write_bytes(payload)
    return write_pack(directory, "design.json", {
        "packID": "design-test", "version": 1,
        "types": [{"typeID": 342000, "sourceTypeID": 587,
                   "overrides": {"name": "Test", "iconID": icon_id, "mass": 1100000}}],
        "icons": [{"iconID": icon_id, "templateIconID": 21, "file": f"icons/{icon_id}.png",
                   "sha256": hashlib.sha256(payload).hexdigest()}],
    })


def single_clone_sequence(tables: dict[str, bytes], requests: list) -> tuple[dict[str, bytes], dict[str, str]]:
    """One clone_integer_record per request and table, each with its own split and hash."""
    from fsd.items import _patch_icon_file, _patch_types

    current = dict(tables)
    skipped: dict[str, str] = {}
    for item in requests:
        current["types"] = clone_integer_record(current["types"], item.source_type_id, item.target_type_id, 152,
                                                lambda body, context, item=item: _patch_types(body, context, item))
        current["typedogma"] = clone_integer_record(
            current["typedogma"], item.source_type_id, item.target_type_id, 24,
            lambda body, context, item=item: _patch_dogma(body, context, item.dogma_overrides))
        for name, stride in (("requiredskillsfortypes", 24), ("typematerials", 32)):
            if contains_root_key(current[name], item.source_type_id, stride):
                current[name] = clone_integer_record(current[name], item.source_type_id, item.target_type_id, stride)
            else:
                skipped[name] = f"source {item.source_type_id} has no identity record"
    for item in requests:
        if item.custom_icon_file:
            current["iconids"] = clone_integer_record(
                current["iconids"], item.source_icon_id, item.icon_id, 32,
                lambda body, context, path=item.custom_icon_file: _patch_icon_file(body, context, path))
    changed = {name: payload for name, payload in current.items()
               if name in ("types", "typedogma") or payload != tables[name]}
    return changed, skipped


class PackV2(unittest.TestCase):
    def test_ct1_batch_clones_equal_the_single_clone_sequence(self) -> None:
        set_38 = lambda body, context: _patch_dogma(body, context, {38: 999.0})
        clones = [(24700, 340000, set_38), (24702, 340001, None), (5, 340004, set_38),
                  (24700, 340002, None), (5, 340003, None)]
        for stride in (24, 32):
            table = dogma_table(SOURCES, stride)
            sequential = table
            for source, target, mutator in clones:
                sequential = clone_integer_record(sequential, source, target, stride, mutator)
            self.assertEqual(tool.clone_integer_records(table, clones, stride), sequential, f"stride {stride}")
            self.assertTrue(tool.body_contains_root_key(sequential[32:], 340004, stride))
            self.assertFalse(tool.body_contains_root_key(table[32:], 340004, stride))
        self.assertIs(tool.clone_integer_records(table, [], 32), table)
        tables = {"types": dogma_table(SOURCES, 152), "typedogma": dogma_table(SOURCES),
                  "requiredskillsfortypes": dogma_table({24700: [(1.0, 3)]}),
                  "typematerials": dogma_table(SOURCES, 32), "iconids": dogma_table({21: [(0.0, 1)]}, 32)}
        requests = [request(24700, 340000, dogma_overrides={38: 420.0}, field_overrides={"mass": 5.0}),
                    request(5, 340004, 950000, source_icon_id=21, custom_icon_file=tool.icon_logical_path(950000))]
        expected, skipped = single_clone_sequence(tables, requests)
        actual = tool.compile_tables(tables.__getitem__, requests)
        self.assertEqual(actual.resources, expected)
        self.assertEqual((actual.changed_tables, actual.skipped_tables), (sorted(expected), skipped))
        self.assertEqual(skipped, {"requiredskillsfortypes": "source 5 has no identity record"})
        self.assertIn("iconids", actual.resources)

    def test_ct2_unknown_key_is_refused_by_name(self) -> None:
        base = {"packID": "a", "types": [{"typeID": 340900, "sourceTypeID": 971, "overrides": {"iconID": 1}}]}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            cases = {
                "foo": {**base, "foo": 1},
                "colour": {**base, "types": [{**base["types"][0], "colour": 1}]},
                "speed": {**base, "types": [{**base["types"][0], "overrides": {"iconID": 1, "speed": 2}}]},
            }
            for key, pack in cases.items():
                with self.assertRaisesRegex(tool.ToolError, f"unknown key {key}"):
                    tool.load_pack(write_pack(directory, f"{key}.json", pack))
            tool.load_pack(write_pack(directory, "ok.json", base))
        self.assertEqual(len(tool.load_packs(tool.default_pack_paths())["packIDs"]), 9)

    def test_ct3_dogma_override_only_on_carried_attributes(self) -> None:
        table = dogma_table(SOURCES)
        with self.assertRaisesRegex(tool.ToolError, "dogma.attributes 37 not on source 24700 - only attributes the "
                                                    "source record carries"):
            tool.require_dogma_attributes(table, [request(24700, 340000, dogma_overrides={37: 1.0, 38: 2.0})])
        planned = request(24700, 340000, dogma_overrides={38: 420.0})
        tool.require_dogma_attributes(table, [planned])
        compiled = tool.clone_integer_records(table, [
            (24700, 340000, lambda body, context: _patch_dogma(body, context, planned.dogma_overrides))], 24)
        tool.check_dogma_overrides(compiled, [planned])
        self.assertEqual(tool.read_dogma_attributes(compiled[32:], 340000), {3: 0.0, 38: 420.0})
        self.assertEqual(tool.read_dogma_attributes(compiled[32:], 24700), {3: 0.0, 38: 400.0}, "source unchanged")

    def test_ct4_icon_png_checked_and_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for payload, message in ((png((32, 32)), "must be 64x64"), (png(mode="RGB"), "must be RGBA")):
                path = icon_pack(directory, payload)
                with self.assertRaisesRegex(tool.ToolError, message):
                    tool.load_packs([path], directory)
            good = png()
            path = icon_pack(directory, good)
            (directory / "icons" / "950000.png").write_bytes(png(mode="RGBA") + b"x")
            with self.assertRaisesRegex(tool.ToolError, "sha256 of .* the pack says"):
                tool.load_packs([path], directory)
            path = icon_pack(directory, good)
            packs = tool.load_packs([path], directory)
            self.assertEqual(packs["icons"][0]["payload"], good)
            tq = directory / "client" / "tq"
            tq.mkdir(parents=True)
            (tq / "resfileindex.txt").write_text("res:/a.png,ab/abc_1,00,1,1\n", "utf-8")
            (tq / "resfileindex_prefetch.txt").write_text("res:/a.png,ab/abc_1,00,1,1\n", "utf-8")
            index = tool.ResourceIndex.load(directory / "client")
            payloads, originals, entries = tool.icon_resources(index, packs["icons"])
            logical = "res:/ui/texture/icons/customtypes/950000.png"
            self.assertEqual([entry["logical"] for entry in entries], [logical])
            replacements, outputs = tool.stage_payloads(index, payloads, originals, directory / "staging")
            primary = outputs[tq / "resfileindex.txt"].decode("utf-8").splitlines()
            self.assertEqual(primary, ["res:/a.png,ab/abc_1,00,1,1", replacements[logical].render()])
            self.assertTrue(primary[1].startswith(logical + ","))
            self.assertNotIn(logical, outputs[tq / "resfileindex_prefetch.txt"].decode("utf-8"))
            self.assertEqual((directory / "staging" / "ResFiles" / replacements[logical].hashed_path).read_bytes(), good)

    def test_ct5_icon_change_forces_reapply(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            applied = tool.load_packs([icon_pack(directory, png())], directory)["packs"]
            self.assertTrue(tool.same_packs({"packs": applied}, tool.load_packs([directory / "design.json"], directory)["packs"]))
            changed = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
            output = io.BytesIO()
            changed.save(output, "PNG")
            current = tool.load_packs([icon_pack(directory, output.getvalue())], directory)["packs"]
            self.assertFalse(tool.same_packs({"packs": applied}, current))

    def test_ct6_shared_icon_cloned_once(self) -> None:
        tables = {"types": dogma_table(SOURCES, 152), "typedogma": dogma_table(SOURCES),
                  "requiredskillsfortypes": dogma_table({24700: [(1.0, 3)]}),
                  "typematerials": dogma_table(SOURCES, 32), "iconids": dogma_table({21: [(0.0, 1)]}, 32)}
        icon = {"source_icon_id": 21, "custom_icon_file": tool.icon_logical_path(950000)}
        shared = tool.compile_tables(tables.__getitem__, [request(24700, 340000, 950000, **icon),
                                                          request(5, 340004, 950000, **icon)])
        self.assertTrue(tool.body_contains_root_key(shared.resources["iconids"][32:], 950000, 32))
        single = tool.compile_tables(tables.__getitem__, [request(24700, 340000, 950000, **icon)])
        self.assertEqual(shared.resources["iconids"], single.resources["iconids"])
        with self.assertRaisesRegex(tool.CfsdEncodingError, "icon 950000: requests disagree on template/file"):
            tool.compile_tables(tables.__getitem__, [
                request(24700, 340000, 950000, **icon),
                request(5, 340004, 950000, source_icon_id=21, custom_icon_file=tool.icon_logical_path(950001))])


LOADERS = {"types": "typesLoader", "typedogma": "typeDogmaLoader", "requiredskillsfortypes": "requiredSkillsForTypesLoader",
           "typematerials": "typeMaterialsLoader", "iconids": "iconIDsLoader"}


def fake_client(directory: Path, build: int, fingerprints: dict[str, str] | None = None) -> Path:
    """A client folder with the five item tables (synthetic payloads, header fingerprints of the known layouts)."""
    client = directory / "client"
    (client / "tq" / "bin64").mkdir(parents=True)
    (client / "tq" / "start.ini").write_text(f"[main]\nversion = 99.01\nbuild = {build}\n", "utf-8")
    rows = []
    for name, loader in LOADERS.items():
        (client / "tq" / "bin64" / f"{loader}.pyd").write_bytes(b"")
        fingerprint = (fingerprints or {}).get(name) or next(iter(fsd_profile.LAYOUTS[name]))
        payload = bytes.fromhex(fingerprint) + dogma_table(SOURCES)[16:]
        hashed = f"aa/{name}_{tool.md5_bytes(payload)}"
        (client / "ResFiles" / "aa").mkdir(parents=True, exist_ok=True)
        (client / "ResFiles" / hashed).write_bytes(payload)
        rows.append(f"res:/staticdata/{name}.fsdbinary,{hashed},{tool.md5_bytes(payload)},{len(payload)},{len(payload)}")
    for filename in tool.INDEX_FILES:
        (client / "tq" / filename).write_text("\n".join(rows) + "\n", "utf-8")
    return client


class Standalone(unittest.TestCase):
    def test_st1_no_import_outside_the_mod(self) -> None:
        sources = [CLIENT_TOOL_DIR / "apply_client_data.py", *sorted((CLIENT_TOOL_DIR / "fsd").glob("*.py"))]
        self.assertGreater(len(sources), 6)
        for path in sources:
            tree = ast.parse(path.read_text("utf-8"))
            names = [alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
            names += [node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 0]
            self.assertEqual([name for name in names if name.startswith("elysian")], [], str(path))
            self.assertNotIn("sys.path.append", path.read_text("utf-8"), str(path))
        self.assertEqual(sorted(name for name in sys.modules if name.startswith("elysian")), [])


class BuildProfiles(unittest.TestCase):
    def test_bp1_unknown_build_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = fake_client(Path(temporary), 9999999)
            index = tool.ResourceIndex.load(client)
            with self.assertRaisesRegex(tool.ToolError, r"no profile for client build 9999999 in .*ApplyClientData\.bat profile"):
                tool.supported_profile(index)

    def test_bp2_changed_layout_or_profile_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = fake_client(Path(temporary), 3724492, {"typedogma": "00" * 16})
            with self.assertRaisesRegex(tool.ToolError, "typedogma: schema fingerprint 0+ has no known native layout"):
                tool.supported_profile(tool.ResourceIndex.load(client))
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            client = fake_client(directory, 3724492)
            (client / "tq" / "bin64" / "typesLoader.pyd").rename(client / "tq" / "bin64" / "typesV2Loader.pyd")
            with self.assertRaisesRegex(tool.ToolError, "types: no generated loader"):
                tool.supported_profile(tool.ResourceIndex.load(client))
            stored = json.loads((tool.PROFILES_DIR / "build-3724492.json").read_text("utf-8"))
            stored["tables"]["types"]["loaderModule"] = "typesV2Loader"
            profiles = directory / "profiles"
            profiles.mkdir()
            (profiles / "build-3724492.json").write_text(json.dumps(stored), "utf-8")
            (client / "tq" / "bin64" / "typesV2Loader.pyd").rename(client / "tq" / "bin64" / "typesLoader.pyd")
            with self.assertRaisesRegex(tool.ToolError, "types: loaderModule is 'typesLoader', the profile says 'typesV2Loader'"):
                tool.supported_profile(tool.ResourceIndex.load(client), profiles)

    def test_bp3_shipped_profiles_match_the_known_layouts(self) -> None:
        for build in (3396210, 3724492):
            stored = fsd_profile.load_build_profile(tool.PROFILES_DIR, build)
            self.assertTrue(stored["proof"]["success"])
            for name in fsd_profile.ITEM_TABLES:
                self.assertIn(stored["tables"][name]["schemaFingerprint"], fsd_profile.LAYOUTS[name])
        with tempfile.TemporaryDirectory() as temporary:
            client = fake_client(Path(temporary), 3724492)
            profile = tool.supported_profile(tool.ResourceIndex.load(client))
            self.assertEqual((profile.build, sorted(profile.tables)), (3724492, sorted(fsd_profile.ITEM_TABLES)))
            self.assertEqual(tool.default_sde_dir(profile.build).name, "eve-online-static-data-3724492-jsonl")


class StatePerBuild(unittest.TestCase):
    def test_sb1_other_build_state_is_archived_and_never_rolled_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            client = fake_client(directory, 3724492)
            state_dir = directory / "state"
            old = {"status": "applied", "build": 3396210, "client": str(client), "appliedAt": "x",
                   "tqRoot": str(client / "tq"), "backupDir": str(directory), "indexFiles": {}, "createdPayloads": []}
            tool.write_state(state_dir, old)
            self.assertFalse(tool.other_build_state({**old, "build": 3724492}, 3724492))
            self.assertTrue(tool.other_build_state({"status": "applied"}, 3724492))
            self.assertTrue(tool.other_build_state(old, tool.client_build(client)))
            args = tool.argparse.Namespace(state_dir=state_dir, force=True)
            with self.assertRaisesRegex(tool.ToolError, "belongs to client build 3396210, the client is build 3724492"):
                tool.command_rollback(args)
            archived = tool.archive_state(state_dir, old)
            self.assertEqual(archived.name, "state.3396210.json")
            self.assertIsNone(tool.read_state(state_dir))
            tool.write_state(state_dir, old)
            self.assertNotEqual(tool.archive_state(state_dir, old).name, "state.3396210.json", "an older archive is kept")

    def test_sb2_unreadable_client_is_refused_before_the_state_is_touched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            client = fake_client(directory, 3724492)
            state_dir = directory / "state"
            tool.write_state(state_dir, {"status": "applied", "build": 3396210, "client": str(client), "appliedAt": "x",
                                         "tqRoot": str(client / "tq"), "backupDir": str(directory), "indexFiles": {},
                                         "createdPayloads": []})
            before = (state_dir / tool.STATE_FILE).read_bytes()
            no_build = fake_client(directory / "no-start-ini", 3724492)
            (no_build / "tq" / "start.ini").unlink()
            unknown = fake_client(directory / "unknown-build", 9999999)
            cases = {"typo": (directory / "typo-no-client", "cannot read the client folder"),
                     "no start.ini": (no_build, "names no client build"),
                     "no profile": (unknown, "no profile for client build 9999999")}
            for name, (folder, reason) in cases.items():
                for command in ("apply", "plan"):
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                        code = tool.main([command, "--client", str(folder), "--state-dir", str(state_dir)])
                    self.assertEqual(code, 2, f"{command} {name}")
                    self.assertRegex(stderr.getvalue(), f"^REFUSED: .*{reason}", f"{command} {name}")
                    self.assertEqual(sorted(path.name for path in state_dir.iterdir()), [tool.STATE_FILE], name)
                    self.assertEqual((state_dir / tool.STATE_FILE).read_bytes(), before, name)

    def test_sb3_state_without_build_is_refused_unless_its_plan_names_the_build(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            client = fake_client(directory, 3724492)
            state_dir = directory / "state"
            legacy = {"status": "applied", "client": str(client), "appliedAt": "20261030-121818-757176",
                      "tqRoot": str(client / "tq"), "backupDir": str(directory),
                      "indexFiles": {"resfileindex.txt": {"originalSha256": "0" * 64, "appliedSha256": "1" * 64}},
                      "createdPayloads": []}
            tool.write_state(state_dir, legacy)
            before = (state_dir / tool.STATE_FILE).read_bytes()
            for argv in (["rollback", "--force"], ["rollback"], ["apply", "--client", str(client)]):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                    code = tool.main([*argv, "--state-dir", str(state_dir)])
                self.assertEqual(code, 2, argv)
                self.assertRegex(stderr.getvalue(), r"REFUSED: .*records no client build.*not even with --force.*"
                                                    r"rename it to state\.<old build>\.json", argv)
                self.assertEqual(sorted(path.name for path in state_dir.iterdir()), [tool.STATE_FILE], argv)
                self.assertEqual((state_dir / tool.STATE_FILE).read_bytes(), before, argv)
            plan_dir = state_dir / f"apply-{legacy['appliedAt']}"
            plan_dir.mkdir()
            (plan_dir / "plan.json").write_text(json.dumps({"client": str(client), "build": 3396210}), "utf-8")
            self.assertEqual(tool.state_with_build(state_dir, legacy)["build"], 3396210)
            with self.assertRaisesRegex(tool.ToolError, "belongs to client build 3396210, the client is build 3724492"):
                tool.command_rollback(tool.argparse.Namespace(state_dir=state_dir, force=True))
            self.assertEqual((state_dir / tool.STATE_FILE).read_bytes(), before)
            self.assertEqual(tool.archive_state(state_dir, tool.state_with_build(state_dir, legacy)).name,
                             "state.3396210.json")
            (plan_dir / "plan.json").write_text(json.dumps({"client": str(directory / "other"), "build": 3396210}),
                                                "utf-8")
            self.assertIsNone(tool.recorded_build(state_dir, legacy), "a plan of another client folder is ignored")


def real_client_build() -> int:
    return tool.client_build(REAL_CLIENT) if (REAL_CLIENT / "tq" / "start.ini").is_file() else 0


@unittest.skipUnless(real_client_build() == 3724492, f"client build 3724492 not found at {REAL_CLIENT}")
class ClientBuild3724492(unittest.TestCase):
    def test_cb1_encoder_roundtrip_on_the_client_tables(self) -> None:
        index = tool.ResourceIndex.load(REAL_CLIENT)
        profile = tool.supported_profile(index)
        dogma = profile.table("typedogma").resource_path.read_bytes()
        header, body = _split(dogma)
        source = tool.read_dogma_attributes(body, 24700)
        attribute = min(source)
        clone_record_in_body(body, 24700, 349999, tool.TYPEDOGMA_STRIDE,
                             lambda payload, context: _patch_dogma(payload, context, {attribute: 1234.0}))
        self.assertEqual(tool.read_dogma_attributes(body, 349999), {**source, attribute: 1234.0})
        self.assertEqual(tool.read_dogma_attributes(body, 24700), source, "source unchanged")
        self.assertTrue(tool.body_contains_root_key(body, 349999, tool.TYPEDOGMA_STRIDE))
        self.assertEqual(struct.unpack_from("<Q", body, 8)[0], struct.unpack_from("<Q", dogma, 40)[0] + 1)
        types = profile.table("types").resource_path.read_bytes()
        _header, types_body = _split(types)
        request = tool.ItemCloneRequest(source_type_id=24700, target_type_id=349999, name_message_id=2999998,
                                        description_message_id=2999999, icon_id=0, market_group_id=None,
                                        field_overrides={"mass": 5.0})
        from fsd.items import _patch_types
        clone_record_in_body(types_body, 24700, 349999, tool.TYPES_STRIDE,
                             lambda payload, context: _patch_types(payload, context, request))
        self.assertTrue(tool.body_contains_root_key(types_body, 349999, tool.TYPES_STRIDE))
        self.assertFalse(tool.body_contains_root_key(types[32:], 349999, tool.TYPES_STRIDE))


if __name__ == "__main__":
    unittest.main(verbosity=2)
