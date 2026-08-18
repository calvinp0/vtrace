"""M160 §12 — materialize SWE-bench Verified from the local HuggingFace cache.

WHY THIS EXISTS
----------------
Broad100-A is exactly the 100 instances of the vexp harness's
`data/swe-bench-100.jsonl`, so the unconsumed population it must be disjoint from
does not exist in that file at all. It exists only because Broad100-A is a strict
SUBSET of `princeton-nlp/SWE-bench_Verified` (100 of 500), whose parquet is
already in the local HuggingFace cache. This script converts that parquet to the
same JSONL shape the Stage 5 fixture builder already reads, so Broad100-B is drawn
from the same benchmark family as Broad100-A (§12) rather than a new one.

Rows are emitted sorted by `instance_id` so the output bytes are deterministic and
the recorded sha256 is reproducible.

The output is a large raw corpus artifact and is NEVER committed — only its hash,
row count and column list are, inside the M160 pool artifact.

NO network by default (reads the on-disk cache), NO Claude, NO Docker, NO agent.

Usage:
    uv run --with pyarrow python benchmarks/stage5_vexp_swe_bench_smoke/\
m160_extract_swe_bench_verified.py --out <path.jsonl>
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys

DEFAULT_CACHE_GLOB = os.path.expanduser(
    "~/.cache/huggingface/hub/datasets--princeton-nlp--SWE-bench_Verified/snapshots/*/data/*.parquet"
)


def resolve_parquet(explicit: str | None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"parquet not found: {explicit}")
        return explicit
    matches = sorted(glob.glob(DEFAULT_CACHE_GLOB))
    if not matches:
        sys.exit(
            "SWE-bench Verified parquet not found in the local HuggingFace cache.\n"
            f"Looked under: {DEFAULT_CACHE_GLOB}"
        )
    if len(matches) > 1:
        sys.exit(f"ambiguous cache: {len(matches)} parquet files matched {DEFAULT_CACHE_GLOB}")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--parquet", default=None)
    args = parser.parse_args()

    import pyarrow.parquet as pq  # imported late so --help works without pyarrow

    source = resolve_parquet(args.parquet)
    table = pq.read_table(source)
    rows = table.to_pylist()
    rows.sort(key=lambda row: row["instance_id"])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    digest = hashlib.sha256()
    with open(args.out, "w", encoding="utf-8") as handle:
        for row in rows:
            line = json.dumps(row, default=str, sort_keys=True, ensure_ascii=False) + "\n"
            handle.write(line)
            digest.update(line.encode("utf-8"))

    print(
        json.dumps(
            {
                "source": source,
                "sourceSha256": hashlib.sha256(open(source, "rb").read()).hexdigest(),
                "out": args.out,
                "outSha256": digest.hexdigest(),
                "rows": len(rows),
                "columns": list(table.schema.names),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
