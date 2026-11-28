# SPDX-License-Identifier: AGPL-3.0-only
# Port of EveJS tools/ElysianFSD/elysian_fsd/resource_index.py and hashing.py.
"""The client's resource index (tq/resfileindex.txt): logical path -> content-addressed ResFiles file."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

INDEX_FILES = ("resfileindex.txt", "resfileindex_prefetch.txt")


def md5_bytes(payload: bytes) -> str:
    return hashlib.md5(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class ResourceRecord:
    logical_path: str
    hashed_path: str
    md5: str
    uncompressed_size: int
    compressed_size: int

    @classmethod
    def parse(cls, line: str) -> "ResourceRecord":
        parts = line.rstrip("\r\n").split(",")
        if len(parts) != 5:
            raise ValueError(f"Malformed resource index row: {line[:120]!r}")
        return cls(parts[0], parts[1], parts[2].lower(), int(parts[3]), int(parts[4]))

    def render(self) -> str:
        return ",".join((self.logical_path, self.hashed_path, self.md5, str(self.uncompressed_size),
                         str(self.compressed_size)))


def normalize_client_root(path: Path) -> tuple[Path, Path]:
    candidate = Path(path).expanduser().resolve()
    if (candidate / "resfileindex.txt").is_file():
        return candidate.parent, candidate
    if (candidate / "tq" / "resfileindex.txt").is_file():
        return candidate, candidate / "tq"
    raise FileNotFoundError(f"Could not find tq/resfileindex.txt below {candidate}")


class MissingResourceFileError(FileNotFoundError):
    """An index row whose file is not in ResFiles: an unfinished download."""

    def __init__(self, record: ResourceRecord, physical: Path, tq_root: Path) -> None:
        self.record = record
        self.physical = physical
        super().__init__(
            f"{record.logical_path} is listed in {tq_root / 'resfileindex.txt'} but {physical} is not on disk. "
            "The EVE client has not finished downloading: let its launcher download the full client (or run its "
            "verify/repair), then retry."
        )


class ResourceIndex:
    def __init__(self, client_root: Path, tq_root: Path, records: list[ResourceRecord]) -> None:
        self.client_root = client_root
        self.tq_root = tq_root
        self.records = records
        self.by_logical = {record.logical_path.casefold(): record for record in records}

    @classmethod
    def load(cls, path: Path) -> "ResourceIndex":
        client_root, tq_root = normalize_client_root(path)
        records = [
            ResourceRecord.parse(line)
            for line in (tq_root / "resfileindex.txt").read_text("utf-8", errors="replace").splitlines()
            if line.strip()
        ]
        return cls(client_root, tq_root, records)

    def get(self, logical_path: str) -> ResourceRecord | None:
        return self.by_logical.get(logical_path.casefold())

    def require(self, logical_path: str) -> ResourceRecord:
        record = self.get(logical_path)
        if record is None:
            raise KeyError(logical_path)
        return record

    def physical_path(self, record_or_path: ResourceRecord | str) -> Path:
        record = record_or_path if isinstance(record_or_path, ResourceRecord) else self.require(record_or_path)
        return self.client_root / "ResFiles" / Path(record.hashed_path)

    def read(self, record_or_path: ResourceRecord | str, *, verify: bool = True) -> bytes:
        record = record_or_path if isinstance(record_or_path, ResourceRecord) else self.require(record_or_path)
        physical = self.physical_path(record)
        try:
            payload = physical.read_bytes()
        except FileNotFoundError as error:
            raise MissingResourceFileError(record, physical, self.tq_root) from error
        if verify:
            if len(payload) != record.uncompressed_size:
                raise ValueError(f"Size mismatch for {record.logical_path}")
            if md5_bytes(payload) != record.md5:
                raise ValueError(f"MD5 mismatch for {record.logical_path}")
        return payload

    def render_updated_files(self, replacements: dict[str, ResourceRecord]) -> dict[Path, bytes]:
        """Both index files with the replaced rows; a new logical path is appended to the primary index only."""
        normalized = {key.casefold(): value for key, value in replacements.items()}
        outputs: dict[Path, bytes] = {}
        for filename in INDEX_FILES:
            path = self.tq_root / filename
            if not path.is_file():
                continue
            lines = path.read_text("utf-8", errors="replace").splitlines()
            positions = {line.split(",", 1)[0].casefold(): index for index, line in enumerate(lines)}
            for logical, record in normalized.items():
                if logical in positions:
                    lines[positions[logical]] = record.render()
                elif filename == "resfileindex.txt":
                    lines.append(record.render())
            outputs[path] = ("\n".join(lines) + "\n").encode("utf-8")
        return outputs
