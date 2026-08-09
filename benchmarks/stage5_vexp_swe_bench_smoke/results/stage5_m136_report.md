# M136 — Budget-Preserving Context Delivery

Overall verdict: **PASS**. Functional commit: `f48f8c11f0cf76805943e98baa4fc3f566400d39`. Evidence commit: this report-only commit. Starting commit: `2809d667dcc7639d3e5723720296f89bf441ea48`.

## Root cause and corrected flow

M135 made `modelVisibleContext` immutable at the envelope boundary. When duplicate and optional metadata compaction was insufficient, `compactMandatoryProductMetadata` erased all item rows and `degradeOversizedProductResponse` replaced the entire selected context with a generic `budget_failure`. The final 46-token notice could fit, but it no longer said retrieval had succeeded. Verbose selection diagnostics, compatibility manifests, repeated task/intent data, freshness detail, runtime provenance, and accounting competed for the metadata allowance; the guard had no intermediate way to reduce selected source context.

M136 now runs: unchanged M135 retrieval/selection → finite role-aware context packing → metadata/compatibility compaction → authoritative final payload measurement → explicit delivery failure only if the smallest truthful item cannot fit. `max_tokens` continues to bound model-visible context; the complete ceiling remains requested tokens plus `max(1000, 15%)`.

Result semantics are compatible and unambiguous:

- `resolved`, `retrievalFound:true`, `resolved:true`: useful context was delivered; `delivery.status` is `complete` or `compacted`.
- `no_result`, `retrievalFound:false`, `resolved:false`: retrieval found no relevant evidence.
- `delivery_failure`, `retrievalFound:true`, `resolved:false`, `deliveryFailed:true`: retrieval succeeded but no truthful item fit. A bounded top-match reference is retained when possible.

## ARC acceptance

The clean M135 debug-preset replay reproduces the false-empty branch: lead `get_dihedral`, 2,516 selected model tokens → 46-token `budget_failure`, zero items, 1,661 metadata tokens. The archived incident’s initial context was 3,468 tokens; its larger pre-compaction metadata was approximately 6,871 tokens. M136 on the same replay delivers all 12 selected items’ context: 2,516 model + 1,444 metadata = 3,960/4,000, with `get_dihedral` visible.

The required standard budget ladder is:

| max_tokens | state | found | resolved | lead | get_dihedral | selected | delivered | model | metadata | total/ceiling |
|---:|---|---|---|---|---|---:|---:|---:|---:|---:|
| 50 | delivery_failure | yes | no | get_normal | no | 6 | 0 | 40 | 945 | 985/1050 |
| 100 | delivery_failure | yes | no | get_normal | no | 6 | 0 | 40 | 1026 | 1066/1100 |
| 200 | resolved | yes | yes | get_normal | no | 7 | 1 | 166 | 999 | 1165/1200 |
| 500 | resolved | yes | yes | get_normal | yes | 7 | 3 | 442 | 992 | 1434/1500 |
| 1000 | resolved | yes | yes | get_normal | yes | 7 | 7 | 793 | 1108 | 1901/2000 |
| 2000 | resolved | yes | yes | get_dihedral | yes | 12 | 12 | 1568 | 1308 | 2876/3000 |
| 3000 | resolved | yes | yes | get_dihedral | yes | 12 | 12 | 2020 | 1869 | 3889/4000 |
| 6000 | resolved | yes | yes | get_dihedral | yes | 12 | 12 | 2020 | 4919 | 6939/7000 |
| 9000 | resolved | yes | yes | get_dihedral | yes | 12 | 12 | 2020 | 7708 | 9728/10350 |

Every row is within its envelope. Once `get_dihedral` appears it never disappears. The 3,000-token response has a non-empty compact item manifest and all 12 selected items in the authoritative delivered context. At 9,000 tokens the M135 contrast penalty remains on `calculate_dihedral_angle`; ordinary-prose `In` is absent. Upstream weak `likelySymbols` hygiene and existence-query lead promotion remain M137 work.

## Preservation and provenance

The M134 paired runner compared clean detached M135/M136 worktrees with the same runner, fixtures, target commits, protocol, and isolated indexes. Django expanded: 0/20 changed. Cross-repo: 0/30 changed. All retrieval selection, lead, role, content-mode, rendered-context, accounting, and quality hashes are identical at the benchmark budgets.

- Flow: `reorder_p_label_map → map_two_species` remains one exact `calls` edge; the edge site is line 1724 and traversal is frontier-bounded.
- Impact: `get_dihedral`, `max_edges:10`, `max_tokens:1200` retains 3 canonical edges, omits 41, and returns 1,672/2,000 tokens with `withinEnvelope:true`.
- Project name: the geometry control does not promote `arc/main.py::ARC`.
- Worktrees: the full nested-worktree and routing suites pass; no source repository or in-place index was written.
- TCKDB: the same read-only index/check-out lineage retains client tests, implementation, workflow, pytest/full-suite, dependency config, and notebook evidence; lead remains `test_to_payload_snapshot`.
- Shared paths: `get_context_capsule` and `run_pipeline` both deliver `get_dihedral` at 500 tokens and never map a retrieval hit to `no_result`.

## Verification and limitations

`bun run typecheck` and `bun run typecheck:benchmarks` pass. Full suite: 3,887 pass, 49 skip, 0 fail across 241 files (2,590 expectations). `git diff --check` passes. Focused response-envelope suite: 30/30. No live agents, paid APIs, Docker, VEXP, or SWE-bench arms ran.

Compaction adds bounded whole-context estimates at finite stages. The focused six-budget determinism test completes in low tens of milliseconds; real ARC calls remain dominated by retrieval (~1.2–1.4 seconds per cold call). No repeated retrieval occurs and no per-stage full response copies are retained.

Known limitations: exact-answer/existence-query ranking and residual weak-symbol construction remain M137; observation provenance/freshness remains M138. The 50/100 ARC rows retrieve a different tight-budget candidate pool (`get_normal`), so their top-match reference truthfully reflects that selected pool; fixed-selection metamorphic tests separately prove delivery monotonicity. Workspace/multi-repository aggregation was not started.

Recommendation: promote M136, then proceed to M137.
