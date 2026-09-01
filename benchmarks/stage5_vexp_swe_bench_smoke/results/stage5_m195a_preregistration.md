# M195A preregistration — validation-selection vs validation-scaffold

**Milestone.** M195A. Zero-spend interpretive closure of M195.
**Frozen at.** This file is committed BEFORE any M195A reclassification result is
computed, read, or reported. Nothing below may be renegotiated once the counts are in.
**Parent authority.** `results/stage5_m195_preregistration.md` (8655851a) and the
M195 artefacts it produced. M195A changes no rule in that preregistration.

## 0. What M195A is and is not

M195 mechanically returned `I6_INTERVENTION_MECHANISM_WITNESSED` under its own nine
frozen gates. That result stands and is not rewritten. M195A asks a different,
narrower question: **what kind of intervention opportunity did that positive gate
actually witness?**

M195A is an audit of a frozen mechanism. It does not search for a new mechanism,
improve ranking, add candidate families, touch held-out data, or run any model.

## 1. Corpus authority

Exactly the M195 corpus, unchanged:

- 33 paid valid M194 arms, over 33 distinct instances, 12 repositories.
- 59 decision points (40 `DP_EDIT`, 19 `DP_POST_FAILED_VALIDATION`).
- 4 frozen candidate families `I6-A`, `I6-B`, `I6-C`, `I6-D`, plus the reported
  `I6-UNION` aggregate. There is no fifth family and M195A does not create one.
- No historical run, no unused fixture arm, no held-out instance enters the analysis.

**Authority precondition.** Before any M195A number is computed, the frozen M195
driver is re-executed unmodified over the preserved M194 tree and its three
artefacts (`stage5_m195_audit.json`, `stage5_m195_candidates.jsonl`,
`stage5_m195_decision_points.jsonl`) must reproduce **byte-for-byte**. If any byte
differs, M195A halts and reports `INCOMPLETE`. M195A reads only the committed M195
artefacts and this verified replay.

## 2. Derivation stays frozen

M195A does not modify `m195Mechanism.ts` or `m195Evaluation.ts`, nor the audit
driver. Candidate discovery, scoring, rank, the bound of 3, the relevance oracle,
decision-point extraction, the equivalence rules and the forward-only credit window
are all inherited exactly. Reclassification happens strictly downstream of the
frozen candidate set, after it has been derived and hashed.

If a defect is found that prevents faithful replay of the frozen rule, M195A STOPS
and reports the defect rather than repairing the mechanism.

## 3. Structural facts inherited as premises

- **Runner intent is already encoded.** `relateOne` returns `BROADER_THAN_CANDIDATE`
  or `DIFFERENT_VALIDATION` only when `obs.runnerStarted` is true, and returns
  `NO_VALIDATION` otherwise. Therefore, for any decision point where the family
  fired, a best relation of `NO_VALIDATION` is a proof that **no test runner started
  inside the credit window**, and a best relation of `DIFFERENT_VALIDATION` is a
  proof that **a runner started and its target set did not contain the candidate**.
  M195A relies on exactly this and adds no new runner heuristic. A `python -c`
  reproduction remains no validation, per the M195 §10 instrument correction.
- **`EXACT_MATCH` / `EQUIVALENT` are selection facts**, held whether or not the
  runner went on to start. M195A preserves that, per the M195 unpaired-`bash_pre`
  correction.
- **One arm per task.** The 33 arms cover 33 distinct instances, so the corpus
  contains no within-task failed/success analogue pair. This is a premise, not a
  result, and it constrains §6 below.

## 4. Intervention taxonomy (mutually exclusive, one per decision point per family)

Evaluated per `(decision point, family key)` row. Exactly one class applies.

| id | class | condition |
|----|-------|-----------|
| S6 | `NO_DERIVABLE_VALIDATION_TARGET` | family delivered 0 candidates (abstained) |
| S2 | `VALIDATION_TARGET_ALREADY_SELECTED` | best relation is `EXACT_MATCH` or `EQUIVALENT` |
| S3 | `VALIDATION_BROADER_SELECTION` | best relation is `BROADER_THAN_CANDIDATE` |
| S1 | `VALIDATION_TARGET_SELECTION_OPPORTUNITY` | best relation is `DIFFERENT_VALIDATION` **and** at least one delivered candidate is confirmed relevant under the frozen oracle |
| S4 | `VALIDATION_SCAFFOLD_OPPORTUNITY` | best relation is `NO_VALIDATION` **and** at least one delivered candidate is confirmed relevant under the frozen oracle |
| S5 | `VALIDATION_EVIDENCE_UNUSABLE` | M195 assigned `VALIDATION_EVIDENCE_UNUSABLE` (attempts existed in window, none trustworthy) and no class above applies |
| S0 | `CANDIDATE_FIRED_NOT_CONFIRMED` | candidates fired but none confirmed relevant, and no class above applies |

Order of evaluation is S6, S2, S3, S1, S4, S5, S0. `S1 ∪ S4` is exactly M195's
`I6_VALIDATION_SELECTION_MISS` set, partitioned on runner intent and nothing else.

## 5. The key quantity

```
GENUINE_I6_SELECTION_MISS
```

A `(decision point, family)` row qualifies iff **all** hold:

1. the frozen pre-decision derivation delivered at least one candidate;
2. at least one delivered candidate is confirmed relevant under the frozen M195
   relevance oracle (`test_patch` paths or `FAIL_TO_PASS` paths/nodes; `PASS_TO_PASS`
   remains excluded);
3. the agent actually initiated a trustworthy validation-selection action — a test
   runner started inside the frozen credit window;
4. the selected target set is non-equivalent to every relevant delivered candidate
   (best relation is exactly `DIFFERENT_VALIDATION`; `BROADER_THAN_CANDIDATE` does
   **not** qualify, because a broader run may subsume the candidate);
5. no relevant delivered candidate was run inside the frozen credit window;
6. the classification does not rest on missing runner evidence — the row is excluded
   if it depends on an unpaired `bash_pre` for which no selection is observable.

`NO_VALIDATION` rows are **never** admitted to this set, by construction.

```
I6_SCAFFOLD_OPPORTUNITY
```

A row qualifies iff conditions 1 and 2 hold and the agent performed **no** validation
in the applicable episode (best relation `NO_VALIDATION`, i.e. no runner started
inside the credit window before the next material edit). This is reported with arms,
tasks, repositories and resolved/unresolved counts. M195A does **not** evaluate
whether scaffolding would help.

```
CREDIT_WINDOW_EDGE_CASE
```

An additional boolean flag, never a class: the row is a miss under the frozen
forward-only credit window, yet a relevant candidate was selected somewhere else in
the arm's trajectory. The window is not changed; the flag is reported alongside the
row's frozen class.

## 6. Selection-specific witness rule

A success-side row is a **selection witness** only if it supports the contrast the
selection hypothesis needs:

> the failed analogue starts a runner against a different, non-equivalent target,
> while the successful analogue starts a runner against the candidate or an
> equivalent.

A success-side row where the failed analogue performed **no** validation is a
**scaffold witness**, not a selection witness. A resolved arm that merely happened to
run the candidate, with no failed analogue exhibiting a contrasting *choice*, is
**neither**.

M195's `strong` definition is inherited verbatim and not loosened: a derived
validation must fail (`FAILED` or `MIXED`), visibly drive a revision
(`postValidationRevision`), and the arm must resolve.

## 7. Closure rule for the original I6 selection hypothesis — Axis A

```
VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED
```

is returned **only if** the reclassified `GENUINE_I6_SELECTION_MISS` set, on its own,
satisfies all of:

- misses span **>= 3 distinct tasks**;
- misses span **>= 3 distinct repositories**;
- **>= 2 success-side selection witnesses** under §6;
- those witnesses span **>= 2 distinct repositories**.

Scaffold specimens (S4) may not be used to satisfy any part of this gate.
Otherwise:

```
VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED
```

## 8. Scaffold observation rule — Axis B

```
VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED
```

iff `I6_SCAFFOLD_OPPORTUNITY` is non-empty at the union level over **>= 2 tasks**
and **>= 2 repositories**. Otherwise `VALIDATION_SCAFFOLD_OPPORTUNITY_NOT_OBSERVED`.

This axis is **observational only**. Observing an opportunity is not evidence that
intervening on it improves outcomes, and M195A will not claim otherwise.

## 9. Selectivity measures

Delivered count is the frozen post-cap `candidates.length` (bounded to 3 by §8 of the
M195 preregistration). Raw pre-truncation count is the frozen `preCapCount` recorded
by each family at derivation time. Both are inherited; neither is recomputed.

Per family and for the union, over candidate-producing decision points:

- `raw median`, `raw p90`, `raw max` of `preCapCount`;
- `fraction > 3`, `fraction > 5`, `fraction > 10`;
- `delivered median`, `delivered max`.

`OUTPUT_BOUND` denotes the frozen `<= 3` delivered cap. `PRE_TRUNCATION_SELECTIVITY`
denotes the raw distribution. These are different claims and are reported separately.

**Preregistered descriptive threshold.** M195A does not invent a new bar; it applies
M195's own G2 requirement to the quantity G2 should have measured:

```
PRE_TRUNCATION_DERIVATION_SELECTIVE   iff  raw p90 <= 3 and fraction(raw > 3) <= 10%
PRE_TRUNCATION_DERIVATION_BROAD       otherwise
```

This is descriptive. It is **not** a retroactive product gate and does not rescore
M195.

## 10. Dead-gate falsification

M195's G2 reads `medianCandidates` / `p90Candidates` computed from post-cap
`candidateCount`. M195A must demonstrate mechanically, with a synthetic frozen
replay, that a decision point with a raw pre-truncation set well above 3 and a
delivered set of exactly 3 still returns `G2 = PASS`. Required verdict on success:

```
M195_G2_OUTPUT_BOUND_ONLY
```

G2 is not to be described as a selectivity test.

## 11. Falsification controls

Committed as executable tests before the verdict is read.

- **F1** candidate exists, agent does nothing → `VALIDATION_SCAFFOLD_OPPORTUNITY`,
  never `GENUINE_I6_SELECTION_MISS`.
- **F2** candidate `test_A`, agent starts a runner on non-equivalent `test_B` →
  `GENUINE_I6_SELECTION_MISS`.
- **F3** exact or equivalent target selected → not a miss
  (`VALIDATION_TARGET_ALREADY_SELECTED`).
- **F4** broader validation → `VALIDATION_BROADER_SELECTION`, distinct from F2.
- **F5** raw 10 candidates truncated to 3 → old G2 `PASS` while raw count is 10.

## 12. Accounting obligation

The 14 union-level `I6_VALIDATION_SELECTION_MISS` specimens must be partitioned
exhaustively into genuine target-selection misses, scaffold opportunities,
credit-window-only cases, runner/instrument edge cases and other. The partition must
sum to 14. No specimen may disappear or be reclassified out of existence.

## 13. Out of scope

Runtime-grounded repair (M194's 7 runtime-diagnosis-usable arms across 5
repositories) is **not analysed**. I5 remains closed and is not reinterpreted. The
held-out corpus — 6 unrun M193 fixture instances across 6 repositories plus the
59-instance django-weighted reserve — is not scored, inspected for outcomes, or
touched.

## 14. Authorizations fixed in advance, regardless of result

```
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
```

`HELD_OUT_I6_SELECTION_REPLICATION_LICENSED` is granted only under §7's
`VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED`. A scaffold observation never
licenses an I6-selection replication; it would require its own preregistration,
evidence threshold, cost model and treatment experiment, and it inherits the M188
caution that extra lifecycle turns cost money and forced workflows can regress
resolution.

## 15. Spend

```
live-agent runs: 0
live model spend: $0
```
