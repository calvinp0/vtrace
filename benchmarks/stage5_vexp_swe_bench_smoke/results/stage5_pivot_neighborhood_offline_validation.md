# Stage 5 — Pivot-neighborhood excerpts: offline validation

Goal: make bounded source excerpts useful in the **default** product-v2
debug/solve path, where the `flow`/`impact` excerpt sections never trigger.

## Why the previous flow/impact excerpt gate was inert

Source excerpts on `search_logic_flow` and `get_impact_graph` only surface when
`run_pipeline` includes those sections, and on the four shaped gate queries
(auto intent) it includes neither:

- `flow` is skipped with `not_enough_endpoints` (the query resolves <2 endpoints)
- `impact` is skipped with `not_refactor_like` (auto intent is not refactor-like)

So all four first responses emitted **0 excerpts** — a live rerun would not have
exercised the feature.

## The new pivot-neighborhood section

When `capsule_engine=v2`, `run_pipeline` now emits an additive
`pivotNeighborhood` array derived from the Capsule v2 pivots (no retrieval,
ranking, or candidate-generation change). For the top 1–2 pivots it attaches
bounded, freshness-gated symbol-window excerpts from the pivot's neighborhood,
labeled by the structural relationship they were reached through
(`support` / `caller` / `callee` / `importer` / `imported` / `reference` /
`sibling` / `fallback_symbol_window`). It does not require flow endpoints or
refactor-like intent.

## Offline replay of the four shaped product-v2 gate queries

Each instance's exact shaped query was replayed through
`run-pipeline --capsule-engine v2 --capsule-intent auto --capsule-budget-tokens 8000`
on the indexed gate workspace. Estimated tokens use `chars/4` of the serialized
response; "before" = the same response with `pivotNeighborhood` removed.

| Instance | section present | pivots enriched | # excerpts | reasons observed | est. tokens before | est. tokens after | est. increase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-22719 | yes | `Axis.convert_units`, `Axis.update_units` | 8 | support, caller, callee | 11043 | 12204 | +1161 |
| astropy-14369 | yes | `VOUnit`, `CDS.to_string` | 8 | support, caller, imported, reference, callee | 10153 | 11133 | +980 |
| django-10880 | yes | `QuerySet.count`, `Least` | 8 | support, reference, sibling, caller | 3383 | 4494 | +1111 |
| django-11095 | yes | `ModelAdmin.get_inline_formsets`, `ModelAdmin.get_inline_instances` | 8 | support, caller | 4410 | 5541 | +1131 |

**Success criterion met:** all four first responses now contain bounded excerpts
(8 each = 2 pivots × 4) where previously they had 0.

## Bounds

- top 2 pivots; max 4 excerpts per pivot (8 total observed per case)
- ≤12 lines per excerpt (signature-focused neighbors use ≤6 lines); ≤200 chars
  per line (trimmed with `…`, `truncated` set)
- never a whole file; unresolved identity / stale source → `skipped`, never a
  failure
- estimated output-token increase ~980–1161 tokens per case (bounded, additive)

## Non-claims

- No live agent runs were launched in this task; this is a deterministic
  first-response measurement only.
- The `impact` and `flow` sections are unchanged; this is a new, additive
  debug-oriented enrichment, not a replacement.
- Snippets are symbol-windows labeled by relationship, not exact edge-site lines.

## Next step

A live 4-case rerun comparing **product-v2 before pivot-neighborhood** vs
**product-v2 + pivot-neighborhood**, on the strict-AND per-case verdict
(resolution preserved && total tokens down && cache-read down &&
Read+Grep+Bash down), to measure whether the now-non-zero first-response
excerpts reduce follow-up Read/Grep/Bash turns.
