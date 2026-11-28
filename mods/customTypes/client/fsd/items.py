# SPDX-License-Identifier: AGPL-3.0-only
# Port of EveJS tools/ElysianFSD/elysian_fsd/item_encoding.py (record mutators of the item tables).
"""Record layouts and mutators of the item tables (types, typedogma, iconids)."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any

from .cfsd import CfsdEncodingError, ShadowContext, append_vector, rewrite_integer_record

TYPES_STRIDE = 152
TYPEDOGMA_STRIDE = 24
TYPEDOGMA_ATTRIBUTE_SIZE = 16
REQUIRED_SKILLS_STRIDE = 24
TYPE_MATERIALS_STRIDE = 32
ICONIDS_STRIDE = 32

TYPE_FIELDS: dict[str, tuple[int, str]] = {
    "basePrice": (8, "<d"),
    "capacity": (16, "<d"),
    "mass": (32, "<d"),
    "portionSize": (40, "<Q"),
    "radius": (48, "<d"),
    "volume": (56, "<d"),
    "descriptionID": (68, "<I"),
    "groupID": (84, "<I"),
    "iconID": (88, "<I"),
    "marketGroupID": (96, "<I"),
    "metaGroupID": (100, "<I"),
    "published": (124, "<I"),
    "typeID": (128, "<I"),
    "typeNameID": (132, "<I"),
}


@dataclass(frozen=True, slots=True)
class ItemCloneRequest:
    source_type_id: int
    target_type_id: int
    name_message_id: int
    description_message_id: int
    icon_id: int
    market_group_id: int | None
    published: bool = True
    source_icon_id: int | None = None
    skills_source_type_id: int | None = None
    dogma_overrides: dict[int, float] = field(default_factory=dict)
    field_overrides: dict[str, Any] = field(default_factory=dict)
    custom_icon_file: str | None = None


@dataclass(slots=True)
class ItemCompileResult:
    resources: dict[str, bytes]
    changed_tables: list[str]
    skipped_tables: dict[str, str]


def _patch_types(body: bytearray, context: ShadowContext, request: ItemCloneRequest) -> None:
    values: dict[str, Any] = {
        "typeID": request.target_type_id,
        "typeNameID": request.name_message_id,
        "descriptionID": request.description_message_id,
        "iconID": request.icon_id,
        "published": int(request.published),
        **request.field_overrides,
    }
    if request.market_group_id is not None:
        values["marketGroupID"] = request.market_group_id
    unsupported = sorted(set(values) - set(TYPE_FIELDS))
    if unsupported:
        raise CfsdEncodingError("types fields are not profiled by the item encoder: " + ", ".join(unsupported))
    for name, value in values.items():
        offset, format_string = TYPE_FIELDS[name]
        struct.pack_into(format_string, body, context.record_offset + offset, value)


def _patch_dogma(body: bytearray, context: ShadowContext, overrides: dict[int, float]) -> None:
    """Overwrites values the cloned record already carries; an attribute it lacks is refused."""
    if not overrides:
        return
    attributes_pointer = struct.unpack_from("<Q", body, context.record_offset + 8)[0]
    if attributes_pointer < 8 or attributes_pointer > len(body):
        raise CfsdEncodingError("typeDogma attributes pointer is invalid")
    count = struct.unpack_from("<Q", body, attributes_pointer - 8)[0]
    found: set[int] = set()
    for index in range(count):
        offset = attributes_pointer + index * TYPEDOGMA_ATTRIBUTE_SIZE
        attribute_id = struct.unpack_from("<I", body, offset + 8)[0]
        if attribute_id in overrides:
            struct.pack_into("<d", body, offset, float(overrides[attribute_id]))
            found.add(attribute_id)
    missing = sorted(set(overrides) - found)
    if missing:
        raise CfsdEncodingError("only inherited dogma attributes can be overridden; missing attribute IDs: "
                                + ", ".join(map(str, missing)))


def _patch_icon_file(body: bytearray, context: ShadowContext, logical_path: str) -> None:
    old_pointer = struct.unpack_from("<Q", body, context.record_offset + 8)[0]
    encoded = logical_path.encode("utf-8")
    pointer = append_vector(body, encoded, len(encoded), pointer_modulo=old_pointer % 8)
    struct.pack_into("<Q", body, context.record_offset + 8, pointer)


def append_type_dogma_attributes(payload: bytes, type_id: int, additions: dict[int, float]) -> bytes:
    """Adds attributes to one typeDogma record; the attributes vector stays sorted by attribute ID.

    A record is ``<I typeID><I pad><Q attributes><Q effects>``, an attribute ``<d value><I id><I pad>``.
    An attribute the record already carries is refused (``_patch_dogma`` changes existing values)."""
    wanted = {int(key): float(value) for key, value in additions.items()}
    if not wanted:
        return payload

    def mutate(body: bytearray, context: ShadowContext) -> None:
        location = context.record_offset + 8
        old_pointer = struct.unpack_from("<Q", body, location)[0]
        if old_pointer < max(8, context.nested_start) or old_pointer > context.nested_end:
            raise CfsdEncodingError(f"typeDogma[{type_id}] attributes pointer is invalid")
        count = struct.unpack_from("<Q", body, old_pointer - 8)[0]
        if count >= 100_000 or old_pointer + count * TYPEDOGMA_ATTRIBUTE_SIZE > context.nested_end:
            raise CfsdEncodingError(f"typeDogma[{type_id}] attributes vector is invalid")
        entries = [
            struct.unpack_from("<dII", body, old_pointer + index * TYPEDOGMA_ATTRIBUTE_SIZE) for index in range(count)
        ]
        present = sorted(set(wanted) & {entry[1] for entry in entries})
        if present:
            raise CfsdEncodingError(f"typeDogma[{type_id}] already carries attribute IDs " + ", ".join(map(str, present)))
        entries.extend((value, attribute_id, 0) for attribute_id, value in wanted.items())
        entries.sort(key=lambda entry: entry[1])
        new_pointer = append_vector(
            body, b"".join(struct.pack("<dII", *entry) for entry in entries), len(entries),
            pointer_modulo=old_pointer % 8,
        )
        struct.pack_into("<Q", body, location, new_pointer)

    return rewrite_integer_record(payload, int(type_id), TYPEDOGMA_STRIDE, mutate)
