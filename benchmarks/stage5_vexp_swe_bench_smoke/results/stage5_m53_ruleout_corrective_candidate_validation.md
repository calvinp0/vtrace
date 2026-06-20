# Stage 5 — M53: Three-replicate corrective candidate-generation validation

**Instance:** `sphinx-doc__sphinx-7462`
**Replicates:** 3 (`r1`, `r2`, `r3`)
**Mode:** candidate generation only — no Docker, no canonical SWE-bench evaluation, no diagnostic verifier, no auto-adoption.
**Module under test:** M51/M52 rule-out sufficiency corrective second pass (`--ruleout-sufficiency-corrective-pass`).
**Predecessor:** M52 (commit `9d6c217`) — first live evidence that the fair corrective loop can move the agent where first-pass text failed (single replicate, `candidate_ast_edit`).

Flags used (per replicate):
`--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check --ruleout-sufficiency-corrective-pass` (auto-enables `--ruleout-sufficiency-check`).
Not enabled: `--pivot-revision-pass`, `--revision-verification-policy`, `--pivot-inspection-enforcement`, `--allow-docker-verify`.

---

## 1. Executive verdict

- **Did the corrective second pass reliably produce revised candidates?** Partially. The checker fired and the second model call ran in **2/3** replicates, producing a revised candidate both times (**2/3**). It did **not** fire in r3.
- **Did candidates edit `ast.py`?** Only in **1/3** (r1). r2 produced a revised candidate that re-edited `python.py` only (byte-identical to its first pass); r3 never reached a second pass.
- **Was canonical safety preserved?** **Yes, 3/3.** Every run: `canonicalReplaced=false`, `adoptionEligible=false`, canonical results-file SHA unchanged before vs. after the corrective pass.
- **Was there any leakage?** **No.** Independent grep of every agent-facing artifact (corrective prompt, response, checker JSON, revised patch, result JSON) across all 3 runs found zero forbidden strings.

**Primary success (`candidate_ast_edit` in ≥2/3): NOT met — 1/3.**
**Strong success (3/3 both-file edits): NOT met.**
**Safety boundary: fully preserved (3/3).**

The M53 result does not reproduce M52's `candidate_ast_edit` reliably. The mechanism is sound and safe, but the *outcome* is variance-limited by (a) first-pass depth and (b) model judgment on output-correctness — see §4.

---

## 2. Run matrix

| Label | Valid | Checker triggered | 2nd call | Revised candidate | Classification |
|---|---|---|---|---|---|
| eval-m53-ruleout-corrective-sphinx-7462-r1 | yes | **yes** | yes | yes (python.py + ast.py) | `candidate_ast_edit` |
| eval-m53-ruleout-corrective-sphinx-7462-r2 | yes | **yes** | yes | yes (python.py only) | `candidate_no_ast_edit` |
| eval-m53-ruleout-corrective-sphinx-7462-r3 | yes | **no** | no | no | `checker_did_not_fire` |

First-pass cost/turns: r1 = 24 turns / \$0.347, r2 = 21 turns / \$0.297, r3 = **11 turns / \$0.174**.

---

## 3. First-pass vs. revised candidate analysis

| Run | First-pass changed files | First-pass edits ast.py? | Revised changed files | Revised edits ast.py? | Revised vs first-pass |
|---|---|---|---|---|---|
| r1 | `sphinx/domains/python.py` | no | `sphinx/domains/python.py`, `sphinx/pycode/ast.py` | **yes** | **changed** (added ast.py edit) |
| r2 | `sphinx/domains/python.py` | no | `sphinx/domains/python.py` | no | **identical** (revisedPatchSha == firstPassPatchSha) |
| r3 | `sphinx/domains/python.py` | no | — (no second pass) | — | n/a |

- **All three first passes edited `python.py` only** — consistent with the known M40/M52 localization gap (the paired `sphinx/pycode/ast.py::unparse` is never edited in the first pass).
- r1 and r2 produced **byte-identical first-pass patches** (`1f5e48d6…`) yet diverged in the second pass — so the divergence is entirely in the corrective step, not the first pass.
- r2's revised patch SHA equals its first-pass SHA: the second call ran, reasoned about `ast.py`, and chose to reproduce the same `python.py`-only patch.

---

## 4. Corrective prompt/response analysis

The corrective prompt (identical template in r1 and r2) is oracle-free — it names only the file paths and the agent's own `unparse` rule-out:

> Your first-pass patch edited one implementation of `unparse` (sphinx/domains/python.py::unparse) but left a surfaced paired implementation unedited (sphinx/pycode/ast.py::unparse). Your rule-out explains why the paired implementation may not crash, but it does not explain why its output or behavior is correct for the same edge case. Either revise the patch or provide concrete repository evidence that the paired implementation preserves the intended behavior.

The divergence is genuine **model judgment variance on the same question**:

- **r1** accepted the challenge: it concluded `sphinx/pycode/ast.py`'s `", ".join(...)` returns `""` for an empty tuple, judged that *output* incorrect (should render `()`), and **edited `ast.py`** to early-return `"()"`. → addresses the weak rule-out.
- **r2** declined: it judged the same `", ".join(...)` → `""` behavior **acceptable** ("no crash, and correct output"), provided that as its justification, and left `ast.py` unedited. → the response *engages* the weak rule-out but resolves it the other way.

So the corrective pass did its job in both triggered runs (surfaced the weak rule-out, demanded justification); the candidate outcome hinges on whether the model accepts `""` as correct output. This is the variance worth inspecting before any verification/adoption policy.

r3 never produced a corrective prompt: its 11-turn first pass never surfaced or ruled out the paired `ast.py` implementation, so the checker had no rule-out to reclassify (`missingEvidence: "rule-out text/decision for sphinx/pycode/ast.py::unparse"`).

---

## 5. Safety and leakage audit

| Check | r1 | r2 | r3 |
|---|---|---|---|
| `canonicalReplaced=false` | ✅ | ✅ | ✅ |
| `adoptionEligible=false` | ✅ | ✅ | ✅ |
| canonical modelPatch / results-file SHA unchanged | ✅ | ✅ | ✅ |
| no Docker / eval / verifier artifacts | ✅ | ✅ | ✅ |
| no forbidden leakage (independent grep) | ✅ | ✅ | ✅ |

Forbidden-string scan (`FAIL_TO_PASS`, `PASS_TO_PASS`, `test_unparse[()-()]`, `gold patch`, `hidden test`, `resolved=true`, `benchmark expected`) over the corrective prompt, response, checker JSON, revised patch, and result JSON for all 3 runs: **clean, no matches**. No `_eval.meta.json`, no docker/evaluate markers in run logs, no `_pivot_revision*` artifacts. The corrective pass also self-guards: it throws if the canonical results artifact SHA changes — it did not throw.

---

## 6. Aggregate table

| Metric | Rate |
|---|---|
| Replicates completed | 3/3 |
| Checker trigger rate | **2/3** (66.7%) |
| Second-call execution rate | **2/3** (66.7%) |
| Revised-candidate production rate | **2/3** (66.7%) |
| `ast.py` edit rate (all runs) | **1/3** (33.3%) |
| `ast.py` edit rate (triggered runs only) | 1/2 (50%) |
| Both-file edit rate | **1/3** (33.3%) |
| Canonical safety rate | **3/3** (100%) |
| Leakage-free rate | **3/3** (100%) |

Outcome classifications: `candidate_ast_edit` ×1 (r1), `candidate_no_ast_edit` ×1 (r2), `checker_did_not_fire` ×1 (r3).

---

## 7. Next recommendation

**C — Candidates are inconsistent; inspect prompt/response variance before continuing.**

Rationale: the safety boundary held perfectly (3/3), so this is **not** option E. But `ast.py`-editing candidates appeared in only 1/3 (and 1/2 of triggered runs), short of the ≥2/3 primary bar — so it is neither A nor B, and not a flat "never edits ast.py" (D). The variance has two distinct, separable sources, each addressable before any verification/adoption work:

1. **Trigger variance (first-pass depth):** r3's first pass terminated at 11 turns without inspecting the paired `ast.py` implementation, so the checker correctly did not fire. The corrective loop can only help when the first pass surfaces a rule-out to challenge.
2. **Candidate variance (model judgment):** among triggered runs, the agent split on whether `ast.py`'s empty-tuple output (`""`) is acceptable — r1 fixed it, r2 justified leaving it. The corrective prompt is functioning; the outcome is judgment-bound.

Suggested M54 (still candidate-only, no adoption): characterize this variance with more replicates and/or a sharper corrective prompt that forces the agent to state the concrete *rendered output* for the edge case (without supplying any oracle), then re-measure the `ast.py` edit rate among **triggered** runs. Hold canonical safety and the no-leakage / no-Docker / no-verifier / no-auto-adopt invariants.

---

## Appendix — artifact locations

Per run, under `benchmarks/stage5_vexp_swe_bench_smoke/results/runs/<label>/raw/vtrace/`:

- `_run.meta.json`, `swebench-*.jsonl` (canonical `modelPatch`)
- `_ruleout_sufficiency_check.json` — checker verdict
- `_ruleout_sufficiency_corrective_prompt.md` — corrective prompt (r1, r2)
- `_ruleout_sufficiency_corrective_response.txt` — second-pass prose (r1, r2)
- `_ruleout_sufficiency_revised.patch` — revised candidate (r1, r2)
- `_ruleout_sufficiency_corrective_result.json` — machine-readable result record

These raw artifacts are gitignored and are **not** staged. Only this report and its `.json`/`.csv` siblings are committed.
