# ARC Stage 4 Autonomous Edit Benchmark

Stage 4 measures whether vtrace helps Claude Code complete small autonomous ARC edit tasks with fewer tokens and fewer failed runs.

Stage 4 is an autonomous edit benchmark on isolated ARC copies. It is not SWE-bench and not a general pass@1 benchmark.

## Stage 4 result

The completed Stage 4 autonomous edit benchmark is documented in [STAGE4_RESULTS.md](./STAGE4_RESULTS.md).

## Scope

Stage 4 differs from Stages 1-3:

- Stage 1 measured static context-size reduction.
- Stage 2 measured static orientation equivalence.
- Stage 3 measured controlled Claude Code orientation usage.
- Stage 4 measures small autonomous edits on isolated ARC copies/worktrees.

The initial task set is documentation-style by design. Each task asks Claude to add a note to `STAGE4_NOTES.md` inside an isolated ARC copy. This tests whether the agent can identify the correct ARC target and make a concrete edit without risking source-code damage or requiring long ARC test runs.

Stage 4 does not measure:

- SWE-bench performance
- general pass@1
- arbitrary bug-fixing ability
- full development-session cost
- production-ready code quality beyond the task validator

## Safety

Do not mutate `/home/calvin/code/ARC` directly.

Every run creates an isolated directory:

```text
benchmarks/arc_stage4_autonomous_edit/results/worktrees/<task_id>.<condition>/
```

The default `--worktree-mode copy` copies ARC into the isolated run directory. Pass `--overwrite` to replace an existing run directory.

The validator enforces `allowed_files_only` for every task. For the initial task set, Claude may write only `STAGE4_NOTES.md`; changes to real ARC source, docs, tests, or other markdown files fail validation.

Prompt-only constraints were insufficient in the first smoke pair: Claude still updated ARC documentation files while also writing `STAGE4_NOTES.md`. For the initial doc-note tasks, use protected allowed-file mode:

```text
--claude-protect-allowed-files
```

This mode attempts to configure Claude Code tool permissions so reads remain available while `Edit`/`Write` are scoped to the task `allowed_files`, with explicit disallows for common ARC source/doc paths. These tool restrictions are best-effort; validation still enforces `allowed_files_only` and remains the source of truth.

Benchmark/tool state paths are ignored for changed-file safety because local tools may create them while inspecting the isolated copy:

```text
.vtrace/
.mytool/
.claude/
.pytest_cache/
__pycache__/
.vexb/
```

Ignored state paths are reported separately from disallowed changed files. They do not make a run fail, but they remain visible in validation JSON and the Markdown report.

## Change detection

Validation compares the isolated run directory against an **initial snapshot** taken right after the worktree is created and task setup files are applied, but before Claude runs. The snapshot stores `path -> {exists, hash, size}` for every non-ignored file (only `.git/` internals are skipped) and is written to:

```text
results/validation/<task_id>.<condition>.initial_snapshot.json
```

After the run, the final directory is re-scanned and `changedFiles` is the set of files whose hash differs from the snapshot, plus any created or deleted files. This replaces the earlier approach of running `git status`/`git diff` against `HEAD`, which incorrectly blamed pre-existing dirty files copied from the source ARC repo.

Because the source ARC checkout can be dirty, the runner records `git -C <repo> status --short` before copying. Those `sourceRepoDirtyFiles` are reported as diagnostic info in the validation JSON and the Markdown report, but — since they are present in the initial snapshot — they are not counted as agent edits unless Claude modifies them after the snapshot. Validation JSON records `changeDetectionMethod: "initial_snapshot"`.

To refuse to run when the source repo is dirty, pass:

```text
--require-clean-source
```

This fails before spending Claude tokens if `git status --short` on the source repo reports any changes.

## Running

Run one pair:

```bash
bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json \
  --out benchmarks/arc_stage4_autonomous_edit/results \
  --agent-source claude \
  --mode run-pair \
  --task-id doc_find_arkane_input \
  --claude-protect-allowed-files \
  --yes
```

Rerun a failed pair by recreating its isolated worktrees:

```bash
bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json \
  --out benchmarks/arc_stage4_autonomous_edit/results \
  --agent-source claude \
  --mode run-pair \
  --task-id doc_find_arkane_input \
  --overwrite \
  --claude-protect-allowed-files \
  --yes
```

Run a matrix:

```bash
bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json \
  --out benchmarks/arc_stage4_autonomous_edit/results \
  --agent-source claude \
  --mode run-matrix \
  --task-ids doc_find_arkane_input,doc_find_conformer_filtering,doc_find_scheduler,doc_find_cython_boundary \
  --yes
```

Regenerate validation and reports:

```bash
bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json \
  --out benchmarks/arc_stage4_autonomous_edit/results \
  --agent-source claude \
  --mode validate

bun benchmarks/arc_stage4_autonomous_edit/run_arc_stage4_autonomous_edit.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage4_autonomous_edit/tasks.arc.stage4.json \
  --out benchmarks/arc_stage4_autonomous_edit/results \
  --agent-source claude \
  --mode ingest
```

## Interpretation

Pass/fail is primary. Token reduction is quality-preserving only when both baseline and vtrace pass. A `vtrace_only_passed` result is a qualitative win even if tokens are higher.

The `vtrace` condition receives embedded vtrace context. The `baseline` condition receives no vtrace output and may inspect the isolated repo normally.

## Claude Permissions

Autonomous edit runs keep tools enabled, but use non-interactive-safe defaults for isolated worktrees:

```text
--permission-mode acceptEdits
--allowedTools Read,Grep,Glob,LS,Edit,Write
```

This allows repository inspection and edits to the benchmark-local allowed file without interactive permission prompts. It intentionally does not allow Bash by default.

## Outputs

```text
benchmarks/arc_stage4_autonomous_edit/results/
  worktrees/
  prompts/
  snapshots/
  agent_runs/
  patches/
  validation/
  arc_stage4_autonomous_edit.csv
  arc_stage4_autonomous_edit.json
  arc_stage4_autonomous_edit.md
```

## Future Stage 4B Options

Later task types can include:

- small unit-test additions
- small docstring/comment updates near real target code
- low-risk refactors on temp worktrees
- actual bug-fix tasks with test commands
