# M143 Workstream B — checkpoint report

> This is a **Workstream B checkpoint report**, not the final M143 completion
> report. The overall M143 verdict, the final paired benchmark and full
> preservation are deliberately left to the next session (§97).

**Predecessor** `93a34d194b2360094d61b27f2ecc12f6dccacdb3` (M143-A functional)
**Candidate** M143-B — evidence, tests and audit only; **no functional change**
**Verdict** **NOT PASS — measured deterministic capability ceiling**

---

## 1. Dependency on Workstream A (§89)

```
M143-A established:
  title identity can nominate relevance
  title-local signals cannot safely distinguish
  titled bystander vs behaviour owner

M143-B tested whether repository structural evidence
can provide that missing distinction
```

It cannot, for the class of case that matters. The reason is not an indexing
gap — it is that the relationship B needed to read **does not exist in the
source**.

## 2. What was measured

| artifact | what it holds |
|---|---|
| `stage5_m143_title_ownership_matrix.json` | the five title cases: directed relations, family support at two pool widths, path role, objectives |
| `stage5_m143_behavior_owner_generic_controls.json` | six generic controls on real indexes |
| `stage5_m143_gaussian_behavior_owner.json` | adapter vs parser on the exact recorded ARC query |
| `stage5_m143_behavior_owner_trace.json` | per-candidate evidence → decision |
| `stage5_m143_behavior_owner_performance.json` | probe cost |
| `stage5_m143_b_checkpoint_paired.json` | the paired checkpoint (an identity, proven) |
| `stage5_m143_b_changed_case_ledger.json` | changed cases (none) and carried defects |
| `stage5_m143_behavior_ownership_audit.md` | the full evidence audit |

## 3. Result per required case

| case | ownership result | lead before → after |
|---|---|---|
| `django-11740` | **subject**, but unprovably so — zero relations to the owner | unchanged (defect open) |
| `django-13112` | ambiguous → abstain | unchanged ✅ |
| `sympy-16766` | ambiguous → abstain | unchanged ✅ |
| `django-11133` | ambiguous → abstain | unchanged ✅ |
| `django-12276` | ambiguous → abstain | unchanged ✅ |
| Gaussian (ARC) | override surface recovered; query vocabulary does not reach it → abstain | unchanged |

Every control is preserved because nothing fires. That is the intended shape of
a ceiling result, not a coincidence: the abstention rule is *never demote on
ignorance*, and ignorance is what B measured.

## 4. Why no mechanism shipped

Three candidate discriminators were measured and each was rejected on evidence:

1. **Directed relation to the behaviour owner** (§15's hypothesis). Refuted:
   `django-11740` has **no edge in either direction** between
   `autodetector.py` and `related.py`; `ForeignKey`'s 193 in-edges include none
   from the autodetector. Generic implementations do not name their subjects.
2. **Title-family retrieval support.** Looked categorical at pool 400; the
   apparent zero was a pool-floor artifact (floor 0.660 > two other cases'
   support scores). At depth it is a continuum — 0.504 / 0.638 / 0.694 —
   separable only by a constant fitted between `django-11740` and `sympy-16766`,
   which §35 forbids.
3. **Interface-override ownership.** Real and generic — it separates
   `GaussianAdapter` (`write_input_file`) from `GaussianParser` (`parse_*`) and
   switches correctly by requested action on generic fixtures. But it activates
   on **zero of the seven real candidates measured** (five title candidates plus
   the two ARC Gaussian classes), because request vocabulary ("emit route
   keywords") never meets implementation vocabulary (`write_input_file`).
   Closing that gap needs a synonym lexicon — the weak heuristic §55 forbids.

Shipping (3) would have added a lane whose only wins are the fixtures written to
demonstrate it, and shipping (2) would have traded a known one-case defect
against M143-A's measured **4 correct : 1 wrong** promotion population.

## 5. Checkpoint (§86)

The paired comparison `93a34d1 → M143-B` is an **identity**, and is proven
rather than asserted: `git diff --name-only 93a34d1 -- src/` yields **zero**
non-test sources. A Frozen-50 run would report zero diffs on every metric by
construction and would be evidence of nothing.

Metrics therefore stand as M143-A measured them against the M142 final
(`41fb0a9 → 93a34d1`, provenance-valid):

| metric | value |
|---|---|
| Top-1 | 38 |
| Top-3 | 44 |
| gold anywhere | 48 |
| gold symbol anywhere | 31 |
| missing | 2 |
| mean tokens | 1835.20 |
| `selectedFiles` / `lead` / `roles` / `contentModes` diffs | 0 / 0 / 0 / 0 |

**Changed gold cases: none. Improvements: none. Regressions: none. Unexplained
changes: none.**

## 6. Performance (§85)

The override-evidence probe costs **3 graph queries per candidate + 1 per base**
and **0 source reads**. The five-case relation audit cost **4 graph queries** and
~300 relations inspected per case, with **0 source reads**, over bounded
families (largest 34 symbols). No transitive traversal, no repository scan.

Nothing is on the product path, so there is no product latency to report.

## 7. Preserved

`django-11815`, round-robin owner allocation, `<module>` delivery invisibility,
objective role typing, M137 `get_dihedral`, M140 orchestration, M141 readiness,
M142 D/E and the M143-A truthfulness invariant are all untouched — B changed no
product code. The full suite is green.

## 8. Remaining capability ceiling

```
Interface-implementation ownership   tractable, inert on real query vocabulary
Subject-vs-implementation ownership  NO REPOSITORY EVIDENCE EXISTS
```

The second is the one `django-11740` needs. It is not closable by a schema
change: an `inherits` edge type would sharpen the first class and leave the
second untouched, because the source contains no `autodetector → ForeignKey`
fact to index.

## 9. Recommended next action

`django-11740` should be carried as a known, root-caused ceiling rather than
re-attacked. Two honest options remain, and neither is a retrieval change:

1. **Accept it.** One wrong promotion against four correct ones, with the cause
   documented. The title lane stays as M143-A left it.
2. **Change the question, not the score.** Every mechanism B rejected failed
   because it tried to decide ownership from *static* structure. The evidence
   that actually separates a subject from an edit site in `django-11740` is
   behavioural — which file the failing test exercises — and that is a different
   kind of input than the index holds today. Reaching for it is a milestone in
   its own right, not a patch to the title lane.

Per §79, A's closed avenues (`TITLE_SYMBOL_FINAL`, `evidenceTier`, centrality
thresholds, IDF title weighting) stay closed regardless.
