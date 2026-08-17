# M157 — Answer delivery and no-pivot recovery: final report

## Verdict

**M157 = MIXED.**

| workstream | verdict | why |
| ---------- | ------- | --- |
| A — delivery authority and no-pivot failure audit | **PASS** | Django reproduced exactly; the collapse is proven query-global; every consumer mapped; two reporting defects found and fixed additively |
| B — frozen no-pivot evidence corpus | **NOT PASS (ceiling)** | The available data holds **2** no-pivot cases in 2 repositories, against the 20–30 across 4+ repositories §25 requires. Reported rather than manufactured (§33) |
| C — bounded non-pivot support semantics | **NOT PASS as specified; PASS on the proven defect** | Support-only delivery is not justified by the evidence and was not built (§52/§53). The role-classification defect the audit did prove is fixed generically |
| D — consumer and truthfulness integration | **PASS** | Three surfaces asserted to agree; abstention and absence semantics pinned |
| E — broad preservation and changed-case proof | **PASS on preservation; holdout NOT AVAILABLE** | broad100, frozen50, frozen30 and clean27 all run and attributed; no untouched no-pivot holdout exists to consume (§67) |

M157 cannot be PASS because §98 requires all five, and B has no corpus to freeze.
It is not FAIL: nothing in §101 occurred — no top-N dump, no fake pivot, no gold
labels, no new budget, no repo-specific rule, no weakened absence claim, no
routing change, no availability regression, no scoring change.

## The strategic answer (§113)

> Is a meaningful portion of the remaining gap "retrieval has useful evidence,
> delivery policy withholds it"?

**No — and the measurement is the milestone's most useful output.** Classifying
the fate of the gold file across all 100 broad cases (independently reproducing
every published M156 rate):

| fate | cases |
| ---- | ----: |
| delivered as pivot | 67 |
| delivered as support | 11 |
| **withheld by the no-pivot gate** | **2** |
| role-denied or support-budget-evicted | 9 |
| never retrieved | 11 |

The delivery-policy question M157 was convened to answer governs **2 of 100
cases**. Of those two, one was not short of pivot-worthy candidates at all, and
the other is a genuine evidence ceiling where delivering support would deliver
noise. Meanwhile **8 cases lose gold to the support packing cap** — four times
the no-pivot gate — which is the larger and still-open mechanism.

## A — authority audit

`django__django-11740`, reproduced exactly against the pinned M156 corpus:

| | M156 | M157 |
| - | ---: | ---: |
| candidates | 33 | 33 |
| pivots | 0 | 0 |
| support delivered | 0 | 0 |
| discarded | 33 | 33 |
| delivered tokens | 0 | 0 |

**Unchanged, and correctly so.** No candidate in its pool carries a symbol, path,
failing-test or body-literal pointer; the gold candidates rank 29th and 30th of
33 on behaviour-ownership evidence alone (the relation M143-B closed as a
measured ceiling); and the fixture's gold symbol `generate_altered_fields` is not
in the pool at all, so no delivery policy could have delivered the patched
definition. Its top 25 support candidates are `default_error_messages` module
variables — a lexical explosion on the task's `Errors: ValueError` line.

**First gate that prevents delivery**: `buildCapsuleV2.ts:985`,
`if (pivotCandidates.length === 0) return noContextResult(...)`, before budget
packing.

**Candidate-local or query-global**: query-global. All 33 candidates had been
granted support authority by the candidate-local role layer; **zero** were denied
it. Support is impossible without a pivot today.

**Two reporting defects, fixed additively**: `support_count` was a literal `0` on
the no-context path regardless of how much was withheld, and the global discard
reason overwrote each candidate's own role decision. `support_authority_withheld`
and `role_reason` now make the state auditable; neither changes delivery.

**Consumers mapped**: `productAdapter` digest + warnings, `assembleProductContext`
(`resolved`), `runPipelineOrchestrator`, and the shared `productContext` schema
behind `get_code_context` / `get_context_capsule` / `run_pipeline`.

## B — corpus ceiling

No-pivot rate: **2%** (2 of 100). The complete offline instance pool is the same
100 (`swe-bench-100.jsonl`); the other in-repo fixtures are subsets of it, and
the M155-era per-era corpora were deleted by M156. Reaching 20–30 no-pivot cases
would need roughly 1000–1500 instances.

Both real cases were consumed diagnostically in A, so per §27/§28 neither can
serve as a sealed holdout: Django is calibration by instruction, Sphinx was
consumed to identify the mechanism. **There is nothing left to seal**, which is
the second, independent reason B cannot pass.

One ground-truth error was found and corrected **before** freezing: the gold
matcher compared fixture paths (`django/db/...`) against package-root candidate
paths (`db/...`) and reported zero gold candidates for both cases. Using the
scorer's own boundary-aware `fileMatches` recovers 2 and 18. Uncorrected, A would
have concluded neither case retrieved any gold — the opposite of the truth.

## C — what was actually built

Not a support-only lane. The audit proved a different, generic defect:

**A candidate disqualified from the pivot role keeps the slot it consumed.** The
pivot cap is applied before two demotions that can invalidate it — the
scoped-objective block and the non-source-example block — and neither releases the
slot. `capPivots` inside `refineDebugRoles` is correctly ordered after its own
demotions; these two are not.

On `sphinx-doc__sphinx-9320` this empties an entire capsule: both standard slots
go to two `doc/conf.py` candidates, the non-source rule disqualifies both, and
the **seventeen** candidates that had cleared the pivot bar — three of them gold
symbols — are discarded as "no actionable edit target".

The fix records the two states structurally rather than parsing a reason string:
`budgetDemotedPivot` (priced out, still pivot-worthy) and `pivotIneligible`
(judged unfit, never promotable). Genuinely free slots are refilled from the
first group in ranked order.

| §95 criterion | status |
| ------------- | ------ |
| generic authority, no benchmark-specific logic | yes — no instance id, path, or repository name |
| no top-N-discard fallback | yes — only candidates that met the pivot bar are eligible |
| no new numeric threshold | yes — structural flags only |
| wrong-subject / true-empty negatives stay empty | yes — asserted; django-11740 unchanged |
| normal pivot cases preserved | 1 of 98 changed, attributed |
| bounded global envelope preserved | yes — never exceeds the tier's pivot cap |
| support-only evidence remains non-actionable | n/a — no support-only lane built |

Scores, candidate pools and ranking are untouched (§41/§82/§83): the fix operates
purely on role assignment downstream of retrieval.

## D — consumers

`get_code_context`, `get_context_capsule` and `run_pipeline` are asserted to
agree on `ok`, `resolved` and `leadPivot` for the same repository, query and
budget, on the generic doc-outranks-source shape, with a guard against a vacuous
pass. No consumer may be handed a doc-tree file as the edit target. An irrelevant
query stays unresolved with no lead on all three, and no empty delivery is
serialized as `authoritative_absence`.

`resolved = actualMode !== "no_context" && pivots.length > 0` was audited, not
removed (§61): it means *no actionable target*, which is correct and unchanged.
It would have become the §63 boolean collapse only if a support-only state had
been introduced — recorded as the open constraint for any future attempt.

## E — preservation and changed cases

### broad100 (M156 final → M157 final, same fresh derivation-valid corpus)

| metric | M156 | M157 |
| ------ | ---: | ---: |
| gold Top-1 | 0.57 | **0.58** |
| gold Top-3 | 0.73 | **0.74** |
| gold anywhere | 0.89 | 0.89 |
| symbol anywhere | 0.64 | 0.64 |
| gold delivered | 0.78 | **0.79** |
| gold discarded | 0.11 | **0.10** |
| gold missing | 0.11 | 0.11 |
| empty contexts | 0.02 | **0.01** |
| support-only contexts | 0.00 | 0.00 |
| pivot contexts | 0.98 | **0.99** |
| tokens mean | 1647.97 | 1658.15 |
| tokens median | 1165 | 1165 |
| tokens p90 | 3750 | 3750 |

**Changed cases: 2. Unexplained: 0.**

| instance | classification | outcome | before → after |
| -------- | -------------- | ------- | -------------- |
| `sphinx-doc__sphinx-9320` | PIVOT_ROLE_CORRECTION | **IMPROVEMENT** | `skipped_no_context` → `hit_top1_pivot`; gold discarded → pivot; 0 → 533 tokens |
| `pydata__xarray-6599` | PIVOT_ROLE_CORRECTION | NEUTRAL | gold stays Top-1 pivot; 1 → 2 pivots; 199 → 684 tokens |

Token inflation is not the source of the gain: median and p90 are unchanged and
the mean moves +10.18 across 100 cases.

### Other suites

| suite | result |
| ----- | ------ |
| frozen50 fast gate | 50/50 derivation-valid; **byte-identical** to M156 (top1 0.76, top3 0.86, delivered 0.90, discarded 0.06, missing 0.04, meanTokens 1779); **0 changed cases**. Neither broad100 changed case is a member |
| frozen30 availability | **usable 30/30, unavailable 0, degraded 3** — identical set (`requests-1142`, `pytest-5262`, `pylint-4551`) |
| clean27 structural | **27/27** identical file, symbol and edge counts; 0 changed cases |
| M156 recovered-three retrieval | all three identical: `requests-1142` → `requests/models.py` (gold lead), `pytest-5262` → `src/_pytest/capture.py` (gold lead), `pylint-4551` → ordinary miss |
| benchmark quarantine | 0 |

### M157 metrics (§104–§107)

| metric | value |
| ------ | ----- |
| `useful_support_recovery` | **0** — no support-only lane was built. The one recovery happened as a PIVOT; counting it here would credit a capability M157 does not have |
| `misleading_support_recovery` | **0** |
| `true_empty_preservation` | preserved — `django-11740` and both constructed negative controls remain empty |
| `pivot_present_cases_changed` | **1** (`pydata__xarray-6599`), NEUTRAL, permitted by §107 because the role-classification defect is separately proven |

## Safety and provenance

| | |
| - | - |
| branch | `main`, 41 ahead / 0 behind `origin/main`, nothing pushed |
| co-author trailers | 0 |
| worktrees | 13 pre-existing, 0 created, 0 removed |
| pre-existing dirt | `stage5_outcome_ledger.{json,md}` preserved unstaged |
| `.vtrace` staged | 0 |
| tracked `.gitignore` / global git config changes | 0 |
| probe `srcDirty` | false |
| gold labels / instance ids in product logic | none (comment references only) |
| `<module>` deliveries in broad100 | 0 |
| behavioural repository routing | OFF (untouched) |
| index writes on read paths | unchanged (no indexer change) |
| new source reads on the product path | 0 |
| tests | 4820 pass / 0 fail / 49 skip, run on an idle machine |
| typechecks | `bun run typecheck`, `bun run typecheck:benchmarks` clean |
| `git diff --check` | clean |

## Commits

| SHA | kind |
| --- | ---- |
| `1566488c` | M156 final (predecessor) |
| `f1497fc6` | functional (observability) — Audit no-pivot delivery authority |
| `fb509a44` | **functional** — Release pivot slots vacated by a later demotion |
| `623fa03b` | tests — Hold every delivery consumer to one pivot-authority answer |
| this commit | evidence |

## Standing findings

- **The no-pivot collapse is real, query-global, and was unmeasurable.**
  `support_count` was hardcoded to 0 on that path and the global discard reason
  erased each candidate's role decision, so "0 support" meant the same thing for
  a query that retrieved nothing and one that withheld 33 relevant candidates.
- **A disqualified pivot kept its slot.** Generic; 2 of 100 cases across two
  unrelated repositories; the direct cause of one of the two empty capsules. The
  cap was correct — its ordering was not.
- **The support cap, not authority, is the bigger gold-loss mechanism.** 8 cases
  lose gold to `beyond standard support budget (max 4)` versus 2 to the no-pivot
  gate. This is the recommended next milestone.
- **The no-pivot state is too rare in SWE-bench to design a delivery policy
  against.** 2% of instances, and the two instances disagree about what the right
  answer is. A support-only lane cannot be calibrated or held out on this data;
  if it is wanted, it needs a corpus built for it.
- **`django-11740` was never a delivery-policy case.** Its gold symbol is not in
  the candidate pool at all, so it is a retrieval-recall case wearing a delivery
  case's clothes — which is why the exposing instance must not become the
  specification.

## Recommended next milestone

**M158 — support packing and the `max 4` cap.** It is the same question M157
asked, one layer down, with four times the measured reach and a real population
(8 cases, 6 repositories) to calibrate and hold out against.
