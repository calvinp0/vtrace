# M133 report-only bounded-tool audit

| tool | advertised bound | complete-response gate | finding |
| --- | --- | --- | --- |
| get_code_context | max_tokens | `compactProductResponse` plus post-mutation `remeasureResponseBudget` | fixed: successful false envelope is impossible |
| get_context_capsule | max_tokens / capsule budget | `compactProductResponse` after accounting | bounded |
| run_pipeline | max_tokens | `compactProductResponse` after accounting | bounded |
| get_impact_graph | max_edges/path/depth/tokens | new `compactImpactProductResponse` after accounting; CLI uses same gate | fixed P0 |
| search_logic_flow | path/depth/traversal/token caps | field caps, no shared complete-object response accounting | no observed catastrophic leak; follow-up whole-object guard recommended |
| get_skeleton | detail/file selection | bounded structural extraction/accounting, no declared max_tokens | no observed incident; report-only follow-up |

The shared invariant lives in final guards, while product-specific compactors
retain semantic control. No flow or skeleton semantics were changed in M133.
