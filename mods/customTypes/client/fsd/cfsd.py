# SPDX-License-Identifier: AGPL-3.0-only
# Port of EveJS tools/ElysianFSD/elysian_fsd/cfsd_shadow.py (integer-keyed records only).
"""Append-only edits of integer-keyed cFSD tables.

A payload is a 32-byte header (schema fingerprint, content hash, body length) and a body that starts
with an optimized root: ``<Q rootOffset><Q rowCount><Q bucketCount>`` and one bucket pointer per hash
slot. A bucket is a count followed by fixed-size records and their nested graph. Edits never shift a
baseline byte: a changed bucket is copied to the end of the body and its root pointer moved.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Callable, Iterable

HEADER_SIZE = 32
ROOT_HEADER_SIZE = 24


class CfsdEncodingError(RuntimeError):
    """The binary does not match the profiled cFSD layout."""


@dataclass(slots=True)
class ShadowContext:
    key: int | str
    record_offset: int
    bucket_offset: int
    bucket_count: int
    fixed_stride: int
    old_bucket_offset: int
    old_nested_start: int
    old_bucket_end: int
    nested_start: int
    nested_end: int
    relocated_pointers: list[tuple[int, int, int]] = field(default_factory=list)


Mutator = Callable[[bytearray, ShadowContext], None]


def cfsd_content_hash(body: bytes | bytearray) -> int:
    """Unsigned 64-bit content hash the generated loaders store in header bytes 16..24."""
    value = 37
    for byte in body:
        value = ((value * 0xD32B) ^ (byte * 0x12CA3)) & 0xFFFFFFFFFFFFFFFF
    return value


def header_parts(payload: bytes) -> tuple[str, int, int]:
    """(schema fingerprint hex, stored content hash, stored body length) of a payload."""
    if len(payload) < HEADER_SIZE:
        raise CfsdEncodingError("cFSD payload is shorter than its header")
    return payload[:16].hex(), struct.unpack_from("<Q", payload, 16)[0], struct.unpack_from("<Q", payload, 24)[0]


def _u64(value: bytes | bytearray, offset: int) -> int:
    if offset < 0 or offset + 8 > len(value):
        raise CfsdEncodingError(f"uint64 read outside body at {offset}")
    return struct.unpack_from("<Q", value, offset)[0]


def _put_u64(value: bytearray, offset: int, number: int) -> None:
    if offset < 0 or offset + 8 > len(value):
        raise CfsdEncodingError(f"uint64 write outside body at {offset}")
    struct.pack_into("<Q", value, offset, number)


def _split(payload: bytes) -> tuple[bytearray, bytearray]:
    if len(payload) < HEADER_SIZE + ROOT_HEADER_SIZE:
        raise CfsdEncodingError("cFSD payload is shorter than its header")
    header = bytearray(payload[:HEADER_SIZE])
    body_length = _u64(header, 24)
    body = bytearray(payload[HEADER_SIZE:])
    if body_length != len(body):
        raise CfsdEncodingError(f"cFSD body length is {body_length}, physical length is {len(body)}")
    root_offset, _row_count, bucket_count = struct.unpack_from("<QQQ", body, 0)
    if root_offset < ROOT_HEADER_SIZE or root_offset + bucket_count * 8 > len(body):
        raise CfsdEncodingError("root bucket index is outside the cFSD body")
    return header, body


def _finish(header: bytearray, body: bytearray) -> bytes:
    header[16:24] = struct.pack("<Q", cfsd_content_hash(body))
    _put_u64(header, 24, len(body))
    return bytes(header + body)


def _root(body: bytearray) -> tuple[int, int, int, list[int]]:
    root_offset, row_count, bucket_count = struct.unpack_from("<QQQ", body, 0)
    offsets = list(struct.unpack_from(f"<{bucket_count}Q", body, root_offset))
    for offset in offsets:
        if offset < 8 or offset > len(body):
            raise CfsdEncodingError(f"invalid root bucket offset {offset}")
        count = _u64(body, offset - 8)
        if count > row_count:
            raise CfsdEncodingError(f"bucket at {offset} has impossible count {count}/{row_count}")
    return root_offset, row_count, bucket_count, offsets


def _bucket_end(body: bytearray, offsets: Iterable[int], pointer: int) -> int:
    # Shadow buckets are appended out of slot order, so the next physical bucket is the boundary.
    greater = [value for value in offsets if value > pointer]
    return (min(greater) - 8) if greater else len(body)


def _find_record(body: bytearray, pointer: int, count: int, stride: int, key: int) -> int:
    if pointer + count * stride > len(body):
        raise CfsdEncodingError("fixed bucket records extend outside the body")
    for index in range(count):
        offset = pointer + index * stride
        if struct.unpack_from("<I", body, offset)[0] == key:
            return offset
    raise KeyError(key)


def integer_root_keys(payload: bytes, stride: int) -> tuple[int, ...]:
    """Every key of an integer-keyed optimized root, sorted."""
    _header, body = _split(payload)
    _root_offset, row_count, _bucket_count, offsets = _root(body)
    keys: list[int] = []
    for pointer in offsets:
        count = _u64(body, pointer - 8)
        if pointer + count * stride > len(body):
            raise CfsdEncodingError("fixed bucket records extend outside the body")
        keys.extend(struct.unpack_from("<I", body, pointer + index * stride)[0] for index in range(count))
    if len(keys) != row_count or len(set(keys)) != row_count:
        raise CfsdEncodingError("integer root row count or key uniqueness is invalid")
    return tuple(sorted(keys))


def _append_padding_for_pointer(body: bytearray, pointer_modulo: int) -> int:
    pointer_modulo %= 8
    while (len(body) + 8) % 8 != pointer_modulo:
        body.append(0)
    return len(body) + 8


def append_vector(body: bytearray, payload: bytes, count: int, *, pointer_modulo: int = 0) -> int:
    """Appends a cFSD vector (count, then data) and returns the pointer to its first element."""
    pointer = _append_padding_for_pointer(body, pointer_modulo)
    body.extend(struct.pack("<Q", count))
    if len(body) != pointer:
        raise AssertionError("vector count/pointer layout drifted")
    body.extend(payload)
    return pointer


def _relocate(value: int, segments: list[tuple[int, int, int]]) -> int | None:
    for old_start, old_end, new_start in segments:
        if old_start <= value < old_end:
            return new_start + value - old_start
    return None


def _relocate_region(
    body: bytearray,
    start: int,
    end: int,
    segments: list[tuple[int, int, int]],
    excluded_locations: set[int] | None = None,
    protected_values: set[int] | None = None,
) -> list[tuple[int, int, int]]:
    candidates: list[tuple[int, int, int]] = []
    excluded = excluded_locations or set()
    protected = protected_values or set()
    snapshot = bytes(body[start:end])
    for location in range(start, end - 7, 4):
        if location in excluded:
            continue
        old = struct.unpack_from("<Q", snapshot, location - start)[0]
        if old in protected:
            continue
        # Generated-loader offsets are four-byte aligned; an unaligned value is string or scalar data.
        if old % 4:
            continue
        # A real reference points at a vector whose count is stored in the preceding QWORD.
        if old < 8 or old > len(body) or _u64(body, old - 8) > len(body):
            continue
        new = _relocate(old, segments)
        if new is not None and new != old:
            candidates.append((location, old, new))
    # The QWORD before a relocated vector is its count; never rewrite it as a reference.
    copied_count_locations = {new - 8 for _location, _old, new in candidates if start <= new - 8 < end}
    changes = [candidate for candidate in candidates if candidate[0] not in copied_count_locations]
    for location, _old, new in changes:
        _put_u64(body, location, new)
    return changes


def _shadow_existing_bucket(
    header: bytearray,
    body: bytearray,
    key: int,
    stride: int,
    protected_values: set[int] | None = None,
) -> ShadowContext:
    """Copies the bucket holding key to the end of the body and points the root slot at the copy."""
    root_offset, _row_count, bucket_count, offsets = _root(body)
    bucket = key % bucket_count
    old_pointer = offsets[bucket]
    count = _u64(body, old_pointer - 8)
    record = _find_record(body, old_pointer, count, stride, key)
    old_nested = old_pointer + count * stride
    old_end = _bucket_end(body, offsets, old_pointer)
    if old_nested > old_end:
        raise CfsdEncodingError("fixed records overlap the next bucket")
    new_pointer = append_vector(body, bytes(body[old_pointer:old_end]), count, pointer_modulo=old_pointer % 8)
    new_record = new_pointer + (record - old_pointer)
    new_nested = new_pointer + (old_nested - old_pointer)
    new_end = new_pointer + (old_end - old_pointer)
    segments = [(old_nested, old_end, new_nested)]
    fixed_changes = _relocate_region(
        body, new_pointer, new_nested, segments, {new_pointer + index * stride for index in range(count)},
    )
    graph_changes = _relocate_region(
        body, new_nested, new_end, segments, {new - 8 for _location, _old, new in fixed_changes}, protected_values,
    )
    _put_u64(body, root_offset + bucket * 8, new_pointer)
    return ShadowContext(
        key=key,
        record_offset=new_record,
        bucket_offset=new_pointer,
        bucket_count=count,
        fixed_stride=stride,
        old_bucket_offset=old_pointer,
        old_nested_start=old_nested,
        old_bucket_end=old_end,
        nested_start=new_nested,
        nested_end=new_end,
        relocated_pointers=[*fixed_changes, *graph_changes],
    )


def rewrite_integer_record(
    payload: bytes, key: int, stride: int, mutator: Mutator, *, protected_values: set[int] | None = None
) -> bytes:
    """Shadows one root bucket, mutates its selected record and finalizes the payload."""
    header, body = _split(payload)
    context = _shadow_existing_bucket(header, body, key, stride, protected_values)
    mutator(body, context)
    return _finish(header, body)


def clone_record_in_body(
    body: bytearray,
    source_key: int,
    target_key: int,
    stride: int,
    mutator: Mutator | None = None,
    protected_values: set[int] | None = None,
) -> None:
    """Clones the source record into a shadow copy of the target bucket, on an already split body.

    The next clone reads the root from the current body, so a target bucket shadowed by an earlier
    clone is the starting point of the next one."""
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


def clone_integer_record(
    payload: bytes, source_key: int, target_key: int, stride: int, mutator: Mutator | None = None
) -> bytes:
    """One clone with its own split and content hash."""
    header, body = _split(payload)
    clone_record_in_body(body, source_key, target_key, stride, mutator)
    return _finish(header, body)


def body_contains_root_key(body: bytes | bytearray, key: int, stride: int) -> bool:
    """True when an integer-keyed cFSD body (payload without the header) has a record for key."""
    if len(body) < ROOT_HEADER_SIZE:
        return False
    root_offset, _total, bucket_count = struct.unpack_from("<QQQ", body, 0)
    pointer = struct.unpack_from("<Q", body, root_offset + (key % bucket_count) * 8)[0]
    count = struct.unpack_from("<Q", body, pointer - 8)[0]
    return any(struct.unpack_from("<I", body, pointer + index * stride)[0] == key for index in range(count))


def contains_root_key(payload: bytes, key: int, stride: int) -> bool:
    return body_contains_root_key(payload[HEADER_SIZE:], key, stride)
