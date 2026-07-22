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
non-traceback pivot, _flag_ it as the likely root cause, and the agent still
edits only the traceback-named file.

The product hypothesis is that vtrace differentiates itself not by _providing_
context but by _enforcing context use_:

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

| #   | pivot                                         | role_reason (abbrev.)                                                                | source-anchored?                 |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| 1   | `sphinx/domains/python.py::_parse_annotation` | "source line anchor in the issue points at this symbol — explicit edit site"         | **yes** (traceback / issue line) |
| 2   | `sphinx/pycode/ast.py::unparse`               | "actionable function — exercised by a failing test; symbol-name match; 9 dependents" | **no** (inference-surfaced)      |

The injected snapshot rendered the full multi-pivot preamble _and_ the
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
prevent. The harness recorded the _lead_-pivot compliance (`buildAgentCompliance`
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

1. **One row per pivot.** The agent must account for _every_ pivot, including
   hidden / non-traceback ones — not just the one it intends to edit.
2. **Inspect, don't pre-judge.** `inspected?` means the agent actually opened the
   pivot's file/symbol (a `Read`/`view` on the path). It is not allowed to mark a
   pivot `relevant? = no` without first inspecting it.
3. **Rule out with a grounded reason.** A pivot may end as `edit needed? = no`,
   but only with a concrete reason tied to what the agent saw in the source
   ("only formats the AST string, does not build the xref target"), never a bare
   "not relevant".
4. **No instruction to edit everything.** The agent is forced to _inspect and
   account for_ each pivot, not to edit each one. Editing the smallest correct
   set remains the goal.

The checklist is emitted as text in the agent's response (the only channel
available without a new tool). The harness then **independently verifies** it
against the ordered tool-call log and the final patch — the checklist is the
agent's _claim_; the tool-call log is the _evidence_. Divergence between the two
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
  _ignored_ pivot, re-invoke the agent with a targeted follow-up
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

A function classifies each pivot. This was the load-bearing piece of judgment in
the design; it is now **implemented and settled** as `classifyPivotInspection`
in `src/capsule/finalEditDiagnostics.ts` (pure, shape-only, no per-instance
tables).

**The chosen classification rule (resolves the former `TODO(user)`):**

- **Read-on-path counts as inspected.** A direct read/open whose target is the
  pivot path (`Read`/`view`/`open`/…) means the agent looked at the file's
  contents → `inspected`.
- **Search-only does not.** A grep/search that merely surfaces the path or symbol
  (as the search target or in its output) is `discovered`, never `inspected` —
  search reveals a file _exists_; inspection means the agent _read inside it_.
  Because of this, `discovered` is an observation flag, not a terminal status: a
  pivot seen only in search is still `ignored`.
- **Edited-without-reading is tracked separately.** Editing is taken from the
  final patch (authoritative). A pivot the patch touched **without** a prior
  read/open is `edited_without_inspection`; with a prior read it is `edited`.
- **Ruling out requires inspection first.** `ruled_out` is set only when the
  agent both inspected the pivot _and_ explicitly dismissed it (a checklist
  rule-out claim) — you cannot grounded-ly dismiss a file you never opened.

```ts
export type PivotInspectionStatus =
  | "edited"
  | "edited_without_inspection"
  | "ruled_out"
  | "inspected"
  | "ignored"; // surfaced but neither inspected nor edited — the sphinx-7462 gap

export interface PivotInspectionRecord {
  path: string;
  symbol: string;
  role: "pivot" | "support";
  hidden: boolean; // non-source-anchored pivot (the skip-prone kind)
  discovered: boolean; // appeared in search output/target; NOT engagement
  inspected: boolean; // direct read/open of the pivot path
  edited: boolean; // final patch touched the pivot path
  edited_without_inspection: boolean;
  ruled_out: boolean;
  status: PivotInspectionStatus;
}

export function classifyPivotInspection(
  pivots: readonly PivotForInspection[],
  toolCalls: readonly InspectionToolCall[], // {tool, target?, output?}
  editedFiles: readonly string[], // from editedFilesFromPatch(patch)
  ruledOut?: readonly PivotRuleOut[],
): PivotInspectionRecord[];
```

Status precedence (highest first): `edited_without_inspection` → `edited` →
`ruled_out` → `inspected` → `ignored`.

**Wiring (implemented).** The classifier is threaded through the curated
live-comparison report, `run_stage5_capsule_v2_validation_report.ts`, in
`loadPair` — the one place that already joins the capsule run's
`_run.meta.json` (the pivot list, `vtraceCapsulePivots` / `vtraceCapsuleSupport`)
with the agent's result record (`modelPatch` + `toolCalls`). Three thin,
exported helpers do the adaptation:

- `extractCapsulePivots(runMeta)` — pivots + support as
  `PivotForInspection[]`; `hidden` is derived from `role_reason` (not
  source-anchored), mirroring `renderHuman.isSourceAnchoredPivot`.
- `extractOrderedToolCalls(record)` — returns `{calls, ordered}`. SWE-bench
  records carry only an **aggregate** count object (`{Read: 2, Edit: 2}`) with no
  ordering or targets, so this honestly reports `ordered: false` and the
  inspection signals degrade to patch-only rather than guessing.
- `buildPivotInspection(runMeta, record)` — runs `classifyPivotInspection` and
  reports `toolLogOrdered`.

Because current live records lack an ordered tool log, `inspected` / `discovered`
are _false-by-absence_ (recorded as such via `toolLogOrdered`), while `edited` /
`ignored` come from the patch and are authoritative. On the real
`eval-locgap-multipivot-sphinx-7462` artifacts this yields exactly the target
statement: `sphinx/pycode/ast.py::unparse` → hidden, inspected:no, edited:no,
**status `ignored`**.

### 4.3 No changes to

- Capsule v2 scoring / candidate generation / ranking (`src/capsuleV2/**`
  builder, scorecards, allocator) — untouched.
- The underlying agent model.
- The external `vexp-swe-bench` tool API (no new tools, no new flags into the
  spawned CLI; injection stays the existing `VTRACE_AGENT_INSTRUCTIONS_FILE`
  append at `:4055`).

---

## 5. Required artifacts / logging

**Implemented now (analysis lever).** The validation report
(`run_stage5_capsule_v2_validation_report.ts`) attaches `pivotInspection`
(`PivotInspectionRecord[]`) and `pivotInspectionToolLogOrdered` to each
`ValidationPair`, and renders a **`## Pivot inspection`** markdown section: one
row per surfaced pivot with `hidden / discovered / inspected / edited / status`,
plus an explicit note when no run carried an ordered tool log (so a `false`
`inspected` is not misread as confirmed-not-inspected). This is what produces the
sphinx-7462 statement below.

**Planned (prompt lever, when the checklist is injected).** Per vtrace row,
additionally record:

| field                       | meaning                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `pivotInspection`           | array of `PivotInspectionRecord` (one per surfaced pivot)                  |
| `hiddenPivotCount`          | how many surfaced pivots were non-source-anchored                          |
| `hiddenPivotsInspected`     | of those, how many reached `inspected` or `edited`                         |
| `hiddenPivotsIgnored`       | of those, how many ended `ignored` (the headline gap metric)               |
| `checklistEmitted`          | bool — did the agent's response contain a parseable checklist table?       |
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
- **Checklist theater.** The agent may emit a plausible checklist _without_
  actually inspecting (mark `inspected? = yes` for a pivot it never opened). This
  is exactly why verification is tool-call-based, not text-based:
  `checklistVsToolsAgreement` surfaces fabrication.
- **Tool-call log is absent in practice.** SWE-bench result records carry only an
  aggregate tool-count object (`{Read: 2, Edit: 2}`), no ordering or file targets
  (confirmed on sphinx-7462). The classifier handles this honestly: with no
  ordered log, `inspected` / `discovered` are false-by-absence and
  `pivotInspectionToolLogOrdered` is `false`, so a reader does not mistake them
  for confirmed-not-inspected; `edited` / `ignored` still come from the patch and
  are authoritative. Getting true `inspected`/`discovered` signal requires the
  external adapter to emit an ordered tool log — a follow-up, not this change.
- **Over-editing.** Forcing inspection of every pivot risks nudging the agent to
  edit pivots it should have ruled out, trading false-negatives for
  false-positives. The instruction explicitly forbids "edit them all"; the
  `ruled-out-with-reason` path is first-class.
- **Single noisy case.** sphinx-7462 is one stochastic live run; a single
  improved run is suggestive, not proof (see Non-claims).

---

## 7. Minimal implementation plan

**Done in this change (post-hoc verifier + reporting):**

2. ✅ **Verifier:** `classifyPivotInspection` + `PivotInspectionRecord` in
   `src/capsule/finalEditDiagnostics.ts` (pure, shape-only), implementing the §4.2
   rule.
3. ✅ **Wire-up:** `extractCapsulePivots` / `extractOrderedToolCalls` /
   `buildPivotInspection` in `run_stage5_capsule_v2_validation_report.ts`, called
   from `loadPair`, rendered as the `## Pivot inspection` section.
4. ✅ **Tests:** the 8 required cases for `classifyPivotInspection` in
   `finalEditDiagnostics.test.ts`, plus wiring/sphinx-7462 tests in the report's
   test file (mocked, no external deps).

**Not in this change (the prompt lever / live loop — deliberately deferred):**

1. **Prompt:** in `buildVtraceContextMarkdown`, when the capsule is multi-pivot,
   append the checklist requirement + seed the pivot rows from
   `vtraceCapsulePivots`. (Benchmark-only first.)
2. **Parser:** a small, lenient markdown-table parser to recover the agent's
   emitted checklist from its response text, feeding `classifyPivotInspection`'s
   `ruledOut` argument (best-effort; absence ⇒ `checklistEmitted: false`).

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

### Live validation result (first run) — done

C2 was implemented (compact `PIVOT_CHECK`, commit `13c7a25`) and run as
`eval-pivot-check-vtrace-sphinx-7462`. Actual readout vs. the expectations above:

```
pivotInspection[ast.py::unparse].state: inspected   ✓ (was discovered-only/ignored in C1)
hidden pivot directly Read:             twice        ✓
checklistEmitted:                       false        ✗ vs. the "expect true" above
vtraceToolLogOrdered / toolCallCount:   true / 11
resolved (Docker):                      reported separately, NOT the criterion
```

The behavioral success criterion was met — the hidden pivot was inspected. But the
`checklistEmitted: expect true` line above was **wrong**: the agent complied with
the inspection behavior without echoing the checklist table. This confirms the
design's own §4.2 priority — **ordered tool evidence is authoritative; the emitted
checklist is secondary** — and is the reason `checklistVsToolsAgreement` keeps
row-level parsing as a TODO rather than a gate. Full write-up:
[`capsule_v2_context_to_action_gap.md`](./capsule_v2_context_to_action_gap.md).

---

## 9. Non-claims

- **Not a retrieval change.** No claim about scoring, candidate generation, or
  ranking; those are untouched. Pivot quality is held fixed — only what the agent
  _does with_ the pivots changes.
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
