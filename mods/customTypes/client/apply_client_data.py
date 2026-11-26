"""customTypes client data tool: the client half of mods/customTypes/data/*.json packs.

The server half is the customTypes loader mod (in memory, no files). The client needs, per pack:

1. the item type rows (``types`` and ``typedogma`` .fsdbinary, localization pickles for the name),
   compiled by Elysian Item Forge's ``ItemFsdEncoder`` (tools/ElysianFSD) WITHOUT Item Forge's
   ``validate``: validate blocks every category-9 (blueprint) source with "Missing server adapter:
   blueprint/industry adapter" (dependencies.py:157-166, compiler.py:557-559), and that adapter is
   the customTypes mod;
2. the blueprint activity rows, added to a COPY of ``res:/staticdata/blueprints.static`` (SQLite:
   ``cache(key, value JSON, time)`` + ``indexes('productTypeID.<id>' -> '<blueprintTypeID>')``),
   each row a clone of the Vexor Blueprint (971) row with the pack's activities;
3. new ``resfileindex.txt`` / ``resfileindex_prefetch.txt`` entries pointing at the new
   content-addressed ResFiles payloads (new hash and size).

Nothing is overwritten in ResFiles (payloads are new content-addressed files). The index files are
backed up first; ``rollback`` restores them and deletes the payloads this tool created.

Commands (the operator runs them, the client and the launcher closed):
    plan      build everything into a staging folder, write nothing to the client
    apply     plan + write the payloads and the index files (backup first); while an apply is
              active: no-op for the same pack files, otherwise rollback first, then a fresh apply

All data/*.json packs are applied together by default (one plan, one backup, one rollback);
--pack (repeatable) selects packs.
    rollback  restore the backed-up index files, delete the created payloads
    status    show the recorded state and whether the client index still matches it

Run with the Elysian suite venv (it has elysian_fsd and elysian_item_forge): ApplyClientData.bat.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import json
import io
import math
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

MOD_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = MOD_DIR.parent.parent
for relative in ("tools/ElysianFSD", "tools/ElysianItemForge"):
    candidate = str(REPO_ROOT / relative)
    if candidate not in sys.path:
        sys.path.append(candidate)

from elysian_fsd.cfsd_shadow import (  # noqa: E402
    CfsdEncodingError,
    Mutator,
    ShadowContext,
    _append_padding_for_pointer,
    _bucket_end,
    _find_record,
    _finish,
    _put_u64,
    _relocate_region,
    _root,
    _shadow_existing_bucket,
    _split,
    _u64,
    append_vector,
    integer_root_keys,
)
from elysian_fsd.discovery import discover_build_profile  # noqa: E402
from elysian_fsd.hashing import md5_bytes, sha256_file  # noqa: E402
from elysian_fsd.item_encoding import (  # noqa: E402
    ItemCloneRequest,
    ItemCompileResult,
    ItemFsdEncoder,
    _contains_root_key,
    _patch_dogma,
    _patch_icon_file,
    _patch_types,
)
from elysian_fsd.item_verification import ensure_item_encoder_verified  # noqa: E402
from elysian_fsd.native_loader import NativeLoaderHost  # noqa: E402
from elysian_fsd.resource_index import ResourceIndex, ResourceRecord  # noqa: E402
from elysian_item_forge.allocation import MESSAGE_RANGE, TYPE_RANGE  # noqa: E402
from elysian_item_forge.localization import (  # noqa: E402
    localization_records,
    patch_language_payload,
    used_message_ids,
)
from elysian_item_forge.models import CustomItem, ItemPack  # noqa: E402

DATA_DIR = MOD_DIR / "data"
DEFAULT_STATE_DIR = REPO_ROOT / "_local" / "customTypes-client"
BLUEPRINTS_LOGICAL = "res:/staticdata/blueprints.static"
TEMPLATE_BLUEPRINT_TYPE_ID = 971
INDEX_FILES = ("resfileindex.txt", "resfileindex_prefetch.txt")
CLIENT_PROCESS = "exefile.exe"
STATE_FILE = "state.json"
TYPEDOGMA_STRIDE = 24
CLIENT_ACTIVITY_FIELDS = ("skills", "materials", "products", "time")
CLIENT_ITEM_FIELDS = {
    "skills": ("typeID", "level"),
    "materials": ("typeID", "quantity"),
    "products": ("typeID", "probability", "quantity"),
}


CLIENT_TOOL_DIR = Path(__file__).resolve().parent
DOGMA_OVERLAYS_FILE = CLIENT_TOOL_DIR / "dogma-overlays.json"
DEFAULT_SDE_DIR = REPO_ROOT / "_local" / "sde" / "eve-online-static-data-3396210-jsonl"
ROOT_ENV_FILE = REPO_ROOT / ".env"
SMB_OVERLAY_ID = "overlay:smbForEveryShip"
ATTRIBUTE_HAS_SMB = 907
ATTRIBUTE_SMB_CAPACITY = 908
CATEGORY_SHIP = 6
TYPEDOGMA_ATTRIBUTE_SIZE = 16
SMB_RATIO_RANGE = range(1, 10001)
SMB_ENV_RATIO = "EVEJS_SOLO_SMB_RATIO_PERMILLE"
SMB_NATIVE_PROBES = 40

PACK_KEYS = frozenset({"packID", "version", "types", "blueprints", "icons", "source", "description"})
TYPE_KEYS = frozenset({"typeID", "sourceTypeID", "overrides", "dogma"})
OVERRIDE_KEYS = frozenset({"name", "groupID", "iconID", "basePrice", "published", "marketGroupID", "description",
                           "mass", "volume", "capacity", "radius"})
DOGMA_KEYS = frozenset({"attributes"})
BLUEPRINT_KEYS = frozenset({"blueprintTypeID", "productTypeID", "maxProductionLimit", "activities", "shop"})
ICON_KEYS = frozenset({"iconID", "templateIconID", "file", "sha256"})
NUMERIC_FIELD_OVERRIDES = ("mass", "volume", "capacity", "radius")
NATIVE_FIELD_CHECKS = ("groupID", "basePrice", "mass", "volume", "capacity", "radius")
ICON_RANGE_CUSTOM = range(950_000, 960_000)
ICON_LOGICAL = "res:/ui/texture/icons/customtypes/{icon_id}.png"
ICONS_DIR = CLIENT_TOOL_DIR / "icons"
ICON_SIZE = (64, 64)
ICONIDS_STRIDE = 32
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
ATTRIBUTE_KEY = re.compile(r"[0-9]+")


class ToolError(RuntimeError):
    """A refusal with a message for the operator; nothing was written when raised before `apply` writes."""


def _require_keys(where: str, value: Any, allowed: frozenset[str]) -> dict[str, Any]:
    """value must be an object with only the allowed keys; an unknown key is refused by name."""
    if not isinstance(value, dict):
        raise ToolError(f"{where} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ToolError(f"{where}: unknown key {', '.join(unknown)} (allowed: {', '.join(sorted(allowed))})")
    return value


def _is_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _check_type_entry(path: Path, entry: Any) -> int:
    _require_keys(f"{path}: type {entry.get('typeID') if isinstance(entry, dict) else entry!r}", entry, TYPE_KEYS)
    type_id = entry.get("typeID")
    if not isinstance(type_id, int) or type_id not in TYPE_RANGE:
        raise ToolError(f"type {type_id!r} outside {TYPE_RANGE.start}-{TYPE_RANGE.stop - 1}")
    if not isinstance(entry.get("sourceTypeID"), int):
        raise ToolError(f"type {type_id}: sourceTypeID missing")
    overrides = _require_keys(f"{path}: type {type_id} overrides", entry.get("overrides", {}), OVERRIDE_KEYS)
    for key in NUMERIC_FIELD_OVERRIDES:
        if key in overrides and not (_is_number(overrides[key]) and overrides[key] > 0):
            raise ToolError(f"type {type_id}: overrides.{key} must be a finite number > 0")
    if "dogma" in entry:
        dogma = _require_keys(f"{path}: type {type_id} dogma", entry["dogma"], DOGMA_KEYS)
        attributes = dogma.get("attributes", {})
        if not isinstance(attributes, dict):
            raise ToolError(f"type {type_id}: dogma.attributes must be an object")
        for key, value in attributes.items():
            if not ATTRIBUTE_KEY.fullmatch(key) or not _is_number(value):
                raise ToolError(f"type {type_id}: dogma.attributes {key!r} must be an attributeID (digits) "
                                f"with a finite number")
    return type_id


def _check_icons(path: Path, pack: dict[str, Any]) -> None:
    """icons[]: own range, unique, a sha256 and a file; every icon used by a type of this pack and every
    custom-range iconID of a type declared here."""
    icons = pack.get("icons", [])
    if not isinstance(icons, list):
        raise ToolError(f"{path}: icons must be a list")
    declared: set[int] = set()
    for icon in icons:
        _require_keys(f"{path}: icon {icon.get('iconID') if isinstance(icon, dict) else icon!r}", icon, ICON_KEYS)
        icon_id = icon.get("iconID")
        if isinstance(icon_id, bool) or not isinstance(icon_id, int) or icon_id not in ICON_RANGE_CUSTOM:
            raise ToolError(f"icon {icon_id!r} outside {ICON_RANGE_CUSTOM.start}-{ICON_RANGE_CUSTOM.stop - 1}")
        if icon_id in declared:
            raise ToolError(f"icon {icon_id} declared twice in {path}")
        template = icon.get("templateIconID")
        if isinstance(template, bool) or not isinstance(template, int) or template <= 0:
            raise ToolError(f"icon {icon_id}: templateIconID must be an existing client iconID")
        if not isinstance(icon.get("file"), str) or not icon["file"]:
            raise ToolError(f"icon {icon_id}: file missing")
        if not isinstance(icon.get("sha256"), str) or not SHA256_HEX.fullmatch(icon["sha256"]):
            raise ToolError(f"icon {icon_id}: sha256 must be 64 lowercase hex digits")
        declared.add(icon_id)
    used = {entry.get("overrides", {}).get("iconID") for entry in pack["types"]}
    unused = sorted(declared - used)
    if unused:
        raise ToolError(f"{path}: icons {', '.join(map(str, unused))} are used by no type")
    undeclared = sorted(value for value in used
                        if isinstance(value, int) and value in ICON_RANGE_CUSTOM and value not in declared)
    if undeclared:
        raise ToolError(f"{path}: iconID {', '.join(map(str, undeclared))} has no entry in icons")


def load_pack(path: Path) -> dict[str, Any]:
    pack = json.loads(path.read_text("utf-8"))
    if not isinstance(pack, dict) or not isinstance(pack.get("packID"), str):
        raise ToolError(f"{path}: not a customTypes pack (packID missing)")
    _require_keys(f"{path}", pack, PACK_KEYS)
    types = pack.get("types")
    if not isinstance(types, list) or not types:
        raise ToolError(f"{path}: no types")
    type_ids = {_check_type_entry(path, entry) for entry in types}
    for blueprint in pack.get("blueprints", []):
        _require_keys(f"{path}: blueprint {blueprint.get('blueprintTypeID') if isinstance(blueprint, dict) else blueprint!r}",
                      blueprint, BLUEPRINT_KEYS)
        if blueprint.get("blueprintTypeID") not in type_ids:
            raise ToolError(f"blueprint {blueprint.get('blueprintTypeID')!r} is not a type of this pack")
    _check_icons(path, pack)
    return pack


def load_icon(entry: dict[str, Any], base: Path = CLIENT_TOOL_DIR) -> bytes:
    """The PNG of an icons[] entry: inside base, sha256 as declared, 64x64 RGBA (Item Forge validate_icon)."""
    icon_id = entry["iconID"]
    root = base.resolve()
    path = (root / entry["file"]).resolve()
    if not path.is_relative_to(root):
        raise ToolError(f"icon {icon_id}: {entry['file']} is outside {root}")
    if not path.is_file():
        raise ToolError(f"icon {icon_id}: {path} not found")
    payload = path.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != entry["sha256"]:
        raise ToolError(f"icon {icon_id}: sha256 of {path} is {digest}, the pack says {entry['sha256']}")
    from PIL import Image

    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != "PNG":
                raise ToolError(f"icon {icon_id}: {path} is not a PNG")
            if image.size != ICON_SIZE:
                raise ToolError(f"icon {icon_id}: must be 64x64, got {image.size[0]}x{image.size[1]}")
            if image.mode != "RGBA":
                raise ToolError(f"icon {icon_id}: must be RGBA (with alpha), got {image.mode}")
            image.verify()
    except ToolError:
        raise
    except Exception as error:
        raise ToolError(f"icon {icon_id}: {path} is not a valid PNG ({error})") from error
    return payload


def default_pack_paths(data_dir: Path = DATA_DIR) -> list[Path]:
    """Every data/*.json pack, in the server's load order (lib/pack.js loadPackFiles: name order)."""
    paths = sorted((path for path in data_dir.iterdir() if path.is_file() and path.name.lower().endswith(".json")),
                   key=lambda path: path.name)
    if not paths:
        raise ToolError(f"no packs in {data_dir}")
    return paths


def load_packs(paths: list[Path], icon_base: Path = CLIENT_TOOL_DIR) -> dict[str, Any]:
    """All packs as one client change (one plan, one apply, one backup, one rollback).

    Refuses the whole set when two packs declare the same typeID, blueprint or product, or the same
    packID: the server would refuse the later pack, and the client must carry exactly what the
    server accepts. Same for an iconID; every icon PNG is read and checked here (load_icon)."""
    packs: list[dict[str, Any]] = []
    seen_packs: set[str] = set()
    seen_types: dict[int, str] = {}
    seen_products: dict[int, str] = {}
    seen_icons: dict[int, str] = {}
    icons: list[dict[str, Any]] = []
    for path in paths:
        pack = load_pack(path)
        pack_id = pack["packID"]
        if pack_id in seen_packs:
            raise ToolError(f"{path}: packID {pack_id} used by two pack files")
        seen_packs.add(pack_id)
        for entry in pack["types"]:
            type_id = entry["typeID"]
            if type_id in seen_types:
                raise ToolError(f"type {type_id} declared by packs {seen_types[type_id]} and {pack_id}")
            seen_types[type_id] = pack_id
        for blueprint in pack.get("blueprints", []):
            product = blueprint.get("productTypeID")
            if product in seen_products:
                raise ToolError(f"product {product} has blueprints in packs {seen_products[product]} and {pack_id}")
            seen_products[product] = pack_id
        for icon in pack.get("icons", []):
            icon_id = icon["iconID"]
            if icon_id in seen_icons:
                raise ToolError(f"icon {icon_id} declared by packs {seen_icons[icon_id]} and {pack_id}")
            seen_icons[icon_id] = pack_id
            icons.append({**icon, "packID": pack_id, "payload": load_icon(icon, icon_base)})
        packs.append({"path": path, "pack": pack, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    if not packs:
        raise ToolError("no packs")
    return {
        "packIDs": [entry["pack"]["packID"] for entry in packs],
        "packs": [{"packID": entry["pack"]["packID"], "file": str(entry["path"]), "sha256": entry["sha256"]}
                  for entry in packs],
        "types": [(entry["pack"]["packID"], item) for entry in packs for item in entry["pack"]["types"]],
        "blueprints": [item for entry in packs for item in entry["pack"].get("blueprints", [])],
        "icons": icons,
    }


def state_packs(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Packs of a state file; a state written by the single-pack version has packID/packFile/packSha256."""
    if isinstance(state.get("packs"), list):
        return state["packs"]
    if state.get("packID"):
        return [{"packID": state["packID"], "file": state.get("packFile"), "sha256": state.get("packSha256")}]
    return []


def same_packs(state: dict[str, Any], packs: list[dict[str, Any]]) -> bool:
    """True when the state was applied from exactly these pack files (packID and content)."""
    key = lambda entries: sorted((entry.get("packID"), entry.get("sha256")) for entry in entries)  # noqa: E731
    return key(state_packs(state)) == key(packs)


def client_activity(activity: dict[str, Any]) -> dict[str, Any]:
    """One activity in the client's key order; item fields in the client's order too."""
    result: dict[str, Any] = {}
    for field in CLIENT_ACTIVITY_FIELDS:
        if field not in activity:
            continue
        if field == "time":
            result["time"] = int(activity["time"])
            continue
        order = CLIENT_ITEM_FIELDS[field]
        result[field] = [
            {key: item[key] for key in order if key in item}
            for item in activity[field]
        ]
    return result


def client_blueprint_row(template: dict[str, Any], blueprint: dict[str, Any]) -> dict[str, Any]:
    """Clone of the template row: activities, blueprintTypeID and maxProductionLimit replaced.

    Only the pack's activities remain (a PI blueprint has manufacturing only)."""
    row = copy.deepcopy(template)
    row["activities"] = {
        key: client_activity(value) for key, value in blueprint["activities"].items()
    }
    row["blueprintTypeID"] = int(blueprint["blueprintTypeID"])
    row["maxProductionLimit"] = int(blueprint["maxProductionLimit"])
    return row


def product_type_ids(row: dict[str, Any]) -> list[int]:
    """`indexes` rows of the client file: one productTypeID.<id> per product of every activity."""
    found: list[int] = []
    for activity in row["activities"].values():
        for product in activity.get("products", []):
            if int(product["typeID"]) not in found:
                found.append(int(product["typeID"]))
    return found


def merge_blueprints(payload: bytes, rows: list[dict[str, Any]], destination: Path) -> bytes:
    """Adds the rows to a copy of blueprints.static (pattern: Serenity Importer
    auxiliary._merge_skin_cache_once). Refuses a key or a product that already exists."""
    destination.write_bytes(payload)
    connection = sqlite3.connect(destination)
    try:
        tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if tables != {"cache", "indexes"}:
            raise ToolError(f"blueprints.static has unexpected tables {sorted(tables)}")
        template = connection.execute(
            "SELECT value, time FROM cache WHERE key = ?", (str(TEMPLATE_BLUEPRINT_TYPE_ID),)
        ).fetchone()
        if template is None:
            raise ToolError(f"blueprints.static has no template row {TEMPLATE_BLUEPRINT_TYPE_ID}")
        row_time = float(template[1])
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("BEGIN IMMEDIATE")
        for row in rows:
            key = str(row["blueprintTypeID"])
            if connection.execute("SELECT 1 FROM cache WHERE key = ?", (key,)).fetchone():
                raise ToolError(f"blueprints.static already has blueprint {key} (applied already?)")
            for product in product_type_ids(row):
                index_key = f"productTypeID.{product}"
                existing = connection.execute("SELECT value FROM indexes WHERE key = ?", (index_key,)).fetchone()
                if existing:
                    raise ToolError(f"product {product} already has client blueprint {existing[0]}")
                connection.execute("INSERT INTO indexes (key, value) VALUES (?, ?)", (index_key, key))
            connection.execute(
                "INSERT INTO cache (key, value, time) VALUES (?, ?, ?)", (key, json.dumps(row), row_time)
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    return destination.read_bytes()


def template_row(payload: bytes, scratch: Path) -> dict[str, Any]:
    scratch.write_bytes(payload)
    connection = sqlite3.connect(scratch)
    try:
        found = connection.execute(
            "SELECT value FROM cache WHERE key = ?", (str(TEMPLATE_BLUEPRINT_TYPE_ID),)
        ).fetchone()
    finally:
        connection.close()
    if found is None:
        raise ToolError(f"blueprints.static has no template row {TEMPLATE_BLUEPRINT_TYPE_ID}")
    return json.loads(found[0])


def content_path(logical_path: str, payload: bytes, original: ResourceRecord | None) -> str:
    """Content-addressed ResFiles path, same rule as Item Forge deployment._content_path."""
    content_hash = md5_bytes(payload)
    if original:
        normalized = original.hashed_path.replace("\\", "/")
        directory, filename = normalized.split("/", 1) if "/" in normalized else (content_hash[:2], normalized)
        prefix = filename.split("_", 1)[0]
    else:
        prefix = hashlib.sha256(logical_path.casefold().encode("utf-8")).hexdigest()[:16]
        directory = prefix[:2]
    return f"{directory}/{prefix}_{content_hash}"


def _clone_record_in_body(
    body: bytearray,
    source_key: int,
    target_key: int,
    stride: int,
    mutator: Mutator | None = None,
    protected_values: set[int] | None = None,
) -> None:
    """Port of tools/ElysianFSD cfsd_shadow.clone_integer_record (body between _split and _finish),
    working on an already split body: the next clone reads the root from the current body, so a
    target bucket shadowed by an earlier clone is the starting point of the next one."""
    root_offset, row_count, bucket_count, offsets = _root(body)
    if not (0 <= source_key <= 0xFFFFFFFF and 0 <= target_key <= 0xFFFFFFFF):
        raise CfsdEncodingError("profiled integer keys are unsigned 32-bit")
    try:
        target_pointer = offsets[target_key % bucket_count]
        target_count = _u64(body, target_pointer - 8)
        _find_record(body, target_pointer, target_count, stride, target_key)
    except KeyError:
        pass
    else:
        raise KeyError(f"target key already exists: {target_key}")

    source_pointer = offsets[source_key % bucket_count]
    source_count = _u64(body, source_pointer - 8)
    source_record = _find_record(body, source_pointer, source_count, stride, source_key)
    source_nested = source_pointer + source_count * stride
    source_end = _bucket_end(body, offsets, source_pointer)
    if source_nested > source_end:
        raise CfsdEncodingError("source fixed records overlap the next bucket")

    target_nested = target_pointer + target_count * stride
    target_end = _bucket_end(body, offsets, target_pointer)
    if target_nested > target_end:
        raise CfsdEncodingError("target fixed records overlap the next bucket")

    target_fixed = bytes(body[target_pointer:target_nested])
    source_fixed = bytes(body[source_record:source_record + stride])
    target_graph = bytes(body[target_nested:target_end])
    source_graph = bytes(body[source_nested:source_end])

    new_pointer = _append_padding_for_pointer(body, target_pointer % 8)
    body.extend(struct.pack("<Q", target_count + 1))
    if len(body) != new_pointer:
        raise AssertionError("shadow bucket pointer drifted")
    body.extend(target_fixed)
    new_record = len(body)
    body.extend(source_fixed)
    new_target_nested = len(body)
    body.extend(target_graph)
    new_target_end = len(body)

    while len(body) % 8 != source_nested % 8:
        body.append(0)
    new_source_nested = len(body)
    body.extend(source_graph)
    new_end = len(body)

    target_segments = [(target_nested, target_end, new_target_nested)]
    source_segments = [(source_nested, source_end, new_source_nested)]
    target_fixed_changes = _relocate_region(
        body, new_pointer, new_record, target_segments,
        {new_pointer + index * stride for index in range(target_count)},
    )
    source_fixed_changes = _relocate_region(body, new_record, new_target_nested, source_segments, {new_record})
    target_count_locations = {new - 8 for _location, _old, new in target_fixed_changes}
    source_count_locations = {new - 8 for _location, _old, new in source_fixed_changes}
    target_graph_changes = _relocate_region(
        body, new_target_nested, new_target_end, target_segments, target_count_locations, protected_values,
    )
    source_graph_changes = _relocate_region(
        body, new_source_nested, new_end, source_segments, source_count_locations, protected_values,
    )
    relocated = [*target_fixed_changes, *source_fixed_changes, *target_graph_changes, *source_graph_changes]
    struct.pack_into("<I", body, new_record, target_key)
    _put_u64(body, root_offset + (target_key % bucket_count) * 8, new_pointer)
    _put_u64(body, 8, row_count + 1)

    context = ShadowContext(
        key=target_key,
        record_offset=new_record,
        bucket_offset=new_pointer,
        bucket_count=target_count + 1,
        fixed_stride=stride,
        old_bucket_offset=source_pointer,
        old_nested_start=source_nested,
        old_bucket_end=source_end,
        nested_start=new_source_nested,
        nested_end=new_end,
        relocated_pointers=relocated,
    )
    if mutator:
        mutator(body, context)


def clone_integer_records(payload: bytes, clones: list[tuple[int, int, Mutator | None]], stride: int) -> bytes:
    """Byte for byte the same as one clone_integer_record(payload, s, t, stride, m) per (s, t, m) in
    order, with one _split and one _finish (the pure-Python content hash of the whole table once).
    Works on a local copy: an exception half-way returns nothing. No clones = the same payload."""
    if not clones:
        return payload
    header, body = _split(payload)
    for source_key, target_key, mutator in clones:
        _clone_record_in_body(body, source_key, target_key, stride, mutator)
    return _finish(header, body)


def body_contains_root_key(body: bytes | bytearray, key: int, stride: int) -> bool:
    """item_encoding._contains_root_key on a cFSD body (payload without the 32-byte header)."""
    if len(body) < 24:
        return False
    root_offset, _total, bucket_count = struct.unpack_from("<QQQ", body, 0)
    pointer = struct.unpack_from("<Q", body, root_offset + (key % bucket_count) * 8)[0]
    count = struct.unpack_from("<Q", body, pointer - 8)[0]
    return any(struct.unpack_from("<I", body, pointer + index * stride)[0] == key for index in range(count))


def _identity_clones(
    payload: bytes, pairs: list[tuple[int, int]], stride: int, table: str, skipped: dict[str, str]
) -> list[tuple[int, int, Mutator | None]]:
    """Clones of the sources that have a record (ItemFsdEncoder.compile requiredskillsfortypes /
    typematerials): the check sees earlier targets of the same batch, as the vendor's sequence does."""
    body = payload[32:]
    cloned: set[int] = set()
    clones: list[tuple[int, int, Mutator | None]] = []
    for source, target in pairs:
        if source in cloned or body_contains_root_key(body, source, stride):
            clones.append((source, target, None))
            cloned.add(target)
        else:
            skipped[table] = f"source {source} has no identity record"
    return clones


def compile_tables(source: Callable[[str], bytes], requests: list[ItemCloneRequest]) -> ItemCompileResult:
    """ItemFsdEncoder.compile (tools/ElysianFSD item_encoding.py) for our requests, one batch per table.
    Not ported: dynamic_memberships / type_list_memberships / manufacturable_sources (packs do not use
    them). source(name) = the client payload of a table."""
    if not requests:
        return ItemCompileResult({}, [], {})
    resources: dict[str, bytes] = {}
    skipped: dict[str, str] = {}
    sources = {name: source(name) for name in ("types", "typedogma", "requiredskillsfortypes", "typematerials",
                                               "iconids")}
    resources["types"] = clone_integer_records(sources["types"], [
        (request.source_type_id, request.target_type_id,
         lambda body, context, item=request: _patch_types(body, context, item))
        for request in requests
    ], 152)
    resources["typedogma"] = clone_integer_records(sources["typedogma"], [
        (request.source_type_id, request.target_type_id,
         lambda body, context, item=request: _patch_dogma(body, context, item.dogma_overrides))
        for request in requests
    ], TYPEDOGMA_STRIDE)
    skills = clone_integer_records(sources["requiredskillsfortypes"], _identity_clones(
        sources["requiredskillsfortypes"],
        [(request.source_type_id if request.skills_source_type_id is None else request.skills_source_type_id,
          request.target_type_id) for request in requests],
        24, "requiredskillsfortypes", skipped,
    ), 24)
    materials = clone_integer_records(sources["typematerials"], _identity_clones(
        sources["typematerials"], [(request.source_type_id, request.target_type_id) for request in requests],
        32, "typematerials", skipped,
    ), 32)
    if skills != sources["requiredskillsfortypes"]:
        resources["requiredskillsfortypes"] = skills
    if materials != sources["typematerials"]:
        resources["typematerials"] = materials
    icon_clones: list[tuple[int, int, Mutator | None]] = []
    seen_icons: dict[int, tuple[int, str]] = {}
    for request in requests:
        if not request.custom_icon_file:
            continue
        source_icon_id = int(request.source_icon_id or 0)
        if not source_icon_id:
            raise CfsdEncodingError("custom icon request is missing source_icon_id")
        key = (source_icon_id, request.custom_icon_file)
        previous = seen_icons.get(request.icon_id)
        if previous is not None:
            if previous != key:
                raise CfsdEncodingError(f"icon {request.icon_id}: requests disagree on template/file")
            continue
        seen_icons[request.icon_id] = key
        icon_clones.append((source_icon_id, request.icon_id,
                            lambda body, context, path=request.custom_icon_file: _patch_icon_file(body, context, path)))
    icons = clone_integer_records(sources["iconids"], icon_clones, ICONIDS_STRIDE)
    if icons != sources["iconids"]:
        resources["iconids"] = icons
    return ItemCompileResult(resources, sorted(resources), skipped)


def compile_items(profile, requests: list[ItemCloneRequest]) -> ItemCompileResult:
    """ItemFsdEncoder(profile) still guards the schema fingerprints of the item tables; the clones are
    ours (compile_tables), read from the encoder's own sources."""
    encoder = ItemFsdEncoder(profile)
    return compile_tables(encoder._source, requests)


def load_dogma_overlays(path: Path = DOGMA_OVERLAYS_FILE) -> dict[str, Any] | None:
    """The enabled SMB overlay ({"config", "pack"}) or None (file missing or overlay disabled)."""
    if not path.is_file():
        return None
    raw = path.read_bytes()
    try:
        document = json.loads(raw.decode("utf-8"))
    except ValueError as error:
        raise ToolError(f"{path}: not JSON ({error})") from error
    if not isinstance(document, dict) or document.get("schema") != 1:
        raise ToolError(f"{path}: schema 1 expected")
    smb = document.get("smbForEveryShip")
    if smb is None:
        return None
    if not isinstance(smb, dict) or not isinstance(smb.get("enabled"), bool):
        raise ToolError(f"{path}: smbForEveryShip.enabled must be true or false")
    if not smb["enabled"]:
        return None
    ratio = smb.get("ratioPermille")
    if isinstance(ratio, bool) or not isinstance(ratio, int) or ratio not in SMB_RATIO_RANGE:
        raise ToolError(f"{path}: smbForEveryShip.ratioPermille must be an integer 1..10000")
    excluded = smb.get("excludedGroupIds", [])
    if not isinstance(excluded, list) or any(
        isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in excluded
    ):
        raise ToolError(f"{path}: smbForEveryShip.excludedGroupIds must be a list of integers > 0")
    maximum = smb.get("maxCapacityM3", 0)
    if isinstance(maximum, bool) or not isinstance(maximum, (int, float)) or maximum < 0:
        raise ToolError(f"{path}: smbForEveryShip.maxCapacityM3 must be a number >= 0 (0 = no limit)")
    return {
        "config": {"ratioPermille": ratio, "excludedGroupIds": frozenset(excluded), "maxCapacityM3": maximum},
        "pack": {"packID": SMB_OVERLAY_ID, "file": str(path), "sha256": hashlib.sha256(raw).hexdigest()},
    }


def overlay_pack_entries(overlay: dict[str, Any] | None) -> list[dict[str, Any]]:
    """State `packs` entries of the enabled overlays: a changed overlay file forces a re-apply."""
    return [overlay["pack"]] if overlay else []


def smb_capacity(group_id: int, volume: float | None, base: float | None, config: dict[str, Any]) -> float | None:
    """Same rule as the server (mods/soloProgressionBalance/lib/smbForEveryShip.js computeSmbCapacity):
    max(type SMB, floor(volume x ratio / 1000)), limit (>0) never below the type SMB. None = not applicable."""
    if group_id in config["excludedGroupIds"]:
        return None
    if volume is None or not math.isfinite(volume) or volume <= 0:
        return None
    base_value = base if base is not None and math.isfinite(base) and base > 0 else 0.0
    capacity = max(base_value, float(math.floor(volume * config["ratioPermille"] / 1000)))
    if config["maxCapacityM3"] > 0:
        capacity = max(base_value, min(capacity, float(config["maxCapacityM3"])))
    return capacity


def load_sde_ships(sde_dir: Path) -> dict[int, tuple[int, float | None]]:
    """Every category-6 type of the SDE as {typeID: (groupID, volume)} (groups.jsonl + types.jsonl)."""
    groups_path, types_path = sde_dir / "groups.jsonl", sde_dir / "types.jsonl"
    if not groups_path.is_file() or not types_path.is_file():
        raise ToolError(f"SDE not found in {sde_dir} (groups.jsonl, types.jsonl); use --sde <dir>")
    ship_groups: set[int] = set()
    with groups_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                if row.get("categoryID") == CATEGORY_SHIP:
                    ship_groups.add(int(row["_key"]))
    ships: dict[int, tuple[int, float | None]] = {}
    with types_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            group_id = row.get("groupID")
            if group_id in ship_groups:
                volume = row.get("volume")
                ships[int(row["_key"])] = (int(group_id), float(volume) if volume is not None else None)
    if not ships:
        raise ToolError(f"no ship types (category {CATEGORY_SHIP}) in {sde_dir}")
    return ships


def _dogma_record(body: bytes | bytearray, type_id: int) -> int | None:
    """Offset of the typedogma record of type_id in a cFSD body, None when the type has no record."""
    root_offset, _rows, bucket_count = struct.unpack_from("<QQQ", body, 0)
    pointer = struct.unpack_from("<Q", body, root_offset + (type_id % bucket_count) * 8)[0]
    count = struct.unpack_from("<Q", body, pointer - 8)[0]
    for index in range(count):
        record = pointer + index * TYPEDOGMA_STRIDE
        if struct.unpack_from("<I", body, record)[0] == type_id:
            return record
    return None


def read_dogma_attributes(body: bytes | bytearray, type_id: int) -> dict[int, float] | None:
    """{attributeID: value} of one typedogma record (body = payload without the 32-byte header)."""
    record = _dogma_record(body, type_id)
    if record is None:
        return None
    pointer = struct.unpack_from("<Q", body, record + 8)[0]
    count = struct.unpack_from("<Q", body, pointer - 8)[0]
    return {
        attribute_id: value
        for value, attribute_id, _pad in (
            struct.unpack_from("<dII", body, pointer + index * TYPEDOGMA_ATTRIBUTE_SIZE) for index in range(count)
        )
    }


def _set_dogma_attributes(body: bytearray, context: Any, type_id: int, wanted: dict[int, float]) -> None:
    """Rewrites the attributes vector of the shadowed record: wanted IDs overwritten or added, sorted by
    attribute ID (the layout of append_type_dogma_attributes, tools/ElysianFSD item_encoding.py)."""
    location = context.record_offset + 8
    old_pointer = struct.unpack_from("<Q", body, location)[0]
    if old_pointer < max(8, context.nested_start) or old_pointer > context.nested_end:
        raise ToolError(f"typeDogma[{type_id}] attributes pointer is invalid")
    count = struct.unpack_from("<Q", body, old_pointer - 8)[0]
    if count >= 100_000 or old_pointer + count * TYPEDOGMA_ATTRIBUTE_SIZE > context.nested_end:
        raise ToolError(f"typeDogma[{type_id}] attributes vector is invalid")
    entries = [
        list(struct.unpack_from("<dII", body, old_pointer + index * TYPEDOGMA_ATTRIBUTE_SIZE))
        for index in range(count)
    ]
    present = {entry[1]: entry for entry in entries}
    for attribute_id, value in wanted.items():
        if attribute_id in present:
            present[attribute_id][0] = float(value)
        else:
            entries.append([float(value), attribute_id, 0])
    entries.sort(key=lambda entry: entry[1])
    new_pointer = append_vector(
        body,
        b"".join(struct.pack("<dII", *entry) for entry in entries),
        len(entries),
        pointer_modulo=old_pointer % 8,
    )
    struct.pack_into("<Q", body, location, new_pointer)


def apply_smb_overlay(
    payload: bytes, ships: dict[int, tuple[int, float | None]], config: dict[str, Any]
) -> tuple[bytes, dict[str, Any]]:
    """907 = 1 and 908 = smb_capacity on every ship record of a typedogma payload.

    Batch form of `rewrite_integer_record` (cfsd_shadow.py): the same shadow-and-append per record,
    but one split and one content hash for the whole table (the pure-Python hash per record would take
    hours for ~500 ships). Byte-identical to calling append_type_dogma_attributes per ship."""
    header, body = _split(payload)
    present = set(integer_root_keys(payload, TYPEDOGMA_STRIDE))
    changed: dict[int, float] = {}
    report: dict[str, Any] = {"shipTypes": len(ships), "excluded": 0, "notApplicable": 0,
                              "withoutDogmaRecord": 0, "unchanged": 0, "changed": 0}
    for type_id in sorted(ships):
        group_id, volume = ships[type_id]
        if group_id in config["excludedGroupIds"]:
            report["excluded"] += 1
            continue
        if type_id not in present:
            report["withoutDogmaRecord"] += 1
            continue
        attributes = read_dogma_attributes(body, type_id) or {}
        capacity = smb_capacity(group_id, volume, attributes.get(ATTRIBUTE_SMB_CAPACITY), config)
        if capacity is None or capacity <= 0:
            report["notApplicable"] += 1
            continue
        wanted = {ATTRIBUTE_HAS_SMB: 1.0, ATTRIBUTE_SMB_CAPACITY: capacity}
        if all(attributes.get(key) == value for key, value in wanted.items()):
            report["unchanged"] += 1
            continue
        context = _shadow_existing_bucket(header, body, type_id, TYPEDOGMA_STRIDE)
        _set_dogma_attributes(body, context, type_id, wanted)
        changed[type_id] = capacity
    report["changed"] = len(changed)
    report["examples"] = {str(type_id): changed[type_id] for type_id in sorted(changed)[:5]}
    for type_id in (24700, 28606):
        if type_id in changed:
            report["examples"][str(type_id)] = changed[type_id]
    if not changed:
        return payload, report
    result = _finish(header, body)
    result_body = result[32:]
    for type_id, capacity in changed.items():
        attributes = read_dogma_attributes(result_body, type_id) or {}
        if attributes.get(ATTRIBUTE_HAS_SMB) != 1.0 or attributes.get(ATTRIBUTE_SMB_CAPACITY) != capacity:
            raise ToolError(f"SMB overlay read-back of type {type_id} failed: {attributes.get(ATTRIBUTE_SMB_CAPACITY)}")
    report["changedTypeIDs"] = sorted(changed)
    return result, report


def root_env_value(key: str, path: Path = ROOT_ENV_FILE) -> str | None:
    """A key of the repository .env (the Docker server reads it through compose), None when unset."""
    if not path.is_file():
        return None
    value = None
    for line in path.read_text("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, raw = stripped.partition("=")
        if name.strip() == key:
            value = raw.strip().strip("\"'")
    return value or None


def smb_ratio_warning(config: dict[str, Any], env_path: Path = ROOT_ENV_FILE) -> str | None:
    """A client ratio other than the server's only changes Show Info; warn, do not refuse."""
    server = root_env_value(SMB_ENV_RATIO, env_path)
    if server is None:
        server_ratio = 750
    else:
        try:
            server_ratio = int(server)
        except ValueError:
            return f"{SMB_ENV_RATIO}={server!r} in {env_path} is not an integer; the server refuses it"
    if server_ratio != config["ratioPermille"]:
        return (f"SMB overlay ratio {config['ratioPermille']} per mille differs from the server's {server_ratio} "
                f"({SMB_ENV_RATIO} in {env_path}); Show Info and the client capacity check will differ from the server")
    return None


def apply_dogma_overlays(
    dogma_payload: bytes,
    overlay: dict[str, Any] | None,
    sde_dir: Path,
    ships_loader: Callable[[Path], dict[int, tuple[int, float | None]]] = load_sde_ships,
) -> tuple[bytes, dict[str, Any] | None]:
    """Overlay disabled -> the payload unchanged (same bytes) and no report."""
    if not overlay:
        return dogma_payload, None
    return apply_smb_overlay(dogma_payload, ships_loader(sde_dir), overlay["config"])


def verify_smb_natively(profile, payload: bytes, report: dict[str, Any], staging: Path) -> None:
    """Reads changed ship records back with the client's own FSD loader (as verify_types_natively)."""
    changed = report.get("changedTypeIDs") or []
    if not changed:
        return
    sample = sorted({*changed[:SMB_NATIVE_PROBES], *(key for key in (24700, 28606) if key in changed)})
    path = staging / "typedogma.verify.fsdbinary"
    path.write_bytes(payload)
    try:
        native = NativeLoaderHost(profile).verify_table(
            "typedogma", resource_path=path, probes=[{"key": key} for key in sample], persist=False, semantic=False,
        )
    finally:
        path.unlink(missing_ok=True)
    if not native.success:
        raise ToolError(f"native loader could not read the overlaid typedogma table: {native.error}")
    expected = {int(key): value for key, value in report["examples"].items()}
    for probe in native.probes:
        values = {int(entry["attributeID"]): entry["value"]
                  for entry in ((probe.get("value") or {}).get("dogmaAttributes") or [])}
        key = int(probe.get("key"))
        if values.get(ATTRIBUTE_HAS_SMB) != 1.0 or values.get(ATTRIBUTE_SMB_CAPACITY) is None:
            raise ToolError(f"native read of typedogma {key}: 907={values.get(ATTRIBUTE_HAS_SMB)} "
                            f"908={values.get(ATTRIBUTE_SMB_CAPACITY)}")
        if key in expected and values[ATTRIBUTE_SMB_CAPACITY] != expected[key]:
            raise ToolError(f"native read of typedogma {key}: 908={values[ATTRIBUTE_SMB_CAPACITY]} != {expected[key]}")
    report["nativeCheck"] = f"{len(sample)} ship records read back by the client loader"


def allocate_messages(index: ResourceIndex, count: int) -> list[int]:
    used = used_message_ids(index)
    result: list[int] = []
    for value in MESSAGE_RANGE:
        if value not in used:
            result.append(value)
            if len(result) == count:
                return result
    raise ToolError("localization message ID range exhausted")


def verify_types_natively(profile, payload: bytes, requests: list[ItemCloneRequest], staging: Path) -> list[str]:
    """Reads the compiled types table back with the client's own FSD loader (Elysian native host,
    as ItemEncoderVerifier does) and checks every custom record."""
    path = staging / "types.verify.fsdbinary"
    path.write_bytes(payload)
    try:
        report = NativeLoaderHost(profile).verify_table(
            "types",
            resource_path=path,
            probes=[{"key": request.target_type_id} for request in requests],
            persist=False,
            semantic=False,
        )
    finally:
        path.unlink(missing_ok=True)
    if not report.success:
        raise ToolError(f"native loader could not read the compiled types table: {report.error}")
    warnings: list[str] = []
    for request in requests:
        record = next((probe.get("value") for probe in report.probes if probe.get("key") == request.target_type_id), None)
        record = record or {}
        expected = {
            "typeID": request.target_type_id,
            "typeNameID": request.name_message_id,
            **{key: value for key, value in request.field_overrides.items() if key in NATIVE_FIELD_CHECKS},
        }
        actual = {key: record.get(key) for key in expected}
        if actual != expected:
            raise ToolError(f"native read of type {request.target_type_id}: {actual} != {expected}")
        if record.get("iconID") is None:
            if request.custom_icon_file:
                raise ToolError(f"source {request.source_type_id} has no iconID; a custom icon needs one "
                                f"(type {request.target_type_id})")
            warnings.append(f"type {request.target_type_id}: source has no iconID, the client keeps the "
                            f"source's look (graphicID {record.get('graphicID')})")
        elif request.icon_id == 0:
            raise ToolError(f"type {request.target_type_id}: overrides.iconID is null, but source "
                            f"{request.source_type_id} has iconID {record.get('iconID')} (null is only for a "
                            f"source without one)")
        elif record.get("iconID") != request.icon_id:
            raise ToolError(f"native read of type {request.target_type_id}: iconID {record.get('iconID')}")
    return warnings


def verify_icons_natively(profile, payload: bytes, requests: list[ItemCloneRequest], staging: Path) -> None:
    """Reads the new iconids records back with the client's FSD loader: iconFile = the new logical path."""
    custom = [request for request in requests if request.custom_icon_file]
    if not custom:
        return
    path = staging / "iconids.verify.fsdbinary"
    path.write_bytes(payload)
    try:
        report = NativeLoaderHost(profile).verify_table(
            "iconids", resource_path=path, probes=[{"key": request.icon_id} for request in custom],
            persist=False, semantic=False,
        )
    finally:
        path.unlink(missing_ok=True)
    if not report.success:
        raise ToolError(f"native loader could not read the compiled iconids table: {report.error}")
    for request in custom:
        record = next((probe.get("value") for probe in report.probes if probe.get("key") == request.icon_id), None)
        if (record or {}).get("iconFile") != request.custom_icon_file:
            raise ToolError(f"native read of icon {request.icon_id}: iconFile {(record or {}).get('iconFile')!r}")


def require_dogma_attributes(dogma_payload: bytes, requests: list[ItemCloneRequest]) -> None:
    """dogma.attributes may only change attributes the source's typeDogma record carries (vendor
    _patch_dogma raises CfsdEncodingError otherwise); refused up front with a readable message."""
    body = dogma_payload[32:]
    problems: list[str] = []
    for request in requests:
        if not request.dogma_overrides:
            continue
        present = read_dogma_attributes(body, request.source_type_id) or {}
        missing = sorted(set(request.dogma_overrides) - set(present))
        if missing:
            problems.append(f"type {request.target_type_id}: dogma.attributes {', '.join(map(str, missing))} not on "
                            f"source {request.source_type_id}")
    if problems:
        raise ToolError("; ".join(problems) + " - only attributes the source record carries can be overridden")


def check_dogma_overrides(dogma_payload: bytes, requests: list[ItemCloneRequest]) -> None:
    """Self-check after compiling: every override reads back from the result with the planned value."""
    body = dogma_payload[32:]
    for request in requests:
        if not request.dogma_overrides:
            continue
        values = read_dogma_attributes(body, request.target_type_id) or {}
        for attribute_id, value in request.dogma_overrides.items():
            if values.get(attribute_id) != value:
                raise ToolError(f"typeDogma read-back of type {request.target_type_id}: attribute {attribute_id} = "
                                f"{values.get(attribute_id)}, planned {value}")


def require_icon_ids(iconids_payload: bytes, icons: list[dict[str, Any]]) -> None:
    """templateIconID must be a client iconids record, the new iconID must not be one yet."""
    body = iconids_payload[32:]
    for icon in icons:
        if not body_contains_root_key(body, icon["templateIconID"], ICONIDS_STRIDE):
            raise ToolError(f"icon {icon['iconID']}: templateIconID {icon['templateIconID']} is not in the client's iconids")
        if body_contains_root_key(body, icon["iconID"], ICONIDS_STRIDE):
            raise ToolError(f"icon {icon['iconID']} already in the client (status?)")


def icon_logical_path(icon_id: int) -> str:
    return ICON_LOGICAL.format(icon_id=icon_id)


def icon_resources(
    index: ResourceIndex, icons: list[dict[str, Any]]
) -> tuple[dict[str, bytes], dict[str, ResourceRecord | None], list[dict[str, Any]]]:
    """The PNG of every icon as a new ResFiles payload (no original record: content_path derives the
    prefix from the logical path, render_updated_files appends a line to resfileindex.txt only)."""
    payloads: dict[str, bytes] = {}
    originals: dict[str, ResourceRecord | None] = {}
    entries: list[dict[str, Any]] = []
    for icon in icons:
        logical = icon_logical_path(icon["iconID"])
        if index.get(logical):
            raise ToolError(f"{logical} is already in the client index (status?)")
        payloads[logical] = icon["payload"]
        originals[logical] = None
        entries.append({"iconID": icon["iconID"], "templateIconID": icon["templateIconID"], "packID": icon["packID"],
                        "file": icon["file"], "sha256": icon["sha256"], "logical": logical})
    return payloads, originals, entries


def stage_payloads(
    index: ResourceIndex, payloads: dict[str, bytes], originals: dict[str, ResourceRecord | None], staging: Path
) -> tuple[dict[str, ResourceRecord], dict[Path, bytes]]:
    """Writes every payload under staging/ResFiles and the updated index files under staging/tq."""
    replacements: dict[str, ResourceRecord] = {}
    for logical, payload in payloads.items():
        record = ResourceRecord(
            logical, content_path(logical, payload, originals[logical]), md5_bytes(payload), len(payload), len(payload)
        )
        replacements[logical] = record
        target = staging / "ResFiles" / Path(record.hashed_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    index_outputs = index.render_updated_files(replacements)
    for path, payload in index_outputs.items():
        (staging / "tq").mkdir(exist_ok=True)
        (staging / "tq" / path.name).write_bytes(payload)
    return replacements, index_outputs


def require_dogma_sources(
    dogma_payload: bytes,
    requests: list[ItemCloneRequest],
    has_record: Callable[[bytes, int, int], bool] = _contains_root_key,
) -> None:
    """ItemFsdEncoder.compile clones the typedogma record of every source; a source without
    one makes clone_integer_record raise a KeyError. Refuse such a pack up front, by name."""
    missing = sorted({
        request.source_type_id for request in requests
        if not has_record(dogma_payload, request.source_type_id, TYPEDOGMA_STRIDE)
    })
    if missing:
        raise ToolError(
            "; ".join(f"source {type_id} has no typeDogma record" for type_id in missing)
            + " - the client encoder cannot clone it; use a source type with a dogma record"
        )


def item_description(pack_id: str, entry: dict[str, Any], name: str) -> str:
    """overrides.description if the pack has one, else the generic text."""
    description = entry.get("overrides", {}).get("description")
    if description:
        return str(description)
    return f"{name}. Custom type {entry['typeID']} (customTypes pack {pack_id})."


def build_plan(
    client: Path,
    pack_paths: list[Path],
    staging: Path,
    skip_proof: bool,
    overlay: dict[str, Any] | None = None,
    sde_dir: Path = DEFAULT_SDE_DIR,
) -> dict[str, Any]:
    started = time.perf_counter()
    timings: dict[str, float] = {}
    index = ResourceIndex.load(client)
    profile = discover_build_profile(client)
    packs = load_packs(pack_paths)
    pack_label = "+".join(packs["packIDs"] + [entry["packID"] for entry in overlay_pack_entries(overlay)])
    if not skip_proof:
        proof = ensure_item_encoder_verified(profile)
        if not proof.success:
            raise ToolError("Item Forge encoder proof failed: " + "; ".join(proof.errors or ["unknown"]))

    types = packs["types"]
    icons_by_id = {icon["iconID"]: icon for icon in packs["icons"]}
    messages = allocate_messages(index, 2 * len(types))
    items: list[CustomItem] = []
    requests: list[ItemCloneRequest] = []
    for position, (pack_id, entry) in enumerate(types):
        overrides = entry.get("overrides", {})
        if "iconID" not in overrides:
            raise ToolError(f"type {entry['typeID']}: overrides.iconID is required by this tool "
                            f"(null only for a source without an iconID)")
        icon = icons_by_id.get(overrides["iconID"])
        name = str(overrides.get("name") or f"Custom type {entry['typeID']}")
        item = CustomItem(
            item_id=f"{pack_id}:{entry['typeID']}",
            source_type_id=int(entry["sourceTypeID"]),
            name=name,
            description=item_description(pack_id, entry, name),
            target_type_id=int(entry["typeID"]),
            native_icon_id=overrides.get("iconID"),
            name_message_id=messages[2 * position],
            description_message_id=messages[2 * position + 1],
            published=bool(overrides.get("published", True)),
        )
        field_overrides: dict[str, Any] = {}
        if overrides.get("groupID") is not None:
            field_overrides["groupID"] = int(overrides["groupID"])
        if overrides.get("basePrice") is not None:
            field_overrides["basePrice"] = float(overrides["basePrice"])
        for key in NUMERIC_FIELD_OVERRIDES:
            if key in overrides:
                field_overrides[key] = float(overrides[key])
        dogma_overrides = {int(key): float(value)
                           for key, value in entry.get("dogma", {}).get("attributes", {}).items()}
        items.append(item)
        requests.append(
            ItemCloneRequest(
                source_type_id=item.source_type_id,
                target_type_id=item.target_type_id,
                name_message_id=item.name_message_id,
                description_message_id=item.description_message_id,
                icon_id=0 if overrides["iconID"] is None else int(overrides["iconID"]),
                market_group_id=None,
                published=item.published,
                source_icon_id=icon["templateIconID"] if icon else None,
                dogma_overrides=dogma_overrides,
                field_overrides=field_overrides,
                custom_icon_file=icon_logical_path(icon["iconID"]) if icon else None,
            )
        )

    dogma_client = profile.table("typedogma").resource_path.read_bytes()
    require_dogma_sources(dogma_client, requests)
    require_dogma_attributes(dogma_client, requests)
    if packs["icons"]:
        require_icon_ids(profile.table("iconids").resource_path.read_bytes(), packs["icons"])
    phase = time.perf_counter()
    try:
        compiled = compile_items(profile, requests)
    except CfsdEncodingError as error:
        raise ToolError(f"ItemFsdEncoder refused the pack: {error}") from error
    except KeyError as error:
        raise ToolError(f"ItemFsdEncoder: {error} - the type is already in the client data (status?)") from error
    check_dogma_overrides(compiled.resources["typedogma"], requests)
    timings["encoder"] = time.perf_counter() - phase

    staging.mkdir(parents=True, exist_ok=False)
    phase = time.perf_counter()
    warnings = [] if skip_proof else verify_types_natively(profile, compiled.resources["types"], requests, staging)
    if not skip_proof and "iconids" in compiled.resources:
        verify_icons_natively(profile, compiled.resources["iconids"], requests, staging)
    timings["nativeCheck"] = time.perf_counter() - phase

    phase = time.perf_counter()
    overlay_report = None
    if overlay:
        dogma_source = compiled.resources.get("typedogma") or profile.table("typedogma").resource_path.read_bytes()
        dogma_payload, overlay_report = apply_dogma_overlays(dogma_source, overlay, sde_dir)
        if dogma_payload is not dogma_source:
            compiled.resources["typedogma"] = dogma_payload
            if skip_proof:
                overlay_report["nativeCheck"] = "skipped (--skip-proof)"
            else:
                verify_smb_natively(profile, dogma_payload, overlay_report, staging)
        ratio_warning = smb_ratio_warning(overlay["config"])
        if ratio_warning:
            warnings.append(ratio_warning)
    timings["dogmaOverlays"] = time.perf_counter() - phase

    payloads: dict[str, bytes] = {}
    originals: dict[str, ResourceRecord | None] = {}
    for table_name, payload in compiled.resources.items():
        logical = profile.table(table_name).logical_path
        payloads[logical] = payload
        originals[logical] = index.require(logical)
    icon_payloads, icon_originals, icon_entries = icon_resources(index, packs["icons"])
    payloads.update(icon_payloads)
    originals.update(icon_originals)

    phase = time.perf_counter()
    item_pack = ItemPack(project_id=f"customTypes:{pack_label}", name=pack_label, build=profile.build, items=items)
    for record in localization_records(index):
        payloads[record.logical_path] = patch_language_payload(index.read(record), item_pack)
        originals[record.logical_path] = record
    timings["localization"] = time.perf_counter() - phase

    phase = time.perf_counter()
    blueprint_rows: list[dict[str, Any]] = []
    if packs["blueprints"]:
        original = index.require(BLUEPRINTS_LOGICAL)
        source = index.read(original)
        template = template_row(source, staging / "template.sqlite")
        (staging / "template.sqlite").unlink()
        blueprint_rows = [client_blueprint_row(template, entry) for entry in packs["blueprints"]]
        payloads[original.logical_path] = merge_blueprints(source, blueprint_rows, staging / "blueprints.static")
        originals[original.logical_path] = original
    timings["blueprints"] = time.perf_counter() - phase

    phase = time.perf_counter()
    replacements, index_outputs = stage_payloads(index, payloads, originals, staging)
    timings["indexes"] = time.perf_counter() - phase
    timings["total"] = time.perf_counter() - started

    summary = {
        "packID": pack_label,
        "packIDs": packs["packIDs"],
        "packs": packs["packs"] + overlay_pack_entries(overlay),
        "dogmaOverlays": {SMB_OVERLAY_ID: overlay_report} if overlay_report else {},
        "client": str(index.client_root),
        "build": profile.build,
        "typeIDs": [item.target_type_id for item in items],
        "messageIDs": messages,
        "encoderSkippedTables": compiled.skipped_tables,
        "nativeCheck": "skipped (--skip-proof)" if skip_proof else "types read back by the client loader",
        "warnings": warnings,
        "replacements": {
            logical: {
                "from": originals[logical].hashed_path if originals[logical] else None,
                "to": record.hashed_path,
                "size": record.uncompressed_size,
            }
            for logical, record in sorted(replacements.items())
        },
        "indexSha256Before": {path.name: sha256_file(path) for path in index_outputs},
        "icons": icon_entries,
        "timings": {name: round(seconds, 3) for name, seconds in timings.items()},
        "blueprintRows": blueprint_rows,
    }
    (staging / "plan.json").write_text(json.dumps(summary, indent=2) + "\n", "utf-8")
    return {"summary": summary, "replacements": replacements, "index": index, "indexOutputs": index_outputs}


def client_running() -> bool:
    if os.name != "nt":
        return False
    result = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {CLIENT_PROCESS}", "/NH"],
        capture_output=True, text=True, check=False,
    )
    return CLIENT_PROCESS.casefold() in result.stdout.casefold()


def read_state(state_dir: Path) -> dict[str, Any] | None:
    path = state_dir / STATE_FILE
    return json.loads(path.read_text("utf-8")) if path.is_file() else None


def write_state(state_dir: Path, state: dict[str, Any]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    temporary = state_dir / (STATE_FILE + ".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", "utf-8")
    os.replace(temporary, state_dir / STATE_FILE)


def replace_file(target: Path, payload: bytes) -> None:
    temporary = target.with_name(target.name + ".customtypes.tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, target)


def now_stamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def command_plan(args: argparse.Namespace) -> int:
    staging = args.state_dir / f"plan-{now_stamp()}"
    state = read_state(args.state_dir)
    if state and state.get("status") == "applied":
        print("Note: a previous apply is active. `plan` reads the CURRENT client index, so it refuses the "
              "types applied already; `apply` rolls the previous apply back first (README, Re-apply).")
    plan = build_plan(args.client, args.pack, staging, args.skip_proof,
                      load_dogma_overlays(args.dogma_overlays), args.sde)
    printed = {key: value for key, value in plan["summary"].items() if key != "blueprintRows"}
    printed["dogmaOverlays"] = {
        name: {key: value for key, value in report.items() if key != "changedTypeIDs"}
        for name, report in printed["dogmaOverlays"].items()
    }
    print(json.dumps(printed, indent=2))
    shutil.rmtree(staging / "ResFiles", ignore_errors=True)
    print(f"Plan in {staging} - nothing written to the client.")
    return 0


def index_as_applied(state: dict[str, Any]) -> bool:
    tq_root = Path(state["tqRoot"])
    return all(
        (tq_root / name).is_file() and sha256_file(tq_root / name) == digests.get("appliedSha256")
        for name, digests in state["indexFiles"].items()
    )


def command_apply(args: argparse.Namespace) -> int:
    """Re-apply = rollback, then a fresh apply (the encoder and blueprints.static refuse a type or a
    blueprint that is already in the client data, so an in-place rewrite is not possible). The same
    pack files on an unchanged index: nothing to do."""
    state = read_state(args.state_dir)
    if state and state.get("status") == "applying":
        raise ToolError(f"the apply at {state['appliedAt']} was interrupted - run `rollback --force` first")
    if state and state.get("status") == "applied":
        packs = load_packs(args.pack)["packs"] + overlay_pack_entries(load_dogma_overlays(args.dogma_overlays))
        if same_packs(state, packs) and index_as_applied(state):
            print(f"Already applied at {state['appliedAt']} from the same pack files "
                  f"({', '.join(entry['packID'] for entry in packs)}); nothing to do.")
            return 0
        print(f"Re-apply: rolling back the apply of {state.get('packID')} at {state['appliedAt']} first.")
        command_rollback(args)
    return apply_fresh(args)


def apply_fresh(args: argparse.Namespace) -> int:
    if client_running():
        raise ToolError(f"close the EVE client ({CLIENT_PROCESS}) first")
    stamp = now_stamp()
    plan = build_plan(args.client, args.pack, args.state_dir / f"apply-{stamp}", args.skip_proof,
                      load_dogma_overlays(args.dogma_overlays), args.sde)
    index: ResourceIndex = plan["index"]
    for path, digest in plan["summary"]["indexSha256Before"].items():
        if sha256_file(index.tq_root / path) != digest:
            raise ToolError(f"{path} changed while planning - retry")

    backup = args.state_dir / f"backup-{stamp}"
    backup.mkdir(parents=True, exist_ok=False)
    index_files: dict[str, dict[str, str]] = {}
    for path in plan["indexOutputs"]:
        shutil.copy2(path, backup / path.name)
        if sha256_file(backup / path.name) != plan["summary"]["indexSha256Before"][path.name]:
            raise ToolError(f"backup of {path.name} does not match the original - nothing written")
        index_files[path.name] = {"originalSha256": plan["summary"]["indexSha256Before"][path.name]}

    created: list[str] = []
    written_index: list[Path] = []
    state = {
        "status": "applying",
        "appliedAt": stamp,
        "client": str(index.client_root),
        "tqRoot": str(index.tq_root),
        "backupDir": str(backup),
        "indexFiles": index_files,
        "plannedPayloads": [
            str(index.client_root / "ResFiles" / Path(record.hashed_path))
            for record in plan["replacements"].values()
            if not (index.client_root / "ResFiles" / Path(record.hashed_path)).exists()
        ],
        "createdPayloads": created,
        **{key: plan["summary"][key] for key in ("packID", "packIDs", "packs", "typeIDs", "messageIDs",
                                                 "replacements")},
    }
    write_state(args.state_dir, state)
    try:
        for record in plan["replacements"].values():
            target = index.client_root / "ResFiles" / Path(record.hashed_path)
            if target.exists():
                if md5_bytes(target.read_bytes()) != record.md5:
                    raise ToolError(f"content-addressed payload collision: {target}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = (args.state_dir / f"apply-{stamp}" / "ResFiles" / Path(record.hashed_path)).read_bytes()
            replace_file(target, payload)
            created.append(str(target))
        for path, payload in plan["indexOutputs"].items():
            replace_file(path, payload)
            written_index.append(path)
            index_files[path.name]["appliedSha256"] = sha256_file(path)
    except Exception:
        for path in written_index:
            shutil.copyfile(backup / path.name, path)
        for name in created:
            Path(name).unlink(missing_ok=True)
        state["status"] = "failed"
        write_state(args.state_dir, state)
        raise

    state["status"] = "applied"
    write_state(args.state_dir, state)
    shutil.rmtree(args.state_dir / f"apply-{stamp}" / "ResFiles", ignore_errors=True)
    print(f"Applied packs {plan['summary']['packID']}: {len(plan['replacements'])} resources, "
          f"{len(created)} new payload files, index backup in {backup}.")
    print("Timings (s): " + json.dumps(plan["summary"]["timings"]))
    return 0


def command_rollback(args: argparse.Namespace) -> int:
    state = read_state(args.state_dir)
    if not state or state.get("status") not in ("applied", "applying"):
        raise ToolError("nothing applied (no active state)")
    if state["status"] == "applying" and not args.force:
        raise ToolError("the last apply was interrupted; `rollback --force` restores the backed-up index")
    if client_running():
        raise ToolError(f"close the EVE client ({CLIENT_PROCESS}) first")
    tq_root = Path(state["tqRoot"])
    backup = Path(state["backupDir"])
    drifted = [
        name for name, digests in state["indexFiles"].items()
        if not (tq_root / name).is_file() or sha256_file(tq_root / name) != digests.get("appliedSha256")
    ]
    if drifted and not args.force:
        raise ToolError(
            "these index files changed after apply (client update, launcher repair, another tool): "
            + ", ".join(drifted) + ". Restoring the backup would undo that change; use --force only if you are sure."
        )
    for name, digests in state["indexFiles"].items():
        if sha256_file(backup / name) != digests["originalSha256"]:
            raise ToolError(f"backup {backup / name} is damaged - nothing restored")
    for name in state["indexFiles"]:
        replace_file(tq_root / name, (backup / name).read_bytes())
    restored = ResourceIndex.load(Path(state["client"]))
    referenced = {
        str(Path(state["client"]) / "ResFiles" / Path(record.hashed_path)).casefold() for record in restored.records
    }
    removed = 0
    for name in dict.fromkeys([*state["createdPayloads"], *state.get("plannedPayloads", [])]):
        if name.casefold() not in referenced and Path(name).is_file():
            Path(name).unlink()
            removed += 1
    state["status"] = "rolled_back"
    state["rolledBackAt"] = now_stamp()
    write_state(args.state_dir, state)
    print(f"Rolled back packs {state.get('packID')}: index restored from {backup}, {removed} payload files removed.")
    return 0


def command_status(args: argparse.Namespace) -> int:
    state = read_state(args.state_dir)
    if not state:
        print("No state: nothing applied by this tool.")
        return 0
    print(json.dumps({key: state[key] for key in ("status", "packID", "typeIDs", "appliedAt") if key in state}, indent=2))
    for entry in state_packs(state):
        current = "missing"
        if entry.get("file") and Path(entry["file"]).is_file():
            current = "same" if sha256_file(Path(entry["file"])) == entry.get("sha256") else "CHANGED since apply"
        print(f"pack {entry.get('packID')} ({entry.get('file')}): {current}")
    if state.get("status") == "applied":
        tq_root = Path(state["tqRoot"])
        for name, digests in state["indexFiles"].items():
            current = sha256_file(tq_root / name) if (tq_root / name).is_file() else None
            verdict = "as applied" if current == digests.get("appliedSha256") else "CHANGED since apply"
            print(f"{name}: {verdict}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="customTypes client data (blueprints.static + item types)")
    parser.add_argument("command", choices=("plan", "apply", "rollback", "status"))
    parser.add_argument("--client", type=Path, default=os.environ.get("EVEJS_CLIENT_PATH"),
                        help="client folder, e.g. \"D:\\EVE Online\" (or EVEJS_CLIENT_PATH)")
    parser.add_argument("--pack", type=Path, action="append", default=None,
                        help="pack JSON, repeatable (default: every data/*.json pack, applied together)")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR, help="backups, staging, state.json")
    parser.add_argument("--skip-proof", action="store_true", help="do not run the Item Forge encoder proof")
    parser.add_argument("--force", action="store_true", help="rollback even if the index changed after apply")
    parser.add_argument("--dogma-overlays", type=Path, default=DOGMA_OVERLAYS_FILE,
                        help="dogma overlay file (default: dogma-overlays.json next to this tool; disabled overlays "
                             "change nothing)")
    parser.add_argument("--sde", type=Path, default=DEFAULT_SDE_DIR,
                        help="SDE jsonl folder for the ship list and volumes of the SMB overlay")
    args = parser.parse_args(argv)
    if args.command in ("plan", "apply") and not args.client:
        parser.error("--client is required (or set EVEJS_CLIENT_PATH)")
    commands = {"plan": command_plan, "apply": command_apply, "rollback": command_rollback, "status": command_status}
    try:
        if args.pack is None and args.command in ("plan", "apply"):
            args.pack = default_pack_paths()
        return commands[args.command](args)
    except ToolError as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
