# Stage 5 — M15.1 live validation of the improved pivot revision prompt

Tiny live validation (n=2 per case, real agents + Docker) of the M15 improvements to the
opt-in pivot revision path (`--pivot-inspection-enforcement --pivot-revision-pass`). M15
added: first-pass assistant-text persistence, machine-readable first-pass `PIVOT_DECISION`
markers (requested + parsed), marker-based suppression of false triggers, FAIL_TO_PASS/test
expectation context in the revision prompt, bounded source excerpts, and minimal-diff
guardrails. Predecessor: M14.1 (`stage5_m14_pivot_revision_live_validation.md`), where every
revised patch came back empty because the second pass was under-informed.

Cases: `sphinx-doc__sphinx-7462`, `mwaskom__seaborn-3187`. Conditions:
`--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting
--disable-pivot-check --pivot-inspection-enforcement --pivot-revision-pass`
(legacy PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY all off — confirmed in artifacts).

## 1. Executive verdict

**`m15_revision_live_partial`** — a useful non-empty sphinx revision exists; seaborn
false-trigger suppression works; but rule-out suppression can incorrectly suppress a true
required pivot when it conflicts with the test expectation.

M15.1 now demonstrates **both sides of marker suppression**:

1. **seaborn r2** — a grounded `PIVOT_DECISION` `RULED_OUT` **correctly suppresses a false
   trigger** for the non-gold `scatterplot` pivot.
2. **sphinx r1** — a grounded `PIVOT_DECISION` `RULED_OUT` **incorrectly suppresses a true
   trigger** for the gold-required `ast.py::unparse` pivot.

Therefore marker suppression is useful, but it needs a **test-expectation conflict
guardrail**.

Supporting the verdict:

- **sphinx improved decisively.** Where M14 always produced an empty revised patch, M15's
  revision pass (armed with the FAIL_TO_PASS test `test_unparse[()-()]`) produced a
  **non-empty revised patch that adds `sphinx/pycode/ast.py::unparse`** — and the added hunk
  is **the canonical gold fix** (empty `ast.Tuple` now returns `"()"` instead of `""`).
  This is the exact M14→M15 behavior change the prompt work targeted (sphinx r2).
- **No over-edit.** When the trigger fired on the non-gold seaborn pivot (r3), the second
  pass returned a patch byte-identical to the original (no scatterplot edit) and emitted a
  correct rule-out. Minimal-diff guardrail held; the canonical resolved=True patch preserved.

No revised patch was wired into canonical evaluation, and no shadow evaluation was run.
**No shadow resolution effect claimed.**

## 2. Run validity

| label | run-protocol | docker eval | valid? | note |
|---|---|---|---|---|
| eval-m15-pivot-revision-current-sphinx-7462-r1 | ✅ exit0 | ✅ exit0 | ✅ | 24 turns, $0.428 |
| eval-m15-pivot-revision-current-sphinx-7462-r2 | ✅ exit0 | ✅ exit0 | ✅ | 24 turns, $0.341 |
| eval-m15-pivot-revision-current-seaborn-3187-r1 | ✅ exit0 | ✅ exit0 | ✅ | 99 turns, $3.016 (hit $3 cap) |
| eval-m15-pivot-revision-current-seaborn-3187-r2 | ✅ exit0 | ✅ exit0 | ✅ | 66 turns, $1.004 — same label re-run after a transient quota limit on the first attempt¹ |
| eval-m15-pivot-revision-current-seaborn-3187-r3 | ✅ exit0 | ✅ exit0 | ✅ | 48 turns, $0.994 — bonus 3rd run |

¹ seaborn r2's first attempt hit a transient session/quota limit (HTTP 429, agent never
spawned, no JSONL). Once credits reset the **same r2 label was re-run** and is a valid run;
quota failures are not counted as unresolved. (r3, started as a replacement before the reset,
is retained as a third seaborn data point.)

- Docker health: all valid runs evaluated cleanly. No Docker infra errors.
- Valid labels now used: **sphinx r1, sphinx r2, seaborn r1, seaborn r2, seaborn r3**
  (≥2 valid per case).
- Baseline not run; 30/100 not run (per constraints).

## 3. Artifact validation

Per-run treatment integrity (all valid runs identical):

| check | result |
|---|---|
| effectiveCapsuleEngine | **v2** |
| capsuleEngineFallbackReason | **null** |
| context injected | **yes** |
| ordered telemetry / tool calls | present (`_tool_calls.json`, `_tool_calls.summary.json`) |
| legacy PIVOT_CHECK | **absent** (`vtracePivotCheckInjected=false`, `disabledByFlag=true`) |
| legacy EDIT_GUARD | **absent** (`vtraceEditGuardInjected=false`, `textPresent=false`) |
| legacy PATCH_VERIFY | **absent** (`vtracePatchVerifyInjected=false`, `textPresent=false`) |
| pivot inspection enforcement | **present** (behaviorally confirmed: sphinx r1 and seaborn r2 emitted well-formed `PIVOT_DECISION` markers, which only happens when the M12 enforcement block is injected) |
| pivot revision pass | **enabled** (revision record present every run; `ran=true` on sphinx r2 + seaborn r3) |

M15-specific artifacts:

| M15 artifact | result |
|---|---|
| `_pivot_first_pass_assistant.txt` | **present in every valid run** (feature #1 working) |
| first-pass `PIVOT_DECISION` markers requested + parsed | yes — sphinx r1 and seaborn r2 each produced one grounded marker |
| `firstPassPivotDecisions` recorded in `_pivot_revision.json` | yes (sphinx r1: 1; seaborn r2: 1; others: 0) |
| `testExpectation` recorded | yes — `source=instance_metadata`, 2 FAIL_TO_PASS in **every** run |
| revision prompt includes FAIL_TO_PASS/test expectation | yes — sphinx r2 prompt has a `## Test expectation` block listing `test_parse_annotation` + `test_unparse[()-()]` |
| revision prompt includes bounded source excerpts | yes ("Source excerpts for the outstanding candidates:") |
| revision prompt includes minimal-diff / anti-over-edit guardrails | yes ("Prefer the minimal diff", "Return a non-empty unified diff only if source/test evidence requires a change", PIVOT_DECISION rule-out guidance) |

Per-run revision record summary:

| field | sphinx r1 | sphinx r2 | seaborn r1 | seaborn r2 | seaborn r3 |
|---|---|---|---|---|---|
| ran | false | **true** | false | false | **true** |
| decisionReason | already compliant | 1 missing/unclear | already compliant | already compliant | 1 missing/unclear |
| firstPassPivotDecisions count | **1** | 0 | 0 | **1** | 0 |
| testExpectation source / FTP | instance_metadata / 2 | instance_metadata / 2 | instance_metadata / 2 | instance_metadata / 2 | instance_metadata / 2 |
| compliance before | ruledOut=[ast.py::unparse] | unclear=[ast.py::unparse] | edited=[scatterplot] | ruledOut=[scatterplot] | unclear=[scatterplot] |
| compliance after | — | edited=[ast.py::unparse] | — | — | unclear=[scatterplot] |
| replacedFinalPatch | false | true² | false | false | false |
| original patch (bytes) | 1450 | 1489 | 5689 | 1345 | 1219 |
| revised exists / non-empty | no | **yes / yes (2168)** | no | no | yes / yes (1219) |
| revised differs from original | n/a | **yes** | n/a | n/a | **no (identical)** |

² `replacedFinalPatch=true` is an *internal record flag*. The Docker-evaluated canonical
`modelPatch` for sphinx r2 was byte-identical to the **original** (1489 B), **not** the
revised (2168 B) — verified directly. The revised patch was **not** wired into canonical
evaluation, consistent with the constraint.

## 4. Per-case table

| instance | label | first-pass resolved | revision ran? | marker count | test exp present? | revised non-empty? | revised patch files | false trigger suppressed? | classification |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | r1 | ❌ | no | 1 | yes (2 FTP) | no | — | **yes, but WRONGLY** (suppressed a gold-required revision) | `m15_revision_harm` (false suppression of true positive) |
| sphinx-7462 | r2 | ❌ | **yes** | 0 | yes (2 FTP) | **yes** | python.py + **ast.py** (gold fix) | n/a | **`m15_revision_sphinx_success`** |
| seaborn-3187 | r1 | ❌ | no | 0 | yes (2 FTP) | no | — | n/a (compliant by edit, no trigger) | `m15_revision_artifact_success` |
| seaborn-3187 | r2 | ❌ | no | 1 | yes (2 FTP) | no | — | **yes, CORRECTLY** (non-gold scatterplot ruled out via grounded marker) | **`m15_revision_false_trigger_suppressed`** |
| seaborn-3187 | r3 | ✅ | yes | 0 | yes (2 FTP) | yes (identical to original) | scales.py + utils.py (no over-edit) | via 2nd-pass rule-out + non-install | `m15_revision_artifact_success` (no over-edit, harmless) |

## 5. Behavior analysis

**Did FAIL_TO_PASS context change sphinx behavior?** Yes — decisively, when the revision
actually ran. In sphinx r2 the second pass received `## Test expectation` with
`test_unparse[()-()]` and produced:

```
 elif isinstance(node, ast.Tuple):
-        return ", ".join(unparse(e) for e in node.elts)
+        if node.elts:
+            return ", ".join(unparse(e) for e in node.elts)
+        else:
+            return "()"
```

That is the canonical sphinx-7462 fix. Under M14 (no test context) this candidate came back
empty every time; under M15 it produced the correct edit to the previously-missing pivot.
**This is the headline M14→M15 improvement.**

**Did PIVOT_DECISION markers suppress seaborn false triggers?** **Yes — demonstrated in
seaborn r2.** The first-pass agent emitted a grounded `RULED_OUT` for
`relational.py::scatterplot` (evidence: the fix belongs in `utils.py::locator_to_legend_entries`,
which scatterplot delegates to). M15 parsed it, classified scatterplot as ruled-out, found the
patch already compliant, and **did not run the revision** — the correct call, since scatterplot
is not gold-required. The other seaborn runs corroborate harmlessness:
- seaborn r1: the agent simply *edited* the scatterplot pivot ⇒ already compliant, no trigger.
- seaborn r3: no first-pass marker ⇒ trigger fired ("unclear"); the **second pass** returned
  no edit and emitted a correct rule-out, was not installed, and the resolved=True first-pass
  patch was preserved. (Note: the recorded compliance-after stayed "unclear" — it did not
  credit the correct second-pass rule-out, a measurement gap, not a behavior problem.)

**Did the revision pass still return empty patches?** No. M14's defining failure (always
empty) is gone: sphinx r2 returned a substantive, correct non-empty diff; seaborn r3 returned
a non-empty (identical-to-original) diff. No empty-patch revisions among triggered runs.

**Did it over-edit?** No. sphinx r2 added exactly one file — the gold-required `ast.py` —
and kept the lead. seaborn r3 added nothing beyond the original. No spurious files, no noise.

**The two sides of marker suppression.** The decisive M15.1 finding is that the *same*
mechanism cuts both ways:
- **seaborn r2 (correct):** grounded `RULED_OUT` on `scatterplot` — a non-gold pivot whose
  rule-out is *consistent* with the test expectation — correctly suppressed the false trigger.
- **sphinx r1 (incorrect):** grounded `RULED_OUT` on `ast.py::unparse` — a pivot anchored by
  the FAIL_TO_PASS test `test_unparse[()-()]`, which the rule-out *contradicts* ("returns
  empty string safely") — wrongly suppressed the true trigger and skipped the gold fix that
  sphinx r2 independently produced.

Suppression is therefore only as trustworthy as the agent's rule-out, and the agent can rule
out a pivot the FAIL_TO_PASS test directly refutes. This is exactly the conflict the next
recommendation addresses.

## 6. Next recommendation

**Add a rule-out conflict guardrail.** A grounded `RULED_OUT` marker should **not** suppress
revision when the candidate pivot/file/symbol is strongly anchored by FAIL_TO_PASS or
test-expectation evidence. sphinx r1 (wrongly suppressed the needed `ast.py::unparse` fix that
the failing test `test_unparse[()-()]` directly anchors) versus seaborn r2 (correctly
suppressed the non-gold `scatterplot`) shows today's heuristic accepting any "source-grounded"
rule-out without checking it against the test expectation. The guardrail: gate marker
suppression on the rule-out being *consistent* with the test expectation — if the ruled-out
pivot is anchored by a FAIL_TO_PASS test (by file/symbol match), keep the trigger and let the
revision pass run.

Follow-on (after the guardrail lands): a read-only shadow evaluator for revised patches would
let us measure whether sphinx r2's gold-reconstructing revision actually **resolves** under
Docker (revised patches are intentionally not wired into canonical eval, and no shadow path
exists today), turning "mechanically correct revision" into a measured resolution delta.

(Not recommending 30/100 yet.)

## Appendix — cost

| run | first-pass cost | first-pass turns | revision overhead | revision turns |
|---|---|---|---|---|
| sphinx r1 | $0.428 | 24 | $0 (no revision) | — |
| sphinx r2 | $0.341 | 24 | not separately retained³ | — |
| seaborn r1 | $3.016 | 99 | $0 (no revision) | — |
| seaborn r2 | $1.004 | 66 | $0 (suppressed, no revision) | — |
| seaborn r3 | $0.994 | 48 | **$0.662** | 17 |

³ The second-pass agent writes a *shared* `results/_agent_pivot_revision_stream.jsonl`,
overwritten by the last run, so only seaborn r3's overhead survived ($0.662 / 17 turns).
sphinx r2's revision overhead was overwritten; the seaborn r3 figure is representative
(~$0.5–0.7 / ~15–20 turns per triggered revision). Total valid first-pass spend ≈ $5.78;
total run ≈ $6.4 including captured revision overhead. **Per-run revision overhead is not
durably instrumented — a capture gap to fix if a shadow evaluator is built.**

---

*Method note: shadow evaluation was deliberately not performed (no safe zero-code helper
exists in-repo; adding one was out of scope for this task). **No shadow resolution effect is
claimed.** All resolution figures above are first-pass canonical Docker results.*
