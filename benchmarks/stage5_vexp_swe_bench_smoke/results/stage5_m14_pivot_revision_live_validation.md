# Stage 5 — M14.1 Pivot Revision Pass: Live Validation

Live validation of the M14 corrective pivot-revision pass (`--pivot-revision-pass`,
gated behind `--pivot-inspection-enforcement`) on the two target cases plus a
compliant control. All runs were real `claude-code` agents under the external
`vexp-swe-bench` harness, evaluated with real SWE-bench Docker.

- Date: 2026-06-16
- Scaffold under test: commit `23e85ab` (M14)
- Conditions: `eval-m14-pivot-revision-current-{sphinx-7462,seaborn-3187}-r{1,2,3}`
  plus control `eval-m14-pivot-revision-current-django-13195-r1`
- Baseline for comparison (A): `eval-m12-pivot-enforcement-current-*` (existing)
- Flags: `--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting
  --disable-pivot-check --pivot-inspection-enforcement --pivot-revision-pass`

---

## 1. Executive verdict

**`pivot_revision_live_partial`.**

The revision pass is mechanically validated end-to-end and is **safe**: it triggers
on exactly the right runs, spawns a real second agent without touching external
harness internals, writes well-formed artifacts, never mutates any canonical
first-pass artifact, and — by design — never replaced a final patch. **Zero harm**
was observed, including on already-resolved seaborn runs where it fired
unnecessarily.

However, it **did not change patch behavior in any run**: the second pass produced
an **empty patch in all 6 triggering runs**, so no revised patch was ever produced
and no shadow resolution effect could be measured. The reason is informative and
actionable, not a plumbing failure:

- **sphinx-7462** — `sphinx/pycode/ast.py::unparse` is **genuinely required** (it is
  in the gold patch; the failing test `test_pycode_ast.py::test_unparse[()-()]`
  exercises it). The revision agent **inspected it and wrongly ruled it out** in
  prose ("`", ".join([])` is empty-safe"), missing that the test requires the
  *output* `"()"`, not merely "no crash". The rule-out was plausible but wrong, so
  it emitted no edit. The prompt did not give it the failing-test expectation.
- **seaborn-3187** — `seaborn/relational.py::scatterplot` is **not** in the gold
  patch. The trigger is a **false positive** (contract over-inclusion); the agent
  correctly produced no edit. Harmless, but wasted a second pass.

**Conclusion on wiring into canonical evaluation:** not yet justified. Because no
revised patch was non-empty, there is nothing whose resolution gain would warrant
swapping it into canonical results. The next step is to make the second pass
actually produce correct revised patches (better prompt/excerpts) and to tighten
the trigger — not to wire replacement.

---

## 2. Run validity

| label | run exit | docker eval | valid |
|---|---|---|---|
| sphinx-7462-r1 | 0 | ran (resolved=0) | ✅ |
| sphinx-7462-r2 | 0 | ran (resolved=0) | ✅ |
| sphinx-7462-r3 | 0 | ran (resolved=0) | ✅ |
| seaborn-3187-r1 | 0 | ran (resolved=1) | ✅ |
| seaborn-3187-r2 | 0 | ran (resolved=0) | ✅ |
| seaborn-3187-r3 | 0 | ran (resolved=1) | ✅ |
| django-13195-r1 (control) | 0 | ran (resolved=0) | ✅ |

- 6/6 target runs valid; 3/3 each for sphinx and seaborn. No infra failures, no
  aborts, no missing JSONL, no missing model patch. No retries needed.
- Docker health: healthy (Docker 29.5.2). Every `evaluate` returned
  `evaluationRan=true, dockerUsed=true, evaluationError=null`.
- Auth: agent ran via the `claude` CLI credentials (subscription), same mechanism
  as the M12 baseline.

---

## 3. Artifact validation

All 7 runs passed the full criteria set (`_run.meta.json`):

```
effectiveCapsuleEngine = v2          ✅ (all 7)
fallbackReason         = null        ✅ (all 7)
context injected       = yes         ✅ (all 7)
ordered telemetry      = present     ✅ (all 7)
legacy PIVOT_CHECK     = absent      ✅ (all 7)  (disabled by --disable-pivot-check)
legacy EDIT_GUARD      = absent      ✅ (all 7)
legacy PATCH_VERIFY    = absent      ✅ (all 7)
pivot inspection enforcement = active ✅ (complianceBefore.enabled=true)
pivot revision pass enabled  = yes    ✅ (second pass observed / decision recorded)
exitCode               = 0           ✅ (all 7)
```

Revision artifacts (in each triggering run's `raw/vtrace/`):

| artifact | sphinx r1-3 | seaborn r1-3 | django r1 |
|---|---|---|---|
| `_pivot_revision.json` | ✅ | ✅ | ✅ (`ran=false`) |
| `_pivot_revision_original.patch` | ✅ | ✅ | n/a (not triggered) |
| `_pivot_revision_prompt.md` | ✅ | ✅ | n/a |
| `_pivot_revision_response.txt` | ✅ | ✅ | n/a |
| `_pivot_revision_revised.patch` | **absent (revised empty)** | **absent (revised empty)** | n/a |

`_pivot_revision_revised.patch` is intentionally not written when the second pass
returns an empty diff. The second pass also writes its own
`raw/vtrace_pivot_revision/swebench-*.jsonl`, kept **separate** from the canonical
`raw/vtrace/swebench-*.jsonl` — canonical first-pass artifacts are never mutated.

Per-run revision record:

| label | ran | decisionReason | required candidate | before (unclear/missing) | revisedPatch | replacedFinalPatch | after == before |
|---|---|---|---|---|---|---|---|
| sphinx r1 | true | 1 missing/unclear | ast.py::unparse | unclear | null (empty) | false | yes |
| sphinx r2 | true | 1 missing/unclear | ast.py::unparse | unclear | null (empty) | false | yes |
| sphinx r3 | true | 1 missing/unclear | ast.py::unparse | unclear | null (empty) | false | yes |
| seaborn r1 | true | 1 missing/unclear | relational.py::scatterplot | unclear | null (empty) | false | yes |
| seaborn r2 | true | 1 missing/unclear | relational.py::scatterplot | unclear | null (empty) | false | yes |
| seaborn r3 | true | 1 missing/unclear | relational.py::scatterplot | unclear | null (empty) | false | yes |
| django r1 | **false** | **patch already compliant** | (all 3 edited) | — / — | — | false | n/a |

---

## 4. Shadow evaluation method

**Option C — no shadow evaluation performed, and none is meaningful here.**

The intended method was Option B (build a shadow `swebench-*.jsonl` whose
`modelPatch` is `_pivot_revision_revised.patch`, then run the external evaluator on
the shadow file without touching canonical artifacts). A helper for this was
prepared. **It was not exercised because no revised patch was ever non-empty** —
the second pass returned an empty diff in all 6 triggering runs, so the "revised"
patch is byte-identical to "no patch," which differs from the canonical first-pass
and would only ever evaluate worse or equal. There is nothing whose resolution gain
is worth measuring.

We therefore do **not** claim any shadow resolution effect. The only resolution
numbers reported are the **canonical first-pass** Docker results (Section 5), which
under this scaffold equal the M14 condition's own outcomes (revision never replaced
the final patch).

---

## 5. Per-case comparison

| instance | run label | revision ran? | original patch files | revised patch files | revised differs? | canonical first-pass resolved | shadow revised resolved |
|---|---|---|---|---|---|---|---|
| sphinx-7462 | m14 r1 | yes | python.py | (empty) | no | 0 | n/a |
| sphinx-7462 | m14 r2 | yes | python.py | (empty) | no | 0 | n/a |
| sphinx-7462 | m14 r3 | yes | python.py | (empty) | no | 0 | n/a |
| seaborn-3187 | m14 r1 | yes | _core/scales.py, utils.py | (empty) | no | 1 | n/a |
| seaborn-3187 | m14 r2 | yes | _core/scales.py, utils.py | (empty) | no | 0 | n/a |
| seaborn-3187 | m14 r3 | yes | _core/scales.py, utils.py | (empty) | no | 1 | n/a |
| django-13195 | m14 r1 (control) | no (compliant) | response.py, sessions/middleware.py, messages/storage/cookie.py | — | — | 0 | n/a |

Condition A (M12 first-pass) vs B (M14 run), resolved over r1/r2/r3:

| case | A: M12 | B: M14 |
|---|---|---|
| sphinx-7462 | 0 / 0 / 0 | 0 / 0 / 0 |
| seaborn-3187 | 0 / 0 / 1 (1/3) | 1 / 0 / 1 (2/3) |
| django-13195 | 0 / 0 / 0 | 0 (1 run) |

The seaborn A-vs-B difference (1/3 → 2/3) is **first-pass agent stochasticity, not
the revision pass**: the revision produced empty patches and never replaced the
canonical patch in any run, so the M14 condition's resolved count is exactly its own
first-pass count. The revision pass contributed **no** resolution delta.

Per-run classification (task taxonomy):

| label | classification |
|---|---|
| sphinx r1/r2/r3 | `revision_artifact_success` + `revision_no_effect` (missed: should have edited ast.py::unparse) |
| seaborn r1/r2/r3 | `revision_artifact_success` + `revision_no_effect` (false trigger; harmless; r1/r3 preserve resolution) |
| django r1 | compliant control — revision correctly did not trigger |

No run was `revision_harm`. No run reached `revision_behavior_success` or
`revision_shadow_resolution_success`.

---

## 6. Behavior analysis

- **Did the revision pass address missing/unclear candidates?** It *triggered* on
  every genuinely-unclear candidate (sphinx ast.py::unparse; seaborn scatterplot)
  and the agent *engaged* with them (inspected, reasoned), but in no case did it
  emit an edit or a machine-readable resolution, so `complianceAfter == complianceBefore`
  in all 6 runs.
- **Did it add the non-lead pivot when appropriate?** No. For sphinx, where the
  non-lead pivot was genuinely required, the agent **wrongly ruled it out** (treated
  "won't raise IndexError" as sufficient, missing the required `"()"` output). The
  revision prompt did not include the failing-test expectation, so the agent had no
  signal that its rule-out was wrong.
- **Did it avoid over-editing?** Yes, completely. For seaborn (false trigger) and
  for sphinx (wrong rule-out), the second pass produced an empty diff and
  `decideReplacement` kept the original. The control (django) shows the trigger
  itself is correctly suppressed when the first pass is compliant.
- **Did it preserve minimal-diff behavior?** Yes. No run's submitted patch grew. The
  two resolved seaborn runs stayed resolved; the conservative replacement gate means
  a false trigger cannot worsen an already-good patch.

Net: the **trigger and safety machinery are correct**; the **value-add (correct
revised patches) is blocked by an under-informed revision prompt and an
over-inclusive contract trigger**.

---

## 7. Next recommendation

**C — improve the revision prompt / source excerpts before more live runs.**

Concretely, two prompt/contract fixes are indicated by this validation:

1. **Feed the failing-test expectation into the revision prompt** (sphinx failure
   mode). The agent ruled out `ast.py::unparse` because the prompt asked only
   "is this file safe?" Including the FAIL_TO_PASS test name and its expected output
   (`test_unparse[()-()]` ⇒ `"()"`) would have shown the rule-out was wrong and
   prompted the correct ast.py edit.
2. **Tighten trigger precision** (seaborn false-positive). Emit a first-pass
   `PIVOT_DECISION:` marker (Option C, already parsed by the glue) so a non-lead
   pivot the first pass legitimately decided not to edit (scatterplot) is recorded
   as `ruled_out` rather than `unclear`, suppressing the unnecessary second pass.

Secondary (B), deferred until C lands: once the second pass produces non-empty
revised patches, add the shadow-evaluate-revised-patch path (Option B helper) to
measure resolution before any canonical wiring. Do **not** wire replacement into
canonical evaluation yet.

Not recommended: 30/100-case runs; making the revision pass default; any change to
scoring, candidate generation, retrieval, or Capsule v2 ranking.

---

## Appendix — cost (revision-pass overhead)

`costUsd` from each run's canonical row (first pass) and the second-pass section of
the run log (revision). Revision cost is pure overhead here, since output was empty.

| label | first-pass $ | first-pass turns | revision $ (overhead) |
|---|---|---|---|
| sphinx r1 | 0.418 | 21 | 0.177 |
| sphinx r2 | 0.376 | 29 | 0.071 |
| sphinx r3 | 0.240 | 18 | 0.260 |
| seaborn r1 | 1.021 | 54 | 0.268 |
| seaborn r2 | 1.266 | 71 | 0.267 |
| seaborn r3 | 0.566 | 34 | 0.287 |
| django r1 | 0.382 | 21 | 0 (not triggered) |

Revision overhead ≈ \$0.07–0.29 per triggering run (one short extra agent turn),
currently with no benefit because output is empty. The control incurs zero revision
overhead.
