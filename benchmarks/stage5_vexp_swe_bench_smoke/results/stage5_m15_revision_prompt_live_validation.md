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

**`m15_revision_live_partial` — M15 is a real improvement over M14.1, with one new risk.**

- **sphinx improved decisively.** Where M14 always produced an empty revised patch, M15's
  revision pass (armed with the FAIL_TO_PASS test `test_unparse[()-()]`) produced a
  **non-empty revised patch that adds `sphinx/pycode/ast.py::unparse`** — and the added hunk
  is **the canonical gold fix** (empty `ast.Tuple` now returns `"()"` instead of `""`).
  This is the exact M14→M15 behavior change the prompt work targeted.
- **No over-edit.** On seaborn (a non-gold pivot), the second pass returned a patch
  byte-identical to the original (no scatterplot edit) and emitted a correct grounded
  rule-out. The minimal-diff guardrail held; the canonical resolved=True patch was preserved.
- **New risk — marker-based suppression can fire backwards.** In sphinx r1 the first-pass
  agent emitted a *plausible-but-wrong* grounded `RULED_OUT` marker for `ast.py::unparse`
  ("uses `", ".join(...)` … returns empty string safely — no IndexError possible"). M15's
  suppression logic accepted it and **skipped the very revision that r2 produced as the gold
  fix.** The suppression mechanism (M15 feature #4) is double-edged: it correctly silences
  noise, but a confident-wrong rule-out on a gold-/test-anchored pivot is a false negative.

No revised patch was wired into canonical evaluation, and no shadow evaluation was run.
**No shadow resolution effect claimed.**

## 2. Run validity

| label | run-protocol | docker eval | valid? | note |
|---|---|---|---|---|
| eval-m15-pivot-revision-current-sphinx-7462-r1 | ✅ exit0 | ✅ exit0 | ✅ | 24 turns, $0.428 |
| eval-m15-pivot-revision-current-sphinx-7462-r2 | ✅ exit0 | ✅ exit0 | ✅ | 24 turns, $0.341 |
| eval-m15-pivot-revision-current-seaborn-3187-r1 | ✅ exit0 | ✅ exit0 | ✅ | 99 turns, $3.016 (hit $3 cap) |
| eval-m15-pivot-revision-current-seaborn-3187-r2 | ⚠️ no spawn | ❌ exit1 | ❌ **excluded** | HTTP 429 `out_of_credits` (session limit) — agent never spawned, no JSONL |
| eval-m15-pivot-revision-current-seaborn-3187-r3 | ✅ exit0 | ✅ exit0 | ✅ | 48 turns, $0.994 — replacement for r2 |

- **seaborn r2 was an infrastructure/quota failure, not a code defect** ("You've hit your
  session limit · resets 7:20pm"). Per protocol it is excluded and **not** counted as
  unresolved. Credits reset; **r3** was run to restore 2 valid seaborn runs.
- Docker health: all 4 valid runs evaluated cleanly. No Docker infra errors.
- Final valid set: **sphinx r1, sphinx r2, seaborn r1, seaborn r3** (2 valid per case).
- Baseline not run; 30/100 not run (per constraints).

## 3. Artifact validation

Per-run treatment integrity (all 4 valid runs identical):

| check | result |
|---|---|
| effectiveCapsuleEngine | **v2** |
| capsuleEngineFallbackReason | **null** |
| context injected | **yes** |
| ordered telemetry / tool calls | present (`_tool_calls.json`, `_tool_calls.summary.json`) |
| legacy PIVOT_CHECK | **absent** (`vtracePivotCheckInjected=false`, `disabledByFlag=true`) |
| legacy EDIT_GUARD | **absent** (`vtraceEditGuardInjected=false`, `textPresent=false`) |
| legacy PATCH_VERIFY | **absent** (`vtracePatchVerifyInjected=false`, `textPresent=false`) |
| pivot inspection enforcement | **present** (behaviorally confirmed: sphinx r1 emitted a well-formed `PIVOT_DECISION` marker, which only happens when the M12 enforcement block is injected) |
| pivot revision pass | **enabled** (revision record present every run; `ran=true` on sphinx r2 + seaborn r3) |

M15-specific artifacts:

| M15 artifact | result |
|---|---|
| `_pivot_first_pass_assistant.txt` | **present in all 4 valid runs** (feature #1 working) |
| first-pass `PIVOT_DECISION` markers requested | yes (sphinx r1 produced one ⇒ requested + parsed) |
| `firstPassPivotDecisions` recorded in `_pivot_revision.json` | yes (sphinx r1: 1; others: 0) |
| `testExpectation` recorded | yes — `source=instance_metadata`, 2 FAIL_TO_PASS in **every** run |
| revision prompt includes FAIL_TO_PASS/test expectation | yes — sphinx r2 prompt has a `## Test expectation` block listing `test_parse_annotation` + `test_unparse[()-()]` |
| revision prompt includes bounded source excerpts | yes ("Source excerpts for the outstanding candidates:") |
| revision prompt includes minimal-diff / anti-over-edit guardrails | yes ("Prefer the minimal diff", "Return a non-empty unified diff only if source/test evidence requires a change", PIVOT_DECISION rule-out guidance) |

Per-run revision record summary:

| field | sphinx r1 | sphinx r2 | seaborn r1 | seaborn r3 |
|---|---|---|---|---|
| ran | false | **true** | false | **true** |
| decisionReason | patch already compliant | 1 missing/unclear candidate | patch already compliant | 1 missing/unclear candidate |
| firstPassAssistantTextPath | set | set | set | set |
| firstPassPivotDecisions count | **1** | 0 | 0 | 0 |
| testExpectation source | instance_metadata | instance_metadata | instance_metadata | instance_metadata |
| testExpectation FAIL_TO_PASS | 2 | 2 | 2 | 2 |
| compliance before | ruledOut=[ast.py::unparse] | unclear=[ast.py::unparse] | edited=[relational.py::scatterplot] | unclear=[relational.py::scatterplot] |
| compliance after | — (no run) | edited=[ast.py::unparse] | — (no run) | unclear=[relational.py::scatterplot] |
| replacedFinalPatch | false | true¹ | false | false |
| original patch hash (bytes) | 1450 | 1489 | 5689 | 1219 |
| revised patch exists | no | **yes (2168)** | no | yes (1219) |
| revised non-empty | no | **yes** | no | yes |
| revised differs from original | n/a | **yes** | n/a | **no (identical)** |

¹ `replacedFinalPatch=true` is an *internal record flag*. The Docker-evaluated canonical
`modelPatch` for sphinx r2 was byte-identical to the **original** (1489 B), **not** the
revised (2168 B) — verified directly. The revised patch was **not** wired into canonical
evaluation, consistent with the constraint.

## 4. Per-case table

| instance | label | first-pass resolved | revision ran? | marker count | test exp present? | revised non-empty? | revised patch files | false trigger suppressed? | classification |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | r1 | ❌ | no | 1 | yes (2 FTP) | no | — | **yes, but WRONGLY** (suppressed a gold-required revision) | `m15_revision_harm` (false suppression of true positive) |
| sphinx-7462 | r2 | ❌ | **yes** | 0 | yes (2 FTP) | **yes** | python.py + **ast.py** (gold fix) | n/a | **`m15_revision_sphinx_success`** |
| seaborn-3187 | r1 | ❌ | no | 0 | yes (2 FTP) | no | — | n/a (compliant by edit, no trigger) | `m15_revision_artifact_success` |
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

**Did PIVOT_DECISION markers suppress seaborn false triggers?** Not in the first pass —
neither seaborn run emitted first-pass markers (count=0), so first-pass marker suppression
was **not exercised** on seaborn. What happened instead:
- seaborn r1: the agent simply *edited* the scatterplot pivot, so it was already compliant
  (no trigger to suppress).
- seaborn r3: the trigger fired (scatterplot "unclear"); the **second pass** correctly
  returned no edit and emitted a grounded rule-out ("the legend formatting occurs via
  `locator_to_legend_entries` … my fix in `seaborn/utils.py` handles all code paths"). It
  did not improve the recorded compliance (still "unclear"), so it was not installed and the
  resolved=True first-pass patch was preserved. Harmless, but note the compliance-after
  metric did not credit the (correct) second-pass rule-out — a measurement gap, not a
  behavior problem.

**Did the revision pass still return empty patches?** No. M14's defining failure (always
empty) is gone: sphinx r2 returned a substantive, correct non-empty diff; seaborn r3 returned
a non-empty (identical-to-original) diff. No empty-patch revisions among triggered runs.

**Did it over-edit?** No. sphinx r2 added exactly one file — the gold-required `ast.py` —
and kept the lead. seaborn r3 added nothing beyond the original. No spurious files, no noise.

**The new risk (sphinx r1).** M15's marker-suppression accepted a confident-but-incorrect
grounded `RULED_OUT` for `ast.py::unparse` and skipped the revision entirely. The same pivot,
without a first-pass marker (r2), correctly triggered and was fixed. So the suppression
heuristic can convert a true-positive trigger into a false negative on a gold-/test-anchored
pivot. The heuristic trusts "source-grounded" phrasing without checking it against the
FAIL_TO_PASS test that contradicts it.

## 6. Next recommendation

**A — add safe shadow-evaluation support for revised patches.**

M15 demonstrably produces a *useful* non-empty revision: sphinx r2 reconstructed the gold
`ast.py::unparse` fix from FAIL_TO_PASS context. The single most valuable next datum is
whether that revised patch actually **resolves** under Docker — which we cannot claim today
because revised patches are intentionally not wired into canonical eval and no shadow path
exists. A read-only shadow evaluator (build a shadow JSONL with `modelPatch` = revised patch,
run the external evaluator, never mutate canonical artifacts) would convert "mechanically
correct revision" into a measured resolution delta and tell us if second-pass patching is
worth pursuing further.

**Required guardrail before trusting M15 in anger (carry the D-concern into A):** tighten
marker-based suppression so a grounded `RULED_OUT` **cannot** suppress a revision on a pivot
that is anchored by a FAIL_TO_PASS test (or otherwise gold-required). sphinx r1 shows the
suppression heuristic accepting a rule-out that the failing test directly refutes. Suppression
should be gated on the rule-out being consistent with the test expectation, not just on
"source-grounded" phrasing.

(Not recommending 30/100 yet.)

## Appendix — cost

| run | first-pass cost | first-pass turns | revision overhead | revision turns |
|---|---|---|---|---|
| sphinx r1 | $0.428 | 24 | $0 (no revision) | — |
| sphinx r2 | $0.341 | 24 | not separately retained² | — |
| seaborn r1 | $3.016 | 99 | $0 (no revision) | — |
| seaborn r3 | $0.994 | 48 | **$0.662** | 17 |
| seaborn r2 (excluded) | ~$0 (429 before spawn) | 0 | — | — |

² The second-pass agent writes a *shared* `results/_agent_pivot_revision_stream.jsonl`,
overwritten by the last run, so only seaborn r3's overhead survived ($0.662 / 17 turns).
sphinx r2's revision overhead was overwritten; the seaborn r3 figure is representative
(~$0.5–0.7 / ~15–20 turns per triggered revision). Total valid first-pass spend ≈ $4.78;
total run ≈ $5.4 including captured revision overhead. **Per-run revision overhead is not
durably instrumented — a capture gap to fix if shadow-eval (rec A) is built.**

---

*Method note: shadow evaluation was deliberately not performed (no safe zero-code helper
exists in-repo; adding one was out of scope for this task). **No shadow resolution effect is
claimed.** All resolution figures above are first-pass canonical Docker results.*
