# Stage 5 — M4 matplotlib-22719 regression root-cause audit

Generated: 2026-06-14. Read-only audit (no live agents, no Docker, no retrieval/scoring/policy changes). It explains why the current-default M4 run for `matplotlib__matplotlib-22719` regressed even though an earlier compact inspect-first run was a strict PASS, by comparing immutable artifacts of the relevant runs under `benchmarks/stage5_vexp_swe_bench_smoke/results/runs/`.

## Verdict

```
verdict: likely_stochastic
```

Compounded by a **comparison_mismatch** in how the M4 gate chose its "old" baseline. **Not** an implementation regression from Milestones 1/2/3/5, and **not** a telemetry/accounting bug. No code was changed.

**Next action (per rules):** propose an n≥3 paired rerun plan (below) and correct the M4 comparison framing; do **not** rerun live in this task.

## One-paragraph answer

The current-default M4 matplotlib run did not regress because of any product change. Its injected context is **byte-identical** to the earlier passing compact inspect-first run (same 9587-char snapshot, same Capsule v2 engine, same pivots/neighborhood, same accounting), and in both runs the agent did the *same optimal thing*: it Read the gold file and Edited it immediately at tool-call index 1 (patch-first, no exploration). The entire difference is **post-edit Bash self-verification depth** — 4 verification commands in the passing run vs 10 in the M4 run — which, because cache-read scales ~linearly with turns (~33k tokens/turn), inflated total tokens from 646k to 1.28M. Across five identically-configured matplotlib runs the totals span 646k–1.28M (≈2×), all resolved. That spread on identical input is stochastic trajectory variance. The M4 *report* additionally compared against a leaner-shaped older baseline (`turn-reduction-canary`, which predates inspect-first / pivot-neighborhood / PIVOT_CHECK), so its +58% headline mixed a context-shape change with the stochastic draw; the correct matched baseline (`compact-inspectfirst`, 646k) shows current-default is simply a high draw.

## Runs compared

| Role | Label | Date | total tok | cacheRead | turns | Bash | resolved |
|---|---|---|---:|---:|---:|---:|:--:|
| Passing canary (matched context) | `eval-product-v2-compact-inspectfirst-matplotlib-22719` | 06-13 19:23 | 646,055 | 591,028 | 18 | 4 | yes |
| M4 "old" baseline (leaner context) | `eval-product-v2-turn-reduction-canary-matplotlib-22719` | 06-12 | 808,673 | 754,376 | 23 | 6 | yes |
| neighborhood (verbose) | `eval-product-v2-neighborhood-matplotlib-22719` | 06-13 | 872,800 | 758,575 | 24 | 7 | yes |
| default-v2-migration | `eval-default-v2-migration-matplotlib-22719` | 06-13/14 | 850,113 | 730,041 | 23 | 4 | yes |
| **M4 current-default (fail)** | `eval-current-default-matplotlib-22719` | 06-14 12:38 | **1,281,852** | **1,216,925** | **34** | **10** | yes |

All five share identical run config: `dist/cli.js run --no-vexp`, Capsule **v2**, intent **auto**, policy **inject**, tool-discipline v1, **hard gate off**. All resolved. Totals span ~2×.

## 1. Context-delivery comparison (passing canary vs current-default)

| Dimension | compact-inspectfirst (PASS) | current-default (M4 fail) |
|---|---|---|
| requestedCapsuleEngine | v2 | v2 |
| effectiveCapsuleEngine | v2 | v2 |
| fallbackReason (workspaceGitFallbackUsed) | no | no |
| compactInspectFirst (pivotNeighborhood) | yes | yes |
| policyAction | inject | inject |
| context injected | yes | yes |
| capsule intent | auto | auto |
| capsule budget | 8,000 | 8,000 |
| pivotNeighborhood present | yes | yes |
| # pivots / # excerpts | 2 / 8 | 2 / 8 |
| pivotsEnriched | 2 | 2 |
| first inspect-first target | `lib/matplotlib/category.py::convert` | `lib/matplotlib/category.py::convert` |
| confidence | high | high |
| surface/root distinction | `axis.py` = surface, `category.py` = edit site | identical |
| accounting est. first-call tokens | 12,124 | 12,411 (chars/4 noise) |
| **injected snapshot** | **9587 chars / 206 lines** | **9587 chars / 206 lines** |

`diff` of the two `_vtrace_instructions.snapshot.md` files is **empty (IDENTICAL)**. The two runs delivered the same context byte-for-byte.

## 2. Injected-context text diff

- Inspect-first block: unchanged; leads the context at line 13, `confidence: high`, names the gold `category.py::convert` as likely-first.
- Likely-first target: unchanged (`category.py::convert`); `axis.py` correctly demoted to surface.
- pivotNeighborhood verbosity: unchanged (compact, 8 excerpts, bodies not inlined).
- No impact section, no logic-flow section in either snapshot (grep for "impact graph"/"logic flow"/"blast radius" → none). M3 excerpts/M5 intent unification did **not** add impact/flow sections for this case.
- No accidental **hard-gate** text and no two-phase preflight text (hard gate is off; confirmed by meta `pivotCheckGate=n/a` and absence of preflight/phase streams).
- **PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY blocks are present** in the current-default snapshot — but they are present **identically in the passing canary** (snapshots are byte-identical). They are injected by the default `--pivot-check-policy strict_risk_gated` (a soft, deterministic, pre-existing benchmark policy for risk-gated multi-pivot cases), **not** by the hard gate. See "Secondary finding" below.

## 3. Intent behavior (M5 audit)

Both runs: engine v2, intent **auto**, policy **inject**, identical snapshot. No impact/flow section fired in either (matplotlib's shaped query is not refactor-like, so impact is correctly skipped; flow has insufficient endpoints). M5 "Unify context intent routing" did **not** change matplotlib's resolved intent, did not add procedural sections, and did not enlarge the prompt — the post-M5 default snapshot is byte-identical to the pre-M5 (06-13) compact run. Intent is ruled out as a cause.

## 4. Tool trajectory

Ordered telemetry (`_tool_calls.json`), both runs:

| | compact-inspectfirst (PASS) | current-default (M4 fail) |
|---|---|---|
| total tool calls | 6 | 12 |
| call 0 | Read `lib/matplotlib/category.py` | Read `lib/matplotlib/category.py` |
| call 1 | **Edit `category.py`** (the fix) | **Edit `category.py`** (the fix) |
| calls 2..n | 4× Bash | 10× Bash |
| Read / Grep | 1 / 0 | 1 / 0 |
| files read before category.py | 0 | 0 |
| tests run before first edit | 0 | 0 |
| first edited file | gold `category.py` | gold `category.py` |
| turn of first edit | 1 | 1 |

Both runs localize perfectly and patch-first (edit at index 1, zero pre-edit search). The +11 turns / +6 Bash are **entirely post-edit self-verification**: the M4 draw ran extra edge-case probes (empty list, numeric-still-warns, `is_numlike`, `_is_natively_supported`, multiple scenarios) and a `pip install -e .` rebuild, where the canary ran 4 focused checks. No failure/retry loop, no re-localization, no context-ignored behavior — just deeper voluntary verification of the same correct patch.

Cache-read scales ~linearly with turns across the five runs (591k@18t, 754k@23t, 759k@24t, 730k@23t, 1217k@34t ≈ 33k/turn), so the extra verification turns directly produce the extra cache-read tokens.

## 5. Patch comparison

| | PASS | M4 fail |
|---|---|---|
| edited files | `lib/matplotlib/category.py` | `lib/matplotlib/category.py` |
| gold file edited | yes | yes |
| functional change | empty-input guard in `StrCategoryConverter.convert` | same guard |
| Docker resolved | yes | yes |

Both resolve with the same gold-file edit. The M4 run is not a worse patch; it is the same fix reached with more post-edit verification.

## 6. Accounting / telemetry attribution

- Totals are genuine, not a reporting artifact: M4 = input 244 + output 65 + cacheRead 1,216,925 + cacheCreation 64,618 = 1,281,852.
- Exactly **one** swebench JSONL row per label (single solve stream). No phase1/phase2 streams, no probe/scratch stream, no `vtrace_pivot_check_phase1` dir — the current-default run dir contains only the single `raw/vtrace` solve plus the first-call probe JSON.
- No run-label collision (each run has its own label/dir; the lesson "one label per instance" is honored).
- The probe `accounting.estimatedOutputTokens` (~12.4k) is a first-call chars/4 estimate of the injected capsule, kept separate from the agent's solve totals; it is not summed into the 1.28M.

No telemetry bug.

## Why earlier compact inspect-first "passed" and M4 "failed"

1. **Different reference baseline.** The canary's PASS was measured prior→product within the *same* enrichment family and against a bloated `eval-controlled-vtrace` history (2.7M tok, unresolved); the M4 gate measured current-default against `turn-reduction-canary` (a leaner, pre-inspect-first/pre-PIVOT_CHECK shape). Neither is wrong, but they are different baselines.
2. **Single live draws.** PASS = a low draw (646k/Bash4); M4 = a high draw (1.28M/Bash10) of the *same* configuration with *identical* injected context. The 2× spread is stochastic verification-loop depth, not a product change.

## Secondary finding (not the regression cause; not patched here)

The default `run-protocol --protocol vtrace-indexed` path injects the **soft** PIVOT_CHECK + EDIT_GUARD + PATCH_VERIFY blocks (via default `--pivot-check-policy strict_risk_gated`) for risk-gated multi-pivot cases like matplotlib. The **hard** gate (`--pivot-check-gate`) is correctly **off**. These soft blocks were *added between 06-12 and 06-13* (the 06-12 `turn-reduction-canary` snapshot lacks them; the 06-13 `compact-inspectfirst` and 06-14 `current-default` snapshots include them). They are present **in every comparable run including the PASS**, so they do not cause the regression — but their presence means the M4 gate was **not** the "pure context provider, no enforcement" single-shot path that the milestone reconciliation (§9) prescribed for a clean headline measurement. This is a measurement-cleanliness issue, addressed by the rerun plan via `--disable-pivot-check`, not a code bug. It is **not** patched here because: it is intended/default policy (not accidental), it is constant across the comparison, and the task forbids changing policy on speculation.

## n≥3 paired rerun plan (do NOT run in this task)

Goal: separate stochastic variance from any true effect, on a clean matched baseline.

1. **Matched apples-to-apples, n≥3 per arm.** Both arms identical except the variable under test. Use the *same injected-context shape* (current default v2) so the only difference is run-to-run noise:
   - Arm A (current default): `--mode run-protocol --protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting`, labels `eval-rerun-default-matplotlib-22719-{1,2,3}` (one label per run — no reuse).
   - Report median and full range of total tokens, cacheRead, Read+Grep+Bash, turns, resolved.
2. **Clean "pure context provider" arm, n≥3.** Same as Arm A but add `--disable-pivot-check` (removes the soft PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY blocks) to measure the headline path the reconciliation intended, labels `eval-rerun-nopivotcheck-matplotlib-22719-{1,2,3}`.
3. **Decision rule.** The gate's "tokens/cacheRead/Read+Grep+Bash down with preserved resolution" must be judged on the **median of n≥3**, against a matched-shape baseline (also n≥3) — never on a single draw. A single high or low draw is not evidence either way given the observed ≈2× spread.
4. Each run: separate `--run-label`, then `--mode evaluate --eval-mode docker`. Do not fold no-enforcement runs into the same headline as enforcement runs without labeling.

This is a plan only; no live agents or Docker were run.

## Constraints honored

No live agents, no Docker, no 100-task run, no retrieval/scoring/candidate/intent/auto-policy changes, no raw artifacts staged, stayed on main. No code changed (verdict is likely_stochastic + comparison_mismatch, neither of which is a concrete code bug under the patching rules).

## Non-claims

- All live figures are single runs (n=1 per cell); the variance argument rests on the spread across five same-config runs, still a small sample.
- This audit does not claim the current path is better or worse than prior; it claims the matplotlib delta is dominated by trajectory stochasticity and a baseline-shape mismatch, not a product regression.
- The M4 gate verdict (NOT CLEARED) is unchanged: even against the matched 646k baseline, current-default (1.28M) is a worse draw, and astropy remains unresolved both arms. The gate should be re-decided on the n≥3 plan above.
