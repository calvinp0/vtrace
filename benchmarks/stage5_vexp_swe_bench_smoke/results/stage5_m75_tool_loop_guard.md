# Stage 5 M75 Tool Loop Guard

> **Implementation + offline validation only.** No live agents, no Docker, no API spend,
> no new benchmark. The guard is **DEFAULT-OFF** behind `--tool-loop-guard`. It changes
> NO retrieval / scoring / ranking / candidate generation, NO Capsule v2, NO digest
> decision contract, NO pivot-confidence gate, NO optional-impact behavior. The M73
> benchmark result is untouched.

## Summary

- **Rule implemented.** A deterministic repeated-failure / repeated-read tool-loop guard
  (candidate **C1** from the M74 audit). It detects six loop shapes over the captured
  tool-call stream — repeated byte-identical failed command, repeated same-family+error
  command, repeated unproductive file read, repeated dead search, repeated edit/write
  failure, and high repeated-read density over a sliding window — normalizes volatile
  noise out of the signatures, and renders a compact recovery instruction tagged with a
  stable `<VTRACE_TOOL_LOOP_GUARD>` marker.
- **Flag name.** `--tool-loop-guard` (explicit, boolean).
- **Default behavior changed?** **No.** Off by default; with the flag absent, runs and
  `_run.meta.json` are byte-identical to before (the guard block is only added when the
  flag is set).
- **Runtime integration point.** The external `vexp-swe-bench` harness owns the agent turn
  loop (our wrapper injects context once up-front and reads the stream back afterwards), so
  M75 runs the guard in **OBSERVE mode**: after each run's tool-call stream is persisted,
  `computeToolLoopGuardMeta` runs the PURE detector and records additive `tool_loop_guard_*`
  metadata describing what the guard *would* inject. Mid-loop injection needs a future hook
  into the external harness and is explicitly out of scope for M75.
- **Offline replay result.** Over the 99 captured M71/M72/M73 treatment runs (no agents):
  the guard fires on **5/9 (56%)** of the M74 cost-cap + thrashing cases, **0/10** of the
  treatment-only wins, **0/7** of the baseline-only losses, and only **3/54 (5.6%)** of the
  normal resolved controls — every control firing tied to a genuine repeated read.
- **Recommendation.** **Proceed to a small live validation with the guard enabled**, but
  pair it with the budget-aware cost guard (C7) for early intervention, because in the
  cap-hit cases the loop often only becomes detectable mid/late in the run.

## M74 Evidence Recap

The M74 Self-Harness-lite audit classified all 100 benchmark tasks and found the largest,
cleanest treatment-failure cluster was **cost-cap exhaustion / tool-loop thrashing**:

- 6 treatment runs pinned the ~\$3 per-run cost cap; **0 of 6 resolved**.
- 9 runs tripped the thrashing signal (`repeated_file_reads >= 5` or `tool_calls >= 25`).

C1 was chosen because it is the smallest, most general, fully offline-detectable
intervention; it targets the cluster with the clearest signal (cap-hits resolve at 0%, so
there is almost no resolution to lose); and its changed-behavior evidence (repeated-read /
failed-command counts, fire turns) is directly measurable on existing traces.

**Why this is not retrieval tuning.** The guard reads only the agent's *own* tool-call
trajectory (reads, searches, shell exit codes, edit failures). It never consults retrieval
candidates, ranking, the Capsule, the digest contract, or any gold label. It cannot change
what context is surfaced — only advise the agent when it is visibly looping. The detector is
a pure function of the tool-call stream.

## Implementation

- **Module:** `benchmarks/stage5_vexp_swe_bench_smoke/toolLoopGuard.ts` — PURE (no I/O, no
  clock, no randomness), benchmark-scoped, mirroring the existing `pivotCheckGate.ts`
  pattern. Not wired into any MCP/product path.
- **Detector (`runToolLoopGuard`)** — single forward pass over normalized
  `ToolLoopGuardEvent`s. Trigger types:
  1. `repeated_failed_command` — same normalized failed command ≥2× (threshold 2).
  2. `repeated_command_family_error` — same command family + same error signature ≥3×
     (threshold 3; weaker signal, so a higher bar — two *distinct* erroring commands can
     share a family).
  3. `repeated_read` — same file read ≥3× in a streak (threshold 3).
  4. `repeated_search` — same query+path with no new result ≥2× (threshold 2).
  5. `repeated_edit_failure` — same edit/write target failing the same way ≥2×.
  6. `repeated_read_window` — ≥4 repeated reads within a 6-event sliding window.
  - **Progress resets.** An intervening **edit** resets read streaks AND advances an
    edit-generation counter, so a failed command that recurs only *after* an edit is treated
    as a fix-and-reverify attempt (red→edit→red), **not** a dead loop. A **new search
    result** (or first-time search) also resets read streaks. These resets implement the
    spec's "without intervening edit or new evidence" condition and are what keep the
    red→green→red verify cycle from looking like thrashing.
- **Signature normalization (`normalizeCommand`, `normalizeErrorSignature`).** Strips
  hex addresses, timestamps, absolute temp/workspace/`.bench-repos`/run paths (→ basename),
  `eval-…` run labels, and `line N` / `:N:N` numbers. **Preserves** the meaningful tokens:
  exception/error class, missing module, missing file, command-not-found, permission denied,
  syntax error, and test-failure class. Two identical actions differing only by a temp path
  collapse to one signature; an `ImportError` and a `ValueError` do not.
- **Guard injection text (`renderToolLoopGuardMessage`).** Compact, marker-tagged. Read/
  search loops get "stop re-reading unchanged; state your hypothesis and inspect a different
  file / edit the likely target / run a focused verification command"; command/edit failure
  loops get "do not retry unchanged; summarize what failed, inspect current state, choose a
  different recovery; if no file changed yet, make the smallest testable progress move."
- **Caps / cooldowns (anti-spam).** `maxInjections` per run = **3**; cooldown = **≥3 tool
  calls** between injections; each signature warns **once**. Diagnostic counters
  (`repeated*Count`) accumulate regardless of caps so the replay can characterize thrash even
  when the guard self-suppresses.
- **Runtime metadata (`toolLoopGuardMeta`).** Emits `tool_loop_guard_enabled`,
  `tool_loop_guard_injection_count`, `tool_loop_guard_events` (turn, trigger_type, signature,
  repeat_count), `tool_loop_guard_signatures`, `tool_loop_guard_first_event_turn`,
  `tool_loop_guard_last_event_turn`, plus `tool_loop_guard_mode: "observe_post_run"` and the
  config. Spread into `_run.meta.json` **only when the flag is set**.
- **Default-off behavior.** `DEFAULT_TOOL_LOOP_GUARD_CONFIG.enabled = false`; the disabled
  detector returns `wouldFire=false`, zero injections, and inert metadata. With the flag
  absent, `computeToolLoopGuardMeta` returns `{}` and the run meta is unchanged.

## Offline Replay

`run_stage5_m75_tool_loop_guard_replay.ts` reads the already-captured
`_tool_calls_with_outputs.json` (rich: command/exitCode/success/output) for all 99 treatment
runs and runs the enabled detector. Deterministic (byte-identical across repeated runs); uses
no gold labels. Groups are assigned from the M74 classification (priority: cap-hit → thrash
→ treatment-only win → baseline-only loss → no-patch → high-cost → normal resolved control).

| group | cases | guard_fired | early_fire | late_fire | resolved | mean cost | false-positive notes |
|---|---|---|---|---|---|---|---|
| cap_hit (≥\$2.9) | 6 | 3 | 2 | 1 | 0 | \$3.015 | misses are volume-driven exhaustion, not loops (see below) |
| thrashing_signal | 3 | 2 | 2 | 0 | 2 | \$1.18 | the 2 fires are resolved runs with genuine early re-reads |
| treatment_only_win | 10 | 0 | 0 | 0 | 10 | \$0.63 | **no disruption of wins** |
| baseline_only_loss | 7 | 0 | 0 | 0 | 0 | \$0.57 | no spurious fires |
| no_patch_exhaustion | 1 | 0 | 0 | 0 | 0 | \$0.51 | not loop-shaped |
| normal_resolved_control | 54 | 3 | 3 | 0 | 54 | \$0.51 | all 3 = `repeated_read` tied to real repeats; runs still resolved |
| other_unresolved | 18 | 1 | 1 | 0 | 0 | \$0.45 | — |

**Headline.** cap-hit fired 3/6 (2 before the 75% mark); thrash-or-cap fired **5/9 (56%)**;
normal-control fired **3/54 (5.6%)**; treatment-only-win fired **0/10**.

**Cap-hit fires:** `astropy-14598` (turn 29/32), `django-15503` (28/44), `django-16263`
(10/35) — all via `repeated_read`.
**Cap-hit misses (honest scope limit):** `pylint-4551` (0 repeated reads, 0 repeated
failures — reached the cap through high-*volume* diverse activity, not a tight loop),
`sympy-12419` (repeated reads spread across paths, never a 3-streak to one file),
`sympy-15599` (its repeated failures were separated by edits → correctly *not* a loop). The
guard targets loop-shaped exhaustion; pure volume/budget exhaustion is the separate cost
guard's (C7) domain, which M75 does not implement.
**Control fires:** `astropy-14539`, `pydata-xarray-3677`, `sphinx-9698` — each re-read one
file ≥3× early; the runs recovered, so these are acceptable per the spec's "false positives
acceptable only if … clearly tied to repeated actions." All are genuine repeated reads, not
artifacts of signature collapse.

**Thresholds are principled defaults, not fit to these instances** (2 for exact repeats, 3
for the weaker family-error and read signals). No threshold was tuned to flip a specific
benchmark task, so the result does not depend on benchmark-specific leakage.

## Future Live Validation Plan

*(Designed here; NOT run in M75.)*

- **Selected candidate cases (8–12 treatment runs):**
  - Cap-hit / loop targets (4): `astropy-14598`, `django-15503`, `django-16263`,
    `sympy-12419` (a miss — tests recall sensitivity).
  - Treatment-only wins to protect (2): `matplotlib-24627`, `django-13112`.
  - Baseline-only losses (2): `sympy-12419` is a loss too; add `django-15572`.
  - No-patch exhaustion (1): `django-13513`.
  - Normal resolved controls (2–3): `astropy-14539`, `sphinx-9698` (must stay resolved).
- **Expected run count:** 8–12 guarded treatment runs vs the matched prior unguided
  treatment artifacts (same model/scaffold class, same cost/turn caps, paired).
- **Success criteria:** validity ≥ prior; resolution non-regressive on the full paired set;
  pooled cost non-regressive (the guard should *reduce* cost on loops); tool-call reduction
  on the cap-hit/loop subset; changed-behavior evidence (guard fired and the post-fire
  trajectory differs); and at least some injections landing **before** the cost cap.
- **Stop conditions:** abort/quarantine if resolution drops > 1 net paired loss, if cost
  rises, if invalid/no-patch cases increase, or if changed-behavior evidence is absent.

## Tests

`toolLoopGuard.test.ts` (25 tests) + a parseArgs wiring test in
`run_stage5_vexp_swe_bench_smoke.test.ts`, covering all 14 required cases:

1. identical failed command ×2 → fires. 2. same family + normalized same error → fires (at
family threshold). 3. volatile paths/timestamps/addresses normalized (and meaningful
differences preserved). 4. distinct errors/commands do not collapse. 5. repeated read fires
only at threshold. 6. repeated read suppressed by an intervening edit or new search. 7.
repeated identical search with no new result fires (new result suppresses). 8. respects
`maxInjections`. 9. respects cooldown. 10. same signature warned once. 11. default-off is
inert / byte-identical. 12. flag wiring enables the guard (module + CLI `parseArgs`). 13.
metadata records guard events. 14. detector output is deterministic. Plus edit-failure and
red→edit→red progress cases, and `toGuardEvent` shape tolerance.

**Verification:** `bun run typecheck` ✓ · `bun run typecheck:benchmarks` ✓ ·
`bun test` ✓ (full suite) · `git diff --check` ✓ · replay byte-identical across runs ✓.

## Recommendation

**Proceed to a small live validation with the guard enabled** (8–12 paired runs on the
frozen split above), keeping it default-off until that gate passes. Caveat to carry in:
in the cap-hit runs the loop frequently becomes detectable only mid/late, so the guard's
*cost* benefit will be partial on its own — pair it with the budget-aware stop-and-commit
cost guard (candidate **C7**) for early intervention. Do not promote to default, do not make
external benchmark claims, and re-confirm changed-behavior evidence on the live split before
any "confirmed" status.
