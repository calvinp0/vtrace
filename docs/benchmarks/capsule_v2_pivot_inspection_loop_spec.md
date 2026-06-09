# Capsule v2 — Pivot-Inspection Loop Spec

A design for a minimal agent-loop mechanism that forces the agent to **inspect
every Capsule v2 pivot before editing**, and records whether each pivot was
inspected, ruled out, or edited.

This is **not retrieval work**. It changes neither Capsule v2 scoring, candidate
generation, nor ranking. It changes only (a) the text vtrace injects into the
agent prompt and (b) the post-hoc analysis the Stage 5 harness runs over
artifacts it already captures.

Scope in one line: **vtrace already surfaces the right hidden pivot; this closes
the gap between surfacing it and the agent acting on it, by requiring a
structured pivot-inspection step and scoring whether the agent honored it.**

---

## 1. Motivation

The Stage 5 retrieval evals show Capsule v2 recovers the correct edit target at a
high rate (Django top-3 90%, cross-repo top-3 87.5%; see
[`capsule_v2_stage5_state.md`](./capsule_v2_stage5_state.md)). But the latest live
smoke exposed a **context-to-action gap**: the capsule can surface a hidden,
non-traceback pivot, *flag* it as the likely root cause, and the agent still
edits only the traceback-named file.

The product hypothesis is that vtrace differentiates itself not by *providing*
context but by *enforcing context use*:

```
retrieval → pivot inspection → edit plan → patch
```

Today the pipeline is effectively `retrieval → patch`. The renderer already emits
soft "inspect every pivot" guidance (`renderHuman.ts:57-101`), but soft guidance
is advisory prose buried in a long prompt; nothing requires the agent to engage
with each pivot, and nothing records whether it did. This spec adds the missing
middle two steps as a **prompt-level requirement plus a post-hoc verifier** —
without a second model invocation and without touching the external tool API.

---

## 2. Evidence from sphinx-7462

Run: `results/runs/eval-locgap-multipivot-sphinx-7462/`.

The capsule surfaced **two pivots** and explicitly flagged the second as hidden
(`_vtrace_instructions.snapshot.md`, hidden-candidate block at line 163):

| # | pivot | role_reason (abbrev.) | source-anchored? |
|---|-------|------------------------|------------------|
| 1 | `sphinx/domains/python.py::_parse_annotation` | "source line anchor in the issue points at this symbol — explicit edit site" | **yes** (traceback / issue line) |
| 2 | `sphinx/pycode/ast.py::unparse` | "actionable function — exercised by a failing test; symbol-name match; 9 dependents" | **no** (inference-surfaced) |

The injected snapshot rendered the full multi-pivot preamble *and* the
hidden-candidate block under pivot #2:

```
hidden candidate:
This pivot was not selected because it appeared in a traceback or path anchor.
It was surfaced by symbol / graph / literal reasoning and may hold the
root-cause implementation.
Inspect it before finalizing the patch.
```

Outcome (`raw/vtrace/_run.meta.json`, `raw/vtrace/swebench-*.jsonl`):

```
vtracePivotCount:           2
vtraceTreatmentValid:       true     (context was injected and observed)
modelPatch edited files:    sphinx/domains/python.py        ← pivot #1 only
sphinx/pycode/ast.py:       never edited, no evidence it was read
resolved:                   false
```

So: vtrace surfaced the hidden pivot, flagged it, and the agent **edited only the
traceback-named file** — exactly the failure mode the soft guidance was meant to
prevent. The harness recorded the *lead*-pivot compliance (`buildAgentCompliance`
at `run_stage5_vexp_swe_bench_smoke.ts:1036`) and the final edited file's role
(`finalEditedFileRole` in `src/capsule/finalEditDiagnostics.ts:111`), but **no
existing signal records what happened to pivot #2** — the one that mattered.

---

## 3. Proposed loop

Insert a mandatory inspection step between retrieval and patch. The agent must,
**before producing any edit**, emit a Pivot Inspection Checklist covering every
pivot the capsule surfaced:

```
## Pivot inspection checklist

| pivot path | pivot symbol | why vtrace selected it | inspected? | relevant? | edit needed? | reason |
|------------|--------------|------------------------|-----------|-----------|--------------|--------|
| sphinx/domains/python.py | _parse_annotation | source line anchor in issue | yes | yes | yes | renders annotation; ... |
| sphinx/pycode/ast.py | unparse | failing-test symbol match, 9 dependents | yes | no | no | confirmed: only formats AST, not xref target; behavior X lives in _parse_annotation |
```

Rules baked into the injected instruction:

1. **One row per pivot.** The agent must account for *every* pivot, including
   hidden / non-traceback ones — not just the one it intends to edit.
2. **Inspect, don't pre-judge.** `inspected?` means the agent actually opened the
   pivot's file/symbol (a `Read`/`view` on the path). It is not allowed to mark a
   pivot `relevant? = no` without first inspecting it.
3. **Rule out with a grounded reason.** A pivot may end as `edit needed? = no`,
   but only with a concrete reason tied to what the agent saw in the source
   ("only formats the AST string, does not build the xref target"), never a bare
   "not relevant".
4. **No instruction to edit everything.** The agent is forced to *inspect and
   account for* each pivot, not to edit each one. Editing the smallest correct
   set remains the goal.

The checklist is emitted as text in the agent's response (the only channel
available without a new tool). The harness then **independently verifies** it
against the ordered tool-call log and the final patch — the checklist is the
agent's *claim*; the tool-call log is the *evidence*. Divergence between the two
is itself a recorded signal.

### Enforcement model (the one real fork)

There are two viable enforcement strengths. This spec recommends the first as the
**minimal** design and documents the second as a deliberate future escalation:

- **(A) Prompt-required + post-hoc verified (RECOMMENDED, minimal).** Inject the
  checklist requirement; the agent produces it single-shot alongside the patch;
  the harness scores, per pivot, inspected / ruled-out / edited / **ignored**. No
  second model call, no external-API change, no live rejection. Fits the existing
  single-shot harness exactly. Success = the hidden pivot is no longer silently
  ignored: it is inspected and either edited or ruled out with a grounded reason.
- **(B) Iterative re-prompt loop (future).** If post-hoc verification finds an
  *ignored* pivot, re-invoke the agent with a targeted follow-up
  ("`sphinx/pycode/ast.py::unparse` was surfaced and never inspected — inspect it
  and update your patch or justify skipping it"). This is a true loop but
  requires the harness to support a **second agent invocation with carried-over
  workspace state**, which the current single-shot spawn does not do. Out of scope
  for the minimal experiment; noted so the artifact schema below leaves room for
  it.

---

## 4. Required harness changes

All changes are additive and live in two places already identified above.

### 4.1 Injected instruction (prompt lever)

`buildVtraceContextMarkdown` (`run_stage5_vexp_swe_bench_smoke.ts:2990`) appends a
fixed `## Instruction` block today. For multi-pivot capsules, extend that block
(or add a sibling block) with the **mandatory checklist requirement** and the
checklist's column contract. The pivot rows the agent must cover are already
available to the harness as `vtraceCapsulePivots`
(`CapsuleAuditItem[]`, `:2187`) — the same `{path, symbol, roleReason}` list it
already records in `_run.meta.json`. Render them as the seed rows so the agent
cannot "forget" a pivot.

This stays a **rendering/prompt change only** — it reads already-selected pivots
and adds instruction text. It touches no scoring, candidate generation, or
ranking. The single-pivot case stays quiet (no checklist needed when there is one
obvious target), matching the existing multi-pivot gate (`renderHuman.ts:62`).

Decision to settle in code: whether the checklist instruction lives in the
benchmark's `buildVtraceContextMarkdown` (benchmark-only, fastest to iterate) or
in `renderCapsuleV2Human` (ships with the capsule, so every consumer gets it).
**Recommended: benchmark-only first** — validate on sphinx-7462 before promoting
into the shared renderer.

### 4.2 Post-hoc verifier (analysis lever)

Generalize the existing single-pivot diagnostics to **all** pivots. The building
blocks already exist:

- `readOrderedToolCalls` (`:1007`) — ordered `{tool, target}` log from the result
  record; already handles `Read`/`Edit`/search tool families.
- `editedFilesFromPatch` / `primaryEditedFile` (`finalEditDiagnostics.ts:16,35`).
- `samePath` lenient matching (`finalEditDiagnostics.ts:146`).
- `targetsFile` (`:1027`).

Add a function that classifies each pivot. This is the load-bearing piece of
judgment in the whole design, so it is scaffolded here for review rather than
asserted:

```ts
// Per-pivot inspection outcome, derived from the ordered tool-call log and the
// final patch. Pure: no per-instance lookup tables, shape-only matching.
export type PivotInspectionState =
  | "edited"     // a pivot the agent edited (Edit/Write targeting its path)
  | "inspected"  // read but not edited (Read/view targeting its path, no edit)
  | "ignored";   // neither read nor edited — the sphinx-7462 failure mode

export interface PivotInspectionRecord {
  path: string;
  symbol: string;
  isHidden: boolean;          // from renderer's isSourceAnchoredPivot (inverted)
  state: PivotInspectionState;
  // TODO(user): classify one pivot.
  //   `calls` is the ordered [{tool, target}] log (READ_TOOLS / EDIT_TOOLS as
  //   defined in run_stage5_vexp_swe_bench_smoke.ts); `editedFiles` is from the
  //   patch. Decide what counts as "inspected": is a single Read enough, or must
  //   the agent open the pivot's file specifically (vs. a grep that merely lists
  //   it)? And how do we treat a pivot that was edited but never read first —
  //   "edited" (outcome wins) or a distinct "edited-without-reading" flag? This
  //   choice defines what the experiment actually rewards.
}

export function classifyPivots(
  pivots: readonly { path: string; symbol: string; isHidden: boolean }[],
  calls: readonly { tool: string; target: string | null }[],
  editedFiles: readonly string[],
): PivotInspectionRecord[] {
  // ... see TODO above for the per-pivot decision.
}
```

The verifier runs in the same post-hoc stamping pass as
`stampCapsuleDiagnostics` (~`:3770`), which already reads the per-instance
context and computes `containsFinalEditedFile` / `finalEditedFileRole`. It needs
no new inputs — `vtraceCapsulePivots`, the tool-call log, and the patch are all
already in scope there.

### 4.3 No changes to

- Capsule v2 scoring / candidate generation / ranking (`src/capsuleV2/**`
  builder, scorecards, allocator) — untouched.
- The underlying agent model.
- The external `vexp-swe-bench` tool API (no new tools, no new flags into the
  spawned CLI; injection stays the existing `VTRACE_AGENT_INSTRUCTIONS_FILE`
  append at `:4055`).

---

## 5. Required artifacts / logging

Per vtrace row (extend the existing `CapsuleDiagnosticFields` / a sibling
`PivotInspectionFields`), record:

| field | meaning |
|-------|---------|
| `pivotInspection` | array of `PivotInspectionRecord` (one per surfaced pivot) |
| `hiddenPivotCount` | how many surfaced pivots were non-source-anchored |
| `hiddenPivotsInspected` | of those, how many reached `inspected` or `edited` |
| `hiddenPivotsIgnored` | of those, how many ended `ignored` (the headline gap metric) |
| `checklistEmitted` | bool — did the agent's response contain a parseable checklist table? |
| `checklistVsToolsAgreement` | rows where the agent's claimed `inspected?` matches the tool-call evidence |

Also persist the **agent's emitted checklist text** verbatim (alongside the
existing `_vtrace_instructions.snapshot.md`) as
`_pivot_inspection.snapshot.md`, so a human can audit the agent's stated
reasoning against the verifier's classification.

The headline success metric for the experiment is `hiddenPivotsIgnored` going to
**0** on sphinx-7462: the hidden pivot must be inspected (and then either edited
or ruled out with a grounded reason), regardless of Docker resolution.

---

## 6. Risks

- **Prompt bloat / distraction.** The checklist instruction adds tokens and a
  procedural demand that could pull the agent away from actually fixing the bug,
  or inflate small/local tasks. Mitigation: gate strictly on multi-pivot capsules
  (single-pivot stays quiet), and measure token delta vs. the existing
  force-inject run.
- **Checklist theater.** The agent may emit a plausible checklist *without*
  actually inspecting (mark `inspected? = yes` for a pivot it never opened). This
  is exactly why verification is tool-call-based, not text-based:
  `checklistVsToolsAgreement` surfaces fabrication.
- **Tool-call log may be absent.** `readOrderedToolCalls` returns `null` when the
  external record carries no ordered log; then per-pivot state is `unknown`, not
  guessed (mirror the existing `nullAgentComplianceFields` discipline at `:1042`).
  If sphinx-7462's record lacks a tool log, the verifier degrades to
  checklist-text-only + patch — log this honestly rather than inventing signal.
- **Over-editing.** Forcing inspection of every pivot risks nudging the agent to
  edit pivots it should have ruled out, trading false-negatives for
  false-positives. The instruction explicitly forbids "edit them all"; the
  `ruled-out-with-reason` path is first-class.
- **Single noisy case.** sphinx-7462 is one stochastic live run; a single
  improved run is suggestive, not proof (see Non-claims).

---

## 7. Minimal implementation plan

1. **Prompt:** in `buildVtraceContextMarkdown`, when the capsule is multi-pivot,
   append the checklist requirement + seed the pivot rows from
   `vtraceCapsulePivots`. (Benchmark-only first.)
2. **Verifier:** add `classifyPivots` + `PivotInspectionRecord` to
   `src/capsule/finalEditDiagnostics.ts` (pure, shape-only). Settle the per-pivot
   classification decision flagged in §4.2.
3. **Wire-up:** call it from the post-hoc stamping pass (~`:3770`), populate the
   new `PivotInspectionFields`, write `_pivot_inspection.snapshot.md`.
4. **Parser:** a small, lenient markdown-table parser to recover the agent's
   emitted checklist from its response text (best-effort; absence ⇒
   `checklistEmitted: false`, not an error).
5. **Tests:** unit-test `classifyPivots` against synthetic tool-call logs
   (`edited`, `inspected`, `ignored`, `unknown` when no log) and the table parser
   against a hand-written checklist — mirroring the existing mocked `*.test.ts`
   pattern (no external deps).

No step touches `src/capsuleV2/**` scoring or the external CLI.

---

## 8. Minimal live validation plan

Run **one case only first**: `sphinx-7462`.

Compare two conditions against the identical baseline already on record:

- **C1 — current force-inject:** `eval-locgap-multipivot-sphinx-7462` (already
  run; the evidence in §2).
- **C2 — force-inject + mandatory pivot-inspection step:** same flags
  (`--context-policy force-inject --capsule-engine v2 --capsule-intent debug
  --capsule-budget 8000`), with the checklist instruction injected.

Read out, for C2:

```
hiddenPivotsIgnored:   expect 0   (was effectively 1 in C1: ast.py::unparse)
pivotInspection[ast.py::unparse].state: expect "inspected" or "edited"
checklistEmitted:      expect true
checklistVsToolsAgreement: report
resolved:              report (NOT the success criterion)
token delta vs C1:     report (bloat risk)
```

**Success is not Docker resolution.** Success is: the agent inspected
`sphinx/pycode/ast.py::unparse` and either edited it or gave a grounded reason not
to. Resolution is reported but not required.

---

## 9. Non-claims

- **Not a retrieval change.** No claim about scoring, candidate generation, or
  ranking; those are untouched. Pivot quality is held fixed — only what the agent
  *does with* the pivots changes.
- **Not a benchmark result.** This is a design spec plus a one-case validation
  plan. It claims nothing about aggregate resolution rates.
- **Not a guaranteed fix.** Forcing inspection makes the hidden pivot impossible
  to silently ignore; it does not guarantee a correct patch on any single
  stochastic run.
- **Not a multi-turn agent.** The minimal design is single-shot (checklist +
  patch in one response, verified post-hoc). The iterative re-prompt loop (§3B)
  is explicitly out of scope until the harness supports carried-over state.
- **Not a model or tool-API change.** The agent model and the external
  `vexp-swe-bench` tool surface are unchanged; the only levers are injected text
  and post-hoc analysis of already-captured artifacts.

---

## 10. Verification

```
bun run typecheck
bun run typecheck:benchmarks
bun test
```
