# M206 — candidate allocation, tier-cap authority and frozen A11

`A11_PARITY_NOT_CLOSED` — `A11_SUPPLY_INSUFFICIENT` — `A11_CAP_REPAIR_INSUFFICIENT`; frozen A11 BELOW; parity 12/15 -> 12/15 (VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET); gates 23/23; falsification M206_FALSIFICATION_CONTROLS_PASS.

## What A11 asks

`run_pipeline takes a whole-output token budget, default 10000` (V-C5, vexp-cli/mcp/mcp-server.cjs). Metric: median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget. Boundary: the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field. MATCH: >= 60% utilisation at every budget; EXCEED: >= 80%.

| | 1000 | 2000 | 4000 | 8000 | 16000 | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| M205 committed engine | 46.55% | 50.2% | 25.1% | 13.17% | 13.74% | BELOW |
| pre-change reproduction (predecessor worktree) | 46.55% | 50.2% | 25.1% | 13.17% | 13.74% | BELOW |
| post-change reproduction | 83.85% | 95.47% | 101.23% | 55.48% | 27.84% | BELOW |
| M206 frozen engine rerun | 83.55% | 95.47% | 101.23% | 55.48% | 27.84% | BELOW |

## Candidate-allocation path

- **retrieval_pool**: hybridRetrieve (src/retrieval/hybridRetrieval.ts) with maxResults = CANDIDATE_POOL_SIZE (buildCapsuleV2.ts)
- **role_gate**: assignCandidateRoles (src/capsule/assignCandidateRoles.ts) / refineDebugRoles (src/capsuleV2/debugRoles.ts)
- **pivot_cap**: allocateBudget().maxPivots -> capPivots (debugRoles.ts) / assignCandidateRoles maxPivots; demotion to support
- **pivot_packing**: renderPivot -> firstFitting (buildCapsuleV2.ts), lead pivot forced
- **support_ordering**: supportTier order, expandCoeditSupport + orderSupportWithCoedit (coeditExpansion.ts), rescueFileEvidenceSupport (fileEvidenceRescue.ts), selectPathCompletion (pathCompletion.ts), discoverMechanismSupport
- **support_packing**: the support packing loop in buildCapsuleV2.ts: renderSupport(remaining tokens) + M158 delivered-identity dedupe + lane token ceilings (+ the tier count until M206)
- **product_assembly**: assembleProductContext (sourceDraft, addActionabilityTargets, addImpactEvidence, addMemoryAndRules, deduplicateDrafts)
- **evidence_budget**: applyProgressiveContextBudget (budgetDelivery.ts) publishing the semantic item supply
- **envelope**: compactProductResponse / responseTokenCeiling (responseEnvelope.ts) on the authoritative response
- **projector_admission**: projectRunPipelineOrientation (orientationProjection.ts): dedupe, claim, prefix under orientationCeilingTokens; M205 routing

Stage losses over the 100 frozen responses (pre -> post):

| stage | lost pre | otherwise eligible pre | lost post | otherwise eligible post | reasons pre | reasons post |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| retrieval_pool | 0 | 0 | 0 | 0 | {} | {} |
| role_gate | 315 | 0 | 320 | 0 | {"ROLE_GATE":315} | {"ROLE_GATE":320} |
| pivot_cap | 1338 | 0 | 1318 | 0 | {"PIVOT_CAP_DEMOTED_TO_SUPPORT":1338} | {"PIVOT_CAP_DEMOTED_TO_SUPPORT":1318} |
| support_lanes | 0 | 0 | 0 | 0 | {} | {} |
| support_packing | 2573 | 2573 | 380 | 0 | {"TIER_SUPPORT_CAP":2573} | {"TOKEN_BUDGET":379,"LANE_TOKEN_CEILING":1} |
| product_assembly | 52 | 0 | 83 | 0 | {"DUPLICATE_DRAFT":52} | {"DUPLICATE_DRAFT":83} |
| evidence_budget | 0 | 0 | 705 | 0 | {} | {"DROPPED_FOR_EVIDENCE_BUDGET":705} |
| projector_admission | 257 | 0 | 8 | 0 | {"DEDUPLICATED":257} | {"DEDUPLICATED":8} |

Stop reasons over the frozen responses: pre {"OTHER_EXPLICIT_POLICY:FIXED_TIER_SUPPORT_CAP":95,"NO_TRUTHFUL_SUPPLY":5}; post {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":59,"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":39,"NO_TRUTHFUL_SUPPLY":2}. Retrieval pool cap 25 (CANDIDATE_POOL_SIZE).

## Tier-cap authority

Allocator history: f099c3b1 2026-06-06 Build capsule v2 product output. Predecessor caps {"micro":{"maxPivots":1,"support":1},"standard":{"maxPivots":2,"support":4},"full":{"maxPivots":5,"support":10}}; current policy {"micro":{"maxPivots":1,"support":1},"standard":{"maxPivots":2,"support":4},"full":{"maxPivots":5,"support":10}}. Predecessor comment claims: {"microDecisive":true,"fullTokenBudgetIsRealBound":true,"tunablePolicy":true}. Hard maximum in packing: predecessor true, current false. Measured over the frozen sweep: {"responses":100,"supportCountDiscards":2573,"tokenBudgetDiscards":0,"responsesStoppedOnCount":95,"pivotCapDemotions":1338,"counterfactualCeilingRejections":36}.

| cap | kind | authority | disposition |
| --- | --- | --- | --- |
| maxPivots (micro 1 / standard 2 / full 5) | role safeguard | pivots are edit targets: productContext marks them required (EDIT_OR_RULE_OUT) and the M112 action contract turns them into obligations; M101's anchored exemption is the one bounded exception | preserved unchanged |
| maxSupport micro 1 | historical default with a stated decisiveness rationale | comment: one decisive edit site; measured: the token budget and the evidence budget bound micro delivery on their own (post 1000: evidence budget binds every response) | no longer a maximum; retained as the support window |
| maxSupport standard 4 / full 10 | historical default | introduced f099c3b1 2026-06-06 Build capsule v2 product output with no measured rationale; the comment claimed the token budget was the real bound at full, which the sweep contradicts (2573 count discards, 0 budget discards over 100 frozen responses) | no longer a maximum; retained as the support window (lane ordering and documentation fill) |

## Supply sufficiency (pre-change counterfactual)

Rule: required_match_tokens(B) = ceil(0.6 x B) whole-packet chars/4 tokens; SUFFICIENT when the all-bounds median reaches it, INSUFFICIENT when the ceiling-only median does not, INDETERMINATE between; the verdict needs every frozen budget.

| budget | required MATCH | required EXCEED | ranked pre-cap | post-cap | current tokens | uncapped tokens (ceiling) | uncapped tokens (all bounds) | current util | theoretical util | theoretical util (all bounds) | min / p10 / p90 / max (all bounds) | sufficiency |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1000 | 600 | 800 | 37 | 2 | 465.5 | 1028.5 | 1028.5 | 46.55% | 102.85% | 102.85% | 39.8 / 100.5 / 103.7 / 104.4 | SUFFICIENT |
| 1500 (non-frozen) | 900 | 1200 | 37 | 6 | 989 | 1544 | 1542.5 | 65.94% | 102.94% | 102.84% | 66.6 / 68 / 103.67 / 104.2 | SUFFICIENT |
| 2000 | 1200 | 1600 | 37 | 6 | 1004 | 2069.5 | 2069.5 | 50.2% | 103.47% | 103.47% | 51 / 82.1 / 104.05 / 104.25 | SUFFICIENT |
| 3000 (non-frozen) | 1800 | 2400 | 37 | 6 | 1004 | 3104.5 | 2541.5 | 33.47% | 103.48% | 84.72% | 34 / 64.8 / 103.47 / 103.8 | SUFFICIENT |
| 4000 | 2400 | 3200 | 37 | 6 | 1004 | 4071 | 3791.5 | 25.1% | 101.78% | 94.78% | 25.5 / 59.25 / 99.92 / 102.13 | SUFFICIENT |
| 6000 (non-frozen) | 3600 | 4800 | 37 | 6 | 1004 | 4262 | 4262 | 16.73% | 71.03% | 71.03% | 17 / 39.5 / 80.23 / 83.15 | SUFFICIENT |
| 8000 | 4800 | 6400 | 37 | 6 | 1053.5 | 4215.5 | 4215.5 | 13.17% | 52.69% | 52.69% | 15.06 / 30.16 / 60.25 / 62.36 | INSUFFICIENT |
| 12000 (non-frozen) | 7200 | 9600 | 38 | 15 | 2186.5 | 4435 | 4435 | 18.23% | 36.96% | 36.96% | 17.57 / 20.23 / 40.96 / 42.79 | INSUFFICIENT |
| 16000 | 9600 | 12800 | 38 | 15 | 2198.5 | 4475 | 4475 | 13.74% | 27.97% | 27.97% | 13.18 / 15.17 / 30.72 / 32.09 | INSUFFICIENT |

Verdict: `A11_SUPPLY_INSUFFICIENT`; the frozen band if uncapped: BELOW. Worst task-level deficits (all-bounds tokens short of the MATCH line):

| task | budget | required | uncapped | deficit | pool | ranked pre-cap | counterfactual stop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| what deduplicates supporting files in the capsule | 16000 | 9600 | 2108 | 7492 | null | null | NO_TRUTHFUL_SUPPLY |
| how does cython parsing differ from python parsing | 16000 | 9600 | 2427 | 7173 | 31 | 38 | OTHER_EXPLICIT_POLICY |
| where is the MCP tool registry assembled | 16000 | 9600 | 3234 | 6366 | 25 | 32 | OTHER_EXPLICIT_POLICY |
| how does hybrid scoring combine lexical and graph signals | 16000 | 9600 | 3837 | 5763 | 29 | 37 | OTHER_EXPLICIT_POLICY |
| where are import edges extracted from typescript | 16000 | 9600 | 4123 | 5477 | 29 | 39 | OTHER_EXPLICIT_POLICY |
| where does logic flow decide a path is unreachable | 16000 | 9600 | 4168 | 5432 | 31 | 39 | OTHER_EXPLICIT_POLICY |
| budget allocation for capsule items is dropping sections | 16000 | 9600 | 4172 | 5428 | 31 | 35 | OTHER_EXPLICIT_POLICY |
| how does search rank candidate symbols for a task | 16000 | 9600 | 4350 | 5250 | 30 | 37 | OTHER_EXPLICIT_POLICY |
| how are skeleton declarations built from indexed symbols | 16000 | 9600 | 4376 | 5224 | 27 | 36 | OTHER_EXPLICIT_POLICY |
| where are call sites persisted for an edge | 16000 | 9600 | 4446 | 5154 | 29 | 36 | OTHER_EXPLICIT_POLICY |

## Candidate admission and utilisation before / after (C-MED medians)

| budget | ranked pre-cap | capsule selected before | after | capsule discarded before | after | delivered items before | after | whole tokens before | after | unused before | after | util before | after | after min / p10 / p90 / max | stops after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1000 | 37 -> 38 | 2 | 17 | 35 | 20 | 3 | 8 | 465.5 | 838.5 | 534.5 | 161.5 | 46.55% | 83.85% | 76.6 / 77.4 / 102.1 / 102.3 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 1500 (non-frozen) | 37 -> 38 | 6 | 23 | 31 | 13 | 9 | 12 | 989 | 1390 | 511 | 110 | 65.94% | 92.67% | 39.47 / 65.2 / 102.8 / 103.07 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 2000 | 37 -> 38 | 6 | 32 | 31 | 5 | 9 | 16.5 | 1004 | 1909.5 | 996 | 90.5 | 50.2% | 95.47% | 52.3 / 66.25 / 101.25 / 102.95 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 3000 (non-frozen) | 37 -> 38 | 6 | 35 | 31 | 2 | 9 | 25 | 1004 | 3025 | 1996 | -25 | 33.47% | 100.84% | 72.37 / 85.27 / 102.6 / 103.17 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 4000 | 37 -> 38 | 6 | 35 | 31 | 2 | 9 | 33 | 1004 | 4049.5 | 2996 | -49.5 | 25.1% | 101.23% | 64.95 / 84.05 / 102.4 / 102.75 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":19,"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":1} |
| 6000 (non-frozen) | 37 -> 38 | 6 | 35 | 31 | 2 | 9 | 36 | 1004 | 4439 | 4996 | 1561 | 16.73% | 73.98% | 43.3 / 58.85 / 81.07 / 83.17 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":15,"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":4,"NO_TRUTHFUL_SUPPLY":1} |
| 8000 | 37 -> 38 | 6 | 35 | 31 | 2 | 11 | 36 | 1053.5 | 4439 | 6946.5 | 3561 | 13.17% | 55.48% | 32.48 / 44.14 / 60.8 / 62.38 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |
| 12000 (non-frozen) | 38 -> 38 | 15 | 35 | 23 | 2 | 17.5 | 37 | 2186.5 | 4453 | 9813.5 | 7547 | 18.23% | 37.11% | 21.73 / 30.65 / 41.73 / 42.67 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |
| 16000 | 38 -> 38 | 15 | 35 | 23 | 2 | 18 | 37 | 2198.5 | 4453 | 13801.5 | 11547 | 13.74% | 27.84% | 16.3 / 22.99 / 31.29 / 32 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |

Debug-surface envelope after (detail=debug, paired call): 1000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.discarded",20],["diagnostics.indexFreshness",8]]; 1500: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.actionabilityHints[].evidence",17],["diagnostics.indexFreshness",7]]; 2000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.actionabilityHints[].evidence",17],["diagnostics.indexFreshness",8]]; 3000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.actionabilityHints[].evidence",17],["diagnostics.indexFreshness",7]]; 4000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.actionabilityHints[].evidence",17],["capsuleResult.discarded",9]]; 6000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.actionabilityHints[].evidence",17],["capsuleResult.discarded",16]]; 8000: within 20/20, top compacted [["accounting",20],["capsuleResult.digest",20],["capsuleResult.discarded",19],["capsuleResult.manifest_only",18]]; 12000: within 20/20, top compacted [["capsuleResult.digest",20],["capsuleResult.discarded",20],["capsuleResult.pivots[].evidence",20],["capsuleResult.pivots[].roleReason",20]]; 16000: within 20/20, top compacted [["capsuleResult.discarded",20],["capsuleResult.pivots[].evidence",20],["capsuleResult.pivots[].source",20],["capsuleResult.support[].evidence",20]].

## Counterfactual-to-product attribution (frozen responses)

100 responses: related set equal to the pre-change counterfactual 11, order equal 0, actual a subset of predicted 27; median identities only predicted 4, only actual 1. the pre-change counterfactual appended the count-cap discards AFTER the delivered prefix (which already held the impact, memory and neighbourhood entries), whereas the product packs every support before the impact and memory items, so order equality is unreachable by construction and set overlap is the attribution measure; the counterfactual modelled the projector's ceiling, the evidence budget and the capsule token budget, not the whole-response envelope's escalation of the evidence budget, which is why the product delivered fewer than predicted at 1000-2000 (the actual stop reason names that budget).

| budget | set equal | order equal | actual ⊆ predicted | median predicted | median actual | median share of actual predicted | actual stops | upstream status |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1000 | 0 | 0 | 2 | 11.5 | 7 | 0.6515 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | {"compacted":20} |
| 2000 | 0 | 0 | 1 | 24 | 15.5 | 0.718 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | {"compacted":20} |
| 4000 | 4 | 0 | 8 | 35 | 32 | 0.9704999999999999 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":19,"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":1} | {"compacted":19,"complete":1} |
| 8000 | 2 | 0 | 8 | 36.5 | 35 | 0.973 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} | {"complete":20} |
| 16000 | 5 | 0 | 8 | 36.5 | 36 | 0.973 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} | {"complete":20} |

## Tail (ten worst post-change frozen responses)

| task | budget | util | items | pool | ranked pre-cap | post-cap | remaining truthful supply | next item fits | stop | binding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| how does cython parsing differ from python parsing | 16000 | 16.3% | 22 | 31 | 38 | 22 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| where is the MCP tool registry assembled | 16000 | 22.99% | 32 | 25 | 34 | 32 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| what deduplicates supporting files in the capsule | 16000 | 23.96% | 33 | null | null | null | 0 | false | NO_TRUTHFUL_SUPPLY | NO_ELIGIBLE_EVIDENCE |
| how does hybrid scoring combine lexical and graph signals | 16000 | 24.14% | 35 | 29 | 37 | 35 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| budget allocation for capsule items is dropping sections | 16000 | 25.14% | 31 | 31 | 35 | 31 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| where are import edges extracted from typescript | 16000 | 25.38% | 38 | 29 | 39 | 37 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| where does logic flow decide a path is unreachable | 16000 | 26.98% | 33 | 31 | 39 | 33 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| how does search rank candidate symbols for a task | 16000 | 27.19% | 40 | 30 | 37 | 35 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| what writes the index manifest after a run | 16000 | 27.2% | 38 | 28 | 37 | 36 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |
| how are skeleton declarations built from indexed symbols | 16000 | 27.44% | 31 | 27 | 36 | 31 | 0 | false | OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP | NO_ELIGIBLE_EVIDENCE |

## Same-corpus control

Repaired product on the pre-change corpus copy: 180 responses; focus same as pre 180; packet byte-identical to pre 1; packet byte-identical to the post run on the moved corpus 84, related set same 87. Frozen A11 on the pre corpus {"1000":86.55,"2000":95.85,"4000":101.22,"8000":54.72,"16000":27.96} vs on the post corpus {"1000":83.85,"2000":95.47,"4000":101.23,"8000":55.48,"16000":27.84}. Median items pre 9, post-on-pre 29.5, post-on-post 31.

## Falsification

| id | pass | statement |
| --- | --- | --- |
| F1 | pass | a high budget whose truthful ranked supply cannot reach the utilisation line keeps its unused budget and admits no filler |
| F2 | pass | an abundant truthful stream at a high budget: the fixed count truncated it; the repaired product admits substantially more until the budget or the stream ends |
| F3 | pass | one semantic item proposed by two routes is delivered once with one accounting record; identical delivered evidence is packed once |
| F4 | pass | candidates below the eligibility line stay excluded when budget remains: the role gate keeps test symbols out, the projector drops a claimless candidate, and the analyzer rejects one forced in |
| F5 | pass | role safeguards hold: abundant support never displaces a pivot; the pivot set and lead are identical before and after; the pivot cap is unchanged |
| F6 | pass | equal-score candidates across roles merge into one stable order across repeated builds; ties break on the ranking keys |
| F7 | pass | a synthetic huge candidate stream stays bounded by independently justified limits: the retrieval pool and lane caps on the stream, the token budget on the capsule |
| F8 | pass | intermediate caller budgets follow the same allocation rule: no rung-specific case, no count discard, monotone capsule items, prefix support order within a tier |
| F9 | pass | a newly admitted item with a wrong or missing cost fails the M203 analyzer; the honest expanded packet reconciles and is fully A14-accounted |
| F10 | pass | expanded allocation never fabricates a richer form: every delivered code is source-anchored under the M205 authority, and a fabricated one fails |
| F11 | pass | utilisation and monotonicity are separate questions: a focus swap between budgets is an A13 violation while both packets pass the utilisation analyzer |
| F12 | pass | the historical fixed-count allocator fails the abundant-supply utilisation control that the repaired allocator passes; where the stream itself binds, neither passes |

## Representation and accounting integrity

A12 on the repaired product: 4 classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt) MATCHES; integrity failures 0/180; related entries on C-MED 4521 (M205 1703), accounted 4521, valid representation 4521; class totals {"focused_source":441,"signature":109,"skeleton":3835,"relationship_only":299,"excerpt":17}; reasons {"upstream_form_delivered":4222,"form_not_code_bearing":225,"no_rendered_body":27,"ceiling":47}; source truth {"focused_source":{"ANCHORED_IN_SPAN":441},"signature":{"PARSER_SIGNATURE":109},"skeleton":{"SKELETON_MATCHES_INDEX":3681,"SKELETON_HEAD_OF_INDEX":154},"excerpt":{"ANCHORED_IN_SPAN":17}}. Frozen rerun A12 MATCHES (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt).

A14 frozen rerun 2548/2548 (MATCHES); M205 1004/1004. Sweep gate failures pre 0/180, post 0/180.

## Determinism

3 repeats: packets stable true, ledgers stable true; unstable []; F6 true.

## Performance

A5 p90 before {"C-SMALL":43.45,"C-MED":197.52,"C-LARGE":334.87} (MATCHES); after {"C-SMALL":52.25,"C-MED":207.46,"C-LARGE":346.68} (MATCHES); frozen A5 MATCHES. Largest packet 11594 -> 20479 bytes; largest item count 21 -> 42; largest ranked stream 42 -> 42; peak RSS 497 -> 1844 MB. no DB table, no schema change, no new persisted metadata; the tool output schema declares two diagnostics markers the envelope already emitted (sectionDecisionsOmitted, sectionDecisionsNote).

| budget | p90 before | p90 after | allocation audit ms (median, after) |
| ---: | ---: | ---: | ---: |
| 1000 | 256.84 | 230.52 | 117.2 |
| 1500 | 217.65 | 224.51 | 117.0 |
| 2000 | 216.14 | 232.85 | 118.2 |
| 3000 | 229.5 | 233.67 | 117.0 |
| 4000 | 217.94 | 241.39 | 119.5 |
| 6000 | 219.05 | 234.63 | 116.1 |
| 8000 | 230.82 | 243.64 | 119.8 |
| 12000 | 260.11 | 241.07 | 117.9 |
| 16000 | 245.54 | 236.53 | 120.7 |

## A13, observed

M205 committed: 3 size violations, 5 focus swaps (BELOW). Pre: 3 / 5, order relations {"subsequence":17,"prefix":42,"neither":21}. Post: 3 / 5, order relations {"subsequence":31,"prefix":15,"neither":34}, representation regressions 6. Frozen rerun: 3 / 5 (BELOW). A13 was measured, not optimized.

## Protected claims

| id | M205 | M206 | held |
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
| A12 | MATCHES | MATCHES | true |
| A14 | MATCHES | MATCHES | true |

## Full matrix

| id | M205 | M206 | measurement |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, |
| A2 | EXCEEDS | EXCEEDS | C-MED 63.49 files/s, C-LARGE 33.7 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.054, k=3 ratio 0.134; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominato |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.005 / 0.077 / 0.157 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 56.03 / 223.09 / 355.85 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 35.24 / 150.07 / 296.22 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 155.19 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 17.46 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.82%, C-LARGE 87.21% over 449 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LA |
| A11 | BELOW | BELOW | C-MED whole-response utilisation by budget: 1000=83.55%, 2000=95.47%, 4000=101.23%, 8000=55.48%, 16000=27.84% over 20 tasks |
| A12 | MATCHES | MATCHES | C-MED default response carries 4 distinct representation classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt) |
| A13 | BELOW | BELOW | 3 of 20 tasks lose focus content as the budget grows, and 5 swap the delivered focus symbol, over 5 budgets |
| A14 | MATCHES | MATCHES | 2548 of 2548 delivered items carry token accounting; no accounting block appears in the default response at all (present at detail=debug onl |
| A15 | BELOW | BELOW | C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface |

M205 12/15, M206 12/15, target 15/15.

Frozen control F6: FAIL. the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so a failure is the stale control and not an A14 regression; not modified (M203 standing finding).

## Gates

| gate | pass | statement |
| --- | --- | --- |
| G1 | pass | frozen A11 definition recovered unchanged |
| G2 | pass | A11 BELOW reproduced pre-change, equal to the committed M205 figures |
| G3 | pass | allocation path traced: every truncation stage identified with counts; no unclassified discard |
| G4 | pass | tier semantics recovered: historical counts, their origin commit and their actual authority documented |
| G5 | pass | read-only counterfactual evaluator: replica matches the projector's ledger on every response; 0 gate failures |
| G6 | pass | supply sufficiency decided before any cap change, on the frozen rule |
| G7 | pass | one allocation authority: the tier support number is a window, the token budget is the bound, no parallel allocator |
| G8 | pass | fixed-cap defect repaired: no ranked support candidate is discarded for a count (F2, F8); the count discard reason no longer exists |
| G9 | pass | role invariants: pivot caps unchanged, pivots pack first, abundant support never displaces a pivot (F5) |
| G10 | pass | no filler: no duplicate, no ineligible tail, unused budget stays unused (F1, F3, F4); analyzer gates on every post response |
| G11 | pass | M205 representation truth on every expanded item (F10; representation sweep on the repaired product) |
| G12 | pass | M203 accounting: every delivered item accounted and reconciled (F9; frozen A14) |
| G13 | pass | determinism: repeats stable on packets and ledgers (F6) |
| G14 | pass | performance: A5 at least MATCHES |
| G15 | pass | A1-A10 protected |
| G16 | pass | A12 protected |
| G17 | pass | A14 protected |
| G18 | pass | A13 measured only; new baseline captured (F11) |
| G19 | pass | A15 untouched (impact rendering unchanged; verdict carried) |
| G20 | pass | frozen A11 verdict from the unmodified scorer |
| G21 | pass | full A1-A15 rerun by the unmodified analyzer |
| G22 | pass | standard verification (recorded by the ledger row; not computed here) |
| G23 | pass | zero model spend: offline instruments only |

## Authority

Replay: `M197A_AUTHORITY_VERIFIED` at 504 files (expected 504) @ fabd8530a935. Post: `M197A_AUTHORITY_VERIFIED` at 504 @ fabd8530a935. C-MED is this repository's src/; M206 edited existing source files and added none, so the self-referential count is unchanged while the revision moved; claim definitions, thresholds, scorer and corpus root unchanged.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_A13_MONOTONICITY_REPAIR_AUTHORIZED
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_NEW_REPRESENTATION_CLASS_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED
