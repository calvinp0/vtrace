# Stage 5 M55V Capsule v2 Digest Validation

Validation of the M55 VEXP-shaped Capsule v2 product `digest` (commit `14bb847`).
This is a **validation milestone, not feature work**. No retrieval/scoring/ranking/
candidate-generation/corrective/oracle code was touched.

## Summary

- **Cases considered:** 4 targeted (sphinx-7462, matplotlib-22719, matplotlib-24627, seaborn-3187). All four have abundant prior Stage 5 artifacts.
- **Conditions run live this milestone:** 0. No live agents were spawned (live runs are approval-gated per `CLAUDE.md`, cost money, and — see below — would have been *invalid* for isolating the digest).
- **Valid M55-digest runs:** 0. **Invalid / not-applicable:** the whole experiment as specified.
- **Headline resolution result:** n/a — no valid digest condition could be produced.
- **Headline token/cost/tool-turn result:** n/a — see blocker.
- **Did the M55 digest move behavior in the right direction?** **Undetermined and currently unmeasurable via the Stage 5 live path** — the digest is not the surface that path injects.

### Decisive finding (the required-first-step blocker)

The M55 `digest` is a field on the **MCP product response** (`get_context_capsule` /
`run_pipeline` → `capsuleV2.digest`). It is produced by `toCapsuleV2ProductResponse`
in `src/capsuleV2/productAdapter.ts`.

The Stage 5 **live** harness does **not** inject that field. It re-renders the
injected context itself, at
`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts:4509-4517`:

```ts
const inspectFirstText = renderInspectFirstText(
  buildInspectFirst(toCapsuleV2ProductResponse(result), neighborhood),  // uses pivots/support, NOT .digest
);
const neighborhoodText = renderPivotNeighborhoodsText(neighborhood);
const rendered = renderCapsuleV2Human(result).trim();                    // separate human render, NOT .digest
const context = [inspectFirstText, rendered, neighborhoodText]...
```

`toCapsuleV2ProductResponse(result)` is called only to feed `buildInspectFirst`
(which reads `pivots`/`support`), and the body of the injected context is
`renderCapsuleV2Human(result)`. **`.digest` is never read.**

Worse for the experiment: the existing injected render **already** carries the
VEXP role glyphs and budget line the milestone's digest-presence check looks for.
`src/capsuleV2/renderItem.ts:14` (`roleBullet`) returns `●`/`○`, `renderItem.ts:25`
already appends pivot evidence, and `renderCapsuleV2Human` already prints a
`budget:` line. Empirically, a **pre-M55** v2 run snapshot
(`runs/eval-default-v2-migration-matplotlib-22719/_vtrace_instructions.snapshot.md`)
contains:

```
budget: 601 / 8,000 tokens used
● pivot lib/matplotlib/axis.py::convert_units
○ support lib/matplotlib/category.py::convert
```

So the markers `● pivot` / `○ support` / `budget:` are **necessary-but-not-sufficient**
to prove the M55 digest specifically — they appear in any v2 run, M55 or not.

**Conclusion:** a `--capsule-engine v2` Stage 5 run does not surface the M55 digest,
and its presence-markers cannot distinguish the digest from the pre-existing render.
Any such run is `m55_digest_not_present` and must not be counted. The milestone's
core experiment is therefore **INVALID as specified** until the digest is
deliberately wired into the injected context.

## Activation Path

| Question | Answer |
|---|---|
| Does `get_context_capsule` require `capsule_engine=v2`? | **Yes.** Opt-in; default stays v1. `tools.ts` reads `capsule_engine`/`capsuleEngine`; only `=v2` builds the v2 product response (incl. `digest`). |
| Does `run_pipeline` require `capsule_engine=v2`? | **Yes.** Same opt-in; default path omits the `capsuleV2` section entirely. |
| Any config/default/preset that sets `capsule_engine=v2` automatically? | **No.** MCP default is v1. The Stage 5 runner flag `--capsule-engine` defaults to **`legacy`**, not v2. |
| Exact tool-call shape to get the new digest | MCP `get_context_capsule` (or `run_pipeline`) with `{ query: "...", capsule_engine: "v2" }` → response field `capsuleV2.digest` (string). The Stage 5 **live harness does not call this path** for its injected context. |
| Where the envelope-level accounting lives | MCP envelope `output.accounting` (built by `buildContextAccountingBestEffort` → `src/metrics/contextAccounting.ts`): `latencyMs`, `estimatedOutputTokens`, `estimatedNaiveFullFileTokens`, `estimatedTokensSavedVsNaiveFullFile`, `estimatedSavingsPercentVsNaiveFullFile`, `method=chars_div_4`, `baseline`. **Not** inside the pure `digest`. |
| Where ordered tool calls are stored | Per labelled run: `runs/<label>/raw/vtrace/_tool_calls.json` (ordered, categorised read/search/edit) and `_tool_calls.summary.json`; agent stream in `_agent_stream.jsonl`; result row in `raw/vtrace/swebench-*.jsonl`; meta in `_run.meta.json` / `_eval.meta.json`. |

**Is the v2 digest default or opt-in?** Opt-in at the MCP layer; **not injected at all**
by the Stage 5 live path.

## Case Selection

All four preferred cases exist locally with rich prior artifacts (baseline + multiple
VTRACE arms across M10–M53). None contains the M55 digest (it postdates them, and the
harness does not inject it), so none can serve as the M55 `C` condition.

| instance_id | reason selected | prior known issue | conditions available (pre-M55) |
|---|---|---|---|
| sphinx-doc__sphinx-7462 | known context-to-action / hidden (non-traceback) pivot gap (`pycode/ast.py::unparse`) | python.py-only patch can never resolve; needs ast.py edit (see project memory) | baseline + many vtrace arms (m10–m53) |
| matplotlib__matplotlib-22719 | known extra tool-turn / cache-read overhead; localization-gap | repeated edit-guard / patch-verify / risk-gated experiments | baseline + vtrace (localization-gap, riskgated, etc.) |
| matplotlib__matplotlib-24627 | known localization-gap candidate | prior vtrace run unresolved at 85 turns / $1.13 | localization-gap baseline + vtrace |
| seaborn__seaborn-3187 | known multi-file co-edit / context-to-action gap | m10 co-edit, m11/m12 pivot-contract arms | baseline + vtrace (m10/m11/m12/m32/m36) |

Selection was by **known prior issue**, not expected pass/fail, per the milestone.

## Results Table

No valid M55-digest (`C`) condition could be produced this milestone, so there is no
digest results row to report. Prior-artifact characterization (clearly **pre-M55**,
**not** a digest measurement) for the VTRACE arm of three cases:

| instance_id | condition | resolved | patch | turns | cost | digest_present |
|---|---|---|---|---|---|---|
| matplotlib-22719 | prior vtrace (localization-gap, pre-M55) | true | yes | 41 | $0.615 | n/a (digest not injected) |
| matplotlib-24627 | prior vtrace (localization-gap, pre-M55) | false | yes | 85 | $1.130 | n/a |
| sphinx-7462 | prior vtrace (localization-gap, pre-M55) | false | yes | 18 | $0.249 | n/a |

These are context only; they do **not** measure the digest.

## Paired Deltas

None computable. There is no `vtrace_m55_capsule_v2_digest` condition to pair against
baseline, because the digest is not in the live injection path. The strongest
available comparison (baseline vs vtrace) already exists in prior artifacts but
reflects the **pre-M55 render**, not the digest.

## Context-to-Action Notes

- **What the digest would show vs what is injected today:** the digest adds, over the
  current `renderCapsuleV2Human` injection, only: a `# query` header, per-item
  `[mode ~Nt]` content tags, `why:` lines on **support** (pivots already get evidence),
  and `→ impact` / `◎ memory` / `◇ rule` lines. In the Stage 5 path those impact/memory/
  rule seams are **unpopulated** (the adapter is called with no seam args), so the digest
  would currently render only `●`/`○` + budget — i.e. near-identical to today's render.
- **Net new signal the digest could add** is therefore small and mostly the
  impact/memory/rule lines, which are exactly the seams left unwired in M55.
- No pivot-inspection reclassification was produced (no run), so the discovered/
  inspected/edited/ignored/ruled_out telemetry is not populated this milestone.

## Verdict

**INVALID** — the M55 digest is not the surface the Stage 5 live path injects, and the
digest-presence markers it shares with the pre-existing `renderCapsuleV2Human` output
cannot isolate the digest's effect. No comparable pre/post artifacts exist, and no
valid `C` condition can be produced without a deliberate harness change. Per the
milestone's own rule, runs in this state are `m55_digest_not_present` and are not
counted.

This is a finding about **wiring/measurability**, not a claim that the digest is good
or bad.

## Recommendation

**Do not proceed to a 20–30 task breadth run on the strength of M55.** Instead, pick a
lane first:

1. **Revisit context-to-action / injection wiring (recommended).** Decide whether the
   digest is meant to be the agent-facing first-call surface. If yes, wire it into the
   Stage 5 injected context behind an explicit **test-only flag**
   (e.g. `--inject-capsule-digest`), and **fold the impact/memory/rules seams** into it
   first — otherwise the digest is near-identical to today's `renderCapsuleV2Human`
   output and there is nothing new to validate. Then a controlled 4-case
   baseline-vs-digest A/B can be run (requires explicit approval; costs money).
2. **Otherwise treat M55 as an MCP-surface-only improvement** for external consumers
   calling `get_context_capsule` / `run_pipeline`, and validate it at the **MCP layer**
   (digest shape/coverage/determinism — already covered by `productAdapter.test.ts` and
   `mcp.test.ts`), not via live SWE-bench.

In both cases: **fold impact/memory/rules into the digest before any breadth run**, since
that is the only materially new signal over the render already injected today.

## What was NOT run, and why

- **Live agents (baseline / vtrace digest A/B):** not run. Approval-gated (`CLAUDE.md`),
  and — decisively — would be invalid for isolating the digest (it is not injected).
- **Docker evaluation:** not run (no new patches were produced).
- **Retrieval evals:** not run — no retrieval/scoring/ranking code was touched this
  milestone (validation only).
