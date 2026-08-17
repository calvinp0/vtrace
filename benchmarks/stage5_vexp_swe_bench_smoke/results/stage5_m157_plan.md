# M157 — Answer delivery and no-pivot recovery: plan and revision

## The question as issued

> VTRACE can retrieve task-relevant evidence, including gold-file evidence, yet
> deliver an empty Capsule because no candidate receives pivot/edit-target
> authority.

with three candidate explanations: (1) a role-classification defect, (2) a
delivery-policy defect, (3) an evidence ceiling.

## What the audit found, and how the plan changed

M157-A was run before any functional change (`stage5_m157_delivery_authority_audit.md`).
Three facts redirected the milestone:

1. **The collapse is query-global.** All 33 `django__django-11740` candidates had
   been granted support authority by the candidate-local role layer; none was
   denied. The gate at `buildCapsuleV2.ts:985` discards them without consulting
   them. So the apparent product rule in §15 is real and correctly located.

2. **The no-pivot state is rare: 2 of 100 broad cases.** Gold-fate
   classification over the whole corpus (independently reproducing every
   published M156 broad100 rate) puts 2 cases in the bucket a delivery-policy
   change could move, against 9 lost to the support *packing* cap and 11 never
   retrieved.

3. **The two no-pivot cases have opposite causes.** `sphinx-doc__sphinx-9320`
   holds seventeen candidates that MET the pivot bar and were demoted only by a
   budget that two later-disqualified candidates were still holding.
   `django__django-11740` holds no candidate with direct evidence of any kind,
   and its top 25 support candidates are a lexical explosion on the word
   `Errors`.

The consequence is that the hypothesis in §34 — "no trustworthy pivot but useful
support exists, therefore deliver bounded support-only context" — is populated by
**one** case in the available data, and that case does not need it: it needs its
pivots back. The other case is exactly where support-only delivery would emit
misleading context.

Per §12 (Django is an exposing case, not the specification), §40 (no numeric
rescue threshold), and §53 (do not force the milestone), the plan was revised to:

| workstream | as issued | as executed |
| ---------- | --------- | ----------- |
| A | delivery authority and no-pivot failure audit | unchanged |
| B | frozen no-pivot evidence corpus, 20–30 cases, 4+ repos | **ceiling reported**: the available data contains 2 no-pivot cases in 2 repositories out of 100 instances; a 20–30-case corpus cannot be built without manufacturing one |
| C | bounded non-pivot support semantics | **redirected** to the proven role-classification defect (hypothesis 1): release pivot slots vacated after the cap. Support-only delivery is NOT implemented — the evidence does not justify it |
| D | consumer / truthfulness integration | unchanged in intent; applies to the recovered-pivot and still-empty states |
| E | broad preservation and changed-case proof | unchanged |

## What is deliberately NOT done

- **No support-only delivery lane.** §52's precondition ("multiple unrelated
  calibration cases demonstrate useful support can be identified independently of
  pivot authority") is not met: there is one such case, and it is better served
  by the authority fix.
- **No support-budget change.** The `beyond standard support budget (max 4)`
  eviction costs 8 gold deliveries — four times the no-pivot gate — but it is a
  packing question, not an authority question. Recorded as the recommended next
  milestone.
- **No ranking, scoring, or candidate-generation change** (§41, §82, §83).
- **No Django-specific logic** (§12). The one functional change does not fire on
  `django__django-11740` at all, which is the correct outcome for an
  evidence-ceiling case.

## The functional change

The pivot cap is applied before two demotions that can invalidate the candidates
holding the slots (`buildCapsuleV2.ts` scoped-objective and non-source blocks),
and neither releases the slot. A candidate demoted purely by the budget is
therefore stranded behind a budget that is no longer spent.

The fix records the two states structurally — `budgetDemotedPivot` (priced out,
still pivot-worthy) and `pivotIneligible` (judged unfit, never promotable) — and
refills genuinely free slots from the first group in ranked order. It cannot
lower the pivot bar, invent an edit target, or promote a candidate any stage
judged unfit.
