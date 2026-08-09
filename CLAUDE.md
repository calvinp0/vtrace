# CLAUDE.md

Guidance for working in this repo. The simple scripts live in `package.json`; this
file captures the **non-obvious** commands and gotchas (Stage 5 benchmark harness,
eval proofs, pivot-inspection/revision modules) that are otherwise easy to rediscover.

## Build / test / typecheck

```bash
bun test                       # full suite (~2.6k tests); bun test <file> for one
bun run typecheck              # tsc --noEmit (src)
bun run typecheck:benchmarks   # tsc -p tsconfig.benchmarks.json (benchmarks/)
bun run lint                   # both typechecks
git diff --check               # whitespace/conflict-marker check before commit
```

## Stage 5 SWE-bench smoke harness

A thin wrapper around the EXTERNAL `vexp-swe-bench` harness (it owns the agent turn
loop + final-patch extraction; we inject context and read back `modelPatch`).

```bash
VEXP=/home/calvin/code/vexp-swe-bench                       # external harness checkout
OUT=benchmarks/stage5_vexp_swe_bench_smoke/results          # results root
DATASET=$VEXP/data/swe-bench-100.jsonl                      # gold patch / FAIL_TO_PASS source
RUNNER=benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts
```

Live run-protocol (spawns a REAL agent — needs explicit approval; costs money):

```bash
bun "$RUNNER" --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir "$VEXP" --instances "<instance_id>" \
  --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check \
  [--pivot-inspection-enforcement] [--pivot-revision-pass] \
  --run-label "<label>" --out "$OUT"
```

Docker evaluate (real SWE-bench resolution; separate step — mutates `resolved` in place):

```bash
bun "$RUNNER" --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir "$VEXP" --run-label "<label>" --out "$OUT"
```

Flag glossary: `--disable-pivot-check` turns off the legacy PIVOT_CHECK;
`--pivot-inspection-enforcement` injects the M12 EDITED/RULED_OUT block (off by
default); `--pivot-revision-pass` runs the M14 corrective second pass (needs
enforcement; off by default; does NOT replace the canonical patch).

### Deterministic retrieval no-change proof

Run the provenance-aware paired predecessor/candidate evaluator after any change
that should not affect retrieval or ranking. The predecessor implementation must be
declared explicitly, and each side must generate its own index and temporary state
against the same immutable target corpus.

No milestone may claim deterministic semantic preservation solely by comparing
against a stored baseline whose provenance does not match the declared predecessor
implementation. Static goldens are supplementary evidence only. An authoritative
comparison must bind and validate the VTRACE commit and tree, clean state, fixture
content, runner/protocol fingerprint, target corpus, and semantic-hash version.

Dirty runs are exploratory. A provenance mismatch must fail closed; the explicit
exploratory override is for investigation and can never satisfy a milestone gate.
When retrieval intentionally changes, regenerate both canonical suites from the
clean promoted implementation after the paired comparison and commit their
execution-time provenance with the evidence report.

### Offline audits (no live agents / no Docker)

Design/validation work uses offline audit scripts that read CAPTURED run artifacts and
recompute verdicts — the safe way to iterate without spending tokens. Pattern:
`run_stage5_m1{3,4,5}_*.ts` → write a `results/stage5_m1*_*.md` report.

## Reading captured run artifacts

Each labelled run lives under `$OUT/runs/<label>/raw/`:

- `raw/vtrace/swebench-*.jsonl` — canonical result row; key fields `modelPatch`,
  `resolved`, `instanceId`, `costUsd`, `numTurns`.
- `raw/vtrace/_run.meta.json` — engine/injection/telemetry meta (`vtraceEffectiveCapsuleEngine`,
  `vtraceContextInjected`, `vtraceCapsulePivots`, …).
- `raw/vtrace/_tool_calls.json` — ordered tool calls (category read/search/edit).
- `raw/vtrace/_eval.meta.json` — post-evaluate evidence (`resolvedCount`, `evaluationRan`).
- `raw/vtrace/_pivot_revision*.{json,patch,md,txt}` — M14/M15 revision-pass artifacts
  (incl. `_pivot_first_pass_assistant.txt`).

## Pivot-inspection / revision module map

- `src/capsuleV2/pivotInspectionContract.ts` — M11 advisory + M12 enforcement block
  (the enforcement block requests machine-readable `PIVOT_DECISION` markers).
- `src/capsuleV2/pivotInspectionCompliance.ts` — M13 deterministic compliance checker
  (edited / ruledOut / unclear / missing) + `parsePivotDecisionMarkers`.
- `src/capsuleV2/pivotRevisionPass.ts` — M14/M15 corrective second-pass core (gate,
  prompt with FAIL_TO_PASS + bounded excerpts, conservative replacement). PURE.
- Live glue: `maybeRunPivotRevisionPass` / `executePivotRevisionPass` in `$RUNNER`.

## Gotchas (learned the hard way)

- **Auth**: the agent authenticates via the `claude` CLI credentials
  (`~/.claude/.credentials.json`), NOT `ANTHROPIC_API_KEY` (which is unset here).
- **Live runs must be sequential**: the first pass writes a SHARED
  `results/_agent_stream.jsonl`; concurrent live runs clobber it. (Docker evaluates can
  overlap a live run — different resources.)
- **Raw artifacts are untracked, never stage them**: everything under `$OUT/runs/`,
  `$OUT/_agent_*.jsonl`, `$OUT/_*prompt*.md`, and `_m1*_*_prompts/` dirs. Stage only
  source, tests, and the named `results/stage5_*.md` reports.
- **Don't touch pre-existing dirty result files** (e.g. `stage5_outcome_ledger.*`) —
  they predate your work. (The `stage5_retrieval_eval_*` baselines are an exception
  since 2026-07-03: they are canonical again, refreshed via the meta-file protocol
  above.)
- **Runs re-clone the repo** (fresh workspace per label) — slow, network-bound; expect
  minutes per run. `--reuse-workspace` exists but can contaminate later repeats.
- **Resolution needs ALL FAIL_TO_PASS to pass**: a partially-correct patch reports
  `resolved=0`. Gold patches + FAIL_TO_PASS are in `$DATASET`.

## Agent workflow conventions

- Commit directly on `main`; do not create feature branches. Do not push unless asked.
- No `Co-Authored-By` trailer on commits.
- Do not run live agents / Docker / 30- or 100-case sweeps without explicit approval.
- Do not change scoring, candidate generation, Capsule v2 ranking, or retrieval as a
  side effect; prove no-change with the retrieval eval above.
- **At the start of any milestone/prompt, read
  `results/stage5_milestone_ledger.md`** (what's been done, standing findings, the
  issued next-step recommendation) and run the baseline freshness check if the work
  touches retrieval/capsule code. **At the end, append the milestone's row +
  standing findings to the ledger in the same commit**, and update the untracked
  working docs (`VTRACE_TOOLING_AUDIT.md` addendum) when a finding changes what
  they claim.
