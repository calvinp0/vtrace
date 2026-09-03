# M208 — budget-growth monotonicity: pre-change causal report

`A13_CAUSAL_ATTRIBUTION_COMPLETE` — M207 A13 reproduced exactly; product b74287688653; 3 repeats, packets stable true.

## 1. Frozen A13 authority

Claim `A13`: "pivots degrade to skeletons and support is dropped when the budget binds" (V-C7). Corpus C-MED (this repository's `src/`), the 20 `A13_TASKS`, budgets 1000 / 2000 / 4000 / 8000 / 16000, one default `get_code_context` call per task per budget.

Engine rule (run_stage5_m197a_engine.ts, verbatim):

```ts
        focusAt: out?.focus?.at ?? null,
        focusCodeTokens: tokens(out?.focus?.code ?? ""),
    // A13: information must not decrease as the budget grows. A focus swap is a
    // separate violation from a size regression, because swapping the delivered
    // symbol is a loss the token count alone cannot show.
    let sizeViolations = 0; let focusSwaps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i]!.focusCodeTokens < points[i - 1]!.focusCodeTokens) sizeViolations += 1;
      if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
    }
    curves.push({ task, points, sizeViolations, focusSwaps });
```

Report rule (run_stage5_m197a_report.ts, verbatim):

```ts
    id: "A13", vexpClaim: "pivots degrade to skeletons and support is dropped when the budget binds",
    vexpSource: "V-C7, vexp-core binary", m196Prior: "1/3 tasks violated — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `${eng("C-MED")?.a11a13?.tasksWithSizeViolation} of `
      + `${eng("C-MED")?.a11a13?.tasks} tasks lose focus content as the budget grows, and `
      + `${eng("C-MED")?.a11a13?.tasksWithFocusSwap} swap the delivered focus symbol, over `
      + `${(eng("C-MED")?.a11a13?.budgets ?? []).length} budgets`,
    matchThreshold: "0 monotonicity violations", exceedThreshold: "0 plus a declared drop order",
    verdict: band([a13Violations], 0, 0, "atMost"),
    comparabilityCaveat: "a focus swap is counted as a violation: swapping the delivered symbol is "
function band(values: readonly (number | null)[], match: number, exceed: number,
              direction: "atLeast" | "atMost"): ClaimVerdict | null {
  if (values.length === 0 || values.some((v) => v === null || Number.isNaN(v))) return null;
  const nums = values as number[];
  const clears = (bar: number) => direction === "atLeast"
    ? nums.every((v) => v >= bar) : nums.every((v) => v <= bar);
  if (clears(exceed)) return ClaimVerdict.Exceeds;
  if (clears(match)) return ClaimVerdict.Matches;
  return ClaimVerdict.Below;
}
```

MATCH = 0 violations; EXCEED = 0 (`band([a13Violations], 0, 0, "atMost")`: both bars are 0, so a zero score reports EXCEEDS; the exceed wording "plus a declared drop order" is not scored — a stale wording control analogous to M203's F6, reported and not edited). The related-order relations and representation regressions M207 reported are observations under `m204Utilization.orderRelation` and the M207 sweep's `relationship_only` rule; they are reproduced here under the same definitions and are not part of the frozen verdict.

## 2. M207 reproduction

|  | size violations | focus swaps | order relations | representation regressions | A11 medians | A13 |
| --- | --- | --- | --- | --- | --- | --- |
| M207 committed | 3 | 5 | {"subsequence":15,"neither":65} | 24 | {"1000":84.05,"2000":94.65,"4000":102.05,"8000":102.5,"16000":94.72} | BELOW |
| M208 pre-change audit | 3 | 5 | {"neither":65,"subsequence":15} | 24 | {"1000":85.05,"2000":94.78,"4000":102.05,"8000":102.5,"16000":94.72} | BELOW |

## 3. Where the budget acts

| budget | tier | maxPivots | supportWindow | candidate allowance |
| --- | --- | --- | --- | --- |
| 750 | micro | 1 | 1 | 25 |
| 1000 | micro | 1 | 1 | 25 |
| 1250 | micro | 1 | 1 | 25 |
| 1499 | micro | 1 | 1 | 25 |
| 1500 | standard | 2 | 4 | 25 |
| 2000 | standard | 2 | 4 | 25 |
| 2500 | standard | 2 | 4 | 25 |
| 3000 | standard | 2 | 4 | 25 |
| 4000 | standard | 2 | 4 | 34 |
| 5000 | standard | 2 | 4 | 42 |
| 6000 | standard | 2 | 4 | 50 |
| 8000 | standard | 2 | 4 | 67 |
| 10000 | standard | 2 | 4 | 84 |
| 11999 | standard | 2 | 4 | 100 |
| 12000 | full | 5 | 10 | 100 |
| 16000 | full | 5 | 10 | 134 |
| 20000 | full | 5 | 10 | 167 |

| stage | how the budget reaches it | code |
| --- | --- | --- |
| S1 ranked pool | hybridRetrieve(maxResults = allocation.candidatePool); conceptOwnerCandidates(... ranked.slice(0, maxResults) ...) judges 'file already represented' against the allowance-sized slice | buildCapsuleV2.ts:254-271, hybridRetrieval.ts:451 |
| S2 role assignment | assignCandidateRoles(candidates, { maxPivots: allocation.maxPivots }) caps pivots in final-score order; refineDebugRoles -> capPivots(maxPivots) likewise | buildCapsuleV2.ts:755,773; debugRoles.ts:572-640 |
| S4a pivot order | pivotCandidates.sort (anchor tiers) and pivot-ranking v2 re-sort run on the CAPPED set; the lead is the head of that order | buildCapsuleV2.ts:975-1050 |
| S4b support order | supportWindow = allocation.supportWindow (1 / 4 / 10) partitions baseSupportOrder in orderSupportWithCoedit (protected winners, displacing co-edits, displaceable winners, spare co-edits, rest); file-evidence, path-completion and mechanism lanes read the same window | buildCapsuleV2.ts:1173-1440; coeditExpansion.ts:786-828 |
| S5 packing | renderPivot / renderSupport against input.maxTokens - usedTokens; over-budget support is skipped ('continue'), later smaller items still pack | buildCapsuleV2.ts:1090-1140, 1463-1470 |
| S6 assembly | assembleProductContext: P#, S#, then actionability (D#), impact (I#), memory (M#), rule (G#) drafts, deduplicated | assembleProductContext.ts:222-260 |
| S7 evidence budget | applyProgressiveContextBudget(draft, requestedTokens or retryWithinCeiling's affordable budget): rungs drop optional support from the tail by keepPriority, where answerBearing is a substring test on the selection reasons | budgetDelivery.ts; responseEnvelope.ts:354-407 |
| S9 projector | orientationCeilingTokens(requested_context_tokens): admission takes a prefix relationship-only, then M205 routing offers each entry its upstream form in order | orientationProjection.ts:527-597 |
| S10 packet | focus = leadPivot item, head-bounded at 1800 chars; related in authoritative order | orientationProjection.ts:424-438 |

## 4. The 80 adjacent-budget transitions

| task | from->to | tiers | pivots | window | pool | focus | relation | focus-adjusted | first divergence | lost | moved | added | regressions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| where are import edges extracted from typescript | 1000->2000 | micro->standard | 1->2 | 1->4 | 29->29 | extractImportEdges -> ExtractImportEdgesInput (size drop) | subsequence | subsequence | S4a_pivot_order: PIVOT_CAP_LEAD_RESELECTION | 0 | 0 | 12 | 0 |
| where are import edges extracted from typescript | 2000->4000 | standard->standard | 2->2 | 4->4 | 29->36 | ExtractImportEdgesInput | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 0 | 23 | 0 |
| where are import edges extracted from typescript | 4000->8000 | standard->standard | 2->2 | 4->4 | 36->68 | ExtractImportEdgesInput | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 2 | 24 | 1 |
| where are import edges extracted from typescript | 8000->16000 | standard->full | 2->5 | 4->10 | 68->128 | ExtractImportEdgesInput | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 2 | 5 | 55 | 0 |
| how does the indexer decide a file is eligible for parsing | 1000->2000 | micro->standard | 1->2 | 1->4 | 34->34 | bindingTermFor | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed | 0 | 2 | 10 | 0 |
| how does the indexer decide a file is eligible for parsing | 2000->4000 | standard->standard | 2->2 | 4->4 | 34->43 | bindingTermFor | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 16 | 0 |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | standard->standard | 2->2 | 4->4 | 43->75 | bindingTermFor | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 0 | 6 | 41 | 5 |
| how does the indexer decide a file is eligible for parsing | 8000->16000 | standard->full | 2->5 | 4->10 | 75->133 | bindingTermFor | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 1 | 8 | 60 | 0 |
| budget allocation for capsule items is dropping sections | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | listCapsuleItems | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 1 | 2 | 8 | 0 |
| budget allocation for capsule items is dropping sections | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->40 | listCapsuleItems | neither | neither | S4b_support_order: SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high | 1 | 3 | 23 | 3 |
| budget allocation for capsule items is dropping sections | 4000->8000 | standard->standard | 2->2 | 4->4 | 40->72 | listCapsuleItems | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 0 | 3 | 24 | 0 |
| budget allocation for capsule items is dropping sections | 8000->16000 | standard->full | 2->5 | 4->10 | 72->127 | listCapsuleItems | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 4 | 53 | 0 |
| how is the impact graph bounded when a symbol has many callers | 1000->2000 | micro->standard | 1->2 | 1->4 | 30->30 | hasInheritedMemberEvidence | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 2 | 6 | 0 |
| how is the impact graph bounded when a symbol has many callers | 2000->4000 | standard->standard | 2->2 | 4->4 | 30->38 | hasInheritedMemberEvidence | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 0 | 15 | 0 |
| how is the impact graph bounded when a symbol has many callers | 4000->8000 | standard->standard | 2->2 | 4->4 | 38->72 | hasInheritedMemberEvidence | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 1 | 41 | 1 |
| how is the impact graph bounded when a symbol has many callers | 8000->16000 | standard->full | 2->5 | 4->10 | 72->134 | hasInheritedMemberEvidence | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 10 | 62 | 0 |
| where does logic flow decide a path is unreachable | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | LogicFlowPath -> hasCrossLanguagePythonCythonStep | neither | neither | S4a_pivot_order: PIVOT_CAP_LEAD_RESELECTION | 2 | 0 | 9 | 0 |
| where does logic flow decide a path is unreachable | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->39 | hasCrossLanguagePythonCythonStep | neither | neither | S7_evidence_budget: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 1 | 0 | 23 | 0 |
| where does logic flow decide a path is unreachable | 4000->8000 | standard->standard | 2->2 | 4->4 | 39->74 | hasCrossLanguagePythonCythonStep | neither | neither | S4b_support_order: SUPPORT_ORDER_OTHER:base_support_tier_1 | 0 | 3 | 30 | 0 |
| where does logic flow decide a path is unreachable | 8000->16000 | standard->full | 2->5 | 4->10 | 74->130 | hasCrossLanguagePythonCythonStep | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 7 | 48 | 0 |
| how are skeleton declarations built from indexed symbols | 1000->2000 | micro->standard | 1->2 | 1->4 | 27->27 | buildDeclarations | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 9 | 0 |
| how are skeleton declarations built from indexed symbols | 2000->4000 | standard->standard | 2->2 | 4->4 | 27->36 | buildDeclarations | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 15 | 0 |
| how are skeleton declarations built from indexed symbols | 4000->8000 | standard->standard | 2->2 | 4->4 | 36->69 | buildDeclarations | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 38 | 0 |
| how are skeleton declarations built from indexed symbols | 8000->16000 | standard->full | 2->5 | 4->10 | 69->130 | buildDeclarations | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 7 | 63 | 0 |
| what determines whether the repository index is considered fresh | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | findFileIndexFailure | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 1 | 9 | 0 |
| what determines whether the repository index is considered fresh | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->40 | findFileIndexFailure | subsequence | subsequence | S9_projector: REPRESENTATION_ROUTING:ceiling | 0 | 1 | 19 | 1 |
| what determines whether the repository index is considered fresh | 4000->8000 | standard->standard | 2->2 | 4->4 | 40->73 | findFileIndexFailure | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 3 | 40 | 2 |
| what determines whether the repository index is considered fresh | 8000->16000 | standard->full | 2->5 | 4->10 | 73->130 | findFileIndexFailure | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 6 | 59 | 0 |
| how does hybrid scoring combine lexical and graph signals | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | combineFinalScore | neither | neither | S7_evidence_budget: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 1 | 0 | 12 | 0 |
| how does hybrid scoring combine lexical and graph signals | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->40 | combineFinalScore | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 24 | 0 |
| how does hybrid scoring combine lexical and graph signals | 4000->8000 | standard->standard | 2->2 | 4->4 | 40->73 | combineFinalScore | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 2 | 3 | 29 | 0 |
| how does hybrid scoring combine lexical and graph signals | 8000->16000 | standard->full | 2->5 | 4->10 | 73->130 | combineFinalScore | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 6 | 52 | 0 |
| where is the MCP tool registry assembled | 1000->2000 | micro->standard | 1->2 | 1->4 | 25->25 | createRestrictedMcpToolRegistry -> McpToolRegistry (size drop) | subsequence | subsequence | S4a_pivot_order: PIVOT_CAP_LEAD_RESELECTION | 0 | 0 | 7 | 0 |
| where is the MCP tool registry assembled | 2000->4000 | standard->standard | 2->2 | 4->4 | 25->34 | McpToolRegistry | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 0 | 1 | 20 | 0 |
| where is the MCP tool registry assembled | 4000->8000 | standard->standard | 2->2 | 4->4 | 34->67 | McpToolRegistry | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 0 | 1 | 32 | 0 |
| where is the MCP tool registry assembled | 8000->16000 | standard->full | 2->5 | 4->10 | 67->131 | McpToolRegistry | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 4 | 64 | 0 |
| how does the python parser resolve module imports | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | resolveImportedModulePath | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 2 | 7 | 0 |
| how does the python parser resolve module imports | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->39 | resolveImportedModulePath | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 0 | 20 | 0 |
| how does the python parser resolve module imports | 4000->8000 | standard->standard | 2->2 | 4->4 | 39->71 | resolveImportedModulePath | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 0 | 1 | 43 | 0 |
| how does the python parser resolve module imports | 8000->16000 | standard->full | 2->5 | 4->10 | 71->129 | resolveImportedModulePath | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 1 | 8 | 52 | 0 |
| what writes the index manifest after a run | 1000->2000 | micro->standard | 1->2 | 1->4 | 29->29 | runCli | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 5 | 0 |
| what writes the index manifest after a run | 2000->4000 | standard->standard | 2->2 | 4->4 | 29->38 | runCli | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 2 | 0 | 24 | 0 |
| what writes the index manifest after a run | 4000->8000 | standard->standard | 2->2 | 4->4 | 38->71 | runCli | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 3 | 38 | 2 |
| what writes the index manifest after a run | 8000->16000 | standard->full | 2->5 | 4->10 | 71->130 | runCli -> openIndexerDatabase (size drop) | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 11 | 60 | 0 |
| how are worktrees excluded from the parent repository index | 1000->2000 | micro->standard | 1->2 | 1->4 | 28->28 | RepositoryIdentity | neither | neither | S4b_support_order: SUPPORT_LANE_PLACEMENT:coedit_rescued_medium | 0 | 1 | 8 | 0 |
| how are worktrees excluded from the parent repository index | 2000->4000 | standard->standard | 2->2 | 4->4 | 28->38 | RepositoryIdentity | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 2 | 22 | 0 |
| how are worktrees excluded from the parent repository index | 4000->8000 | standard->standard | 2->2 | 4->4 | 38->69 | RepositoryIdentity | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 2 | 3 | 41 | 0 |
| how are worktrees excluded from the parent repository index | 8000->16000 | standard->full | 2->5 | 4->10 | 69->132 | RepositoryIdentity | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 7 | 59 | 0 |
| where does the product context decide which files are pivots | 1000->2000 | micro->standard | 1->2 | 1->4 | 34->34 | isRequiredPivot | neither | neither | S4b_support_order: SUPPORT_LANE_PLACEMENT:coedit_injected_high | 0 | 1 | 9 | 0 |
| where does the product context decide which files are pivots | 2000->4000 | standard->standard | 2->2 | 4->4 | 34->42 | isRequiredPivot | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 4 | 1 | 23 | 1 |
| where does the product context decide which files are pivots | 4000->8000 | standard->standard | 2->2 | 4->4 | 42->73 | isRequiredPivot | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 2 | 40 | 1 |
| where does the product context decide which files are pivots | 8000->16000 | standard->full | 2->5 | 4->10 | 73->132 | isRequiredPivot | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 1 | 4 | 63 | 0 |
| how does the response envelope shed content under budget pressure | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | impactResponseMeetsEvidenceBudget | neither | neither | S5_packing: CAPSULE_PACKING:packing_over_budget | 1 | 0 | 3 | 0 |
| how does the response envelope shed content under budget pressure | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->38 | impactResponseMeetsEvidenceBudget | neither | neither | S7_evidence_budget: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 1 | 0 | 18 | 0 |
| how does the response envelope shed content under budget pressure | 4000->8000 | standard->standard | 2->2 | 4->4 | 38->69 | impactResponseMeetsEvidenceBudget | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 39 | 0 |
| how does the response envelope shed content under budget pressure | 8000->16000 | standard->full | 2->5 | 4->10 | 69->130 | impactResponseMeetsEvidenceBudget | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 8 | 60 | 0 |
| what deduplicates supporting files in the capsule | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | CapsuleSupportingCandidate | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 1 | 1 | 11 | 0 |
| what deduplicates supporting files in the capsule | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->40 | CapsuleSupportingCandidate | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 20 | 0 |
| what deduplicates supporting files in the capsule | 4000->8000 | standard->standard | 2->2 | 4->4 | 40->72 | CapsuleSupportingCandidate | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 2 | 4 | 30 | 0 |
| what deduplicates supporting files in the capsule | 8000->16000 | standard->full | 2->5 | 4->10 | 72->130 | CapsuleSupportingCandidate | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 4 | 9 | 44 | 0 |
| how does cython parsing differ from python parsing | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | getCythonBackedExportIndex | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 5 | 0 |
| how does cython parsing differ from python parsing | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->40 | getCythonBackedExportIndex | neither | neither | S4b_support_order: SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high | 1 | 0 | 14 | 0 |
| how does cython parsing differ from python parsing | 4000->8000 | standard->standard | 2->2 | 4->4 | 40->73 | getCythonBackedExportIndex | neither | neither | S4b_support_order: SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring | 2 | 1 | 38 | 1 |
| how does cython parsing differ from python parsing | 8000->16000 | standard->full | 2->5 | 4->10 | 73->130 | getCythonBackedExportIndex | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 8 | 56 | 0 |
| where are call sites persisted for an edge | 1000->2000 | micro->standard | 1->2 | 1->4 | 29->29 | withCallSite | neither | neither | S7_evidence_budget: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 3 | 0 | 10 | 0 |
| where are call sites persisted for an edge | 2000->4000 | standard->standard | 2->2 | 4->4 | 29->37 | withCallSite | subsequence | subsequence | S9_projector: REPRESENTATION_ROUTING:ceiling | 0 | 2 | 18 | 2 |
| where are call sites persisted for an edge | 4000->8000 | standard->standard | 2->2 | 4->4 | 37->71 | withCallSite | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 1 | 40 | 1 |
| where are call sites persisted for an edge | 8000->16000 | standard->full | 2->5 | 4->10 | 71->130 | withCallSite | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 11 | 55 | 0 |
| how does search rank candidate symbols for a task | 1000->2000 | micro->standard | 1->2 | 1->4 | 30->30 | rankSearchCandidates | neither | neither | S4b_support_order: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed | 0 | 1 | 10 | 0 |
| how does search rank candidate symbols for a task | 2000->4000 | standard->standard | 2->2 | 4->4 | 30->37 | rankSearchCandidates | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 2 | 1 | 24 | 1 |
| how does search rank candidate symbols for a task | 4000->8000 | standard->standard | 2->2 | 4->4 | 37->68 | rankSearchCandidates | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 1 | 31 | 0 |
| how does search rank candidate symbols for a task | 8000->16000 | standard->full | 2->5 | 4->10 | 68->131 | rankSearchCandidates | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 1 | 10 | 58 | 0 |
| what happens when the index schema version is incompatible | 1000->2000 | micro->standard | 1->2 | 1->4 | 26->26 | HandoffSchemaVersion | subsequence | subsequence | none: SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 0 | 0 | 10 | 0 |
| what happens when the index schema version is incompatible | 2000->4000 | standard->standard | 2->2 | 4->4 | 26->35 | HandoffSchemaVersion | neither | neither | S7_evidence_budget: EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 1 | 0 | 16 | 0 |
| what happens when the index schema version is incompatible | 4000->8000 | standard->standard | 2->2 | 4->4 | 35->68 | HandoffSchemaVersion | neither | neither | S4b_support_order: SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high | 1 | 1 | 36 | 1 |
| what happens when the index schema version is incompatible | 8000->16000 | standard->full | 2->5 | 4->10 | 68->127 | HandoffSchemaVersion -> maxStoredFormatVersion | neither | neither | S1_ranked_pool: RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 3 | 13 | 64 | 0 |
| how is a symbol's fully qualified name constructed | 1000->2000 | micro->standard | 1->2 | 1->4 | 31->31 | FullyQualifiedName | neither | neither | S4b_support_order: SUPPORT_LANE_PLACEMENT:coedit_rescued_medium | 0 | 1 | 8 | 0 |
| how is a symbol's fully qualified name constructed | 2000->4000 | standard->standard | 2->2 | 4->4 | 31->39 | FullyQualifiedName | neither | neither | S4b_support_order: SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring | 1 | 0 | 18 | 0 |
| how is a symbol's fully qualified name constructed | 4000->8000 | standard->standard | 2->2 | 4->4 | 39->69 | FullyQualifiedName | subsequence | subsequence | S9_projector: REPRESENTATION_ROUTING:ceiling | 0 | 1 | 36 | 1 |
| how is a symbol's fully qualified name constructed | 8000->16000 | standard->full | 2->5 | 4->10 | 69->130 | FullyQualifiedName | neither | neither | S2_role_assignment: PIVOT_CAP_ROLE_PROMOTION | 0 | 8 | 61 | 0 |

## 5. First divergence, by mechanism

| mechanism | transitions |
| --- | --- |
| RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 27 |
| PIVOT_CAP_ROLE_PROMOTION | 14 |
| SUBSEQUENCE_NEW_ITEMS_INTERLEAVED | 10 |
| SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 6 |
| EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 5 |
| PIVOT_CAP_LEAD_RESELECTION | 3 |
| REPRESENTATION_ROUTING:ceiling | 3 |
| SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high | 3 |
| SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring | 2 |
| SUPPORT_LANE_PLACEMENT:coedit_rescued_medium | 2 |
| SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed | 2 |
| CAPSULE_PACKING:packing_over_budget | 1 |
| SUPPORT_LANE_PLACEMENT:coedit_injected_high | 1 |
| SUPPORT_ORDER_OTHER:base_support_tier_1 | 1 |

| stage | transitions |
| --- | --- |
| S1_ranked_pool | 27 |
| S4b_support_order | 17 |
| S2_role_assignment | 14 |
| none | 10 |
| S7_evidence_budget | 5 |
| S4a_pivot_order | 3 |
| S9_projector | 3 |
| S5_packing | 1 |

Lost lower-budget items: 74.

| mechanism | lost items |
| --- | --- |
| RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 40 |
| EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring | 11 |
| SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_high | 7 |
| SUPPORT_LANE_NOT_REPRODUCED:graph_neighbour_anchoring | 5 |
| EVIDENCE_BUDGET_DROP:impact_evidence(inferred) | 4 |
| PIVOT_CAP_LEAD_RESELECTION | 3 |
| CAPSULE_PACKING:packing_over_budget | 1 |
| EVIDENCE_BUDGET_DROP:budget_demoted_pivot | 1 |
| EVIDENCE_BUDGET_DROP:coedit_injected_high | 1 |
| SUPPORT_LANE_NOT_REPRODUCED:coedit_injected_medium | 1 |

Moved items (outside the longest common subsequence of the two common-item orders, or role-changed): 219.

| mechanism | moved items |
| --- | --- |
| SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed | 84 |
| PIVOT_CAP_ROLE_PROMOTION | 63 |
| SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed | 24 |
| REPRESENTATION_ROUTING:ceiling | 21 |
| SUPPORT_LANE_PLACEMENT:coedit_rescued_medium | 12 |
| SUPPORT_LANE_PLACEMENT:graph_neighbour_append | 4 |
| SUPPORT_LANE_PLACEMENT:coedit_injected_high | 2 |
| SUPPORT_LANE_PLACEMENT:coedit_injected_medium | 2 |
| SUPPORT_LANE_PLACEMENT:coedit_rescued_high | 2 |
| SUPPORT_ORDER_OTHER:base_support_tier_1 | 2 |
| REPRESENTATION_ROUTING:form_not_code_bearing | 1 |
| REPRESENTATION_ROUTING:no_rendered_body | 1 |
| SUPPORT_ORDER_OTHER:budget_demoted_pivot | 1 |

## 6. Focus swaps

| task | from->to | tiers (maxPivots) | lower focus (rank, v2) | higher focus (rank, v2) | higher focus's role at the lower budget | class |
| --- | --- | --- | --- | --- | --- | --- |
| where are import edges extracted from typescript | 1000->2000 | micro(1)->standard(2) | extractImportEdges (1, 1.807) | ExtractImportEdgesInput (2, 1.873) | support: strong target but beyond the pivot budget — pivot: actionabl | tier_cap_widened_then_v2_reordered |
| where does logic flow decide a path is unreachable | 1000->2000 | micro(1)->standard(2) | LogicFlowPath (1, 1.996) | hasCrossLanguagePythonCythonStep (2, 2.043) | support: strong target but beyond the pivot budget — pivot: actionabl | tier_cap_widened_then_v2_reordered |
| where is the MCP tool registry assembled | 1000->2000 | micro(1)->standard(2) | createRestrictedMcpToolRegistry (3, 1.951) | McpToolRegistry (4, 1.831) | support: strong target but beyond the pivot budget — pivot: actionabl | tier_cap_widened_then_anchor_tier_reordered |
| what writes the index manifest after a run | 8000->16000 | standard(2)->full(5) | runCli (1, 1.584) | openIndexerDatabase (4, 1.634) | support: strong target but beyond the pivot budget — pivot: actionabl | tier_cap_widened_then_v2_reordered |
| what happens when the index schema version is incompatible | 8000->16000 | standard(2)->full(5) | HandoffSchemaVersion (1, 1.559) | maxStoredFormatVersion (4, 1.6) | support: strong target but beyond the pivot budget — pivot: actionabl | tier_cap_widened_then_v2_reordered |

Every swap: the higher budget's focus was in the lower budget's pool, was a pivot-worthy candidate the lower tier's cap demoted to support (final-score order), and leads once the cap admits it because the pivot ORDER (pivot-ranking v2, or the title-symbol tier) ranks it above the previous lead. Pool growth is not involved (identical swaps with the pool pinned to 25).

## 7. Size violations

| task | from->to | focus | focus code tokens | cause |
| --- | --- | --- | --- | --- |
| where are import edges extracted from typescript | 1000->2000 | extractImportEdges -> ExtractImportEdgesInput | 352 -> 40 | focus_swap |
| where is the MCP tool registry assembled | 1000->2000 | createRestrictedMcpToolRegistry -> McpToolRegistry | 207 -> 60 | focus_swap |
| what writes the index manifest after a run | 8000->16000 | runCli -> openIndexerDatabase | 446 -> 43 | focus_swap |

No task's focus body shrank with the same focus; every size drop is the focus swap.

## 8. Representation regressions

| task | from->to | entry | lower -> higher | projector reason | ordinal | new items admitted ahead | richer form would have fit before later admissions | class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| where are import edges extracted from typescript | 4000->8000 | edgePairKey | skeleton -> relationship_only | no_rendered_body | 60 | 22 | null | upstream_form_changed |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | countFileIndexFailures | skeleton -> relationship_only | ceiling | 65 | 39 | true | avoidable_admission_first_crowding |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | behavioralObjectives | skeleton -> relationship_only | ceiling | 66 | 39 | true | avoidable_admission_first_crowding |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | objectiveProvenance | skeleton -> relationship_only | ceiling | 67 | 39 | true | avoidable_admission_first_crowding |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | hasPackageMarker | skeleton -> relationship_only | ceiling | 69 | 40 | false | necessary_ceiling |
| how does the indexer decide a file is eligible for parsing | 4000->8000 | chooseScopeLabel | skeleton -> relationship_only | ceiling | 70 | 40 | false | necessary_ceiling |
| budget allocation for capsule items is dropping sections | 2000->4000 | compactImpactSection | skeleton -> relationship_only | ceiling | 33 | 23 | true | avoidable_admission_first_crowding |
| budget allocation for capsule items is dropping sections | 2000->4000 | compactLegacyContextSection | skeleton -> relationship_only | ceiling | 34 | 23 | false | necessary_ceiling |
| budget allocation for capsule items is dropping sections | 2000->4000 | reduceDiagnosticsToAgentFacing | skeleton -> relationship_only | ceiling | 35 | 23 | false | necessary_ceiling |
| how is the impact graph bounded when a symbol has many callers | 4000->8000 | selectImpactFocalSymbol | skeleton -> relationship_only | ceiling | 64 | 34 | true | avoidable_admission_first_crowding |
| what determines whether the repository index is considered fresh | 2000->4000 | enclosingClassIs | skeleton -> relationship_only | ceiling | 31 | 19 | false | necessary_ceiling |
| what determines whether the repository index is considered fresh | 4000->8000 | nominateRepositories | skeleton -> relationship_only | ceiling | 67 | 39 | true | avoidable_admission_first_crowding |
| what determines whether the repository index is considered fresh | 4000->8000 | determineStatus | skeleton -> relationship_only | ceiling | 68 | 39 | false | necessary_ceiling |
| what writes the index manifest after a run | 4000->8000 | fileNamesFor | skeleton -> relationship_only | ceiling | 63 | 37 | false | necessary_ceiling |
| what writes the index manifest after a run | 4000->8000 | formatContextCapsulePipelineOutput | skeleton -> relationship_only | ceiling | 64 | 37 | false | necessary_ceiling |
| where does the product context decide which files are pivots | 2000->4000 | enforceTotalEnvelope | skeleton -> relationship_only | ceiling | 33 | 23 | false | necessary_ceiling |
| where does the product context decide which files are pivots | 4000->8000 | chooseScopeLabel | skeleton -> relationship_only | ceiling | 69 | 38 | false | necessary_ceiling |
| how does cython parsing differ from python parsing | 4000->8000 | resolveFromImportSubmodulePath | skeleton -> relationship_only | form_not_code_bearing | 65 | 38 | null | upstream_form_changed |
| where are call sites persisted for an edge | 2000->4000 | attachFlowSourceExcerpts | skeleton -> relationship_only | ceiling | 31 | 18 | false | necessary_ceiling |
| where are call sites persisted for an edge | 2000->4000 | buildBoundedImpactDecline | skeleton -> relationship_only | ceiling | 32 | 18 | false | necessary_ceiling |
| where are call sites persisted for an edge | 4000->8000 | buildStaticRelationEvidence | skeleton -> relationship_only | ceiling | 70 | 39 | false | necessary_ceiling |
| how does search rank candidate symbols for a task | 2000->4000 | bodyLiteralCandidates | skeleton -> relationship_only | ceiling | 33 | 22 | true | avoidable_admission_first_crowding |
| what happens when the index schema version is incompatible | 4000->8000 | productContextItemIdIndex | skeleton -> relationship_only | ceiling | 64 | 36 | false | necessary_ceiling |
| how is a symbol's fully qualified name constructed | 4000->8000 | findBestBroadTermMatch | skeleton -> relationship_only | ceiling | 70 | 36 | false | necessary_ceiling |

Classes: necessary_ceiling 15; avoidable_admission_first_crowding 7; upstream_form_changed 2; reasons: ceiling 22; form_not_code_bearing 1; no_rendered_body 1.

## 9. Candidate universe

Pool order relation across adjacent frozen budgets (lower pool vs higher pool): 1000->2000:prefix 20; 2000->4000:neither 9; 4000->8000:neither 11; 8000->16000:neither 14; 2000->4000:subsequence 11; 4000->8000:subsequence 8; 8000->16000:subsequence 5; 4000->8000:prefix 1; 8000->16000:prefix 1.

40 lower-budget delivered pool candidates are absent from the wider pool; 34 of them sat beyond the lower allowance (a lane extra admitted beside the cap), and every one carries `concept_owner` provenance.

| task | from->to | candidate | lower rank / pool (allowance) | higher pool | provenance |
| --- | --- | --- | --- | --- | --- |
| where are import edges extracted from typescript | 2000->4000 | extractTopLevelSymbols | 27 / 29 (25) | 36 | concept_owner |
| where are import edges extracted from typescript | 4000->8000 | parseImportLine | 35 / 36 (34) | 68 | concept_owner |
| budget allocation for capsule items is dropping sections | 8000->16000 | buildCapsuleSection | 68 / 72 (67) | 127 | concept_owner |
| budget allocation for capsule items is dropping sections | 8000->16000 | compactLegacyContextSection | 70 / 72 (67) | 127 | concept_owner |
| budget allocation for capsule items is dropping sections | 8000->16000 | reduceDiagnosticsToAgentFacing | 71 / 72 (67) | 127 | concept_owner |
| how is the impact graph bounded when a symbol has many callers | 2000->4000 | comparePotentialCallers | 26 / 30 (25) | 38 | concept_owner |
| how is the impact graph bounded when a symbol has many callers | 4000->8000 | compactImpactProductResponse | 35 / 38 (34) | 72 | concept_owner |
| how is the impact graph bounded when a symbol has many callers | 8000->16000 | persistResolvableInterFileEdges | 72 / 72 (67) | 134 | concept_owner |
| where does logic flow decide a path is unreachable | 8000->16000 | compactProductContextDiagnostics | 70 / 74 (67) | 130 | concept_owner |
| what determines whether the repository index is considered fresh | 4000->8000 | baseDiagnostics | 38 / 40 (34) | 73 | concept_owner |
| what determines whether the repository index is considered fresh | 8000->16000 | nominateRepositories | 68 / 73 (67) | 130 | concept_owner |
| how does hybrid scoring combine lexical and graph signals | 4000->8000 | compareGraphSearchResults | 35 / 40 (34) | 73 | concept_owner |
| how does hybrid scoring combine lexical and graph signals | 8000->16000 | filteredSignalDiagnostics | 68 / 73 (67) | 130 | concept_owner |
| how does the python parser resolve module imports | 2000->4000 | parseSource | 28 / 31 (25) | 39 | concept_owner |
| how does the python parser resolve module imports | 2000->4000 | extractImportEdges | 29 / 31 (25) | 39 | concept_owner |
| what writes the index manifest after a run | 2000->4000 | persistCapsuleManifestFromItems | 6 / 29 (25) | 38 | concept_owner |
| what writes the index manifest after a run | 2000->4000 | computeCapsuleManifestId | 17 / 29 (25) | 38 | concept_owner |
| what writes the index manifest after a run | 4000->8000 | formatIndexRunSummary | 8 / 38 (34) | 71 | concept_owner |
| what writes the index manifest after a run | 8000->16000 | formatContextCapsulePipelineOutput | 70 / 71 (67) | 130 | concept_owner |
| how are worktrees excluded from the parent repository index | 2000->4000 | isExcludedWorktreeDirectory | 2 / 28 (25) | 38 | concept_owner |
| how are worktrees excluded from the parent repository index | 4000->8000 | dedupeDimensions | 37 / 38 (34) | 69 | concept_owner |
| how are worktrees excluded from the parent repository index | 4000->8000 | normalizeRequiredCapabilities | 38 / 38 (34) | 69 | concept_owner |
| where does the product context decide which files are pivots | 2000->4000 | impactGraphOutputFilePathGroups | 26 / 34 (25) | 42 | concept_owner |
| where does the product context decide which files are pivots | 2000->4000 | excerptFilePathBearers | 28 / 34 (25) | 42 | concept_owner |
| where does the product context decide which files are pivots | 2000->4000 | noRunRecord | 29 / 34 (25) | 42 | concept_owner |
| where does the product context decide which files are pivots | 2000->4000 | outstandingCount | 30 / 34 (25) | 42 | concept_owner |
| where does the product context decide which files are pivots | 4000->8000 | compactLegacyContextSection | 35 / 42 (34) | 73 | concept_owner |
| where does the product context decide which files are pivots | 4000->8000 | collectNeighborCandidates | 36 / 42 (34) | 73 | concept_owner |
| where does the product context decide which files are pivots | 4000->8000 | classifyEdge | 37 / 42 (34) | 73 | concept_owner |
| how does the response envelope shed content under budget pressure | 8000->16000 | projectRunPipelineOrientation | 68 / 69 (67) | 130 | concept_owner |
| how does the response envelope shed content under budget pressure | 8000->16000 | parseRenderedBodies | 69 / 69 (67) | 130 | concept_owner |
| what deduplicates supporting files in the capsule | 8000->16000 | buildRescueEntry | 70 / 72 (67) | 130 | concept_owner |
| what deduplicates supporting files in the capsule | 8000->16000 | isCredibleRescueFile | 71 / 72 (67) | 130 | concept_owner |
| where are call sites persisted for an edge | 4000->8000 | collectObservedEdgeTypes | 26 / 37 (34) | 71 | concept_owner |
| where are call sites persisted for an edge | 8000->16000 | buildBoundedImpactDecline | 70 / 71 (67) | 130 | concept_owner |
| how does search rank candidate symbols for a task | 2000->4000 | conceptOwnerCandidates | 27 / 30 (25) | 37 | concept_owner |
| how does search rank candidate symbols for a task | 2000->4000 | createFlowGraphAccess | 29 / 30 (25) | 37 | concept_owner |
| how does search rank candidate symbols for a task | 4000->8000 | bodyLiteralCandidates | 36 / 37 (34) | 68 | concept_owner |
| how does search rank candidate symbols for a task | 8000->16000 | toLogicFlowPath | 35 / 68 (67) | 131 | concept_owner |
| what happens when the index schema version is incompatible | 8000->16000 | productContextItemIdIndex | 68 / 68 (67) | 127 | concept_owner |

## 10. Lane and order

Support-order relation (capsule packed support, lower vs higher): neither 73; subsequence 6; prefix 1. Movers by rule: SUPPORT_WINDOW_PARTITION:coedit_displacement:window_changed 84; PIVOT_CAP_ROLE_PROMOTION 63; SUPPORT_WINDOW_PARTITION:coedit_displacement:window_content_changed 24; REPRESENTATION_ROUTING:ceiling 21; SUPPORT_LANE_PLACEMENT:coedit_rescued_medium 12; SUPPORT_LANE_PLACEMENT:graph_neighbour_append 4; SUPPORT_LANE_PLACEMENT:coedit_injected_high 2; SUPPORT_LANE_PLACEMENT:coedit_injected_medium 2; SUPPORT_LANE_PLACEMENT:coedit_rescued_high 2; SUPPORT_ORDER_OTHER:base_support_tier_1 2; REPRESENTATION_ROUTING:form_not_code_bearing 1; REPRESENTATION_ROUTING:no_rendered_body 1; SUPPORT_ORDER_OTHER:budget_demoted_pivot 1.

Dense grid (17 budgets, 16 adjacent pairs x 20 tasks), by transition class:

| class | transitions | prefix | subsequence | neither | focus swaps | first-divergence mechanisms |
| --- | --- | --- | --- | --- | --- | --- |
| same_tier_same_pool | 139 | 49 | 71 | 19 | 0 | SUBSEQUENCE_NEW_ITEMS_INTERLEAVED 70; NONE 49; EVIDENCE_BUDGET_DROP 18; CAPSULE_PACKING 1; REPRESENTATION_ROUTING 1 |
| tier_boundary | 40 | 1 | 3 | 36 | 5 | PIVOT_CAP_LEAD_RESELECTION 3; PIVOT_CAP_ROLE_PROMOTION 30; SUPPORT_WINDOW_PARTITION 1; CAPSULE_PACKING 2; EVIDENCE_BUDGET_DROP 1; SUBSEQUENCE_NEW_ITEMS_INTERLEAVED 2; NONE 1 |
| same_tier_pool_grew | 141 | 0 | 65 | 76 | 0 | RETRIEVAL_POOL_MEMBERSHIP 31; SUBSEQUENCE_NEW_ITEMS_INTERLEAVED 56; SUPPORT_WINDOW_PARTITION 29; SUPPORT_LANE_NOT_REPRODUCED 11; REPRESENTATION_ROUTING 9; EVIDENCE_BUDGET_DROP 3; SUPPORT_LANE_PLACEMENT 1; SUPPORT_ORDER_OTHER 1 |

## 11. Evidence budget

Lost by ladder: EVIDENCE_BUDGET_DROP:impact_evidence(inferred) 4; EVIDENCE_BUDGET_DROP:graph_neighbour_anchoring 11; EVIDENCE_BUDGET_DROP:budget_demoted_pivot 1; EVIDENCE_BUDGET_DROP:coedit_injected_high 1. Delivery status by budget: 750={"compacted":20}; 1000={"compacted":20}; 1250={"compacted":20}; 1499={"compacted":20}; 1500={"compacted":20}; 2000={"compacted":20}; 2500={"compacted":20}; 3000={"compacted":20}; 4000={"compacted":20}; 5000={"compacted":20}; 6000={"compacted":20}; 8000={"compacted":20}; 10000={"complete":2,"compacted":18}; 11999={"complete":3,"compacted":17}; 12000={"compacted":20}; 16000={"compacted":17,"complete":3}; 20000={"complete":15,"compacted":5}.

The ladder protects 'answer-bearing' items and drops the rest from the tail. The test is a substring match, and the role gate's NEGATIVE blocker '(not a pivot: no direct evidence (graph/domain reach only))' contains 'direct evidence', so every weak graph/domain-reach support entry is protected. A larger capsule budget packs more of that tail; the ladder then evicts stronger, unprotected support the smaller budget delivered (e.g. S5 allocateBudget dropped at 1250 while S24-S27 'no direct evidence' entries are kept). The same false positive is the M207 F15 ladder-collapse hazard.

## 12. Projector and envelope

Projector ceiling rejections over every snapshot: 0. the evidence packet (focus + related without per-item tokens fields) never exceeds 4 x max_tokens characters; every whole-output overshoot is the M203 per-item `tokens` accounting riding above the ceiling by design (orientationAccounting.accountingOverhead) — not an A13 metric and not repaired here.

| budget | tier | allowance | median utilisation % | responses over max_tokens (whole) | responses whose evidence exceeds 4 x max_tokens chars | median accounting overhead (tokens) |
| --- | --- | --- | --- | --- | --- | --- |
| 750 | micro | 25 | 87.27 | 2 | 0 | 16 |
| 1000 | micro | 25 | 85.05 | 4 | 0 | 25 |
| 1250 | micro | 25 | 89.12 | 2 | 0 | 32 |
| 1499 | micro | 25 | 93.56 | 4 | 0 | 39 |
| 1500 | standard | 25 | 89.47 | 6 | 0 | 38 |
| 2000 | standard | 25 | 94.78 | 5 | 0 | 53.5 |
| 2500 | standard | 25 | 98.96 | 8 | 0 | 65 |
| 3000 | standard | 25 | 100.72 | 12 | 0 | 81 |
| 4000 | standard | 34 | 102.05 | 16 | 0 | 110 |
| 5000 | standard | 42 | 102.31 | 15 | 0 | 140.5 |
| 6000 | standard | 50 | 102.5 | 12 | 0 | 168 |
| 8000 | standard | 67 | 102.5 | 13 | 0 | 223.5 |
| 10000 | standard | 84 | 100.58 | 10 | 0 | 274.5 |
| 11999 | standard | 100 | 97.07 | 9 | 0 | 324 |
| 12000 | full | 100 | 96.98 | 9 | 0 | 324 |
| 16000 | full | 134 | 94.72 | 7 | 0 | 408 |
| 20000 | full | 167 | 75.77 | 0 | 0 | 408 |

## 13. Counterfactuals

|  | size / swaps | relations (frozen) | first divergence by stage | lost | moved | regressions | A11 medians | dense relations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 product allowance | 3 / 5 | {"neither":65,"subsequence":15} | S1_ranked_pool 27; S4b_support_order 17; S2_role_assignment 14; none 10; S7_evidence_budget 5; S4a_pivot_order 3; S9_projector 3; S5_packing 1 | 74 | 219 | 24 | {"1000":85.05,"2000":94.78,"4000":102.05,"8000":102.5,"16000":94.72} | {"subsequence":139,"neither":131,"prefix":50} |
| C2 pool pinned to 25 (pre-M207 universe) | 3 / 5 | {"neither":36,"subsequence":30,"prefix":14} | none 40; S2_role_assignment 26; S4b_support_order 5; S7_evidence_budget 4; S4a_pivot_order 3; S5_packing 1; S9_projector 1 | 19 | 111 | 1 | {"1000":85.05,"2000":94.78,"4000":101.73,"8000":55.45,"16000":27.88} | {"prefix":168,"subsequence":97,"neither":55} |
| C2 pool pinned to 134 (the 16000 universe) | 4 / 5 | {"neither":46,"subsequence":27,"prefix":7} | none 29; S2_role_assignment 24; S7_evidence_budget 10; S4b_support_order 8; S4a_pivot_order 4; S9_projector 3; S5_packing 2 | 63 | 122 | 11 | {"1000":85.8,"2000":96.65,"4000":102.88,"8000":103.17,"16000":94.72} | {"subsequence":140,"neither":96,"prefix":84} |

C5 projector-only (the higher budget's authoritative debug result projected at both ceilings): measured 0 of 80 frozen pairs (unmeasured: {"debug_delivery_differs_from_default":80}); relations {}; same focus 0; representation regressions 0. With a fixed supply the projector takes a longer prefix and never reorders; the regressions are the admission-first routing.

Reading: pinning the pool to 25 removes the concept-owner losses and leaves the tier-boundary mechanisms (cap/order, window) and the ladder; pinning it to 134 at every budget keeps every frozen swap and exposes the ladder's protection of the weak tail most (the strong support the smaller budget delivered is evicted). Candidate-universe growth is therefore one of several first-loss stages, not the only one.

## 14. Root causes (code-level)

| stage | mechanism | transitions | lost items | code |
| --- | --- | --- | --- | --- |
| S1_ranked_pool | RETRIEVAL_POOL_MEMBERSHIP:concept_owner | 27 | 40 | hybridRetrieval.ts:451 conceptOwnerCandidates(db, input, derivedIntent, ranked.slice(0, maxResults), raw) |
| S2_role_assignment / S4a_pivot_order | PIVOT_CAP_ROLE_PROMOTION + PIVOT_CAP_LEAD_RESELECTION | 17 | 3 | assignCandidateRoles(candidates, { maxPivots }) / debugRoles.capPivots cap the pivot SET in final-score order (buildCapsuleV2.ts:755,773); pivotCandidates.sort (anchor tiers) and pivot-ranking v2 then ORDER the capped set (buildCapsuleV2.ts:975-1050) |
| S4b_support_order | SUPPORT_WINDOW_PARTITION / SUPPORT_LANE_PLACEMENT / SUPPORT_LANE_NOT_REPRODUCED | 17 | 13 | buildCapsuleV2.ts:1173 supportWindow = allocation.supportWindow; coeditExpansion.ts:804 winners = baseOrder.slice(0, maxSupport) |
| S7_evidence_budget | EVIDENCE_BUDGET_DROP | 5 | 17 | budgetDelivery.ts mutableItem(): answerBearing = roles.includes('required') \|\| directEvidence.includes('symbol-name match') \|\| ... \|\| directEvidence.includes('direct evidence') \|\| directEvidence.includes('exact') |
| S9_projector | REPRESENTATION_ROUTING:ceiling | 3 | 0 | orientationProjection.ts:533-597 admission (relationship-only prefix) then routing (upstream form per entry, in order) |
| S5_packing | CAPSULE_PACKING:packing_over_budget | 1 | 1 | buildCapsuleV2.ts:1464 renderSupport(..., input.maxTokens - usedTokens) -> 'over budget: no room for this support item' -> continue |

- **S1_ranked_pool** — The concept-owner rescue (M142-C) skips files 'the pool already represents', judged against the top-maxResults slice. M207 made maxResults the budget's allowance, so a wider allowance lets a lower-ranked lexical sibling in the same file represent it and the rescued owner is no longer admitted: a rank-2 candidate at 2000 (allowance 25) is absent from the 38-candidate pool at 4000 (allowance 34).
- **S2_role_assignment / S4a_pivot_order** — Two authorities disagree: the cap admits pivots by hybrid final score and the order (anchor tiers / v2) decides the lead among the admitted. Widening the cap (micro 1 -> standard 2 -> full 5) admits a candidate the order ranks above the previous lead, so the focus changes at both tier boundaries (all 5 frozen swaps, all 3 size drops); cap-demoted support entries also become pivots and move to the front (14 transitions).
- **S4b_support_order** — orderSupportWithCoedit partitions baseSupportOrder at the tier's support window (1 / 4 / 10) into protected winners, displacing co-edits, displaceable winners, spare co-edits and the rest. The window changes with the tier, so the same candidates are re-partitioned at every tier boundary; a new candidate entering the window re-partitions it within a tier. Co-edit anchors and graph-neighbour seeds are read from the window, so lane-injected entries are not reproduced at the next budget.
- **S7_evidence_budget** — The ladder protects 'answer-bearing' items and drops the rest from the tail. The test is a substring match, and the role gate's NEGATIVE blocker '(not a pivot: no direct evidence (graph/domain reach only))' contains 'direct evidence', so every weak graph/domain-reach support entry is protected. A larger capsule budget packs more of that tail; the ladder then evicts stronger, unprotected support the smaller budget delivered (e.g. S5 allocateBudget dropped at 1250 while S24-S27 'no direct evidence' entries are kept). The same false positive is the M207 F15 ladder-collapse hazard.
- **S9_projector** — M205 admits WHICH entries first and decides WHAT they carry second; a wider supply at the larger budget is admitted relationship-only up to the ceiling, and the later entry that carried code at the smaller budget no longer fits its richer form. Classified per regression as avoidable admission-first crowding or a necessary ceiling.
- **S5_packing** — Greedy first-fit packing: an entry the smaller budget packed can be skipped at the larger budget when newly affordable earlier entries consume the room it had.

## 15. Causal verdict

`A13_CAUSAL_ATTRIBUTION_COMPLETE`

Every one of the 80 frozen transitions and 320 dense transitions that is not a prefix names a first-divergence stage and mechanism; every lost lower-budget item has a stage-level fate; every focus swap is classified; the direct capsule build agrees with the packet's focus on every snapshot and every ledger `S#` id names the capsule entry at that ordinal.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_NEW_REPRESENTATION_CLASS_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED

