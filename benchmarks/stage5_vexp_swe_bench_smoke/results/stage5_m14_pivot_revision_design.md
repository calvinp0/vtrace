# Stage 5 M14 — Corrective pivot-revision pass: design + dry-run

Design, feasibility, and a minimal opt-in scaffold for a second corrective patch pass that works AROUND the external SWE-bench harness, driven by the M13 compliance checker. **No live agents, no Docker, no model calls** were run for this report.

## 1. Harness seam analysis

- The external `vexp-swe-bench` harness owns the agent loop and final-patch extraction. The Stage 5 runner (`run_stage5_vexp_swe_bench_smoke.ts`) spawns it via `runCondition` → `spawn`(`node dist/cli.js run …`) and reads back the canonical `swebench-*.jsonl` (`modelPatch`, tokens, tool counts).
- **Multiple harness invocations are already a proven pattern.** `runVtraceHardGate` spawns the harness TWICE through `spawnHardGatePhase`, pointing `VTRACE_AGENT_INSTRUCTIONS_FILE`, `VTRACE_AGENT_STREAM_FILE`, and the output dir at per-phase paths — using ONLY the installed adapter's `VTRACE_AGENT_*` env seam. No external harness internals are modified.
- **The runner already has everything a second pass needs:** the original task (`_run.meta.json` / instructions file), the injected VTRACE context (`vtraceInstructionsFilePath`), the model patch (`readPhasePatchText` over `findCanonicalResultsFile`), the ordered tool calls (`_tool_calls.json` via `toolCallLogFilePath`), and the post-run workspace.
- **Assistant prose IS recoverable** (resolves the M13 gap): the adapter streams stream-json to `VTRACE_AGENT_STREAM_FILE`, and `assistantTextFromStream` extracts the assistant text — the hard gate already uses it. M13 missed it only because the shared root stream is overwritten each run and not snapshotted per-run. The revision pass points the second pass at its OWN stream file, so its prose (and any `PIVOT_DECISION` markers) are captured.
- **A second post-patch model call is therefore feasible OUTSIDE the external harness** via the same `spawnHardGatePhase` seam.

## 2. Chosen option

**Option B — post-patch corrective revision pass**, implemented as an opt-in scaffold (`--pivot-revision-pass`), with **Option A artifact capture folded in** (the second pass captures its assistant prose, making `PIVOT_DECISION` markers observable).

## 3. Why

- Option A alone does not change behavior; the M13 verdict already showed that injected guidance text is not enough, so the next lever must be behavior-changing.
- Option C (editing the external agent loop) is unnecessary: the `spawnHardGatePhase` seam already lets us add a corrective second pass without touching external internals, so the invasive option is not justified.
- Option B reuses a proven multi-spawn pattern, stays off by default, and is a separate experimental condition — exactly the requested shape.

## 4. Implementation status

- `src/capsuleV2/pivotRevisionPass.ts` — PURE core: `decideRevisionPass` (gating), `buildRevisionPrompt` (wraps M13 `buildCorrectivePrompt` + current patch + bounded source excerpts + minimal-diff framing), `decideReplacement` (conservative), record helpers. Unit-tested.
- Runner: `executePivotRevisionPass` orchestrator (dependency-injected second pass — unit-tested with a stub, NO live agents) + `maybeRunPivotRevisionPass` live glue built on `spawnHardGatePhase`, wired into `runVtrace` BEHIND both flags. The default suite never sets the flags, so behavior is unchanged.
- **Not yet run live.** The live second-pass spawn is gated behind `--pivot-revision-pass` and awaits explicit approval. Final-patch SWAP into the canonical eval JSONL is intentionally NOT wired (replacement is computed + recorded only) so the pass can never corrupt canonical results before live validation.

## 5. Risks

- **Workspace state:** a fresh `run` resets to the base commit, so the second pass starts from base, not the post-patch tree; the revision prompt supplies the prior patch as text to revise. Acceptable for a text-driven revision; flagged for live validation.
- **Cost:** a second `run` doubles token/$ for non-compliant cases. Mitigated by the gate (only fires on missing/unclear) and off-by-default.
- **Over-edit:** the revision could pad the diff. Mitigated by the anti-over-edit / minimal-diff wording and the conservative `decideReplacement` (replace only on a strict compliance improvement with a real diff).
- **Conservative `unclear`:** without `PIVOT_DECISION` markers, a correct silent rule-out reads as `unclear` and would trigger a (wasteful) revision — see seaborn-r3 below. Folding in marker capture is the mitigation; emitting markers from the first pass is the follow-up.

## 6. Exact flags

- `--pivot-revision-pass` (default OFF). Requires `--pivot-inspection-enforcement`. Independent of the legacy PIVOT_CHECK policy / `--disable-pivot-check`. Never the product default.

## 7. Artifact layout

Persisted in the vtrace raw dir, all `_`-prefixed (never a canonical JSONL; gitignored):

- `_pivot_revision_original.patch` — originalPatch
- `_pivot_revision_prompt.md` — prompt
- `_pivot_revision_response.txt` — response
- `_pivot_revision_revised.patch` — revisedPatch
- `_pivot_revision.json` — record

`_pivot_revision.json` carries: `ran`, `decisionReason`, `originalPatch`, `revisionPrompt`, `revisionResponse`, `revisedPatch`, `complianceBefore`, `complianceAfter`, `replacedFinalPatch`.

## 8. Dry-run over M12.1 labels (no model calls)

Compliance-before is the M13 verdict; `would run?` is `decideRevisionPass` with both flags on and Capsule v2 injected. Revision prompts for would-run rows are written under `results/_m14_dry_run_prompts/` (gitignored, not staged).

| case | label | resolved | required | outstanding (missing/unclear) | would run? | reason | prompt path | risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | `…sphinx-7462-r1` | no | `sphinx/pycode/ast.py::unparse` | `sphinx/pycode/ast.py::unparse` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-sphinx-7462-r1.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| sphinx-7462 | `…sphinx-7462-r2` | no | `sphinx/pycode/ast.py::unparse` | `sphinx/pycode/ast.py::unparse` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-sphinx-7462-r2.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| sphinx-7462 | `…sphinx-7462-r3` | no | `sphinx/pycode/ast.py::unparse` | `sphinx/pycode/ast.py::unparse` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-sphinx-7462-r3.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| seaborn-3187 | `…seaborn-3187-r1` | no | `seaborn/relational.py::scatterplot` | `seaborn/relational.py::scatterplot` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-seaborn-3187-r1.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| seaborn-3187 | `…seaborn-3187-r2` | no | `seaborn/relational.py::scatterplot` | `seaborn/relational.py::scatterplot` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-seaborn-3187-r2.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| seaborn-3187 | `…seaborn-3187-r3` | yes | `seaborn/relational.py::scatterplot` | `seaborn/relational.py::scatterplot` | yes | 1 missing/unclear candidate(s) | `_m14_dry_run_prompts/eval-m12-pivot-enforcement-current-seaborn-3187-r3.md` | low — single non-lead pivot; revision is edit-or-grounded-rule-out |
| django-13195 | `…django-13195-r1` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | — | no | patch already compliant | — | none — no second pass |
| django-13195 | `…django-13195-r2` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | — | no | patch already compliant | — | none — no second pass |
| django-13195 | `…django-13195-r3` | no | `django/http/response.py::set_cookie`, `django/contrib/sessions/middleware.py (co-edit)`, `django/contrib/messages/storage/cookie.py (co-edit)` | — | no | patch already compliant | — | none — no second pass |

- **would trigger a revision pass** (6): `eval-m12-pivot-enforcement-current-sphinx-7462-r1`, `eval-m12-pivot-enforcement-current-sphinx-7462-r2`, `eval-m12-pivot-enforcement-current-sphinx-7462-r3`, `eval-m12-pivot-enforcement-current-seaborn-3187-r1`, `eval-m12-pivot-enforcement-current-seaborn-3187-r2`, `eval-m12-pivot-enforcement-current-seaborn-3187-r3`
- **no revision pass** (3): `eval-m12-pivot-enforcement-current-django-13195-r1`, `eval-m12-pivot-enforcement-current-django-13195-r2`, `eval-m12-pivot-enforcement-current-django-13195-r3`

### Notable

- **sphinx-7462 (all 3):** outstanding `ast.py::unparse` → revision WOULD run; the prompt asks to edit-or-grounded-rule-out the gold pivot the first pass skipped. Highest expected value.
- **seaborn-3187-r3 RESOLVED but WOULD still run:** `relational.py::scatterplot` is `unclear` (inspected, correctly not edited, no marker). This is a FALSE trigger — the cost of running without first-pass `PIVOT_DECISION` markers. The conservative `decideReplacement` keeps the already-correct patch unless the revision strictly improves compliance, so a false trigger wastes a second pass but cannot worsen the submitted diff.
- **django-13195 (all 3):** fully compliant → no revision pass (all gold/co-edit files edited).

## Non-claims
- No live agents, no Docker, no model calls; deterministic dry-run.
- Off by default; requires both flags; never the product default.
- No retrieval/scoring/ranking/candidate-gen/pivot-selection change (retrieval evals byte-identical).
- Final-patch swap into the canonical eval JSONL is NOT wired (replacement recorded only).
