# Stage 5 — M21 tool-output capture audit

## 1. What this adds

M20 found the blocker to fair in-loop verification was *capture*: agents run the relevant
tests but VTRACE never persisted the command **outputs**, the streams were shared and
clobberable, and revision-phase tool calls were not extracted. M21 closes the capture gap
**additively** (no canonical replacement, no adoption logic, no retrieval/ranking change):

- **Root cause fixed:** real adapter streams nest `tool_result` inside a `user` event's
  content array keyed by `tool_use_id`. The legacy `parseOrderedToolCalls` only looked for
  *top-level* `tool_result` events, so `output_summary` was always null. The new enriched
  parser matches `tool_result → tool_use` by id and captures the output.
- **New pure module** `src/capsule/toolOutputCapture.ts`: `parseEnrichedToolCalls` (bounded
  outputs + `success`/`exitCode` + `truncated` + phase tag), `classifyTestFramework` /
  `extractSelectedTests`, and `deriveTestCommands` (structured test events with a
  conservative patch-state label). Honest: when the stream lacks an output / `is_error`,
  the field stays null — it never parses pytest stdout to fabricate pass/fail.
- **New per-phase persistence** `persistPhaseToolTelemetry` (runner, best-effort, never
  throws, never touches `_tool_calls.json`): copies the phase stream FIRST, then writes the
  enriched calls and derived test commands.

### Artifacts now persisted per label (future runs)

| phase | stream copy | enriched tool calls | derived test commands |
| ----- | ----------- | ------------------- | --------------------- |
| first pass | `_agent_stream.first_pass.jsonl` | `_tool_calls_with_outputs.json` | `_test_commands.json` |
| pivot revision | `_agent_stream.pivot_revision.jsonl` | `_pivot_revision_tool_calls.json` | `_pivot_revision_test_commands.json` |

`_tool_calls.json` / `_tool_calls.summary.json` are unchanged (additive design).

### Bounds & honesty

- output ≤ 8 KiB, outputSummary ≤ 1 KiB (UTF-8 byte-accurate), `truncated=true` when clipped.
- `success` derives ONLY from the stream's `is_error` (success = !is_error); else null.
- `exitCode` only when the stream exposes an explicit field; else null.
- `patchState` is conservative: `first_pass_before_model_patch` /
  `revision_phase_before_revised_patch` / `unknown`. We never claim a test verified a
  final/after patch, because in-loop tests run before that phase's patch is extracted.

### What is still missing (documented, not guessed)

- The adapter stream does not expose an explicit process exit code on Bash results in the
  captures inspected, so `exitCode` will usually be null; `success` depends on `is_error`
  being present. Pass/fail is therefore available only when the stream marks `is_error`.
- Test-name **provenance/fairness** (is the selected test an oracle FAIL_TO_PASS leak?) is
  NOT decided here — that is the next milestone, now that the data is captured.

## 2. Old captured runs vs new capture path

| label | existing `_tool_calls` has command? | existing output available? | stable first-pass stream? | revision-phase stream? | can recover test outcome today? | will future runs capture it? |
| ----- | ----------------------------------- | -------------------------- | ------------------------- | ---------------------- | ------------------------------- | ---------------------------- |
| `eval-m16-ruleout-guard-current-sphinx-7462-r1` | yes (incl. pytest) | no (`output_summary` null) | no | no | no | yes |
| `eval-m16-ruleout-guard-current-sphinx-7462-r2` | yes (incl. pytest) | no | no | no | no | yes |
| `eval-m16-ruleout-guard-current-seaborn-3187-r2` | yes (no pytest) | no | no | no | no | yes |
| `eval-m14-pivot-revision-current-sphinx-7462-r1` | yes (incl. pytest) | no | no | no | no | yes |
| `eval-m14-pivot-revision-current-sphinx-7462-r2` | yes (incl. pytest) | no | no | no | no | yes |

**Old runs are unrecoverable for outcomes.** Their per-label streams were never copied and
the shared `_agent_stream.jsonl` / `_agent_pivot_revision_stream.jsonl` at the results root
have since been overwritten by later runs. The commands survive (in `_tool_calls.json`) but
the pass/fail outcome does not. This is exactly why M21 copies the stream per-phase *before*
any later phase can clobber it.

## 3. Synthetic fixture coverage (what extraction supports)

Unit tests (`src/capsule/toolOutputCapture.test.ts`,
`benchmarks/stage5_vexp_swe_bench_smoke/phaseToolTelemetry.test.ts`) prove on synthetic
streams:

- nested `tool_result` output is extracted and matched to its `tool_use` by id;
- long output is clipped to the byte bound with `truncated=true`;
- missing output / missing `is_error` stays null (no fabrication);
- pytest / unittest / tox / npm / bun / cargo / go are classified; non-test commands
  (`git diff`, `python -c …`) are not;
- pytest node ids and test-file paths are extracted as `selectedTests`;
- revision-phase events carry `phase=pivot_revision` and the conservative revision patch
  state;
- `patchState` never contains an "after" claim;
- first-pass and revision artifacts persist under separate names;
- `_tool_calls.json` schema/behavior is untouched (additive only).

## 4. Outcome for the sphinx r1 vs r2 question

Capture is now in place, but **the historical r1/r2 split cannot be re-derived from old
artifacts** (outcomes unrecoverable). A fresh revision-enabled run (not performed here — no
live agents) would now persist, per phase, the agent's own test command, its bounded
output, and `success` when `is_error` is present — the raw material a future *fair*
adoption signal would need. Whether that signal is fair (test-name provenance) remains the
next milestone.

## 5. Scope / safety

- Additive capture only: no canonical replacement, no revision adoption, revision pass
  still off by default. No live agents, no Docker, no 30/100 sweep.
- No retrieval/ranking/scoring/candidate/Capsule-v2-pivot changes; deterministic retrieval
  eval re-run and byte-identical.
- `_tool_calls.json` unchanged; all new artifacts are separate, `_`-prefixed, untracked.
