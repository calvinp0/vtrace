# M210 final report — impact caller-enumeration capacity and frozen A15

## 1. Executive verdict

```
M210 — PASS
A15_CALLER_CAPACITY_ATTRIBUTION_COMPLETE
A15_EXISTING_CAPACITY_INSUFFICIENT
A15_BROADER_CAPACITY_INSUFFICIENT
A15_PARITY_NOT_CLOSED
A15 BELOW -> BELOW
14 / 15 -> 14 / 15
product source changed: none
live-agent runs: 0        live model spend: $0
```

M210 asked which of three causes leaves the frozen A15 caller out of the default
`get_impact_graph` response: poor relation allocation inside the existing
capacity, genuinely insufficient caller-enumeration capacity, or a further
unidentified primitive. The answer is the second, and it is now proven rather
than estimated — with the additional finding that no capacity the tool accepts
is sufficient either. Allocation is exonerated by measurement, not by argument:
**every slot ahead of a scored caller is another caller of the same symbol**, so
there is nothing weaker to displace and no ordering can help.

Because §28's repair A is impossible, repair B insufficient and repair C's
primitive unreachable, **M210 changes no product behaviour.**

## 2. Starting state

| | |
| --- | --- |
| branch | `main` |
| HEAD at start | `5c1c2108a465d5b6202f6d750ef56e20123bf58b` |
| ahead / behind `origin/main` | 218 / 0, not pushed |
| `git diff --check` | clean |
| tracked dirt inherited | `stage5_outcome_ledger.json`, `stage5_outcome_ledger.md` (untouched) |
| M209 chain | `0b091b9c` → `75c8f94d` audit → `328f9457` functional → `9eae0cf5` evidence → `5c1c2108` ledger |

All predecessor SHAs were read from Git, not from the prompt's abbreviations.

## 3. Frozen A15 authority

Recovered mechanically from the committed sources (`m197aScoring.ts`,
`m197aFixtures.ts`, `run_stage5_m197a_engine.ts`, `run_stage5_m197a_report.ts`)
and quoted verbatim in `stage5_m210_causal_report.md` §1. Nothing about the
population, the first-50 rule, the edge ordering, the `referenceName` predicate,
the 90 % / 100 % thresholds, the C-LARGE identity or the default tool invocation
was changed.

## 4. Pre-change reproduction

C-SMALL 83.33 % / C-MED 24 % / C-LARGE **8 %** impact rendering; flow 100 % on
all three; eligible 36 / 50 / 50. The `a15` block is **byte-identical** to
M209's committed `stage5_m209_engine.json`, including all five misrendered
examples. Full matrix: **A1 MATCHES, A2 EXCEEDS, A3 MATCHES, A4 EXCEEDS, A5
MATCHES, A6 EXCEEDS, A7 EXCEEDS, A8 EXCEEDS, A9 MATCHES, A10 MATCHES, A11
EXCEEDS, A12 MATCHES, A13 EXCEEDS, A14 MATCHES, A15 BELOW — 14 / 15.**

A2/A3 needed `run_stage5_m197a_indexing.ts` rerun: the report reads
`stage5_m197a_indexing.json`, which still holds M197A's own contended-machine
measurement, and reading it stale gives A2 BELOW / A3 BELOW and a spurious
12 / 15. Freshly measured on this machine it reproduces M209 exactly. This is a
protocol trap for successors and is recorded as a standing finding.

## 5. Relation-enumeration architecture

Recovered from code and tabulated in `stage5_m210_causal_report.md` §3, stage by
stage from `listEdgesForSymbol` to serialization, with every bound's real value.
The load-bearing facts: the direct candidate query is **unbounded**; ordering is
incoming → strength → kind → path → symbol → id, and `calls` is alphabetically
first of all fourteen relation kinds; `max_edges` (64) bounds enumeration;
`max_tokens` (1 200) bounds a budget **shared** by `edges`, `nodes`, `view`,
`directRelations` and `paths`; `nodes` and `view` have no rung on the degradation
ladder at all.

## 6. Frozen 50-query relation composition

Complete relation universe: median 12.5 relations per C-LARGE query, maximum 999.
Core default slice: median 12.5, capped at 64. Delivered: **1 relation in 44 of
50 cases, 2 in the other 6.**

## 7. Miss attribution — `A15_CALLER_CAPACITY_ATTRIBUTION_COMPLETE`

| class | C-SMALL | C-MED | C-LARGE |
| --- | --- | --- | --- |
| SCORED | 30 | 12 | 4 |
| CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE | 6 | 38 | 38 |
| CALLER_OUTSIDE_GLOBAL_SLICE | 0 | 0 | 8 |
| CALLER_ORDERED_BELOW_WEAKER_RELATIONS | 0 | 0 | **0** |
| CALLER_INSIDE_SLICE_RENDERING_FAILURE | 0 | 0 | **0** |
| CALLER_DEDUPED_INCORRECTLY / CALLER_TRUTH_UNAVAILABLE / CALLER_STALE / OTHER | 0 | 0 | 0 |

Rendering failure is zero, as M209's repair requires. Affordability splits into
29 `relation_trimmed` and 9 `evidence_shed` on C-LARGE.

**Occupancy ahead of the scored caller:** 831 slots on C-LARGE, of which 192
exact callers and 639 resolved callers — and **zero** referrers, importers,
subtypes, structural or outgoing relations, zero duplicates, and zero relations
lacking evidence (831 / 831 carry a persisted site and a renderable line). F1
proves this is a property of the product's comparator, not of ARC.

## 8. Caller ordinal distribution

C-LARGE, sorted: `0×10, 1×8, 2, 3×5, 4×3, 5, 6, 7, 9×2, 10×2, 11, 13, 21, 26,
27, 37, 45, 46, 219, 477, 530, 556, 598, 762, 788, 816`.

**Reaching 90 % (45 / 50) requires delivering 531 direct relations, each with its
own rendered source line. Reaching 100 % requires 817.**

## 9. Existing-capacity counterfactual

Eight arms at the shipped bounds, each a pure permutation or pre-shed handed to
the product's own unmodified envelope; the identity arm reproduces the real MCP
response 136 / 136.

| arm | C-SMALL | C-MED | C-LARGE |
| --- | --- | --- | --- |
| CONTROL / P1 lane authority / P2 grounded-first / P3 lane-then-grounded / P4 lane round-robin / E1 no-compat-edges / E2 / E3 | 83.33 % | 24 % | **8 %** |

All eight identical, on all three corpora. Packing the default budget by hand at
the product's own measured sizes: A_STATUS_QUO 2 %, B_COHERENT_PROJECTIONS 36 %,
**C_EVIDENCE_ONLY 46 %** on C-LARGE. Only the last is load-bearing, and only as a
bound: it charges **zero** for four of the five model-visible fields, so no
allocation policy can beat it. The first two are not calibrated predictions of
the shipped ladder and are not offered as such — A_STATUS_QUO reads 94.44 %
against a shipped 83.33 % on C-SMALL and 2 % against a shipped 8 % on C-LARGE.

## 10. Existing-capacity sufficiency verdict

```
A15_EXISTING_CAPACITY_INSUFFICIENT
```

Two independent proofs: only 42 of 50 callers lie inside the 64-relation slice
(**84 % ceiling**, below the bar before any budget is measured), and the
restatement-free packing ceiling is **46 %**.

## 11. Capacity sweep — one authority at a time

**Enumeration capacity alone** (`max_edges` 64 → 2000, `max_tokens` at default):
**8 % at every width on C-LARGE**, 24 % at every width on C-MED, 83.33 % at every
width on C-SMALL; median relations delivered stays 1; C-LARGE p90 latency rises
222 ms → 4 425 ms. Widening enumeration recovers zero items and buys only cost.

**Representation budget alone** (`max_tokens` 1200 → 20000, `max_edges` at
default): C-LARGE 8 → 14 → 18 → 20 → 30 → 42 → **74 %**; C-MED 24 → 90 %;
C-SMALL 83.33 → 100 %. At the hard maximum the C-LARGE response is 66 346
characters — 8.8× the default — and still short of 90 %.

## 12. Broader-capacity verdict

```
A15_BROADER_CAPACITY_INSUFFICIENT
```

`A15_CALLER_SUPPLY_INSUFFICIENT` is **not** the finding and must not be reported:
C-LARGE holds 12 421 `calls` edges, **12 421 of them with a persisted call site**
(100 %) and 19 330 sites; the scored caller's relation exists in the truthful
universe for 50 of 50 items. Nothing is missing from the index.

## 13. Root cause

**A15_DELIVERY_ARITHMETICALLY_UNREACHABLE.** Frozen A15 scores whether the
default response contains one *arbitrary* caller chosen by edge id. On C-LARGE
that requires enumerating 531 callers with a rendered line inside 1 200
model-visible tokens (4 800 characters). A delivered relation costs a median of
1 014 characters today; even a hypothetical minimal truthful record (caller
identity + span + the line the predicate must read) cannot fall below ~150. So:

| representation | 531 records | vs default budget (4 800 ch) | vs hard ceiling (80 000 ch) |
| --- | --- | --- | --- |
| as delivered today | 538 000 ch | 112× over | 6.7× over |
| hypothetical minimum | 79 650 ch | **16.6× over** | at the ceiling, alone |

## 14. Repair

None. §28's hierarchy terminates: repair A (fixed capacity, better role
allocation) is impossible because there is no weaker relation to displace;
repair B (a general capacity policy) is insufficient at 74 % at the hard maximum;
repair C's primitive is neither narrowly repairable nor sufficient. No product
file was modified.

## 15. Caller coverage before / after

Unchanged by construction: C-SMALL 83.33 %, C-MED 24 %, C-LARGE 8 %.

## 16. Other relation retention

Not traded away — nothing was traded. The measured composition stands as the
baseline: on C-LARGE the delivered relation is an exact or resolved caller in
every scored case, and the arms show that promoting callers over other families
is a no-op because no other family is ever ahead of one.

## 17. Exact / potential integrity

Preserved and separately measured. Target lanes: C-LARGE 21 exact callers and 21
resolved callers among the 42 with a core relation; C-MED 37 exact and 13
resolved; C-SMALL 36 exact. F4 shows an unresolved receiver arriving as a
`potentialCaller` with `confidence: "unresolved"`, kept out of `directRelations`,
never promoted to an exact caller.

## 18. M209 rendering preservation

Untouched: no renderer was replaced, no fallback added. The frozen engine reports
`strengthenedCallSiteRenderings: 0` and `inventedStructuralClaims: 0` on all three
corpora; excerpt anchoring is 100 % of conclusive cases.

## 19. SourceText truth

F12: the delivered line is the file's own line at the persisted span, with zero
truth faults — and a forged line that **satisfies the frozen rule** is still
rejected by the M209 truth guard. F13: a file edited after indexing yields a
withheld excerpt, never a stale one.

## 20. Budget / response-size behaviour

The two authorities are separate in the code and were measured separately (§11).
The response's own accounting is exact: `serializedCharacters` equals the
measured length, and a +40 corruption is detectable (F17). F14: a 400-caller
fanout stays inside its envelope at `max_tokens` 1, 50, 200, 400, 1 200, 4 000 and
20 000.

## 21. Falsification F1–F20

**20 / 20 pass — `M210_FALSIFICATION_SUITE_PASSED`.** Fixtures are real
repositories indexed by the production `indexProject`.

| id | question | result |
| --- | --- | --- |
| F1 | can a weaker relation ever precede an exact caller? | no — 6 weaker relations present, exact caller still at ordinal 0 |
| F2 | is a caller slot fabricated when none exists? | no — 0 relations, `exactCallerCount` 0 |
| F3 | many exact callers → deterministic bounded prefix? | yes at fanout 0…512 |
| F4 | can an unresolved receiver become an exact caller? | no — 1 potential caller, `unresolved`, kept separate |
| F5 | is non-call impact evidence still carried? | yes — 5 importers, 1 referrer beside the callers |
| F6 | same-file / cross-file truthful? | yes — 1 same-file, 8 cross-file |
| F7 | one pair reached by several routes arrives once? | yes — 9 relations, 9 distinct ids and pairs |
| F8 | two calls from one caller stay two sites? | yes — `callSiteCount` 2, spans 4-4 and 5-5 |
| F9 | can any allocation policy recover the caller in the bound? | **no** — all 8 arms 8 %, evidence-only ceiling 46 % < 90 |
| F10 | genuine exhaustion stays bounded and self-reports? | yes — `bounded_truncated`, 88…1 432 omitted |
| F11 | is the capacity/budget decomposition single-authority? | yes — edge sweep flat, token sweep monotone |
| F12 | is the line the file's own, and is a forgery caught? | yes to both |
| F13 | is an edited file rendered as current? | no — excerpt withheld |
| F14 | does a 400-caller fanout leave the envelope? | no, at any budget |
| F15 | is the impact envelope on the run_pipeline path? | **no** — only `mcp/tools.ts` and the CLI import it |
| F16 | did the focus contract move? | no — 0 size violations, 0 swaps over 20 tasks |
| F17 | does size accounting equal measured size? | yes — 7 653 = 7 653, +40 detectable |
| F18 | did M210 change product behaviour? | no — 0 `src/` files modified |
| F19 | did a frozen-A15 constant enter the product? | no — `src/impact` diff empty |
| F20 | one policy across arbitrary fanout? | yes — 0…512 callers, ≤ 8 000 ch, 11.8 → 57.8 ms |

## 22. A11 preservation

**EXCEEDS**, unchanged: C-MED whole-response utilisation 82.7 / 94 / 102.06 /
102.58 / 96.19 % at budgets 1000 / 2000 / 4000 / 8000 / 16000.

Mechanically proven isolation (F15): `compactImpactProductResponse` is imported
only by `src/mcp/tools.ts` and `src/cli/commands/impactGraphCommand.ts`.
`runPipelineOrchestrator.ts` and `productContext/assembleProductContext.ts`
import the **core** `getImpactGraph` and never the envelope, so any
envelope-scoped change cannot reach A11/A13. With zero source change the point is
moot, but it is the boundary a successor milestone needs.

## 23. A13 preservation

**EXCEEDS**, unchanged: 0 focus-size drops and 0 focus swaps over 20 tasks. No
shared budget or allocation layer was touched. Observationally, prefix /
subsequence / neither behaviour and the M208 representation regressions are
carried forward unchanged (§32).

## 24. A5 / runtime / resources

Frozen A5 p90 **57.22 / 242.08 / 361.92 ms** — **MATCHES** (M209: 67.93 / 251.83 /
366.48). Standalone A5 harness on this machine at load 2.5: **65.4 / 225.22 /
375.32 ms**, classified `VTRACE_MATCHES_VEXP_CLAIM`
(`stage5_m201_a5_m210_post.json`); M209's was 61.58 / 223.93 / 361.95 at load
1.32. A6 (impact) p90 9.71 / 47.61 / **172.65 ms** — EXCEEDS. A7 p90 8.3 / 9.57 /
18.19 ms — EXCEEDS.

Standalone `get_impact_graph` by fanout (synthetic, 3 repeats): 0 callers 11.8 ms,
1 → 13.1, 8 → 12.4, 32 → 21.8, 63 → 39.1, 64 → 36.4, 128 → 39.5, 256 → 45.9,
512 → 57.8 ms, with the response holding at ~7 700 characters throughout — no
N+1, no unbounded materialisation. Real-corpus default p90: C-SMALL ~10 ms, C-MED
~27 ms, C-LARGE ~220 ms. The one cost signal found is that `max_edges: 2000`
raises C-LARGE p90 to 4 425 ms while delivering the same single relation.

## 25. A12 / A14

**A12 MATCHES**: C-MED default response carries exactly 3 representation classes
(`FOCUS:focused_source`, `RELATED_WITH_CODE`, `RELATIONSHIP_ONLY`). No
representation class was added. **A14 MATCHES**: 5 072 of 5 072 delivered items
carry token accounting, no accounting block in the default response. The M205
representation sweep was not rerun: with `src/` byte-identical there is no
mechanism by which either could move, and the frozen rerun measures both directly.

## 26. Retrieval guard

Both fixtures re-run on this tree into a scratch output directory:
`stage5_retrieval_eval_expanded` 20/20, top-1 **85.0 %**, top-3 100 %, pivot
100 %; `stage5_retrieval_eval_cross_repo_30` 30/30, top-1 **66.7 %** (0.6667),
top-3 73.3 %, pivot 70 %, missing 6.7 %. **Both CSVs are byte-identical to the
committed baselines.** The M208 floor is held exactly. No baseline was
regenerated, and none needed to be: `git diff HEAD -- src` is empty, so retrieval
could not have moved.

## 27. Determinism

All 136 scored responses stable across 3 semantic-projection repeats on every
corpus, pre-existing and unchanged. The falsification fanout family is stable
across 3 repeats at all 11 widths. The §29 projection used is the committed one,
not a hand-rolled variant — an earlier hand-rolled projection reported spurious
non-determinism and was replaced rather than accommodated.

## 28. Same-corpus attribution

No source file changed, so no corpus moved. The frozen authority re-verified
C-SMALL 21 files @ `d658e3457b`, C-MED **506** files @ `5c1c2108a4`, C-LARGE
**276** files @ `826144342e`, and the 699 nested-worktree `.py` exclusion —
`M197A_AUTHORITY_VERIFIED`. There is no policy-versus-corpus movement to separate
because there is no policy movement.

## 29. Frozen A15 result

```
A15  VTRACE_BELOW_VEXP_CLAIM
C-LARGE, 50 eligible call edges: the impact surface renders 8 % as source
expressions, the logic-flow surface 100 %.
```

## 30. Full A1–A15 matrix

```
A1   MATCHES      A6   EXCEEDS      A11  EXCEEDS
A2   EXCEEDS      A7   EXCEEDS      A12  MATCHES
A3   MATCHES      A8   EXCEEDS      A13  EXCEEDS
A4   EXCEEDS      A9   MATCHES      A14  MATCHES
A5   MATCHES      A10  MATCHES      A15  BELOW

MATCH 7  EXCEED 7  BELOW 1     TOTAL 14 / 15
VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET  (threshold 10/15)
```

## 31. Deterministic parity conclusion

```
A15_PARITY_NOT_CLOSED
14 / 15
```

**15 / 15 is not claimed and VTRACE_DETERMINISTIC_VEXP_ENGINE_PARITY_COMPLETE is
not asserted.** The deterministic parity programme ends at 14 / 15 with A15's
residual proven unreachable rather than merely unrepaired.

## 32. Residual observations

- **Two named allocation repairs, measured but not made.** Coherent projections
  would take C-MED 24 → 74 % and C-LARGE 8 → 36 % inside the identical bound;
  graduated evidence shedding would recover 9 C-LARGE / 20 C-MED / 6 C-SMALL
  `evidence_shed` misses. Both are bounded above by the 46 % evidence-only
  ceiling, so neither closes A15, and both change delivered structure at every
  budget — a budget/representation milestone with its own A11/A13/A12 obligations.
- **`nodes` and `view` have no rung on the impact degradation ladder.** The graph
  restatement is 173 % (C-MED) and 768 % (C-LARGE) of the model-visible budget at
  `max_edges: 64` before shedding, while the evidence projection is trimmed to
  one relation.
- **`stage5_m197a_indexing.json` is a shared slot holding M197A's own contended
  measurement.** Any successor running `run_stage5_m197a_report.ts` without
  rerunning indexing will see a spurious A2/A3 BELOW and 12 / 15.
- **The envelope's canonical selection re-applies `max_edges` over edges and
  synthetic relation ids together**, so it can deliver fewer relations than the
  core's own 64-relation slice contains (11 vs 8 absent targets on C-LARGE).
- Carried forward unchanged from M208/M209: the non-prefix behaviour, the known
  representation regressions, `cross_repo_30` top-1 0.6667, M139's edge-gated
  caller-coverage discovery, and the frozen F6 control that fails by construction
  once A14 passes (it asserts `a14PerItem === 0` while A14 delivers 5 072 / 5 072,
  so the frozen report exits non-zero while certifying
  `VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET`). Not M210's to change.

## 33. What 14 / 15 — or 15 / 15 — does not prove

- It does **not** prove coding-agent utility.
- It does **not** prove VTRACE beats VEXP.
- It does **not** erase the prior neutral paired-agent evidence (M164 0 unique
  wins, M185 no success witness, M190 I5 falsified out of sample).
- `ENGINE QUALITY != CODING-AGENT UTILITY` and
  `CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern.

## 34. Verification

```
bun run typecheck              PASS
bun run typecheck:benchmarks   PASS
bun run lint                   PASS (both typechecks)
bun test                       6236 pass, 49 skip, 0 fail
                               (7328 expect() calls, 6285 tests, 383 files, 243.55 s)
git diff --check               clean
live-agent runs: 0
live model spend: $0
Docker evaluates: 0
```

**Evidence.** `stage5_m210_final_report.md`, `stage5_m210_causal_report.md`,
`stage5_m210_audit_pre.json` + `stage5_m210_items_pre.jsonl`,
`stage5_m210_allocation_pre.json` + `stage5_m210_allocation_items_pre.jsonl`,
`stage5_m210_falsification.json`, `stage5_m210_engine_pre.json`,
`stage5_m210_indexing_pre.json`, `stage5_m210_authority.json`,
`stage5_m210_claim_ledger.json`, `stage5_m201_a5_m210_post.json`. The shared
M197A measurement slots (`stage5_m197a_{engine,indexing,authority,claim_ledger}.json`)
were snapshotted per milestone and then restored to HEAD, as every milestone
since M197A has done.

## 35. Repository state

`main`, committed locally, not pushed. Pre-existing tracked dirt
(`stage5_outcome_ledger.{json,md}`) and all untracked results dirt preserved
untouched. `src/` is byte-identical to `5c1c2108`.

## 36. Next-programme recommendation

The deterministic engine-parity programme is finished at 14 / 15 and should not
be reopened for A15: the claim's own arithmetic puts it out of reach.

The separately-authorised next programme remains the causal benchmark —
**Baseline vs Baseline + VTRACE vs Baseline + VEXP under identical live-agent
conditions** — which M210 did not begin and which no engine result licenses.

If impact-response quality is pursued on its own merits rather than for parity,
the licensed milestone is the one named in §32: a budget/representation milestone
that gives `nodes` and `view` a rung, makes the projections coherent with the set
they project, and sheds evidence from the tail rather than the whole list —
justified by the tool's contract and measured against A11/A13/A12, never against
A15's threshold.
