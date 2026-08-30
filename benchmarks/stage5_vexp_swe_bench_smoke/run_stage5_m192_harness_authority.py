#!/usr/bin/env python
"""
M192 step 0 - establish which harness code is authoritative.

M188/M191 discipline: never derive a methodological claim from a file that might
be a local modification. The VEXP checkout IS dirty (it carries VTRACE's own
agent shim), so nothing under it is quoted as upstream behaviour.

The SWE-bench harness is not read from a working tree at all. It is the
installed `swebench` wheel that `run_evaluation` actually imports, so authority
is provable directly: every installed .py is hashed against the wheel's own
RECORD. That is a stronger guarantee than a clean `git status`, because it
checks the exact bytes the interpreter loads.

    /home/calvin/code/vexp-swe-bench/.venv/bin/python \
        benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_harness_authority.py
"""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "results" / "stage5_m192_harness_authority.json"
VEXP = pathlib.Path("/home/calvin/code/vexp-swe-bench")

# The files M192's architectural claims are read from.
AUDITED = [
    "swebench/harness/test_spec/test_spec.py",
    "swebench/harness/test_spec/python.py",
    "swebench/harness/docker_build.py",
    "swebench/harness/run_evaluation.py",
    "swebench/harness/constants/__init__.py",
    "swebench/harness/grading.py",
    "swebench/harness/docker_utils.py",
]


def git(*args):
    try:
        return subprocess.run(
            ["git", "-C", str(VEXP), *args], capture_output=True, text=True, timeout=60
        ).stdout.strip()
    except Exception as exc:
        return f"<error: {exc}>"


def main():
    site = pathlib.Path(next(p for p in sys.path if p.endswith("site-packages")))
    dist = next(site.glob("swebench-*.dist-info"))

    checked, modified = 0, []
    per_file = {}
    for row in csv.reader((dist / "RECORD").open()):
        if len(row) < 2 or not row[1] or not row[0].endswith(".py"):
            continue
        rel, expected = row[0], row[1]
        path = site / rel
        if not path.exists():
            continue
        algo, want = expected.split("=", 1)
        got = (
            base64.urlsafe_b64encode(hashlib.new(algo, path.read_bytes()).digest())
            .rstrip(b"=")
            .decode()
        )
        checked += 1
        if got != want:
            modified.append(rel)
        if rel in AUDITED:
            per_file[rel] = {"matchesWheel": got == want, "sha256_b64": got}

    dirt = git("status", "--short")
    payload = {
        "milestone": "M192",
        "swebenchDistInfo": dist.name,
        "swebenchSitePackages": str(site),
        "installedPyFilesChecked": checked,
        "installedPyFilesModified": len(modified),
        "modifiedFiles": modified,
        "auditedFiles": per_file,
        "auditedFilesAllIntact": all(v["matchesWheel"] for v in per_file.values())
        and len(per_file) == len(AUDITED),
        "productionEnvironmentPath": (
            "swebench.harness.run_evaluation invoked as `<vexp>/.venv/bin/python -m "
            "swebench.harness.run_evaluation` by vexp-swe-bench src/evaluate/evaluator.ts"
        ),
        "vexpCheckout": {
            "path": str(VEXP),
            "head": git("rev-parse", "HEAD"),
            "dirtEntries": len([l for l in dirt.splitlines() if l.strip()]),
            "vtraceModifiedHarnessFiles": [
                l for l in dirt.splitlines() if "agents/claude-code" in l
            ],
            "note": (
                "The VEXP working tree is dirty and carries VTRACE's own agent shim. "
                "No M192 claim is derived from it; it is recorded only to show what was "
                "deliberately NOT treated as upstream truth."
            ),
        },
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"swebench {dist.name}: {checked} installed .py checked, "
        f"{len(modified)} modified; audited files intact: {payload['auditedFilesAllIntact']}"
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
