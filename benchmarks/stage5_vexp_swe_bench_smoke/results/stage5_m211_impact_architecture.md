# M211 — impact census, projection and continuation

```
M211 — PASS
M211_IMPACT_ARCHITECTURE_AUDITED
M211_ARCHITECTURE_REDUCTION_PROVEN
IMPACT_CENSUS_DECOUPLED_FROM_EVIDENCE_BUDGET
IMPACT_PROJECTION_BOUNDED_AND_TRUTHFUL
IMPACT_CONTINUATION_DETERMINISTIC
M211_FALSIFICATION_SUITE_PASSED

Frozen deterministic parity remains 14 / 15, A15 BELOW.
```

0 live-agent runs · $0 model spend · 0 Docker runs · 0 VEXP processes.

## 1. Frozen parity boundary

M210's historical result is untouched and is **not** reopened:

```
match-or-exceed 14/15   A15 BELOW
A15_DELIVERY_ARITHMETICALLY_UNREACHABLE under the frozen default-response predicate
```

M211 is post-parity product work. The A15 scorer was not modified, the frozen
population was not re-derived, and no M211 number is a parity claim. A15's
incidental movement is recorded in §11 as an **observation**.

## 2. Starting state

| | |
|---|---|
| branch | `main` |
| starting SHA | `575287d1651a8bea525d4dfcd1c198e26b3ba06d` |
| ahead / behind `origin/main` | 221 / 0 (unchanged; nothing pushed) |
| `git diff --check` | clean |
| pre-existing tracked dirt | `stage5_outcome_ledger.{json,md}` — untouched |
| untracked dirt | preserved; nothing removed outside this session's own scratch |

## 3. What was wrong

Audited from the source and then measured over 16 probes on three real indexed
corpora at the fanout ladder 0, 1, 8, 32, 64, 128, 500, 1000+
(`stage5_m211_impact_architecture_audit.md`, `stage5_m211_audit_pre.json`).

`countConsumers` was called on `directRelations` **after**
`slice(0, maxEdges)`, so the published caller count *was* the rendered length
once the universe exceeded the slice — and was accidentally truthful just below
it, which is worse, because nothing marked the transition.

`arc/species/species.py::ARCSpecies`, default response, before:

| | |
|---|---|
| truthful direct relations | 999 |
| `summary.consumers.exactCallerCount` | **64** |
| delivered relations | 1, **none** carrying a source line |
| `nodes`+`edges`+`view`+`paths` | 3 167 chars (42.8 %) for 5 nodes and 3 edges |
| `directRelations` | 921 chars (12.6 %) |
| core latency | 221 ms |

Across the 16 probes: census false in 4 (all four whose universe exceeded 64),
restatement exceeding evidence in 15, collapse to ≤1 relation in 10, and zero
source-backed relations in 11 that had persisted call sites to render.

## 4. The four repairs

**One census authority.** `impactCensus` is computed over the complete direct
relation universe before any budget touches it, and `summary.consumers` is now
counted over that same universe. `domain: "direct_universe"` is a promise the
record keeps: transitive counts deliberately do **not** live here (§8 below),
and unproven candidates stay in `callerCoverage` where they always were.
`exactCallers` and `resolvedCallers` are never summed behind one label.

**The graph restatement got a rung, above the evidence.** `nodes`/`edges`/`view`
were only ever trimmed last, so the default response reduced its evidence to
make room for a restatement that was still there. It may yield first now
*because* the census states the graph's real size in ~600 characters, so a
dropped edge row costs a duplicate rather than a fact. Each one stays counted in
`responseBudget.omittedEdges`.

**Graduated representation.** The old ladder demoted every relation to
`minimalRelation` at once — M210's cliff — and then popped the tail. It now
solves for a prefix at full form, a middle at minimal form, and a counted tail,
maximising the **count first**, so it is a Pareto improvement: no relation that
used to be delivered is lost, and the head recovers the source line the global
demotion took from every relation. Binary search: 6 re-serializations replace 63
at the default `max_edges`.

**Counting no longer renders.** `classifyRelation` reads the source excerpt only
for `imports` (re-export/alias) and `references`
(`inherits`/`implements`/`decorates`); `calls` and `contains` are provably
excerpt-independent, so their hydration is deferred to the relations actually
delivered. ARCSpecies: 999 excerpts → 64.

## 5. Continuation

A self-validating cursor that **stores nothing**. `expand_vexp_ref` exists and
already declares an `impact_graph` category, but its contract is stored-truth
snapshotting; snapshotting a 999-relation hydrated universe to serve page two is
what §48/§49 forbid, so it was not reused. The stream is instead re-derived,
which is cheap and totally ordered by `compareStaticRelations` (direction →
strength → kind → source path → source symbol → stable id — a total order that
reads no evidence field, so it was adopted rather than invented).

The ref binds the index revision and the ordering version verbatim, and the
resolved symbol plus request shape by digest. 156 characters — an earlier
revision put every claim on the wire verbatim at 573, which cost exactly the
delivered relation it points away from.

Refusals are explicit: `continuation_stale_index`, `continuation_scope_mismatch`,
`continuation_ordering_mismatch`, `continuation_stream_shifted`,
`continuation_tampered`, `continuation_malformed`, all surfaced as
`invalid_continuation` with a machine-readable `reason` and a stated recovery.

## 6. Result

Default response, after (`stage5_m211_audit_post.json`):

| corpus | universe | published callers | rendered | source-backed | restatement | evidence | latency |
|---|---|---|---|---|---|---|---|
| C-LARGE `ARCSpecies` | 999 | 64 → **869** | 1 → 2 | 0 → **1** | 3167 → **1620** | 921 → **1915** | 221 → **77 ms** |
| C-LARGE `Molecule` | 780 | 64 → **531** | 1 → 2 | 0 → **2** | 3207 → **1577** | 812 → **1855** | 148 → **66 ms** |
| C-LARGE `_submit` | 114 | 64 → **108** | 1 → 2 | 0 → 0 | 3206 → **1813** | 904 → **1804** | 90 → **60 ms** |
| C-LARGE `colliding_atoms` | 81 | 64 → **65** | 1 → 2 | 0 → 0 | 2958 → **1834** | 901 → **1727** | 62 → **44 ms** |
| C-MED `openIndexerDatabase` | 127 | 58 | 1 → 2 | 0 → **2** | 3268 → **1410** | 836 → **1903** | 42 → **22 ms** |
| C-MED `indexProject` | 131 | 31 | 1 → 2 | 0 → **2** | 3658 → **1411** | 846 → **1937** | 40 → **22 ms** |

Evidence now exceeds restatement on every high-fanout probe; before, restatement
exceeded evidence on 15 of 16.

## 7. Frozen M211 product metrics

Frozen in `m211ImpactArchitecture.ts` and recorded in `stage5_m211_audit_pre.json`
**before** any functional change.

| id | bar | result |
|---|---|---|
| P1 CENSUS_TRUTH | 0 disagreements against the complete universe | **0 / 16** — MET |
| P2 CENSUS_INDEPENDENT_OF_EVIDENCE_BUDGET | byte-identical across budgets | MET (F1/F16, all corpora) |
| P3 PROJECTION_IS_A_SUBSET | every rendered id in the census, none twice | MET (F8 + unit test) |
| P4 SOURCE_ANCHORED | 0 fabrications under the M209 guard | MET (F6) |
| P5 CLASS_PRESERVED | rendered classes equal the universe's | MET (F3/F4 + unit test) |
| P6 EVIDENCE_YIELD | must not fall anywhere; must rise on universe ≥ 64 | **PARTIAL** — fell on 0/16; rose on 4/6 high-fanout, flat on 2 |
| P7 RESTATEMENT_SHARE | must fall on every probe with ≥ 8 relations | **9 / 9** — MET |
| P8 BOUNDEDNESS | inside the envelope at every fanout; never above 80 000 chars | MET (F5/F14/F15/F17) |
| P9 RECONCILIATION | offset + delivered + remaining == total | MET (unit test + F20) |
| P10 CONTINUATION_COVERAGE | pages are the canonical prefix, no dupes, no gaps | MET (F9–F11, F13, F23) |
| P11 CENSUS_LATENCY_NO_REGRESSION | p90 must not regress | MET — max probe latency 221 → 77 ms |
| P12 COUNTING_DOES_NOT_RENDER | excerpt builds O(delivered), not O(universe) | MET (999 → 64) |

**P6 is reported as PARTIAL, not met.** `_submit` and `colliding_atoms` gained a
second relation but neither could afford a full form for even one, so their
source-backed count stayed at zero. The bar said "must rise on the high-fanout
targets"; 4 of 6 is not all of them, and the metric was frozen before the result
was known, so it is not restated to fit.

## 8. Two defects M211's own falsification suite found

Both were found by the controls, not by inspection, and both are repaired.

**The census was not budget-independent.** F1/F16 failed on every corpus: the
census carried `transitiveDependents`/`transitiveDependencies`, and the traversal
producing them is bounded by `max_edges` — the same knob that bounds the
projection. A record promising `domain: "direct_universe"` was moving with the
render, which is the coupling this milestone exists to remove, reintroduced
inside the very record that claims to be free of it. Transitive figures now stay
in `richSummary`, where M139's `fieldDomains` already labels them `full_graph`
and budget-bounded — one authority per population, per §32.

**The delivered set was not reproducible.** The repaired ladder left the ARC
default response 16 characters under its ceiling, and `timing` carries measured
wall-clock, whose serialized *width* is not a property of the repository. Identical
requests against an identical index returned two relations or one, and the frozen
A6 determinism control went UNSTABLE on `ARCReaction` under load. `measuredElapsed`
now rounds to two decimals, and the ladder prices wall-clock at width-maximal
stand-ins that are restored before the response is measured and gated — an upper
bound, so a shape the ladder admits can never fail the terminal. Frozen
determinism is `stable` on all three corpora.

The suite was blind to the second one at first: it checked ordering, which never
moved, and not the delivered set. F9 now checks both.

## 9. Falsification F1–F24

`M211_FALSIFICATION_SUITE_PASSED` — 37 pass, 4 vacuous, 0 fail, on real
repositories indexed by the production `indexProject`
(`stage5_m211_falsification.json`).

A control that cannot fail is not reported as a pass. The four vacuous ones say
so: **F7** on all three corpora (no delivered relation lacked a persisted call
site, so "counted but given no fabricated line" had no specimen), and **F20** on
C-SMALL (its widest symbol holds four relations and its whole universe fits the
default response — there is no collapse to repair, and scoring that as either a
pass or a failure would misreport the absence of a defect).

F21 and F22 are asserted by §10 and §11 below rather than by the driver.

## 10. Protected claims

Full frozen matrix re-run (`stage5_m197a_claim_ledger.json`), reported as a
regression check:

| claim | verdict | measurement |
|---|---|---|
| A5 | MATCHES | `get_code_context` warm p90 65.58 / 267.61 / 422.65 ms; best observed 41.76 / 201.26 / **370.57** ms |
| A6 | EXCEEDS | `get_impact_graph` depth 3 warm p90 **93.07 ms** on C-LARGE |
| A7 | EXCEEDS | `search_logic_flow` warm p90 18.57 ms |
| A11 | EXCEEDS | C-MED utilisation 82.1 / 94.08 / 101.95 / 102.53 / 95.97 % (M210: 82.7 / 94 / 102.06 / 102.58 / 96.19) |
| A12 | MATCHES | 3 representation classes on C-MED, 4 on C-LARGE — no new class introduced |
| A13 | EXCEEDS | **0** size drops, **0** focus swaps over 20 tasks × 5 budgets |
| A14 | MATCHES | 5065 / 5065 delivered items carry token accounting; none in the default response |

`determinism: stable`; structural violations 0; strengthened 0; invented 0.
The frozen F6 control still FAILS on its stale `a14PerItem === 0` conjunct alone,
by construction once A14 passes, exactly as at M203 / M208 / M209 / M210. It is
not M211's.

**A5 was not measured on an idle machine.** Load average was 2.97–3.57 on 20
CPUs throughout, from the user's own desktop processes; §36's idle condition was
not achievable. M210 recorded 57.22 / 242.08 / 361.92 idle and 65.4 / 225.22 /
375.32 at load 2.5. The verdict is MATCHES at both, and the M211-attributable
impact latency is measured directly and separately in §6 under identical
conditions in both arms.

**Isolation was checked, not assumed, and it does not hold.**
`productContext/assembleProductContext.ts` and
`runPipeline/runPipelineOrchestrator.ts` both call `getImpactGraph` as a value,
so the A11/A13 path does run M211's core changes. Neither embeds the census —
each reads selected fields — and A11/A12/A13 were therefore re-measured directly
rather than argued away.

## 11. Retrieval and frozen A15

Both fixtures re-run on this tree: `expanded` 20/20 top-1 **85.0 %**,
`cross_repo_30` 30/30 top-1 **66.7 %** (0.6667), top-3 73.3 %, pivot 70.0 %,
missing 6.7 %. Both CSVs are **byte-identical** to the committed baselines. No
baseline was regenerated. The M208 floor is held exactly.

**Frozen A15 observation, not a parity claim.** The frozen A15 measurement moved
from 8 % to **20 %** on C-LARGE (C-MED 24 % → 66 %, C-SMALL 83.33 % → 94.44 %) as
an incidental consequence of the ladder repair. It remains **BELOW**, the matrix
remains **14 / 15**, and M210's conclusion that the frozen predicate is
arithmetically unreachable stands: reaching 90 % on C-LARGE still means
delivering universe rank 530 inside 1200 model-visible tokens. This is recorded
because §39 requires recording it, and for no other purpose.

## 12. What M211 does not prove

- It does not change, reinterpret or reopen the historical 14/15 parity result.
- It does not show that any of this helps a coding agent.
  `ENGINE QUALITY != CODING-AGENT UTILITY` and
  `CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern.
- It does not show VTRACE beats VEXP, and it does not disturb the prior neutral
  paired-agent evidence (M164, M185).
- P6 is partially met; two high-fanout targets still deliver no source line.

## 13. Repository state

| | |
|---|---|
| starting | `575287d1651a8bea525d4dfcd1c198e26b3ba06d` |
| audit / counterfactual | `dc2e5f0b17434314ad51407d63a5063063827f34` |
| census / projection / continuation | `ea7cf446fe...` |
| evidence | this commit |
| pushed | no |
| dirt | preserved |

## 14. Recommendation

Freeze the VTRACE impact/product architecture for the causal benchmark. The next
milestone is to **pre-register and reproduce the exact Baseline vs
Baseline+VTRACE vs Baseline+VEXP conditions before any paid live run** — which
M211 did not begin and which no engine result licenses.
