# SPDX-License-Identifier: AGPL-3.0-only
# Discovery follows EveJS tools/ElysianFSD/elysian_fsd/discovery.py; the mutation proof follows
# tools/ElysianFSD/elysian_fsd/item_verification.py (item tables only).
"""Per-build profile of the item tables: discovery from the client files, the stored profile, the proof."""

from __future__ import annotations

import configparser
import hashlib
import json
import re
import struct
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cfsd import CfsdEncodingError, cfsd_content_hash, clone_integer_record, contains_root_key, header_parts
from .items import (
    ICONIDS_STRIDE,
    REQUIRED_SKILLS_STRIDE,
    TYPE_MATERIALS_STRIDE,
    TYPEDOGMA_STRIDE,
    TYPES_STRIDE,
    ItemCloneRequest,
    _patch_dogma,
    _patch_icon_file,
    _patch_types,
)
from .native_loader import NativeLoaderHost
from .resource_index import ResourceIndex

PROFILE_FORMAT = "customtypes-client-profile"
PROFILE_VERSION = 1
ITEM_TABLES = ("types", "typedogma", "requiredskillsfortypes", "typematerials", "iconids")

# Native layouts the encoder knows, by schema fingerprint: the strides and field offsets in items.py.
LAYOUTS: dict[str, dict[str, int]] = {
    "types": {"4f25d0f64115864bd8c4f58da09c1758": TYPES_STRIDE},
    "typedogma": {"817d560b9962768e1a4b18598e9a1761": TYPEDOGMA_STRIDE},
    "requiredskillsfortypes": {"3c9734f16d5daed7dcac978954601dc7": REQUIRED_SKILLS_STRIDE},
    "typematerials": {"988a9edbbd5a0f3dfdc5b37b067d183f": TYPE_MATERIALS_STRIDE},
    "iconids": {"e62746ff0dc540cc73e06fca63926f29": ICONIDS_STRIDE},
}

PROOF_SOURCE_TYPE = 447
PROOF_SOURCE_ICON = 3433
PROOF_TARGET = 999_999
PROOF_MESSAGES = (2_999_998, 2_999_999)
PROOF_DOGMA = {54: 9_001.0, 105: 3.0}
PROOF_ICON_FILE = f"res:/ui/texture/icons/customtypes/{PROOF_TARGET}.png"


class ProfileError(RuntimeError):
    """The client does not match a profile this tool can write to."""


@dataclass(slots=True)
class ClientTable:
    name: str
    logical_path: str
    loader_module: str | None
    resource_path: Path
    schema_fingerprint: str
    resource_md5: str


@dataclass(slots=True)
class ClientProfile:
    build: int
    version: str
    client_root: Path
    tq_root: Path
    bin_root: Path
    tables: dict[str, ClientTable] = field(default_factory=dict)

    def table(self, name: str) -> ClientTable:
        return self.tables[name.casefold()]


def read_start_ini(tq_root: Path) -> dict[str, str]:
    parser = configparser.ConfigParser()
    parser.read(tq_root / "start.ini", encoding="utf-8")
    return dict(parser["main"]) if parser.has_section("main") else {}


def _loader_for(stem: str, bin_root: Path) -> str | None:
    loaders = {path.stem.casefold(): path.stem for path in bin_root.glob("*Loader.pyd")}
    direct = loaders.get(f"{stem}loader".casefold())
    if direct:
        return direct
    normalized = re.sub(r"[^a-z0-9]", "", stem.casefold())
    for key, name in loaders.items():
        if re.sub(r"[^a-z0-9]", "", key.removesuffix("loader")) == normalized:
            return name
    return None


def discover(client: Path, index: ResourceIndex | None = None) -> ClientProfile:
    """Build, loaders and header fingerprints of the item tables, read from the client files only."""
    index = index or ResourceIndex.load(client)
    start = read_start_ini(index.tq_root)
    try:
        build = int(start.get("build", "0") or 0)
    except ValueError:
        build = 0
    profile = ClientProfile(build, start.get("version", ""), index.client_root, index.tq_root, index.tq_root / "bin64")
    for name in ITEM_TABLES:
        record = index.get(f"res:/staticdata/{name}.fsdbinary")
        if record is None:
            continue
        resource_path = index.physical_path(record)
        with resource_path.open("rb") as stream:
            fingerprint = stream.read(16).hex()
        profile.tables[name] = ClientTable(name, record.logical_path, _loader_for(name, profile.bin_root),
                                           resource_path, fingerprint, record.md5)
    return profile


def describe(profile: ClientProfile) -> dict[str, dict[str, Any]]:
    return {
        name: {"logicalPath": table.logical_path, "loaderModule": table.loader_module,
               "schemaFingerprint": table.schema_fingerprint}
        for name, table in sorted(profile.tables.items())
    }


def layout_issues(profile: ClientProfile) -> list[str]:
    issues = [f"{name}: table missing from the client index" for name in ITEM_TABLES if name not in profile.tables]
    for name, table in profile.tables.items():
        if table.schema_fingerprint not in LAYOUTS[name]:
            issues.append(f"{name}: schema fingerprint {table.schema_fingerprint} has no known native layout")
        if not table.loader_module:
            issues.append(f"{name}: no generated loader in {profile.bin_root}")
    return issues


def profile_path(profiles_dir: Path, build: int) -> Path:
    return profiles_dir / f"build-{build}.json"


def load_build_profile(profiles_dir: Path, build: int) -> dict[str, Any] | None:
    path = profile_path(profiles_dir, build)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text("utf-8"))
    except ValueError as error:
        raise ProfileError(f"{path}: not JSON ({error})") from error
    if not isinstance(value, dict) or value.get("format") != PROFILE_FORMAT or value.get("version") != PROFILE_VERSION:
        raise ProfileError(f"{path}: not a {PROFILE_FORMAT} version {PROFILE_VERSION} file")
    if value.get("build") != build:
        raise ProfileError(f"{path}: build {value.get('build')!r}, expected {build}")
    return value


def profile_issues(profile: ClientProfile, stored: dict[str, Any]) -> list[str]:
    wanted = stored.get("tables")
    if not isinstance(wanted, dict) or sorted(wanted) != sorted(ITEM_TABLES):
        return [f"the stored profile must list exactly the tables {', '.join(ITEM_TABLES)}"]
    proof = stored.get("proof") or {}
    issues = [] if proof.get("success") is True else ["the stored profile has no successful encoder proof"]
    actual = describe(profile)
    for name in ITEM_TABLES:
        if name not in actual:
            continue
        for key in ("logicalPath", "loaderModule", "schemaFingerprint"):
            if wanted[name].get(key) != actual[name][key]:
                issues.append(f"{name}: {key} is {actual[name][key]!r}, the profile says {wanted[name].get(key)!r}")
    return issues


def require_supported(profile: ClientProfile, profiles_dir: Path) -> dict[str, Any]:
    """The stored profile of the client's build; refuses an unknown build, a changed table or layout."""
    if profile.build <= 0:
        raise ProfileError(f"no build number in {profile.tq_root / 'start.ini'}")
    issues = layout_issues(profile)
    if issues:
        raise ProfileError(f"client build {profile.build} is not supported: " + "; ".join(issues))
    stored = load_build_profile(profiles_dir, profile.build)
    if stored is None:
        raise ProfileError(
            f"no profile for client build {profile.build} in {profiles_dir}; run `ApplyClientData.bat profile "
            f"--client <folder>` to derive one from the client files (it writes only to {profiles_dir})"
        )
    issues = profile_issues(profile, stored)
    if issues:
        raise ProfileError(f"client build {profile.build} differs from {profile_path(profiles_dir, profile.build)}: "
                           + "; ".join(issues))
    return stored


def content_hash_issues(profile: ClientProfile) -> list[str]:
    """The stored content hash and body length of every item table, recomputed (same format check as the loader)."""
    issues: list[str] = []
    for name, table in sorted(profile.tables.items()):
        payload = table.resource_path.read_bytes()
        _fingerprint, stored_hash, body_length = header_parts(payload)
        if body_length != len(payload) - 32:
            issues.append(f"{name}: body length {body_length} in the header, {len(payload) - 32} on disk")
        elif cfsd_content_hash(payload[32:]) != stored_hash:
            issues.append(f"{name}: content hash differs from the cFSD algorithm this tool writes")
    return issues


def _proof_resources(profile: ClientProfile) -> dict[str, bytes]:
    request = ItemCloneRequest(
        source_type_id=PROOF_SOURCE_TYPE, target_type_id=PROOF_TARGET, name_message_id=PROOF_MESSAGES[0],
        description_message_id=PROOF_MESSAGES[1], icon_id=PROOF_TARGET, market_group_id=None, published=True,
        source_icon_id=PROOF_SOURCE_ICON, dogma_overrides=PROOF_DOGMA, custom_icon_file=PROOF_ICON_FILE,
    )
    sources = {name: profile.table(name).resource_path.read_bytes() for name in ITEM_TABLES}
    for name, key, stride in (("types", PROOF_SOURCE_TYPE, TYPES_STRIDE), ("typedogma", PROOF_SOURCE_TYPE, TYPEDOGMA_STRIDE),
                              ("requiredskillsfortypes", PROOF_SOURCE_TYPE, REQUIRED_SKILLS_STRIDE),
                              ("typematerials", PROOF_SOURCE_TYPE, TYPE_MATERIALS_STRIDE),
                              ("iconids", PROOF_SOURCE_ICON, ICONIDS_STRIDE)):
        if not contains_root_key(sources[name], key, stride):
            raise ProfileError(f"proof source {key} has no {name} record in client build {profile.build}")
    return {
        "types": clone_integer_record(sources["types"], PROOF_SOURCE_TYPE, PROOF_TARGET, TYPES_STRIDE,
                                      lambda body, context: _patch_types(body, context, request)),
        "typedogma": clone_integer_record(sources["typedogma"], PROOF_SOURCE_TYPE, PROOF_TARGET, TYPEDOGMA_STRIDE,
                                          lambda body, context: _patch_dogma(body, context, PROOF_DOGMA)),
        "requiredskillsfortypes": clone_integer_record(sources["requiredskillsfortypes"], PROOF_SOURCE_TYPE,
                                                       PROOF_TARGET, REQUIRED_SKILLS_STRIDE),
        "typematerials": clone_integer_record(sources["typematerials"], PROOF_SOURCE_TYPE, PROOF_TARGET,
                                              TYPE_MATERIALS_STRIDE),
        "iconids": clone_integer_record(sources["iconids"], PROOF_SOURCE_ICON, PROOF_TARGET, ICONIDS_STRIDE,
                                        lambda body, context: _patch_icon_file(body, context, PROOF_ICON_FILE)),
    }


def prove(profile: ClientProfile, host: NativeLoaderHost) -> dict[str, Any]:
    """Clones type 447 (and icon 3433) into every item table, twice, and reads the result back with the
    client's own loaders from a temporary folder. Nothing is written to the client."""
    result: dict[str, Any] = {"success": False, "deterministic": False, "realContentHashes": False,
                              "nativeTables": {}, "assertions": {}, "errors": []}
    try:
        first = _proof_resources(profile)
        second = _proof_resources(profile)
        digest = lambda resources: {name: hashlib.sha256(payload).hexdigest() for name, payload in resources.items()}  # noqa: E731
        result["deterministic"] = digest(first) == digest(second)
        result["realContentHashes"] = all(
            struct.unpack_from("<Q", payload, 16)[0] == cfsd_content_hash(payload[32:])
            and struct.unpack_from("<Q", payload, 24)[0] == len(payload) - 32
            for payload in first.values()
        )
        reports = {}
        with tempfile.TemporaryDirectory(prefix="customtypes-proof-") as temporary:
            for name, payload in first.items():
                path = Path(temporary) / f"{name}.fsdbinary"
                path.write_bytes(payload)
                keys = [PROOF_SOURCE_ICON, PROOF_TARGET] if name == "iconids" else [PROOF_SOURCE_TYPE, PROOF_TARGET]
                report = host.verify_table(profile.table(name).loader_module, path, [{"key": key} for key in keys])
                reports[name] = report
                result["nativeTables"][name] = report.success
                if not report.success:
                    result["errors"].append(f"{name}: {report.error}")
        if all(result["nativeTables"].values()):
            types = reports["types"].value(PROOF_TARGET)
            result["assertions"]["typesIdentity"] = bool(
                types.get("typeID") == PROOF_TARGET and types.get("typeNameID") == PROOF_MESSAGES[0]
                and types.get("descriptionID") == PROOF_MESSAGES[1] and types.get("iconID") == PROOF_TARGET
                and types.get("published") in (1, True)
            )
            dogma_source = reports["typedogma"].value(PROOF_SOURCE_TYPE)
            dogma_target = reports["typedogma"].value(PROOF_TARGET)
            attributes = {int(entry["attributeID"]): entry["value"] for entry in dogma_target.get("dogmaAttributes", [])}
            result["assertions"]["dogmaOverrides"] = all(attributes.get(key) == value for key, value in PROOF_DOGMA.items())
            result["assertions"]["effectsPreserved"] = bool(
                dogma_target.get("dogmaEffects") == dogma_source.get("dogmaEffects")
                and dogma_source.get("dogmaEffects")
            )
            for name, assertion in (("requiredskillsfortypes", "skillsPreserved"), ("typematerials", "materialsPreserved")):
                result["assertions"][assertion] = bool(
                    reports[name].value(PROOF_TARGET)
                    and reports[name].value(PROOF_TARGET) == reports[name].value(PROOF_SOURCE_TYPE)
                )
            result["assertions"]["iconMapping"] = reports["iconids"].value(PROOF_TARGET).get("iconFile") == PROOF_ICON_FILE
        result["success"] = bool(
            result["deterministic"] and result["realContentHashes"]
            and len(result["nativeTables"]) == len(ITEM_TABLES) and all(result["nativeTables"].values())
            and result["assertions"] and all(result["assertions"].values())
        )
        if not result["success"] and not result["errors"]:
            result["errors"].append("one or more encoder proof assertions failed")
    except (CfsdEncodingError, KeyError, OSError, ValueError) as error:
        result["errors"].append(str(error))
    return result


def derive_profile(profile: ClientProfile, host: NativeLoaderHost) -> dict[str, Any]:
    """A new stored profile for the client's build; refuses when a layout, the hash or the proof fails."""
    if profile.build <= 0:
        raise ProfileError(f"no build number in {profile.tq_root / 'start.ini'}")
    issues = layout_issues(profile) or content_hash_issues(profile)
    if issues:
        raise ProfileError(f"client build {profile.build}: " + "; ".join(issues))
    proof = prove(profile, host)
    if not proof["success"]:
        raise ProfileError(f"encoder proof failed on client build {profile.build}: "
                           + "; ".join(proof["errors"] or ["unknown"]) + f" ({json.dumps(proof['assertions'])})")
    return {
        "format": PROFILE_FORMAT,
        "version": PROFILE_VERSION,
        "build": profile.build,
        "clientVersion": profile.version,
        "tables": describe(profile),
        "proof": proof,
    }


def write_profile(profiles_dir: Path, value: dict[str, Any]) -> tuple[Path, bool]:
    """Writes the profile; an existing file with the same tables is kept (False), a different one refused."""
    path = profile_path(profiles_dir, value["build"])
    if path.is_file():
        existing = load_build_profile(profiles_dir, value["build"])
        if existing and existing.get("tables") == value["tables"]:
            return path, False
        raise ProfileError(f"{path} exists with other tables; remove it first if the client really changed")
    profiles_dir.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", "utf-8")
    temporary.replace(path)
    return path, True
