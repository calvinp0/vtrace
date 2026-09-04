"""M216 §12, §28 — generate the non-frozen research dataset.

The real evaluator needs a dataset row for the instance it grades, and the frozen
`swe-bench-100.jsonl` deliberately does not contain the research instances. This
writes a two-row dataset drawn from SWE-bench Verified's complement.

It is GENERATED rather than committed. The rows carry gold patches and
FAIL_TO_PASS lists, which are precisely what §28 forbids from reaching an agent,
so they live under an untracked results directory and on no path an arm can read.

    <vexp>/.venv/bin/python run_stage5_m216_research_dataset.py
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
OUT_DIR = os.path.join(RESULTS, "_m216_research")
OUT = os.path.join(OUT_DIR, "research_instances.jsonl")
MANIFEST = os.path.join(RESULTS, "stage5_m214_run_manifest.json")

RESEARCH_IDS = ["pylint-dev__pylint-7080", "pylint-dev__pylint-6903"]


def main() -> int:
    os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from datasets import load_dataset

    frozen = {row["instanceId"] for row in json.load(open(MANIFEST))["rows"]}
    overlap = sorted(set(RESEARCH_IDS) & frozen)
    if overlap:
        # §12 asserted before anything is written, not after a container starts.
        print(f"REFUSED: research instances are in the frozen 100: {overlap}", file=sys.stderr)
        return 2

    dataset = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
    wanted = {row["instance_id"]: row for row in dataset if row["instance_id"] in set(RESEARCH_IDS)}
    missing = sorted(set(RESEARCH_IDS) - set(wanted))
    if missing:
        print(f"REFUSED: research instances absent from SWE-bench Verified: {missing}", file=sys.stderr)
        return 2

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w") as fh:
        for instance_id in RESEARCH_IDS:
            fh.write(json.dumps(dict(wanted[instance_id])) + "\n")
    print(json.dumps({
        "wrote": OUT,
        "instances": [
            {"instanceId": i, "repo": wanted[i]["repo"], "baseCommit": wanted[i]["base_commit"]}
            for i in RESEARCH_IDS
        ],
        "notInFrozenPopulation": True,
        "frozenPopulationSize": len(frozen),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
