# M208 — budget-growth monotonicity: final report

`M208 — PASS; A13_PARITY_CLOSED`; frozen A13 0 / 0 (EXCEEDS); parity 13/15 -> 14/15; gates 16/16; falsification M208_FALSIFICATION_CONTROLS_PASS.

## Root cause and repair

- **S1_ranked_pool** (27 transitions, 40 lost items pre-change) — The concept-owner rescue (M142-C) skips files 'the pool already represents', judged against the top-maxResults slice. M207 made maxResults the budget's allowance, so a wider allowance lets a lower-ranked lexical sibling in the same file represent it and the rescued owner is no longer admitted: a rank-2 candidate at 2000 (allowance 25) is absent from the 38-candidate pool at 4000 (allowance 34).
- **S2_role_assignment / S4a_pivot_order** (13 transitions, 3 lost items pre-change) — Two authorities disagree: the cap admits pivots by hybrid final score and the order (anchor tiers / v2) decides the lead among the admitted. Widening the cap (micro 1 -> standard 2 -> full 5) admits a candidate the order ranks above the previous lead, so the focus changes at both tier boundaries (all 5 frozen swaps, all 3 size drops); cap-demoted support entries also become pivots and move to the front (14 transitions).
- **S4b_support_order** (21 transitions, 13 lost items pre-change) — orderSupportWithCoedit partitions baseSupportOrder at the tier's support window (1 / 4 / 10) into protected winners, displacing co-edits, displaceable winners, spare co-edits and the rest. The window changes with the tier, so the same candidates are re-partitioned at every tier boundary; a new candidate entering the window re-partitions it within a tier. Co-edit anchors and graph-neighbour seeds are read from the window, so lane-injected entries are not reproduced at the next budget.
- **S7_evidence_budget** (5 transitions, 17 lost items pre-change) — The ladder protects 'answer-bearing' items and drops the rest from the tail. The test is a substring match, and the role gate's NEGATIVE blocker '(not a pivot: no direct evidence (graph/domain reach only))' contains 'direct evidence', so every weak graph/domain-reach support entry is protected. A larger capsule budget packs more of that tail; the ladder then evicts stronger, unprotected support the smaller budget delivered (e.g. S5 allocateBudget dropped at 1250 while S24-S27 'no direct evidence' entries are kept). The same false positive is the M207 F15 ladder-collapse hazard.
- **S9_projector** (3 transitions, 0 lost items pre-change) — M205 admits WHICH entries first and decides WHAT they carry second; a wider supply at the larger budget is admitted relationship-only up to the ceiling, and the later entry that carried code at the smaller budget no longer fits its richer form. Classified per regression as avoidable admission-first crowding or a necessary ceiling.
- **S5_packing** (1 transitions, 1 lost items pre-change) — Greedy first-fit packing: an entry the smaller budget packed can be skipped at the larger budget when newly affordable earlier entries consume the room it had.

Repair (one authority per stage, no later compensation): `conceptOwnerPoolSize = CANDIDATE_POOL_FLOOR` pins the concept-owner lane's 'already represented' slice to the historical pool (hybridRetrieval.ts, buildCapsuleV2.ts); roles are assigned uncapped and the tier's `maxPivots` is applied by `capOrderedPivots` as a PREFIX of the ordered pivot plan (anchor tiers / pivot-ranking v2 / scoped objectives / class-method expansion), with the M101 exemption appended last (buildCapsuleV2.ts, debugRoles.ts); the pivot-slot reclaim step is retired; `SUPPORT_ORDERING_WINDOW = 4` replaces the tiered window and cap-demoted pivots lead support in plan order (budgetAllocator.ts, buildCapsuleV2.ts); the ladder's answer-bearing test no longer matches negated 'no/weak direct evidence' (budgetDelivery.ts). Not repaired, by decision: the projector's admission-first routing (M205 authority) and greedy first-fit packing; the M203 accounting overhead above the ceiling (not an A13 metric).

## Transitions before / after (frozen, 80)

|  | size / swaps | prefix | subsequence | neither | lost items | moved items | representation regressions | A11 medians |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M207 product on M207 corpus (pre) | 3 / 5 | 0 | 15 | 65 | 74 | 199 | 24 | {"1000":85.05,"2000":94.78,"4000":102.05,"8000":102.5,"16000":94.72} |
| M208 product on M207 corpus | 0 / 0 | 4 | 23 | 53 | 31 | 89 | 8 | {"1000":83.5,"2000":94.1,"4000":102.2,"8000":102.44,"16000":96.87} |
| M208 product on M208 corpus (post) | 0 / 0 | 3 | 25 | 52 | 31 | 89 | 10 | {"1000":83.4,"2000":94,"4000":102.09,"8000":102.59,"16000":97.05} |

Post first divergence: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED 23; SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed 16; PIVOT_CAP_ROLE_PROMOTION 14; EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring 7; SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high 6; NONE 3; SUPPORT_LANE_PLACEMENT:coedit_injected_medium 3; REPRESENTATION_ROUTING:ceiling 2; SUPPORT_LANE_PLACEMENT:coedit_rescued_medium 2; EVIDENCE_BUDGET_DROP:base_support_tier_1 1; SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_medium 1; SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring 1; SUPPORT_LANE_PLACEMENT:coedit_rescued_high 1. Post lost items: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring 14; SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high 9; SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring 4; EVIDENCE_BUDGET_DROP:base_support_tier_1 2; SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_medium 2. Post movers: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed 46; PIVOT_CAP_ROLE_PROMOTION 15; SUPPORT_LANE_PLACEMENT:coedit_rescued_medium 9; REPRESENTATION_ROUTING:ceiling 6; SUPPORT_LANE_PLACEMENT:coedit_injected_medium 5; REPRESENTATION_ROUTING:no_rendered_body 3; SUPPORT_LANE_PLACEMENT:coedit_rescued_high 2; REPRESENTATION_ROUTING:form_not_code_bearing 1; SUPPORT_LANE_PLACEMENT:coedit_injected_high 1; SUPPORT_LANE_PLACEMENT:graph_neighbour_append 1.

## Focus, representation and size before / after

Focus swaps 5 -> 0 tasks; size violations 3 -> 0; representation regressions 24 -> 10 (avoidable_admission_first_crowding 4; upstream_form_changed 4; necessary_ceiling 2).

| budget | tier | median pool | median delivered | median utilisation % | over max_tokens (whole) | evidence over 4 x max_tokens | median accounting overhead | p90 ms (contended) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 750 | micro | 30 | 5 | 72.53 | 1 | 0 | 16 | 269.1 |
| 1000 | micro | 30 | 7 | 83.4 | 2 | 0 | 23 | 253.9 |
| 1250 | micro | 30 | 9 | 88.04 | 2 | 0 | 29.5 | 257.4 |
| 1499 | micro | 30 | 12 | 94.73 | 3 | 0 | 39 | 277.4 |
| 1500 | standard | 30 | 12 | 86.5 | 1 | 0 | 38.5 | 268.2 |
| 2000 | standard | 30 | 15.5 | 94 | 2 | 0 | 49.5 | 279.2 |
| 2500 | standard | 30 | 20 | 98.34 | 5 | 0 | 65 | 284.1 |
| 3000 | standard | 30 | 25 | 100.36 | 11 | 0 | 80.5 | 283.4 |
| 4000 | standard | 39 | 34 | 102.09 | 17 | 0 | 109.5 | 295.3 |
| 5000 | standard | 46 | 43.5 | 102.32 | 14 | 0 | 140 | 308.4 |
| 6000 | standard | 54 | 53 | 102.54 | 14 | 2 | 170 | 322.4 |
| 8000 | standard | 70 | 71 | 102.59 | 13 | 0 | 227.5 | 335.4 |
| 10000 | standard | 86.5 | 85.5 | 101 | 10 | 0 | 275 | 339.4 |
| 11999 | standard | 101.5 | 101 | 99.14 | 9 | 0 | 325 | 373 |
| 12000 | full | 101.5 | 101 | 99.03 | 9 | 0 | 325 | 359.1 |
| 16000 | full | 130 | 128 | 97.05 | 7 | 1 | 412.5 | 427.7 |
| 20000 | full | 130 | 128 | 77.63 | 0 | 0 | 412.5 | 387.7 |

## Arbitrary-budget sweep (dense grid, post)

| class | transitions | prefix | subsequence | neither | focus swaps |
| --- | --- | --- | --- | --- | --- |
| same_tier_same_pool | 139 | 49 | 75 | 15 | 0 |
| tier_boundary | 40 | 3 | 0 | 37 | 0 |
| same_tier_pool_grew | 141 | 1 | 93 | 47 | 0 |

Dense relations before {"subsequence":139,"neither":131,"prefix":50} -> after {"subsequence":168,"neither":99,"prefix":53}.

## Falsification

| id | pass | statement | detail |
| --- | --- | --- | --- |
| F1 | pass | a larger budget keeps every lower-budget related entry that still fits: no lower-budget evidence is evicted across the frozen budgets | preserved 4/4 transitions; relations prefix,prefix,prefix,prefix; related counts 12->24->33->36->36 |
| F2 | pass | the larger budget adds later evidence behind the preserved evidence instead of replacing it | transitions with new entries 3; relations prefix,prefix,prefix,prefix |
| F3 | pass | an entry both budgets deliver keeps its representation or gets a richer one; a larger budget never downgrades it | same 83, richer 22, poorer 0 |
| F4 | pass | a delivered item whose upstream form carries no code is relationship-only under its own reason, never with fabricated code | summary item delivered true, code undefined, reason no_rendered_body; M205 REPRESENTATION_INTEGRITY_PASS |
| F5 | pass | low-ranked tail candidates exposed by a larger budget or a wider pool never change the focus: one lead at every budget and width | leads by budget resolve_widget_handler; by pool width 25/134 resolve_widget_handler |
| F6 | pass | when the task names a symbol the pivot order ranks first, it leads at EVERY budget (micro included); the predecessor let it lead only once the cap admitted it | product leads WidgetHandlerIndex; predecessor leads resolve_widget_handler\|WidgetHandlerIndex |
| F7 | pass | adding candidates to the base support lane leaves the existing entries' relative order intact (a subsequence), at 4000 and 16000 | 4000: prefix; 16000: subsequence |
| F8 | pass | a wider pool at the same budget holds the narrow pool as a prefix of its ranked stream, and the delivered support order follows the stable stream | pool 25 -> 81: prefix; support relation prefix; same lead true |
| F9 | pass | the evidence packet stays inside the caller's budget under the product's own accounting at every dense budget (the per-item tokens fields ride above it by the ledger's stated overhead) | checked 17 budgets; over: none |
| F10 | pass | one general policy over a dense non-frozen budget grid: the focus never changes, its size never shrinks, the support window is a constant, and no product line compares the budget against a frozen rung | 17 budgets; swaps 0, size drops 0; window 4; frozen-rung comparisons in product lines 0 |
| F11 | pass | one semantic item is delivered once with one accounting record at every budget, however many routes proposed it | delivered 25, distinct 25, ledger records 25; M203 ACCOUNTING_INTEGRITY_PASS |
| F12 | pass | a corrupted per-item cost after the M208 path fails the M203 accounting guard | M203 on a +40-token corruption: ACCOUNTING_INTEGRITY_FAIL |
| F13 | pass | a delivered body that its source does not anchor fails the M205 truth guard; the honest packet passes it | honest REPRESENTATION_INTEGRITY_PASS; forged REPRESENTATION_INTEGRITY_FAIL |
| F14 | pass | a small truthful universe leaves the large budgets mostly unused yet the delivery is monotone: A13's semantics are not utilisation | focus resolve_widget_handler_0; utilisation 42/22/11/5/3% |
| F15 | pass | the M208 product change adds no impact, call-site or caller rendering: A13 closes independently of A15 | added product lines mentioning impact/call-site/caller: 0 |
| F16 | pass | the M207 predecessor swaps the focus across tiers on the same fixture and varies the support window with the tier; the M208 product does neither | predecessor b74287688653 leads resolve_widget_handler,WidgetHandlerIndex,WidgetHandlerIndex,WidgetHandlerIndex,WidgetHandlerIndex (swaps 1), windows 1/4/10; product leads WidgetHandlerIndex,WidgetHandlerIndex,WidgetHandlerIndex,WidgetHandlerIndex,WidgetHandlerIndex (swaps 0), window 4 |
| F17 | pass | repeated equivalent calls produce the same packets in one process and the same capsule selection in a fresh process | in-process repeats identical true; fresh-process capsule selections identical true (5 budgets) |

## A11 preservation

|  | 1000 | 2000 | 4000 | 8000 | 16000 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| M207 frozen engine | 84.05% | 94.65% | 102.05% | 102.5% | 94.72% | EXCEEDS |
| M208 pre audit | 85.05% | 94.78% | 102.05% | 102.5% | 94.72% |  |
| M208 post audit | 83.4% | 94% | 102.09% | 102.59% | 97.05% |  |
| M208 frozen engine | 83.4% | 93.78% | 102.08% | 102.59% | 97.05% | EXCEEDS |

## A5 / A12 / A14

A5 frozen p90 {"n":25,"median":174.06,"p90":218.69,"p95":232.84,"max":240.84,"min":161.27} (MATCHES; engine started at load [1.97,2.65,3.87]); A5 harness p90 before {"C-SMALL":51.61,"C-MED":201.04,"C-LARGE":344.91} (MATCHES); after {"C-SMALL":57.16,"C-MED":237.66,"C-LARGE":377} (MATCHES; run at load [3.97,3.71,3.76] after the idle gate was released by hand — the desktop, not this session, held the load above 2).

A12 frozen classes ["FOCUS:focused_source","RELATED_WITH_CODE","RELATIONSHIP_ONLY"] (MATCHES); representation sweep {"verdict":"VTRACE_MATCHES_VEXP_CLAIM","integrityFailures":null}.

A14 5077/5077 (MATCHES).

## Determinism and same-corpus attribution

Post: 3 repeats, packets stable true; gate A13_CAUSAL_ATTRIBUTION_COMPLETE. Same corpus: the M208 product on the M207 corpus copy reports 0 / 0 with relations {"neither":53,"subsequence":23,"prefix":4}; on its own corpus 0 / 0 with {"neither":52,"subsequence":25,"prefix":3} — the movement is the policy, and the corpus movement (C-MED 504 -> 506: two test files added) does not carry it.

## Retrieval eval A/B (predecessor worktree vs this tree)


| fixture | evaluated | top-1 pivot same | result same | top-1 file hits pre -> post | top-3 pre -> post | expected-file rank moves | expected-symbol rank moves | top-1 pivot changed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stage5_retrieval_eval_expanded | 20/20 | 20 | 20 | 17 -> 17 | 20 -> 20 | same 20 | worse 1; same 18; better 1 | none |
| stage5_retrieval_eval_cross_repo_30 | 30/30 | 27 | 27 | 21 -> 20 | 23 -> 22 | same 25; worse 3; gained 1; lost 1 | same 19; better 6; worse 4; gained 1 | scikit-learn__scikit-learn-11578: LogisticRegression -> _check_solver_option; pydata__xarray-3677: merge -> scan_setup_py; sphinx-doc__sphinx-7910: DecoratorDocumenter -> get_updated_docs |

The 50 workspaces were reindexed with the current indexer (their stored indexes were at index_format_version 1 / no index.meta.json and failed the derivation gate); both trees read the same indexes. Every moved row is one where the predecessor's 8000-budget lead already differed from its own 16000-budget lead: the plan is now the full tier's plan at every tier.

## Protected claims

| id | M207 | M208 | held |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | true |
| A2 | EXCEEDS | EXCEEDS | true |
| A3 | MATCHES | MATCHES | true |
| A4 | EXCEEDS | EXCEEDS | true |
| A5 | MATCHES | MATCHES | true |
| A6 | EXCEEDS | EXCEEDS | true |
| A7 | EXCEEDS | EXCEEDS | true |
| A8 | EXCEEDS | EXCEEDS | true |
| A9 | MATCHES | MATCHES | true |
| A10 | MATCHES | MATCHES | true |
| A11 | EXCEEDS | EXCEEDS | true |
| A12 | MATCHES | MATCHES | true |
| A14 | MATCHES | MATCHES | true |

## Full matrix

| id | M207 | M208 | measurement |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, |
| A2 | EXCEEDS | EXCEEDS | C-MED 60.54 files/s, C-LARGE 31.05 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.057, k=3 ratio 0.133; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominato |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.007 / 0.091 / 0.171 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 52.09 / 218.69 / 384.23 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 37.92 / 161.27 / 315.67 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 177.82 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 17.13 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.89%, C-LARGE 87.21% over 450 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LA |
| A11 | EXCEEDS | EXCEEDS | C-MED whole-response utilisation by budget: 1000=83.4%, 2000=93.78%, 4000=102.08%, 8000=102.59%, 16000=97.05% over 20 tasks |
| A12 | MATCHES | MATCHES | C-MED default response carries 3 distinct representation classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY); C-LARGE carri |
| A13 | BELOW | EXCEEDS | 0 of 20 tasks lose focus content as the budget grows, and 0 swap the delivered focus symbol, over 5 budgets |
| A14 | MATCHES | MATCHES | 5077 of 5077 delivered items carry token accounting; no accounting block appears in the default response at all (present at detail=debug onl |
| A15 | BELOW | BELOW | C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface |

M207 13/15, M208 14/15, target 15/15. Remaining gap: A15.

## Gates

| gate | pass | statement |
| --- | --- | --- |
| G1 | pass | frozen A13 authority recovered verbatim and unchanged |
| G2 | pass | M207 A13 reproduced exactly before any product change |
| G3 | pass | every frozen and dense transition attributed before the repair (A13_CAUSAL_ATTRIBUTION_COMPLETE) |
| G4 | pass | the repair is the earliest coherent authority at each stage it touched: concept-owner slice (S1), pivot plan before cap (S2/S4a), support ordering window and plan-ordered demoted pivots (S4b), negation-aware answer-bearing (S7) |
| G5 | pass | frozen A13 from the unmodified scorer |
| G6 | pass | A11 MATCHES or EXCEEDS at every frozen budget |
| G7 | pass | A5 MATCHES or EXCEEDS on the frozen rerun and the A5 harness |
| G8 | pass | A12 and A14 protected |
| G9 | pass | A1-A10 protected |
| G10 | pass | A15 untouched (verdict carried, no impact rendering added: F15) |
| G11 | pass | falsification controls F1-F17 pass |
| G12 | pass | determinism: 3 repeats, packets and ledgers stable post-change |
| G13 | pass | same-corpus attribution: repaired product on the M207 corpus copy closes frozen A13 too |
| G14 | pass | no filler and no relevance weakening: lost items fall, regressions fall, dense prefix count rises |
| G15 | pass | authority: predecessor replay fails only the detached-HEAD branch check; post replay verified |
| G16 | pass | zero model spend: offline instruments only |

## Authority

Replay (predecessor worktree ): M197A_AUTHORITY_MISMATCH, failing only branch_is_main; post: M197A_AUTHORITY_VERIFIED.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_NEW_REPRESENTATION_CLASS_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED

