"""M214 §6, §45 F2 — re-derive the vendor's selection-script subset.

M213 found that VEXP's shipped ``scripts/select-subset.py`` does not reproduce
the ``data/swe-bench-100.jsonl`` committed beside it: 22 of 100 overlap. M214
inherits the ARTIFACT and must therefore be able to show, itself, that the
script is not a route to it — both because the finding is load-bearing for the
external comparison, and because F2 needs the script's output as the wrong
artifact to swap in.

Runs the vendor's OWN script, unmodified, against SWE-bench Verified
materialised from the local HuggingFace cache. Nothing is reimplemented: the
script uses Python's Mersenne Twister through ``random.Random(42).sample`` and
``shuffle``, and a reimplementation would be testing our reimplementation.

Deterministic. No model, no network beyond a local cache read, no container.

Usage:
    <vexp venv python> benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m214_vendor_script_subset.py \
        [--out benchmarks/stage5_vexp_swe_bench_smoke/results]
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

VENDOR_ROOT = "/home/calvin/code/vexp-swe-bench"
VENDOR_SCRIPT = os.path.join(VENDOR_ROOT, "scripts", "select-subset.py")
VENDOR_ARTIFACT = os.path.join(VENDOR_ROOT, "data", "swe-bench-100.jsonl")
VERIFIED_PARQUET = (
    "/home/calvin/.cache/huggingface/hub/datasets--princeton-nlp--SWE-bench_Verified"
    "/snapshots/c104f840cc67f8b6eec6f759ebc8b2693d585d4a/data/test-00000-of-00001.parquet"
)
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")


def materialize_verified(destination: str) -> int:
    """The 500-instance parent dataset, as the vendor's script expects it."""
    import pandas as pd  # imported here so --help works without the dependency

    frame = pd.read_parquet(VERIFIED_PARQUET)
    with open(destination, "w") as handle:
        for record in frame.to_dict(orient="records"):
            handle.write(json.dumps({
                key: (value.tolist() if hasattr(value, "tolist") else value)
                for key, value in record.items()
            }) + "\n")
    return len(frame)


def instance_ids(path: str) -> list[str]:
    with open(path) as handle:
        return [json.loads(line)["instance_id"] for line in handle if line.strip()]


def repo_counts(path: str) -> dict[str, int]:
    with open(path) as handle:
        return dict(Counter(json.loads(line)["repo"] for line in handle if line.strip()))


def complexity_ceiling_pass(path: str, ceiling: int = 250) -> int:
    """How many rows the vendor's own documented step-1 filter would have kept."""
    kept = 0
    with open(path) as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            try:
                fail_to_pass = json.loads(row.get("FAIL_TO_PASS", "[]"))
            except (json.JSONDecodeError, TypeError):
                fail_to_pass = []
            patch_lines = len([
                entry for entry in (row.get("patch") or "").split("\n")
                if entry.startswith("+") or entry.startswith("-")
            ])
            if len(fail_to_pass) * 10 + patch_lines <= ceiling:
                kept += 1
    return kept


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="m214-vendor-script-") as workspace:
        full = os.path.join(workspace, "swebench-verified-full.jsonl")
        parent_rows = materialize_verified(full)
        selected = os.path.join(workspace, "script-subset.jsonl")

        # The vendor's script, unmodified, under its own interpreter.
        completed = subprocess.run(
            [sys.executable, VENDOR_SCRIPT, "--input", full, "--output", selected],
            capture_output=True,
            text=True,
            timeout=900,
            check=False,
        )
        if completed.returncode != 0:
            sys.stderr.write(completed.stderr)
            return 1

        script_ids = sorted(instance_ids(selected))
        script_repos = repo_counts(selected)
        script_sha = hashlib.sha256(open(selected, "rb").read()).hexdigest()
        ceiling_pass = complexity_ceiling_pass(full)

    artifact_ids = sorted(instance_ids(VENDOR_ARTIFACT))
    artifact_repos = repo_counts(VENDOR_ARTIFACT)
    artifact_sha = hashlib.sha256(open(VENDOR_ARTIFACT, "rb").read()).hexdigest()
    overlap = sorted(set(script_ids) & set(artifact_ids))

    document = {
        "schemaVersion": "stage5.m214.vendor-script-subset.v1",
        "milestone": "M214",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "method": (
            "The vendor's own scripts/select-subset.py, unmodified, run under their own venv "
            "interpreter against SWE-bench Verified from the local HuggingFace cache."
        ),
        "parentDataset": {
            "name": "princeton-nlp/SWE-bench_Verified",
            "rows": parent_rows,
            "parquet": VERIFIED_PARQUET,
            "rowsPassingDocumentedComplexityCeiling": ceiling_pass,
        },
        "vendorScript": {
            "path": VENDOR_SCRIPT,
            "seed": 42,
            "targetSize": 100,
            "documentedStepOmitted": (
                "the documented complexity ceiling <= 250 is described in the vendor's docs as "
                "step 1 and is not applied anywhere in the script"
            ),
        },
        "scriptDerived": {
            "instanceCount": len(script_ids),
            "sha256": script_sha,
            "countsByRepository": script_repos,
            "instanceIds": script_ids,
        },
        "publishedArtifact": {
            "path": VENDOR_ARTIFACT,
            "instanceCount": len(artifact_ids),
            "sha256": artifact_sha,
            "countsByRepository": artifact_repos,
        },
        "comparison": {
            "overlapCount": len(overlap),
            "overlapInstanceIds": overlap,
            "disjointCount": len(artifact_ids) - len(overlap),
            "repositoryAllocationDifferences": {
                repo: {
                    "script": script_repos.get(repo, 0),
                    "artifact": artifact_repos.get(repo, 0),
                }
                for repo in sorted(set(script_repos) | set(artifact_repos))
                if script_repos.get(repo, 0) != artifact_repos.get(repo, 0)
            },
        },
        "status": [
            "EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT",
            "EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE",
        ],
        "consequence": (
            "Anyone who reproduces the population from the published script benchmarks a different "
            f"{len(artifact_ids) - len(overlap)} tasks and cannot legitimately compare against the "
            "published number. M214 freezes the artifact, which is the population the published "
            "73/100 was computed on."
        ),
    }

    out_path = os.path.join(args.out, "stage5_m214_vendor_script_subset.json")
    with open(out_path, "w") as handle:
        handle.write(json.dumps(document, indent=2) + "\n")
    print(out_path)
    print(f"script-derived {len(script_ids)} ids, overlap with published artifact "
          f"{len(overlap)}/{len(artifact_ids)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
