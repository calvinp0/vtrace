# ARC Stage 3 Agent Usage Benchmark

Stage 3 measures actual coding-agent CLI token usage on controlled ARC orientation tasks using `ccusage` session reports.

It compares two conditions:

- `baseline`: prompt includes grep-snippet ARC context and instructs the agent not to use vtrace/MCP.
- `vtrace`: prompt includes directly inserted vtrace capsule/handoff context.

The runner does not execute Claude Code or Codex. It prepares prompts, records `ccusage` snapshots, and ingests manually saved responses.

These token counts come from ccusage local CLI usage data. They measure controlled orientation sessions, not full autonomous patch-solving.

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
