# ARC Stage 3 Agent Usage Benchmark

Stage 3 measures actual coding-agent CLI token usage on controlled ARC orientation tasks using `ccusage` session reports.

It compares two conditions:

- `baseline`: prompt includes grep-snippet ARC context and instructs the agent not to use vtrace/MCP.
- `vtrace`: prompt includes directly inserted vtrace capsule/handoff context.

The runner supports both a manual workflow and automated Claude Code print-mode runs. Automated runs still use controlled orientation prompts only; they are not full autonomous patch-solving sessions.

These token counts come from ccusage local CLI usage data. They measure controlled orientation sessions, not full autonomous patch-solving.

## Current Smoke Result

The current Claude Code ccusage-backed smoke result is documented in [STAGE3_SMOKE.md](./STAGE3_SMOKE.md). It currently includes 4 paired controlled orientation tasks and reports both actual token reduction and quality-preserving actual reduction.

## Manual Workflow

```bash
# 1. Prepare prompts
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json \
  --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode prepare

# 2. Take before snapshot
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode snapshot \
  --snapshot-label before \
  --task-id workflow_arkane_input \
  --condition baseline

# 3. Run the prompt manually in a fresh Claude Code session
# Use:
# benchmarks/arc_stage3_agent_usage/results/prompts/workflow_arkane_input.baseline.md

# 4. Save the agent JSON response to:
# benchmarks/arc_stage3_agent_usage/results/responses/workflow_arkane_input.baseline.response.json

# 5. Take after snapshot
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode snapshot \
  --snapshot-label after \
  --task-id workflow_arkane_input \
  --condition baseline

# 6. Repeat for vtrace condition

# 7. Ingest all completed runs
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json \
  --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode ingest
```

For Codex, pass `--agent-source codex`. Snapshot mode runs:

```bash
bunx ccusage codex session --json
```

Claude snapshot mode runs:

```bash
bunx ccusage claude session --json
```

## Output Tree

```text
benchmarks/arc_stage3_agent_usage/results/
  prompts/
    <task_id>.baseline.md
    <task_id>.vtrace.md
  snapshots/
    <task_id>.<condition>.before.json
    <task_id>.<condition>.after.json
  responses/
    <task_id>.<condition>.response.json
  arc_stage3_agent_usage_manifest.json
  arc_stage3_agent_usage.csv
  arc_stage3_agent_usage.json
  arc_stage3_agent_usage.md
```

## Response Format

Save the agent response as JSON only:

```json
{
  "target_file": "repo-relative path or null",
  "target_symbol": "symbol/function/class name or null",
  "quality": "strong|acceptable|weak|missing",
  "confidence": "high|medium|low",
  "reason": "one short sentence"
}
```

## Delta Rules

The runner prefers `ccusage` session reports.

During ingest it:

1. Finds newly added session rows when session IDs are present.
2. Uses the single new session as the delta when exactly one new session appears.
3. Falls back to aggregate after-minus-before totals when session IDs are unavailable.
4. Marks the run ambiguous if multiple new sessions appear unless `--allow-aggregate-ambiguous` is supplied.

The parser is intentionally tolerant because `ccusage` JSON can vary by source and version. It looks for common token, cost, session ID, and model fields in nested objects.

## Interpretation

Stage 3 supports controlled orientation-session token and cost comparisons only after paired baseline/vtrace runs are ingested.

Do not interpret the report as full agent cost savings, patch correctness, pass@1, or SWE-bench performance.

## Automated Workflow

Automated Claude Code execution spends real tokens/cost. Start with one task pair.

```bash
# Run one pair
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json \
  --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode run-pair \
  --task-id workflow_arkane_input \
  --yes

# Run three smoke pairs
bun benchmarks/arc_stage3_agent_usage/run_arc_stage3_agent_usage.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json \
  --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json \
  --out benchmarks/arc_stage3_agent_usage/results \
  --agent-source claude \
  --mode run-matrix \
  --task-ids exact_scheduler,workflow_conformer_filtering,known_weak_rotor_scans \
  --yes
```

`run-one` runs a single task/condition, writes before/after ccusage snapshots, saves raw Claude stdout/stderr/meta files, extracts the requested JSON response, and updates the manifest. It only ingests when `--ingest-after-run` is passed.

`run-pair` runs baseline then vtrace for one task and ingests by default after both conditions finish.

`run-matrix` runs both conditions for the explicit comma-separated `--task-ids` list and ingests by default after all selected runs finish. It requires `--yes`.

The default Claude invocation is equivalent to passing the prompt through stdin:

```bash
claude -p \
  --output-format json \
  --max-turns 1 \
  --append-system-prompt-file benchmarks/arc_stage3_agent_usage/claude_orientation_system_prompt.md
```

Useful Claude options:

```text
--claude-command claude
--claude-model <model>
--claude-max-turns 1
--claude-output-format json
--claude-extra-arg <arg>
--claude-system-prompt-file <path>
--claude-append-system-prompt-file <path>
--claude-bare
--claude-disable-tools
--allow-missing-ccusage
--ingest-after-run
--no-ingest-after-run
```
