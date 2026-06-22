# Stage 5 M65 Impact Representatives Optional Targeting

Offline implementation + retrospective replay. **No live agents, no Docker, no API spend,
no retrieval/scoring/ranking/candidate-generation changes.** All numbers are recomputed
from the committed M62C JSON and the captured M62C run artifacts
(`results/runs/m62c_structured_bounded_compact_*`); the replay re-classifies each target
with the unchanged `classifyDigestDecisionContract` and then re-partitions required-vs-optional
under the new rule.

## Summary

- **Rule implemented:** in `selectBoundedDigestDecisionTargets`, impact representatives are
  no longer promoted to required decision targets. Only pivots — the lead pivot and the
  hidden/non-traceback co-pivot the existing pivot logic surfaces — are required and
  closure-scored. Every cross-file impact representative is demoted to a bounded
  **optional/FYI** context list (O-namespaced ids, explicitly *not* closure-scored). Impact
  context stays visible; it just stops being a required EDIT/RULE_OUT/INSPECT_ONLY decision.
- **Files changed:** `src/capsuleV2/digestDecisionContract.ts` (selector + render + new
  `digestDecisionOptionalId`), its unit test, the bounded-flag help text and the optional
  parser in the Stage 5 runner/analyzer, plus a new offline replay script and this report.
- **Default behavior changed:** **No.** The change is confined to the bounded path
  (`--bounded-digest-decisions`). The default (non-bounded) M57 contract and the M57
  `selectDigestDecisionTargets` selector are byte-unchanged. M63 digest-header compaction
  and the strict four-sentinel validity are untouched.
- **Whether live/Docker ran:** **No.** Offline only.
- **Retrospective result:** the M62C replay reproduces M64's simulation **exactly** —
  coverage **88.7% → 93.6%**, ignored **5.6% → 4.3%**, invalid rule-out **4.2% → 0.0%**.
  Required-target count drops 71 → 47; impact representatives were edited **0/24** and
  closure-scored **0** times under the new rule. Both previously-failed criteria now pass.
- **Recommendation:** **proceed to a small live confirmation.** The rule is narrow,
  deterministic, clears both criteria, harms no treatment-only win, and reduces over-edit
  pressure. A small live run should confirm the structured-decision metrics on fresh agents
  and re-check the one uncertain resolution flip (seaborn-3187) before any larger repeat.

## M64 Diagnosis Recap

- **Why impact representatives were demoted.** M62C was MIXED: it passed cost (−27.8% pooled)
  and resolution-parity (15 = 15) but **failed** two preregistered structured-decision
  criteria — decision coverage ≥90% (it landed at 88.7%) and ignored-required-target rate
  ≤5% (5.6%). M64 traced both misses to one deterministic selector behavior: the M58 bounded
  selector force-required the **first cross-file impact representative** unconditionally
  (`requiredImpact === 0`), with no actionability/role/test-file filter.
- **Evidence from M62C.** The decisive invariant: **required impact representatives were
  EDITED 0 times across all 24 runs.** They closed as RULED_OUT/INSPECT_ONLY/IGNORED/INVALID,
  never as edits. Yet they produced **5 of the 8** open/problem required targets
  (astropy-14539 `printdiff` + `test_core`, flask-5014 `test_async`, sympy-12481
  `generators`, django-11740 `layer`). Several were **test files** the selector promoted to
  "cross-file co-edit candidate" required status. Requiring them added zero resolution value
  while inflating the open/ignored/invalid counts that failed the criteria.
- **Why this is not case tuning.** The rule keys on **target type** (PIVOT vs IMPACT), not on
  any instance id. It is backed by an invariant (impact-edited = 0/24) plus four independent
  cases across four repos, and the M64 simulation showed it is the *only* candidate that
  clears both failed criteria (demoting only test-file impact reps still failed c3 at 6.3%).
  django-11740 is explicitly **not** chased: its two remaining open pivots are a
  retrieval-localization miss (GIS pivots, migrations fix), out of scope here.

## Implementation

- **Selector change** (`selectBoundedDigestDecisionTargets`): the impact-representative loop
  no longer promotes anything to required. Lead pivot and the hidden/non-traceback co-pivot
  are pushed to `required` exactly as before; every cross-file, deduped impact representative
  is appended to `optional` (bounded to `MAX_OPTIONAL_CONTEXT_ITEMS = 2`) with
  `requiredReason: "optional context only"`. The previous `requiredImpact`/`role === "dependent"`
  promotion logic is removed. No pivot-selection, retrieval, or impact-graph code is touched.
- **Rendering change** (`renderBoundedDigestDecisionContractText`): the optional section is
  retitled **"Optional context / FYI impact references (NOT required decision targets; NOT
  closure-scored; do not edit unless the fix needs it):"**, each bullet is O-namespaced
  (`- O1: IMPACT …`, `- O2: …`), and the section closes with the explicit line
  **"These are not required decision targets and are not closure-scored."** The required
  decision grammar (`target_id` / `target` / `decision` / `reason` / `files_touched`) is
  unchanged and now applies only to pivots.
- **Classifier / scoring change:** **none in the classifier itself.** Closure scoring is
  driven by the `requiredTargets` handed to `classifyDigestDecisionContract`; because the
  selector no longer emits impact reps as required, they are structurally excluded from
  required-target closure — they can never count as closed/open/ignored/invalid.
- **Optional/FYI context behavior:** impact reps remain fully visible for orientation, with a
  one-line reason, under the distinct O-id namespace. They are never given a `target_id` the
  parser/classifier expects to close.
- **target_id stability:** required ids stay `T1..Tn` in order, derived from the (now
  pivot-only) required list; optional ids are `O1..Om` and are disjoint from the T-namespace,
  so a required and an optional id can never collide. The required-target parser
  (`parseDigestDecisionContract`, matching only `\d+.`/`target:` lines) never reads an
  `- O1:` bullet as a target.

## Retrospective M62C Replay

Recomputed by `run_stage5_m65_impact_reps_replay.ts` over the 24 captured M62C runs: each
target's decision is re-derived with the unchanged classifier (decisions are independent of
which targets are "required"), then accounted **before** (all PIVOT + IMPACT required, the
M62C rule) vs **after** (only PIVOT required; IMPACT demoted to optional, not closure-scored).

| metric | before | after | delta |
|---|---|---|---|
| required target count | 71 | 47 | −24 |
| closed targets | 63 | 44 | −19 |
| open targets | 8 | 3 | −5 |
| ignored targets | 4 | 2 | −2 |
| invalid rule-outs | 3 | 0 | −3 |
| coverage | 88.7% | **93.6%** | +4.9pp |
| ignored rate | 5.6% | **4.3%** | −1.3pp |
| invalid rate | 4.2% | **0.0%** | −4.2pp |

- **Criteria after the rule:** coverage 93.6% ≥ 90% ✅; ignored 4.3% ≤ 5% ✅; invalid 0.0%
  (not worse) ✅. Both previously-failed criteria now pass.
- **Reconciliation:** before, 71 required = 63 closed + 8 open; open(8) = ignored(4) +
  invalid(3) + inspected-only(1). Demotion removes the 24 impact reps (19 closed + 5 open:
  2 ignored + 3 invalid) from the required set, leaving 47 = 44 closed + 3 open; open(3) =
  ignored(2) + inspected-only(1). Exactly matches the M64 simulation
  (coverage 93.6%, ignored 4.3%, invalid 0.0%).
- **Impact reps closure-scored after the rule: 0** (all 24 demoted; impact-edited = 0/24).
- **Off-target accounting:** unchanged in substance — the agents' edits are identical;
  the only change is that impact reps are no longer counted as required targets the agent
  "ignored". No resolved case becomes less explainable: the 15 resolved cases edited the same
  files; for the resolved cases the required (pivot) targets that explain the fix are retained.

### Targets remaining open after the rule (all PIVOT — untouched by demotion)

| instance | target | status | note |
|---|---|---|---|
| django-11740 | gis/gdal/feature.py::Feature | IGNORED | retrieval mislocalization (GIS pivot; fix in migrations) — out of scope |
| django-11740 | gis/gdal/feature.py::Feature.fid | IGNORED | same mislocalization |
| sympy-12419 | functions/elementary/piecewise.py::Piecewise._sort_expr_cond | INSPECTED_ONLY | minor classifier-strictness nuance; agent inspected, no bounded keyword |

These three are exactly the residual M64 identified; no rule should chase them (the django
pair is a retrieval-localization data point, the sympy one a one-target classifier nuance).

## Demoted Targets

All 24 impact representatives were demoted from required to optional/FYI. **None was edited
in any patch** (impact-edited = 0/24), confirming demotion removes only non-load-bearing
required pressure. The five that were *open/problem* targets pre-M65 (the criteria drivers)
are highlighted; the rest were already closed and simply move to optional.

| instance_id | target | target_type | original_status (M62C) | new_status | reason for demotion |
|---|---|---|---|---|---|
| astropy-14539 | io/fits/convenience.py::printdiff | IMPACT | INVALID_RULE_OUT | optional/FYI | caller/wrapper; never edited; thin rule-out inflated invalid rate |
| astropy-14539 | io/fits/tests/test_core.py::…bytes_object | IMPACT (**test**) | INVALID_RULE_OUT | optional/FYI | a test file, never a patch site |
| pallets-flask-5014 | tests/test_async.py::_async_app | IMPACT (**test**) | INVALID_RULE_OUT | optional/FYI | a test file, never a patch site |
| sympy-12481 | combinatorics/generators.py::alternating | IMPACT | IGNORED | optional/FYI | helper/generator; not a fix site |
| django-11740 | contrib/gis/gdal/layer.py::Layer | IMPACT | IGNORED | optional/FYI | non-actionable; never edited |
| django-11820 | contrib/admin/checks.py::_check_inlines_item | IMPACT | RULED_OUT | optional/FYI | dependent caller; never edited |
| matplotlib-24627 | tests/test_agg.py::test_jpeg_dpi | IMPACT (**test**) | INSPECT_ONLY_NO_EDIT | optional/FYI | test file in the lone t-only win; never edited |
| sphinx-7462 | tests/test_domain_py.py::test_parse_annotation | IMPACT (**test**) | INSPECT_ONLY_NO_EDIT | optional/FYI | test file; never edited |
| (16 more) | … | IMPACT | RULED_OUT / INSPECT_ONLY_NO_EDIT | optional/FYI | all already-closed, never edited |

Full per-target detail (all 24) is in the replay JSON's `demoted` array.

## Treatment-Win Safety Check

The only treatment-only win in M62C is **matplotlib-24627** (treatment resolved, baseline not).

- **Did any demoted impact rep correspond to an edited/resolution-critical file?** **No.** Its
  edits were `lib/matplotlib/axes/_base.py` + `lib/matplotlib/figure.py` (both PIVOT-region);
  its single impact rep was `lib/matplotlib/tests/test_agg.py::test_jpeg_dpi`, a **test file**
  that was never edited. After demotion the win is explained entirely by its two required
  pivots (now `required_pivots_after = 2`).
- **Does the treatment-only explanation remain intact?** **Yes** — `explanation_intact: true`.
  No demoted impact rep was edited in any of the 24 runs, so demotion cannot remove an edited
  required target from any win. No resolved case loses an edited required target.

## Tests

Pure offline unit/assembly tests — no agents, no Docker.

- **Updated** (`src/capsuleV2/digestDecisionContract.test.ts`): the three M58 tests that
  asserted an impact rep is required (`only ONE impact rep is required`, `a second impact rep
  IS required`, `optional impact reps are NOT parsed as required`) were rewritten as M65 tests
  — impact reps are now always optional. The M59 `bounded mode renders the structured
  target_id grammar` test was updated to use a hidden co-pivot for `T2` and to assert the
  impact rep renders as `- O1:` optional context, not a required `target:` line. These updates
  are deliberate: the milestone changes exactly this behavior.
- **Added** M65 tests covering the required behaviors: (1) no impact rep is required —
  callers demoted to optional; (2) dependents are also optional; (3) lead + hidden pivots
  remain required while impacts are optional; (4) optional/FYI section renders with the
  explicit not-closure-scored line; (5) optional ids are O-namespaced and disjoint from
  required T-ids; (6) the classifier never closure-scores optional/FYI rows (an untouched
  impact rep never surfaces as IGNORED); (7) an M62C-style ignored impact rep no longer counts
  against coverage/ignored.
- **Unchanged-on-purpose:** the M57 (non-bounded) selector/render tests, the M61 truncation
  fail-closed tests, and the M63 digest-header compaction tests — verifying default behavior,
  strict sentinel validity, and compaction are all preserved.
- **Verification:** `digestDecisionContract.test.ts` 43 pass / 0 fail;
  `digest_decision_contract_injection.test.ts` 13 pass / 0 fail. Full-suite, typecheck, and
  benchmark-typecheck results in the commit.

## Recommendation

**Proceed to a small live confirmation.**

All recommendation gates are met in the retrospective replay: coverage 93.6% ≥ 90%, ignored
4.3% ≤ 5%, invalid rate does not worsen (4.2% → 0.0%), no treatment-only win loses an edited
required target, and strict sentinel validity is unchanged. The rule is deterministic and the
replay matches the M64 simulation byte-for-byte on the headline metrics.

A small live confirmation (rather than an immediate 24-task repeat) is the responsible next
step because: (a) the criteria fixes are deterministic and already proven offline, so a full
repeat is not needed to validate *them*; (b) the one genuinely uncertain item is a
**resolution** flip (seaborn-3187, T,T,T,F across runs) that only a live run can settle; and
(c) a few fresh agents under the new optional/FYI render will confirm the structured-decision
metrics hold on unseen traces before committing to a larger sweep. Do not promote the
treatment to default and do not relax the classifier.

## Non-Claims

- Does not claim VTRACE beats VEXP or improves SWE-bench pass@1; makes no statistical
  superiority claim.
- Does not change retrieval, ranking, candidate generation, impact-graph retrieval, or the
  M63 digest-header compaction.
- The replay is a recomputation over the frozen M62C artifacts, not a new run; resolution is
  unaffected by the rule (impact reps were never edited).
