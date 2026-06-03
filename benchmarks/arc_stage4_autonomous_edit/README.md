# ARC Stage 4 Autonomous Edit Benchmark

Stage 4 measures whether vtrace helps Claude Code complete small autonomous ARC edit tasks with fewer tokens and fewer failed runs.

Stage 4 is an autonomous edit benchmark on isolated ARC copies. It is not SWE-bench and not a general pass@1 benchmark.

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
