# SPDX-License-Identifier: AGPL-3.0-only
# Port of EveJS tools/ElysianFSD/elysian_fsd/native_loader.py (key probes only).
"""Reads a cFSD file with the client's own generated loader (bin64/*Loader.pyd, Python 2.7)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

WORKER_SOURCE = r'''
from __future__ import print_function
import json
import sys


def key_token(value):
    if isinstance(value, bool):
        return "b:%s" % value
    if isinstance(value, (int, long)):
        return "i:%s" % value
    if isinstance(value, unicode):
        return "s:" + value.encode("utf-8")
    return "s:" + str(value)


def normalize(value, depth=0):
    if depth > 64:
        return {"$depthLimit": True}
    if value is None or isinstance(value, (bool, int, long, float, str, unicode)):
        return value
    if isinstance(value, dict) or callable(getattr(value, "keys", None)):
        keys = list(value.keys())
        return dict(
            (key_token(key), normalize(value.get(key) if hasattr(value, "get") else value[key], depth + 1))
            for key in sorted(keys, key=key_token)
        )
    if isinstance(value, (list, tuple)) or (
        hasattr(value, "__iter__") and hasattr(value, "__len__") and not isinstance(value, basestring)
    ):
        try:
            return [normalize(item, depth + 1) for item in value]
        except Exception:
            pass
    result = {}
    for name in dir(value):
        if name.startswith("_"):
            continue
        try:
            item = getattr(value, name)
        except Exception:
            continue
        if callable(item):
            continue
        result[name] = normalize(item, depth + 1)
    return result if result else repr(value)


task_path, result_path = sys.argv[1], sys.argv[2]
task = json.load(open(task_path, "rb"))
result = {"success": False}
try:
    module = __import__(task["loaderModule"])
    rows = module.load(task["resourcePath"])
    if rows is None:
        raise RuntimeError("Loader returned None")
    result["rowCount"] = len(rows) if hasattr(rows, "__len__") else None
    probes = []
    for probe in task.get("probes", []):
        key = probe.get("key")
        present = key in rows if hasattr(rows, "__contains__") else False
        value = None
        if present:
            value = normalize(rows.get(key) if hasattr(rows, "get") else rows[key])
        probes.append({"key": key, "present": present, "value": value})
    result["probes"] = probes
    result["success"] = True
except Exception as exc:
    result["error"] = repr(exc)
with open(result_path, "wb") as stream:
    stream.write(json.dumps(result))
'''


@dataclass(slots=True)
class NativeReport:
    success: bool
    error: str | None = None
    row_count: int | None = None
    probes: list[dict[str, Any]] = field(default_factory=list)

    def value(self, key: Any) -> dict[str, Any]:
        """The normalized record of a probed key ({} when absent)."""
        for probe in self.probes:
            if probe.get("key") == key:
                return probe.get("value") or {}
        return {}


class NativeLoaderHost:
    def __init__(self, bin_root: Path, python27: Path) -> None:
        self.bin_root = Path(bin_root)
        self.python27 = Path(python27)

    def verify_table(
        self, loader_module: str | None, resource_path: Path, probes: list[dict[str, Any]], timeout: int = 180
    ) -> NativeReport:
        if not self.python27.is_file():
            return NativeReport(False, f"Python 2.7 runtime is missing: {self.python27}")
        if not loader_module:
            return NativeReport(False, "generated loader is missing")
        with tempfile.TemporaryDirectory(prefix="customtypes-loader-") as temporary_name:
            temporary = Path(temporary_name)
            task_path, worker_path, result_path = temporary / "task.json", temporary / "worker.py", temporary / "result.json"
            task_path.write_text(json.dumps({"loaderModule": loader_module, "resourcePath": str(Path(resource_path).resolve()),
                                             "probes": probes}), encoding="utf-8")
            worker_path.write_text(WORKER_SOURCE, encoding="utf-8")
            environment = os.environ.copy()
            environment["PATH"] = str(self.bin_root) + os.pathsep + environment.get("PATH", "")
            environment["PYTHONPATH"] = str(self.bin_root)
            environment.pop("PYTHONHOME", None)
            try:
                completed = subprocess.run(
                    [str(self.python27), str(worker_path), str(task_path), str(result_path)],
                    cwd=self.bin_root, env=environment, capture_output=True, timeout=timeout, check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                return NativeReport(False, str(error))
            if not result_path.is_file():
                stderr = completed.stderr.decode("utf-8", "replace")
                return NativeReport(False, stderr or f"loader host exited {completed.returncode}")
            raw = json.loads(result_path.read_text("utf-8"))
        success = bool(raw.get("success")) and completed.returncode == 0
        error = raw.get("error") or (None if completed.returncode == 0 else
                                     completed.stderr.decode("utf-8", "replace") or f"loader host exited {completed.returncode}")
        return NativeReport(success, error, raw.get("rowCount"), list(raw.get("probes", [])))
