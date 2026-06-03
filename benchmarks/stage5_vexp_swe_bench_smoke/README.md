# Stage 5 vexp-swe-bench Smoke Benchmark

Stage 5 starts external benchmark validation using [`vexp-swe-bench`](https://github.com/Vexp-ai/vexp-swe-bench), a SWE-bench Verified-style harness that reports pass@1/resolution, cost, duration, and token usage and supports a no-vexp baseline mode.

This milestone is a **tiny smoke integration** (3–5 instances), not a full 100-task benchmark.

## Scope

> This is a Stage 5 smoke run against a tiny subset of vexp-swe-bench. It checks integration and measurement workflow only. It is not a public SWE-bench claim and not a comparison against vexp unless an explicit vexp-enabled condition is also run.

Stage 5 does **not** claim:

- that vtrace beats vexp
- that vtrace has better SWE-bench pass@1
- public leaderboard performance
- full 100-task benchmark results
- statistical significance

It only checks whether the benchmark workflow runs on a tiny subset, and whether baseline-vs-vtrace results can be collected and normalized locally.

`vexp-swe-bench` is **not vendored** into this repo. You clone and set it up separately, then point this harness at it with `--vexp-swe-bench-dir`.

## Evidence ladder

| Stage | What it measured | Current result |
| --- | --- | --- |
| Stage 1 | Static ARC context-size reduction | 97.53% mean reduction vs grep snippets, 18/20 strong |
| Stage 2 | Static ARC orientation equivalence | 11/12 parity-or-better, 97.89% quality-preserving static reduction |
| Stage 3 | Actual Claude Code controlled ARC usage | 12 paired tasks, 46.51% mean actual token reduction, 44.46% quality-preserving |
| Stage 4 | Small autonomous ARC edit tasks | 4/4 both-passed pairs, 36.45% mean token reduction |
| Stage 5 | External vexp-swe-bench smoke integration | workflow smoke only (this stage) |

## Suggested first manual workflow

```bash
# 1. Clone/setup external benchmark (not vendored here)
git clone https://github.com/Vexp-ai/vexp-swe-bench.git /home/calvin/code/vexp-swe-bench
cd /home/calvin/code/vexp-swe-bench
./setup.sh
source .venv/bin/activate

# 2. List instances
node dist/cli.js list

# 3. Pick 3-5 instance IDs and prepare Stage 5
cd /home/calvin/code/vtrace
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode prepare \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <id1,id2,id3> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# 4. Run baseline
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <id1,id2,id3> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# 5. Run vtrace condition if configured
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-vtrace \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <id1,id2,id3> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# 6. Ingest/report
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode ingest \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## CLI modes

| Mode | What it does |
| --- | --- |
| `prepare` | Checks `--vexp-swe-bench-dir`/`dist/cli.js` exist, resolves instances, creates output dirs, and writes `results/run_plan.json` with the exact baseline and vtrace commands. |
| `run-baseline` | Runs the no-vexp baseline condition via `node dist/cli.js run ... --no-vexp` inside the external checkout; captures stdout/stderr/meta into `results/raw/baseline/`. |
| `run-vtrace` | Runs the same command (still `--no-vexp`) for the vtrace condition; writes the vtrace instructions artifact and captures output into `results/raw/vtrace/`. |
| `ingest` | Tolerantly parses everything under `results/raw/baseline` and `results/raw/vtrace`, normalizes rows, computes pairs, and writes the CSV/JSON/Markdown reports. |
| `report` | Re-renders the CSV/JSON/Markdown from the normalized intermediate (`stage5_normalized.json`); falls back to re-ingesting raw if no intermediate exists. |
| `install-vtrace-patch` | Patches the external checkout's Claude Code adapter so it injects `VTRACE_AGENT_INSTRUCTIONS_FILE` into the prompt (local-patch method). Backs up the file once, is idempotent, and writes `results/vtrace_patch_manifest.json`. |
| `verify-vtrace-patch` | Reports whether the local vtrace patch marker is present in the external checkout. Exits non-zero if not installed. |

### Baseline command

The baseline condition disables vexp:

```bash
node dist/cli.js run --instances <ids> --no-vexp --output <results/raw/baseline>
```

If the installed `vexp-swe-bench` CLI uses different flag names (e.g. a different `--output`/`--instances` spelling), adapt with `--cli-entry`, `--node-command`, and update this README. `--no-vexp` (vexp disabled) is the invariant that must hold.

## Vtrace condition

The vtrace condition must keep vexp disabled. The goal is baseline agent vs same agent with vtrace, not vexp vs vtrace yet.

Valid first smoke options:

1. Inject vtrace MCP/config into each task repo if supported.
2. Prepend agent instructions telling Claude Code to initialize/use vtrace.
3. Patch/add a tiny local vtrace enhancer in the external benchmark checkout.

The chosen method must be recorded in the report.

This harness defaults to **Approach A (instructions-file)**: `run-vtrace` writes `results/_vtrace_instructions.md` and exports `VTRACE_AGENT_INSTRUCTIONS_FILE` (plus `VTRACE_SMOKE=1`, `VTRACE_METHOD`) into the benchmark process environment, while running the **identical** `--no-vexp` command as baseline (same model/agent/budget).

> The instructions file lives at the **results root**, not under `raw/vtrace/`. vexp-swe-bench's `run` clears its `--output` dir (`raw/vtrace`) at startup, which would delete an instructions file written there before the agent ever reads it (the original `injection skipped: ENOENT` no-op). The results root is never passed to vexp as `--output`, so the file survives the run.

> ⚠️ **`instructions-file` may be a no-op.** The external `vexp-swe-bench` Claude Code adapter (`dist/agents/claude-code.js`) builds its prompt from the task `problem_statement` only and does **not** read `VTRACE_AGENT_INSTRUCTIONS_FILE`. With the bare `instructions-file` method the env var is exported but never consumed, so the vtrace condition runs the same prompt as baseline. Treat any `instructions-file` result as suspect unless you confirm the wrapper reads the file.

### Recommended: `local-patch`

For a **real** vtrace smoke run, use `--vtrace-method local-patch`. This applies a tiny, idempotent, backed-up patch to the external checkout's Claude Code adapter so that, when `VTRACE_AGENT_INSTRUCTIONS_FILE` is set, the adapter appends that file's contents to the prompt under a `## Additional vtrace context/instructions` heading. vexp stays disabled — this only enriches the prompt/context, so it remains baseline-agent vs. same-agent-plus-vtrace.

The patch:

- inserts a block guarded by the marker `STAGE5_VTRACE_INSTRUCTIONS_PATCH` (idempotent — re-running install is a no-op);
- backs the file up once to `<file>.stage5-vtrace-backup` (never overwritten);
- logs `Stage5 vtrace instructions injected from <path>` to **stderr** (stdout is parsed as stream-json for metrics), or `Stage5 vtrace injection skipped: <error>` if the file could not be read;
- targets the built `dist/` output directly, so it is a **local smoke patch** that is lost on `npm run build` and must be re-installed after a rebuild.

`run-vtrace --vtrace-method local-patch` writes the instructions file, then — **before spawning** the external CLI — asserts the file exists, is non-empty, and that the patch marker is installed; it aborts up front otherwise (no tokens spent). After the run, `ingest`/`report` parse the captured vtrace `_run.stderr.txt` and record `vtrace_injection_observed`, `vtrace_injection_error`, and `vtrace_treatment_valid`. If injection was skipped, the report prints **"Vtrace injection was skipped; this run is not a valid vtrace treatment."**, marks the per-instance efficiency deltas as `invalid`, and does not advertise them as vtrace performance.

`run-vtrace --vtrace-method local-patch` refuses to run until the marker is present, failing **before** any agent is spawned so no tokens are wasted on a silent no-op.

```bash
# 1. Install the local vtrace prompt patch into the external checkout
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode install-vtrace-patch \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# 2. Verify the patch is installed (exits non-zero if not)
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode verify-vtrace-patch \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# 3. Run the real vtrace condition (still --no-vexp; fails fast if patch missing)
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-vtrace \
  --vtrace-method local-patch \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <id1,id2,id3> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

The installer writes `results/vtrace_patch_manifest.json` recording the patched file, backup path, and marker. To revert, restore each `<file>.stage5-vtrace-backup` over its original (or rebuild the external checkout).

Select the method with `--vtrace-method instructions-file|mcp|local-patch`; the chosen value is recorded in `run_plan.json`, the run meta, and the Markdown report. vtrace is **not** redesigned for this milestone.

## Instances

`smoke_instances.json` holds the smoke instance IDs:

```json
{
  "instances": [],
  "notes": [
    "Populate with 3-5 instance IDs from `node dist/cli.js list` in vexp-swe-bench.",
    "Prefer small/fast instances for the first smoke run."
  ]
}
```

Pass instances directly to override the file:

```bash
--instances instance1,instance2,instance3
```

## Result schema

`stage5_vexp_swe_bench_smoke.csv` columns:

```text
instance_id, condition, resolved, cost_usd, duration_ms, input_tokens,
output_tokens, total_tokens, num_turns, patch_available, error,
raw_result_path, notes
```

The paired comparison (JSON + Markdown) includes per instance:

```text
instance_id, baseline_resolved, vtrace_resolved, outcome,
baseline_total_tokens, vtrace_total_tokens, token_reduction_pct,
baseline_cost_usd, vtrace_cost_usd, cost_reduction_pct,
baseline_duration_ms, vtrace_duration_ms, duration_reduction_pct
```

Outcome categories: `both_resolved`, `vtrace_only_resolved`, `baseline_only_resolved`, `both_failed`, `unpaired`, `unknown`.

### Tolerant parsing

`vexp-swe-bench` output shape may vary, so `ingest` tries, per file, JSON → JSONL → CSV → GFM markdown tables, and matches common field aliases (e.g. `instance_id`/`instanceId`, `resolved`/`passed`/`success`, `cost_usd`/`cost`, `total_tokens`/`tokens`). **Any field that is not present is recorded as `unknown`, never guessed.** Runner-written artifacts (files prefixed with `_`, like `_run.meta.json`) are skipped during parsing.

## Outputs

```text
benchmarks/stage5_vexp_swe_bench_smoke/results/
  raw/
    baseline/
    vtrace/
  run_plan.json
  stage5_normalized.json
  stage5_vexp_swe_bench_smoke.csv
  stage5_vexp_swe_bench_smoke.json
  stage5_vexp_swe_bench_smoke.md
  vtrace_patch_manifest.json   # written by install-vtrace-patch (local-patch method)
```

## Limitations

- Tiny instance subset; no statistical significance.
- vexp is disabled in both conditions; this is not a vexp-vs-vtrace comparison.
- The instructions-file vtrace method is best-effort and may be a no-op unless the benchmark agent wrapper consumes it.
- Token/cost/duration reductions are only meaningful for instances where both conditions resolved.
- Results must not be used for public SWE-bench claims.

## Tests

Tests use mocked filesystem outputs and never require the external `vexp-swe-bench`, Docker, Node external setup, Claude Code, or internet:

```bash
bun test benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.test.ts
```
