# M182 — Related-Selection Stability Under Load and Deterministic Packet Reproducibility

## Verdict

```text
M182 overall: PASS

A: PASS
B: PASS
C: PASS
D: PASS
E: PASS
F: PASS

stability verdict:
SEMANTIC_PACKET_STABILITY_VALIDATED

root-cause verdict:
ENVIRONMENTAL_ONLY_FALSE_POSITIVE

repair verdict:
NO_PRODUCT_CHANGE_REQUIRED

product verdict:
KEEP_COMPACT_ORIENTATION_UNCHANGED

totality verdict:
RESPONSE_TOTALITY_PRESERVED

truthfulness verdict:
ORIENTATION_TRUTHFULNESS_PRESERVED

economics verdict:
CURRENT_COMPACT_ECONOMICS_PRESERVED

live-readiness verdict:
CURRENT_PRODUCT_LIVE_REQUALIFICATION_LICENSED

product changed: NO
retrieval semantic policy changed: NO
ranking semantic policy changed: NO
fit contract changed: NO
ownership contract changed: NO

live spend: $0.00
live work: NOT RUN
```

## Direct answer

Ordinary load and concurrency did not change current VTRACE's model-facing
orientation for identical authoritative evidence. There is no code path to name
that first turned execution timing into semantic related selection, because no
semantic stage diverged. The 11/200 historical M176 differences were an unpaired
cross-time/environment observation that vanished when interleaved; current
controlled evidence reclassifies it as `ENVIRONMENTAL_ONLY_FALSE_POSITIVE`.

Load also did not change authoritative evidence supply, candidate order, the
published rank vector, or semantic-item supply before projection. Equal primary
scores are resolved by existing FQN/symbol/path identity keys, not unstable
completion, query or insertion order.

## Stability matrix

“Distinct” is the maximum per case within a condition. Full-generation raw bytes
are debug responses containing timing/accounting. After removing the entire
`timing`, `accounting`, and `responseBudget` telemetry blocks they are identical.

| Layer | Condition | Repetitions | Distinct semantic packets | Distinct byte outputs | Semantic instability? |
| --- | --- | ---: | ---: | ---: | --- |
| frozen authority | normal serial | 350 (7×50) | 1 | 1 | no |
| frozen authority | normal repeat | 350 (7×50) | 1 | 1 | no |
| frozen authority | CPU load | 210 (7×30) | 1 | 1 | no |
| frozen authority | I/O load | 210 (7×30) | 1 | 1 | no |
| frozen authority | concurrent packing | 210 (7×30) | 1 | 1 | no |
| frozen authority | same-process interleaved | 140 (7×20) | 1 | 1 | no |
| frozen authority | new process | 350 (7×10×5) | 1 | 1 aggregate worker result | no |
| full generation | normal warm process | 12 (3×4) | 1 | 2–4 raw; 1 normalized | no |
| full generation | bounded CPU load | 12 (3×4) | 1 | 2–4 raw; 1 normalized | no |
| full generation | concurrent servers | 12 (3×4) | 1 | 2–4 raw; 1 normalized | no |
| full generation | new process | 12 (3×4) | 1 | 4 raw; 1 normalized | no |
| default MCP | framed stdio, warm server | 6 | 1 | 1 raw | no |

## Semantic differences

| Difference class | Count | First divergent stage | Model-facing? | Product consequence |
| --- | ---: | --- | ---: | --- |
| focus changed | 0 | none | yes | none |
| related membership | 0 | none | yes | none |
| related order | 0 | none | yes | none |
| primary reason | 0 | none | yes | none |
| qualifiers | 0 | none | yes | none |
| telemetry only | 12 full-generation case/condition groups | timing/accounting serialization | no | raw debug bytes differ; default packet does not |

The detector is not insensitive: swapping the first two related entries changed
the semantic hash and reported order/reason-vector differences. Changing timing,
elapsed and process telemetry changed raw bytes while remaining semantically
identical. One hundred unchanged identity repetitions produced one hash.

## Ordering and root cause

The material order is semantic score/tier/role priority followed by stable
repo-relative identity. Hybrid candidates finish on `fqName, symbolId`; pivot
and support comparators do the same or use stable path; graph/document traversal
normalizes identity; product drafts sort on `roleOrder, identity` before first-wins
dedupe; budget priority embeds authoritative index; orientation consumes that
published order and admits a prefix.

The only reproduced variability is in `productContext.timing`, `accounting`, and
`responseBudget` values derived from serialized timing width. No timing/load value
enters scoring or packing priority. Default orientation omits those blocks, as the
six byte-identical MCP responses confirm.

## Preservation and economics

M181's complete gate set was rerun and passed. M179 orientation→decline remains
0; M180 `projectorSupplyCut` remains 0 (`serializedItemsCut=722` remains the
intended metadata compaction); M181 canonical-primary violations remain 0. The
8 fixed-ceiling pairs remain expected boundary effects and were not reopened.
Truthfulness stays at 0 unsupported/strengthened/invalid-primary claims; totality
stays at 2,028 deliveries, 0 throws and 0 outside-envelope responses.

Current model-facing orientation size is:

| population | count | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| all delivering M181 budget points | 1,380 | 542 | 1,306 | 1,576 |
| current default 8,000-token budget | 167 | **1,229** | **1,527** | **1,576** |

There is no M182 before/after size delta because there is no product change.
`modelVisibleEstimatedTokens` remains a misleading impact-envelope name and was
recorded, not renamed.

## Experimental validity and next step

A future paired baseline-vs-current-VTRACE run can treat the packet as a stable
intervention in this measured regime. Current treatment is materially different
from M173's ~629-token packet; the deterministic correctness branch is clean; and
M182 did not tune retrieval/ranking against outcomes. Prefer a preregistered new
stratified sample with a small replication stratum, not the exact M173 twelve as
the sole proof. Use the actual automatic compact default and whole-run outcome,
token and cost metrics. Gold file/symbol remains diagnostic.

M182 stops here. It did not run live agents, VEXP or Docker and did not start M183.

## Audit document

`VTRACE_TOOLING_AUDIT.md` is untracked, not established as tracked authority, and
contains the two expected stale claims (M171 five-entry cap and pre-M179
non-monotonicity). It was not edited or staged because doing so would take
ownership of unrelated untracked user content.

## Verification

```text
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m182_stability.ts
PASS — 1,820 frozen deliveries, 48 full generations, 6 MCP defaults

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_qualification.ts
PASS — 15/15 gates

bun run typecheck
PASS

bun run typecheck:benchmarks
PASS

bun test
5523 pass
49 skip
0 fail
5572 tests across 353 files

git diff --check
clean
```

Commits are backfilled after the evidence commit. Pushed: **NO**.
