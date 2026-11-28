# SPDX-License-Identifier: AGPL-3.0-only
# Port of EveJS tools/ElysianItemForge/elysian_item_forge/localization.py.
"""Adds name and description messages to the client's protocol-0 localization pickles."""

from __future__ import annotations

import pickle
import pickletools
from dataclasses import dataclass
from typing import Any

from .resource_index import ResourceIndex, ResourceRecord

LOCALIZATION_PREFIX = "res:/localizationfsd/localization_fsd_"


@dataclass(frozen=True, slots=True)
class LocalizedItem:
    name: str
    description: str
    name_message_id: int
    description_message_id: int


def localization_records(index: ResourceIndex) -> list[ResourceRecord]:
    return [
        record
        for record in index.records
        if record.logical_path.casefold().startswith(LOCALIZATION_PREFIX)
        and record.logical_path.casefold().endswith(".pickle")
        and not record.logical_path.casefold().endswith("_main.pickle")
    ]


def read_language_payload(payload: bytes) -> tuple[str, dict[int, Any]]:
    language, messages = pickle.loads(payload, encoding="bytes")
    if isinstance(language, bytes):
        language = language.decode("ascii")
    if not isinstance(messages, dict):
        raise TypeError("Localization pickle did not contain a message dictionary")
    return str(language), messages


def localization_pickle_globals(payload: bytes) -> tuple[str, ...]:
    """Every global reference of a pickle; the client's whitelist unpickler must see none."""
    return tuple(
        str(argument)
        for opcode, argument, _position in pickletools.genops(payload)
        if opcode.name in {"GLOBAL", "STACK_GLOBAL"}
    )


def _protocol_zero_unicode(value: str) -> bytes:
    escaped = value.replace("\\", "\\u005c")
    escaped = escaped.replace("\0", "\\u0000")
    escaped = escaped.replace("\n", "\\u000a")
    escaped = escaped.replace("\r", "\\u000d")
    escaped = escaped.replace("\x1a", "\\u001a")
    return pickle.UNICODE + escaped.encode("raw-unicode-escape") + b"\n"


def _protocol_zero_message(message_id: int, text: str) -> bytes:
    # The messages dict is on the stack right before the root tuple's TUPLE/STOP: push key, value, SETITEM.
    return (
        pickle.INT + str(int(message_id)).encode("ascii") + b"\n"
        + pickle.MARK + _protocol_zero_unicode(text) + pickle.NONE + pickle.NONE + pickle.TUPLE
        + pickle.SETITEM
    )


def patch_language_payload(payload: bytes, items: list[LocalizedItem]) -> bytes:
    _language, messages = read_language_payload(payload)
    if not payload.endswith(pickle.TUPLE + pickle.STOP):
        raise ValueError("Localization pickle does not end with the expected protocol-0 root tuple")
    source_globals = localization_pickle_globals(payload)
    if source_globals:
        raise ValueError("Localization source contains client-whitelist global references: " + ", ".join(source_globals))
    additions = bytearray()
    for item in items:
        if item.name_message_id in messages or item.description_message_id in messages:
            raise ValueError(f"{item.name} localization ID collides with client data")
        additions.extend(_protocol_zero_message(item.name_message_id, item.name))
        additions.extend(_protocol_zero_message(item.description_message_id, item.description))
    patched = payload[:-2] + additions + payload[-2:]
    globals_used = localization_pickle_globals(patched)
    if globals_used:
        raise ValueError("Patched localization contains client-whitelist global references: " + ", ".join(globals_used))
    return patched


def used_message_ids(index: ResourceIndex) -> set[int]:
    english = next(
        (record for record in localization_records(index) if record.logical_path.casefold().endswith("_en-us.pickle")),
        None,
    )
    if not english:
        return set()
    _language, messages = read_language_payload(index.read(english))
    return {int(key) for key in messages if isinstance(key, int)}
