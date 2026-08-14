# M143 — final report

**Overall verdict: MIXED**

| | verdict |
|---|---|
| **M143-A** — title-lane semantics | **MIXED** |
| &nbsp;&nbsp;title evidence *truthfulness* | **PASS** — shipped |
| &nbsp;&nbsp;title *ranking* semantics | **NOT PASS** — `django-11740` known, root-caused, unresolved |
| **M143-B** — behavioural ownership evidence | **NOT PASS** — measured deterministic capability ceiling |

M143 removed a real defect (a synthesized candidate asserting retrieval evidence
that was never measured) at zero cost to retrieval quality, and then established
— by measurement, not argument — why the remaining ranking defect cannot be
closed with static repository evidence. It is MIXED because a genuine product
correctness improvement shipped while the motivating case remains open.

It is **not PASS**: `django-11740` is unresolved and the Gaussian ownership
acceptance is unmet. It is **not INCOMPLETE**: the benchmark ran, preservation
ran, every changed case is attributed, and the investigation reached a
demonstrated boundary rather than running out of time.

---

## 1. Commits and provenance

| role | SHA |
|---|---|
| M142 functional predecessor | `41fb0a9ba22b0f69e3349aca77b4ae2b15908504` |
| **M143 final functional candidate** | `93a34d194b2360094d61b27f2ecc12f6dccacdb3` |
| M143-A evidence | `3b0213b8e99284acdc1d7c54af80db1f330d447a` |
| M143-B evidence (no functional commit — deliberate) | `d9a98edaeebd5f866d7796db9f2984aa19e11109` |
| closure evidence | this commit |

`93a34d1` is the only functional commit in the milestone. Closure HEAD differs
from it by **test files only** — `git diff --name-only 93a34d1 HEAD -- src/`
yields zero non-test sources — so the product candidate and the evidence HEAD are
semantically identical, verified rather than asserted.

## 2. Final paired benchmark

`41fb0a9 → 93a34d1`, re-executed for this closure over independently indexed,
provenance-valid corpora. **`provenanceValid = true`**; both suites report
`sameFixtureHash`, `sameTargetCorpusHash`, `isolatedIndexes`, `authoritative`.

| Metric | M142 | M143 | Delta |
|---|---:|---:|---:|
| Top-1 gold file | 38 | 38 | 0 |
| Top-3 gold file | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean tokens | 1835.72 | 1835.20 | **−0.52** |
| Mean pivots | 2.10 | 2.10 | 0 |
| Mean support | 3.88 | 3.88 | 0 |

Suites: django 20 (4 changed), cross_repo 30 (1 changed) — frozen 50, 5 changed.

### 2.1 Gold-visibility movements

**None.** Zero cases moved any gold metric in either direction.

### 2.2 Non-gold semantic movements (§80)

All five changed cases are exactly the five title-injection cases, and all five
changed the *same two fields only*:

| Case | fields | lead changed | selected files changed | mechanism | classification |
|---|---|---|---|---|---|
| `django-11740` | `modelVisibleContext`, `tokenAccounting` | no | no | title_evidence_truthfulness | NEUTRAL — explanation only |
| `django-13112` | same | no | no | title_evidence_truthfulness | NEUTRAL — explanation only |
| `django-11133` | same | no | no | title_evidence_truthfulness | NEUTRAL — explanation only |
| `django-12276` | same | no | no | title_evidence_truthfulness | NEUTRAL — explanation only |
| `sympy-16766` | same | no | no | title_evidence_truthfulness | NEUTRAL — explanation only |

`roles` and `contentModes` diffs are **0**. **No unexplained case.**

## 3. Title evidence truthfulness — the shipped gain (§81)

The injected title candidate previously declared:

```
lexical: 1   fts: 1   tfidf: 1   bm25: 1   symbol: 1   final: 2.5
```

Four of those are **measured retrieval quantities**, and the premise of the
injection is that retrieval never produced the candidate — so they were never
measured. The role gate, the decoy classifier and the pivot explanation all read
them. On `django-11740` the capsule told the model, in prose it can read:

```
actionable class — symbol-name match; strong lexical match
```

There was no lexical measurement at all. Unmeasured components now report `0`;
`symbol: 1` is retained because exact title-name identity genuinely is observed.

**This is a product correctness improvement even though Top-1 is unchanged.** It
removes a false, model-visible claim about the provenance of evidence. Its whole
measured footprint is the five explanation-only diffs in §2.2 — which is the
point: the fabricated fields were asserting information, never carrying it.

## 4. `django-11740` — final status

**Classification: REGRESSION — KNOWN, ROOT-CAUSED, UNRESOLVED.**

Note the ownership precisely: this case is `top1=false` on **both** sides of the
final comparison. It regressed in **M142**, and M143 root-caused it without
fixing it. It is **not** an M143 regression, and it is **not** relabelled neutral.

| | value |
|---|---|
| title candidate | `ForeignKey` @ `db/models/fields/related.py` |
| injected final | **2.5** (synthesized) |
| what `ForeignKey` actually earns | final **1.343**, rank **14** |
| organic gold | `autodetector.py::_get_dependencies_for_foreign_key`, final **1.760**, **already rank 1** |
| promotion | **1.86×** over what the same scorer gives the same symbol |

Ordinary retrieval already leads with the gold file. The title injection is what
displaces it.

**Root cause — two independent producers of ranking authority:**

| # | producer | effect |
|---|---|---|
| P1 | `TITLE_SYMBOL_FINAL = 2.5` | fixed final above every ordinary candidate |
| P2 | unconditional `evidenceTier = 2` | the pivot comparator sorts on tier **before** score |

P2 is why M142's "restore the organic scorecard" attempt recovered recall but not
the lead — it addressed P1 only, and a tier-2 candidate outranks a tier-1
candidate at *any* score. `titleSymbolIds` has **six** precedence consumers.

**Why it cannot be fixed by demotion:** across the frozen 50 the lane fires on 17
cases (21 matches: 16 incumbents, 5 injections), and the injected promotions are
**4 correct : 1 wrong**. Any class-wide demotion is net-negative — which is
exactly what M142's Attempt 1 measured (37 → 35).

## 5. The five title-injection cases — final state

| case | title | organic top-1 | promotion | final state |
|---|---|---|---|---|
| `django-11740` | `ForeignKey` | `_get_dependencies_for_foreign_key` @1.760 — **already gold** | **wrong** | open |
| `django-13112` | `ForeignKey` | `FieldIsAForeignKeyColumnName` @1.720 — not gold | correct | unchanged |
| `sympy-16766` | `PythonCodePrinter` | `lambdify` @2.428 — not gold | correct | unchanged |
| `django-11133` | `HttpResponse` | `response.py::write` @1.842 — already gold | correct (redundant) | unchanged |
| `django-12276` | `FileInput` | `use_required_attribute` @1.950 — already gold symbol | correct (displaces gold symbol) | unchanged |

## 6. Behavioural ownership — what B measured

**The hypothesis was falsified.** M143 §15 predicted
`_get_dependencies_for_foreign_key --references--> ForeignKey`, which would type
`ForeignKey` as the subject. Across **all 45 × 138 symbol pairs** between
`db/migrations/autodetector.py` and `db/models/fields/related.py` the index holds
**0 relations of any type in either direction**. `ForeignKey` has **inDegree
193**; its top referrers are tests.

The autodetector operates on field **instances** from model state and never names
a concrete field class. The absence is in the **source**, not the index.

**Three discriminators measured and rejected:**

| # | mechanism | result |
|---|---|---|
| 1 | relation to the organic lead | `11740`, `13112`, `16766` all `0/0` — groups the case to fix with two that must not be touched |
| 2 | title-family retrieval support | apparent zero was a **pool-floor artifact** (`11740` floor 0.660 > `16766` support 0.638); at depth a continuum **0.504 / 0.638 / 0.694**, needing a fitted constant |
| 3 | interface / override ownership | **real and generic**, but fires on **0 of the 7 real candidates measured** |

## 7. Gaussian — final classification

Exact recorded wording (not paraphrased):

> How does ARC decide which Gaussian route keywords to **emit**?

| | base | override surface |
|---|---|---|
| `arc/job/adapters/gaussian.py::GaussianAdapter` | `JobAdapter` | `write_input_file`, `set_files`, `set_additional_file_paths`, `set_input_file_memory`, `execute_incore`, `execute_queue` |
| `arc/parser/adapters/gaussian.py::GaussianParser` | `ESSAdapter` | `parse_geometry`, `parse_frequencies`, `parse_normal_mode_displacement`, … |

The interface signal cleanly separates the two roles. Query objectives are
`arc, decide, gaussian, route, keyword, emit` — overlap with the adapter's
surface **0**, with the parser's **0**. The mechanism **abstains**.

**Hard acceptance: NOT MET.** The adapter is *not* deterministically elected over
the parser for a structural reason.

Separately, and honestly: in the live behavioural corpus the final query result
**is** correct — lead `arc/job/adapters/gaussian.py::GaussianAdapter._user_requested_verytight`,
top1/top3/anywhere all true, identical on predecessor and candidate. That is a
**lexical** outcome via Workstream A, exactly as M142 recorded. It must not be
counted as the ownership acceptance.

Bridging `emit → write_input_file` needs a synonym lexicon. **Not added** — it is
a rejected weak-heuristic direction.

## 8. Generic ownership controls

| control | result |
|---|---|
| subject-vs-owner | **ABSTAIN** — no relation exists to read |
| title-is-owner | **PASS** |
| parser-vs-adapter | **PASS** |
| action-switch | **PASS** |
| caller-vs-helper | **ABSTAIN** as intended — a call edge alone proves nothing |
| ambiguous | **ABSTAIN** |

B found a real but *incomplete* structural ownership signal. It did not simply
fail to implement something.

## 9. Persistence representational loss

`edges.edge_type` admits only `contains | imports | calls | references`. The
Python parser tags `inheritance`, `decorator` and `annotation` reference kinds and
`emitReferenceEdges` discards the kind after using it for shadowing. Inheritance
survives only as an undifferentiated `references` edge.

This is a genuine loss, recorded as a standing architectural finding. It is **not**
the cause of §6: restoring it would sharpen the interface/override role and leave
`django-11740` untouched. **Not** a reason to open a schema milestone.

## 10. Preservation

Full table in `stage5_m143_final_preservation.json`. Attribution rule: a red gate
is an M143 regression only if it is green on `41fb0a9`.

| Gate | Predecessor | M143 | Verdict | Attribution |
|---|---|---|---|---|
| M136 budget delivery | FAIL, `ARC 3000=undefined` | identical | PRECONDITION_UNMET | blameless — byte-identical |
| M137 direct answer | `get_dihedral` leads | identical | **PASS** on the control | unchanged; FAIL row is M136's |
| M138 memory provenance | ERROR at line 241 | identical | PRECONDITION_UNMET | blameless — identical harness error |
| M139 impact truthfulness | — | PASS | PASS | product suite; no impact code touched |
| M140-C orchestration + module | — | PASS | PASS | unchanged |
| M140-B TCKDB | — | leadChanged=false, selectionChanged=false | **PASS** | unchanged, same-checkout read-only |
| M141 readiness | — | PASS | PASS | no schema/capability change |
| M132 worktree isolation | MIXED 19/21 | MIXED 19/21 | MIXED | stale assertion vs a pre-M142 baseline |
| ARC behavioural (7 cases) | 7 cases | 7 cases | **PASS** | **0 semantic differences**, field-by-field |
| get_skeleton | — | PASS | PASS | product suite |
| `django-11815` | top1=true, lead `serializer.py` | identical | **PASS** | cap admission preserved |
| `sphinx-7462` | top1=true, rank 1 | identical | **PASS** | traceback repair holds |
| `sphinx-7910` | anywhere=true, not delivered | identical | **PASS** (preserved) | pool gain held; not overclaimed |
| M142 D/E | D PARTIAL, E PASS | unchanged | PASS (not worsened) | not reopened |

**New regressions attributable to M143: 0.**

## 11. Evaluation path-normalization guard (§54)

M143-A's first audit pass compared repository-relative gold paths against
workspace-relative lead paths literally, scoring **three correct leads as wrong**
— which made blanket title demotion look net-positive when it is net-negative.
The comparison was corrected to anchor on a path-segment boundary.

It had **no test**. This closure adds
`benchmarks/stage5_vexp_swe_bench_smoke/goldPathNormalization.test.ts` (5 cases:
repo-relative vs workspace-relative in both directions, exact equality,
non-boundary text suffix, same basename in different directories, unrelated
paths). Harness-only; no product code.

## 12. Tests

```
bun test                     4232 pass / 49 skip / 0 fail / 259 files
bun run typecheck            PASS
bun run typecheck:benchmarks PASS
git diff --check             PASS
```

## 13. Remaining limitations

1. `django-11740` — a titled subject outranks an already-correct behavioural
   lead. Root-caused to two authority producers; unfixable by demotion because
   the population is 4 correct : 1 wrong.
2. Gaussian ownership — the adapter is elected lexically, not structurally.
3. Same-domain action ownership generally — the override role only fires when
   request vocabulary reaches interface member names.
4. Reference-kind loss at persistence (inheritance/decorator/annotation).
5. M142 D remains PARTIAL; E's small-delta worktree path remains unresolved.

## 14. Next milestone

**M144 — Failure-Evidence Attribution and Behavioural Localization.**

M143's boundary says the missing signal is not more static evidence. It is
evidence about what actually executed and failed: failing test name and path,
traceback frames, exception location, explicit reproduction commands,
task-provided file references. M144 should start from evidence **already supplied
to the agent**, not from vtrace running tests itself; dynamic execution is a
later question.

`django-11740` should be used as an **acceptance case for the new evidence
class**, not as another title-tuning target. Per §79 the A avenues
(`TITLE_SYMBOL_FINAL`, `evidenceTier`, centrality thresholds, IDF title
weighting) stay closed, and per M143-B no further static ownership heuristic
should be attempted.

This remains a **hypothesis**: M143 shows static evidence cannot separate this
case; it does not show that failure evidence can. That must be measured.

Then **M145 — Workspace and Repository Identity Foundation** (workspace identity,
explicit repository membership, repo/worktree provenance, per-repo readiness,
explicit routing, result provenance, same-name collision safety, index-operation
ownership/locking — no cross-repo semantic ranking yet), and **M146+ —
Cross-Repository Intelligence**.
