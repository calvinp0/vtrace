/**
 * M168-A/B/C driver — freeze the public VEXP benchmark authority, audit its
 * metric definitions, and diff its agent-facing surface against VTRACE's.
 *
 * Offline. No agent, no Docker, no network, no VTRACE product state mutated.
 *
 * Public bytes are read with `git show <commit>:<path>` rather than from the
 * working tree, because this machine's checkout of the external harness carries
 * local Stage 5 patches. The working-tree drift is recorded, not silently used.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_authority.ts \
 *     --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  analyzeEvalLogProvenance,
  analyzeTimestampGrid,
  analyzeTreatmentCompliance,
  diffToolSurfaces,
  priceRow,
  reconcileCost,
  type ModelPricing,
  type PublishedRunRow,
  type ToolSurface,
  type TreatmentExpectation,
} from "./m168Authority";

import { defaultMcpToolRegistry } from "../../src/mcp/tools";

// ── argv ────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const VEXP_DIR = arg("vexp-swe-bench-dir", "/home/calvin/code/vexp-swe-bench");
const OUT = arg("out", "benchmarks/stage5_vexp_swe_bench_smoke/results");
const VEXP_CLI_DIR = arg(
  "vexp-cli-dir",
  "/home/calvin/.npm-global/lib/node_modules/vexp-cli",
);

mkdirSync(OUT, { recursive: true });

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: VEXP_DIR, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
const write = (name: string, value: unknown) => {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${name}`);
};

const UNKNOWN = "UNKNOWN" as const;

// ── A1. Benchmark authority ─────────────────────────────────────────

const commit = git("rev-parse", "HEAD").trim();
const commitMeta = git("show", "-s", "--format=%an|%ae|%aI|%s", commit).trim().split("|");
const remote = git("remote", "get-url", "origin").trim();

/** Files whose working-tree bytes differ from the pinned commit. */
const workingTreeDrift = git("status", "--porcelain")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("??"))
  .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));

const pkg = JSON.parse(git("show", `${commit}:package.json`)) as Record<string, unknown>;

const authority = {
  milestone: "M168-A",
  generatedBy: "run_stage5_m168_authority.ts",
  benchmarkRepository: remote,
  benchmarkCommit: commit,
  benchmarkCommitAuthor: commitMeta[0] ?? UNKNOWN,
  benchmarkCommitDate: commitMeta[2] ?? UNKNOWN,
  benchmarkCommitSubject: commitMeta[3] ?? UNKNOWN,
  benchmarkPackageName: pkg.name,
  benchmarkPackageVersion: pkg.version,
  localCheckoutPath: VEXP_DIR,
  /**
   * The local checkout is NOT pristine. Every public byte in this report is
   * read from the pinned commit; the drift below exists because Stage 5 added
   * env-gated instrumentation to the adapter in earlier milestones.
   */
  localWorkingTreeDrift: workingTreeDrift,
  localWorkingTreeIsPristine: workingTreeDrift.length === 0,
  publishedDefaults: {
    model: "claude-opus-4-5-20251101",
    agent: "claude-code",
    maxTurns: 250,
    costLimitUsd: 3,
    timeoutSeconds: 0,
    source: "README.md `run` options + src/cli.ts defaults at the pinned commit",
  },
  vexpRuntime: {
    minimumVersionRequiredByHarness: "1.2.0 (src/vexp/ensure.ts MIN_VERSION)",
    versionUsedForThePublishedBenchmark: UNKNOWN,
    versionInstalledOnThisMachine: existsSync(join(VEXP_CLI_DIR, "package.json"))
      ? (JSON.parse(readFileSync(join(VEXP_CLI_DIR, "package.json"), "utf-8")).version as string)
      : UNKNOWN,
    licenceRequired: "vexp Pro or Team (src/vexp/ensure.ts VALID_PLANS)",
    licenceStateOnThisMachine: existsSync(`${process.env.HOME}/.vexp/license.jwt`)
      ? "PRESENT"
      : "ABSENT",
    nativeCoreInstalledOnThisMachine: existsSync(
      "/home/calvin/.npm-global/lib/node_modules/@vexp/core-linux-x64/bin/vexp-core",
    ),
  },
  grader: "SWE-bench Verified official Docker evaluation (swebench python package)",
  unknowns: [
    "vexp-cli version used for the published benchmark",
    "vexp-core version used for the published benchmark",
    "Claude Code CLI version used for the published benchmark",
    "host/hardware and concurrency of the published benchmark",
    "whether the published run used the strict policy shipped at this commit",
  ],
};

write("stage5_m168_vexp_authority.json", authority);

// ── A2. Task manifest ───────────────────────────────────────────────

const manifestRaw = git("show", `${commit}:data/swe-bench-100.jsonl`);
const manifestRows = manifestRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { instance_id: string; repo: string; base_commit: string });

const repoCounts: Record<string, number> = {};
for (const r of manifestRows) repoCounts[r.repo] = (repoCounts[r.repo] ?? 0) + 1;

const instanceIds = manifestRows.map((r) => r.instance_id);

write("stage5_m168_vexp_manifest.json", {
  milestone: "M168-A",
  source: `${remote}@${commit}:data/swe-bench-100.jsonl`,
  frozenManifestPresent: true,
  regeneratedFromProse: false,
  taskCount: manifestRows.length,
  fileSha256: sha256(manifestRaw),
  sortedInstanceIdListSha256: sha256([...instanceIds].sort().join("\n")),
  repositoryDistribution: repoCounts,
  repositoriesRepresented: Object.keys(repoCounts).length,
  selectionProcedure: {
    script: "scripts/select-subset.py",
    seed: 42,
    targetSize: 100,
    complexityScore: "len(FAIL_TO_PASS) * 10 + gold patch +/- line count",
    complexityCeiling:
      "NOT ENFORCED IN CODE — the README/methodology describes a <=250 ceiling, "
      + "but select-subset.py applies no such filter at this commit",
    allocation: "proportional per repository, then even sampling across complexity quintiles",
    reproducedMechanically: false,
    reproductionBlocker:
      "requires the full SWE-bench Verified 500 JSONL, which is not committed to the harness",
  },
  instanceIds,
});

// ── A3. Treatment policy components ─────────────────────────────────

const enhancerSrc = git("show", `${commit}:src/vexp/enhancer.ts`);
const orchestratorSrc = git("show", `${commit}:src/harness/orchestrator.ts`);

/** Pull a template literal out of the enhancer so we hash the real bytes. */
function extractTemplate(marker: string): string {
  const i = enhancerSrc.indexOf(marker);
  if (i < 0) throw new Error(`marker not found in enhancer.ts: ${marker}`);
  const start = enhancerSrc.indexOf("`", i) + 1;
  let end = start;
  while (end < enhancerSrc.length) {
    if (enhancerSrc[end] === "`" && enhancerSrc[end - 1] !== "\\") break;
    end++;
  }
  return enhancerSrc.slice(start, end);
}

const claudeMd = extractTemplate("const content =");
const guardScript = extractTemplate("const guardScript =");

const allowedTools = /const DEFAULT_ALLOWED_TOOLS = \[([^\]]*)\]/
  .exec(orchestratorSrc)?.[1]
  ?.split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean) ?? [];

const policyComponents = {
  milestone: "M168-A",
  source: `${remote}@${commit}`,
  components: [
    {
      component: "mandatory pipeline-first instruction",
      channel: "repo .claude/CLAUDE.md written by setupVexpRepo",
      statedPolicy: "call `run_pipeline` FIRST for every task",
      enforced: false,
      enforcementMechanism: "prose only",
      bytes: claudeMd.length,
      sha256: sha256(claudeMd),
    },
    {
      component: "native-search prohibition text",
      channel: "same CLAUDE.md",
      statedPolicy: "Do NOT use grep, glob, Bash, Read, or cat to search/explore the codebase",
      enforced: false,
      enforcementMechanism: "prose only — note it names five tools",
      sha256: sha256(claudeMd),
    },
    {
      component: "PreToolUse denial hook",
      channel: "repo .claude/settings.json + .claude/hooks/vexp-guard.sh",
      statedPolicy: "matcher Grep|Glob → exit 2 (deny)",
      enforced: true,
      enforcementMechanism:
        "shell hook; denies ONLY when both .vexp/daemon.sock and .vexp/healthy exist, "
        + "otherwise exits 0 and the tool call proceeds",
      hookMatcher: "Grep|Glob",
      hookDeniesTools: ["Grep", "Glob"],
      hookDoesNotDenyTools: ["Bash", "Read", "cat via Bash"],
      bytes: guardScript.length,
      sha256: sha256(guardScript),
      note:
        "the hook script interpolates the absolute repo path, so per-run bytes differ; "
        + "the hash above is of the template at the pinned commit",
    },
    {
      component: "MCP server exposure",
      channel: ".bench-mcp-config.json passed as --mcp-config --strict-mcp-config",
      statedPolicy: "server key `vexp`, command `npx -y vexp-mcp`",
      enforced: true,
      enforcementMechanism: "Claude Code MCP config",
      note:
        "server key `vexp` implies agent-visible tool ids of the form mcp__vexp__<tool>",
    },
    {
      component: "index lifecycle",
      channel: "npx -y vexp-cli index (once per repository)",
      enforced: true,
      enforcementMechanism: "child process; failures are WARNED AND SWALLOWED, run continues unindexed",
    },
    {
      component: "daemon lifecycle",
      channel: "npx -y vexp-cli daemon --workspace <repo> (once per task)",
      enforced: true,
      enforcementMechanism:
        "child process; a daemon that is not ready in 120s only prints a warning, "
        + "and because the guard requires a live socket, a dead daemon silently disables the search denial",
    },
    {
      component: "normal tool whitelist",
      channel: "--allowedTools",
      enforced: true,
      allowedTools,
      note: "identical for the vexp arm and the --no-vexp baseline",
    },
  ],
  statedVersusEnforced: {
    instructionSaysBlocked: ["grep", "glob", "Bash", "Read", "cat"],
    hookActuallyBlocks: ["Grep", "Glob"],
    hookBlocksOnlyWhen: "daemon socket AND healthy marker both present",
    gap: "Bash, Read and shell `cat` are prohibited in prose but never enforced",
  },
  claudeMdText: claudeMd,
  guardScriptTemplate: guardScript,
};

write("stage5_m168_vexp_policy_components.json", policyComponents);

// ── A4. Published result provenance ─────────────────────────────────

const publishedRaw = git("show", `${commit}:results/swebench-2026-03-22.jsonl`);
const published: PublishedRunRow[] = publishedRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as PublishedRunRow);

const expectation: TreatmentExpectation = {
  mandatoryFirstTool: "run_pipeline",
  hookDeniedTools: ["Grep", "Glob"],
};

const grid = analyzeTimestampGrid(published);
const compliance = analyzeTreatmentCompliance(published, expectation);

// Eval-log provenance: which run ids do the committed logs actually cite?
const declaredRunId = "vexp-swebench-1774184993333";
const logPaths = git("ls-tree", "-r", commit, "--name-only")
  .split("\n")
  .filter((p) => p.startsWith("logs/run_evaluation/") && p.endsWith("run_instance.log"));

const referencedRunIds: Record<string, number> = {};
let resolvedTrue = 0;
let resolvedFalse = 0;
for (const p of logPaths) {
  const text = git("show", `${commit}:${p}`);
  const ids = new Set(text.match(/vexp-swebench-\d{13}/g) ?? []);
  for (const id of ids) referencedRunIds[id] = (referencedRunIds[id] ?? 0) + 1;
}

const reportPaths = git("ls-tree", "-r", commit, "--name-only")
  .split("\n")
  .filter((p) => p.startsWith("logs/run_evaluation/") && p.endsWith("report.json"));
for (const p of reportPaths) {
  const report = JSON.parse(git("show", `${commit}:${p}`)) as Record<string, { resolved?: boolean }>;
  for (const entry of Object.values(report)) (entry.resolved ? resolvedTrue++ : resolvedFalse++);
}

const evalProvenance = analyzeEvalLogProvenance(declaredRunId, referencedRunIds, logPaths.length);

const gradedIds = new Set(
  reportPaths.map((p) => p.split("/").slice(-2)[0]!),
);
const ungraded = published.map((r) => r.instanceId).filter((id) => !gradedIds.has(id));

write("stage5_m168_vexp_result_provenance.json", {
  milestone: "M168-A",
  artifact: `${remote}@${commit}:results/swebench-2026-03-22.jsonl`,
  fileSha256: sha256(publishedRaw),
  rowCount: published.length,
  headlineClaim: { pass1Pct: 73.0, costPerTaskUsd: 0.67 },
  headlineReproducedFromArtifact: {
    resolvedTrue: published.filter((r) => r.resolved === true).length,
    resolvedFalse: published.filter((r) => r.resolved === false).length,
    pass1Pct: (published.filter((r) => r.resolved === true).length / published.length) * 100,
    meanCostUsd: published.reduce((s, r) => s + r.costUsd, 0) / published.length,
  },
  timestampGrid: grid,
  treatmentCompliance: compliance,
  evaluationLogProvenance: {
    ...evalProvenance,
    committedReportCount: reportPaths.length,
    resolvedTrue,
    resolvedFalse,
    instancesInResultsWithNoGradingReport: ungraded,
  },
  observations: [
    grid.isUniformGrid
      ? `every consecutive timestamp gap is exactly ${grid.gridSpacingSeconds}s and rows are ordered by instance id, `
        + `while the rows' own durations sum to ${Math.round(grid.reportedDurationSeconds)}s against a `
        + `${Math.round(grid.spanSeconds)}s span — the timestamp column is generated, not observed`
      : "timestamps are irregular, consistent with observed wall-clock",
    `the product's own metrics block is present on ${compliance.rowsWithProductMetrics}/${compliance.rowCount} rows`,
    `the mandated first tool appears on ${compliance.rowsCallingMandatoryTool}/${compliance.rowCount} rows `
      + `(${compliance.mandatoryToolCallTotal} calls) under a policy that requires it on every task`,
    `tools the hook is configured to deny appear on ${compliance.rowsUsingDeniedTools}/${compliance.rowCount} rows `
      + `(${compliance.deniedToolCallTotal} calls)`,
    compliance.mandatoryToolNameVariants.length > 1
      ? `the mandated tool appears under ${compliance.mandatoryToolNameVariants.length} different spellings `
        + `(${compliance.mandatoryToolNameVariants.join(", ")}), which one MCP config cannot produce`
      : "the mandated tool appears under a single spelling",
    evalProvenance.verdict === "ASSEMBLED_FROM_MULTIPLE_RUNS"
      ? `the committed grading logs cite ${evalProvenance.distinctReferencedRunIds} distinct evaluation run ids, `
        + `only ${evalProvenance.filesMatchingDeclaredRunId} of ${evalProvenance.totalLogFiles} files matching the directory's own id`
      : "the committed grading logs come from a single evaluation run",
  ],
  interpretation:
    "The grading evidence is real: official SWE-bench Docker reports are committed and they tally to the "
    + "published resolution count. What the artifact does NOT evidence is that those patches were produced "
    + "under the treatment this commit ships. Recorded as a provenance finding about the artifact, not as a "
    + "claim about the benchmark's honesty.",
});

// ── B. Metric / cost accounting equivalence ─────────────────────────

const OPUS_45: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

const costRecon = reconcileCost(published, OPUS_45);
const costLimitUsd = 3;
const agreeingAtCostLimit = costRecon.agreeingRowIds.filter((id) => {
  const row = published.find((r) => r.instanceId === id);
  return row !== undefined && row.costUsd >= costLimitUsd;
});

const totals = published.reduce(
  (acc, r) => ({
    input: acc.input + r.inputTokens,
    output: acc.output + r.outputTokens,
    cacheRead: acc.cacheRead + r.cacheReadTokens,
    cacheCreation: acc.cacheCreation + r.cacheCreationTokens,
  }),
  { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
);

write("stage5_m168_cost_accounting_equivalence.json", {
  milestone: "M168-B",
  pricingTable: OPUS_45,
  pricingSource: `${remote}@${commit}:src/metrics/pricing.ts`,
  reconciliation: costRecon,
  agreeingRowsAreCostLimitKills: {
    agreeingRows: costRecon.agreeingRows,
    ofWhichAtOrAboveCostLimit: agreeingAtCostLimit.length,
    costLimitUsd,
    mechanism:
      "parseStreamJson returns early on the stream's `result` event and reports Claude Code's own "
      + "total_cost_usd. A run killed at the cost limit never emits that event, so the harness falls "
      + "back to calculateCost over its own token sums — which is why exactly those rows re-price exactly.",
    confirmed: agreeingAtCostLimit.length === costRecon.agreeingRows,
  },
  tokenTotals: {
    ...totals,
    totalModelTraffic: totals.input + totals.output + totals.cacheRead + totals.cacheCreation,
  },
  costDecompositionPct: {
    input: ((totals.input / 1e6) * OPUS_45.inputPerMTok) / (costRecon.repricedMeanCostUsd * published.length) * 100,
    output: ((totals.output / 1e6) * OPUS_45.outputPerMTok) / (costRecon.repricedMeanCostUsd * published.length) * 100,
    cacheRead: ((totals.cacheRead / 1e6) * OPUS_45.cacheReadPerMTok) / (costRecon.repricedMeanCostUsd * published.length) * 100,
    cacheCreation: ((totals.cacheCreation / 1e6) * OPUS_45.cacheWritePerMTok) / (costRecon.repricedMeanCostUsd * published.length) * 100,
  },
  verdict: costRecon.verdict,
});

write("stage5_m168_metric_dictionary.json", {
  milestone: "M168-B",
  rule:
    "No number crosses from one column to the other until both columns name the same measurement "
    + "boundary. Inherited from M166: SERIALIZED TOKENS != MODEL-CONTEXT TOKENS until directly measured.",
  metrics: [
    {
      metric: "cost per task",
      vexpDefinition:
        "mean of RunResult.costUsd, which is Claude Code's self-reported total_cost_usd on 95/100 rows "
        + "and the harness's own re-priced token sum on the 5 cost-limit kills",
      vtraceDefinition:
        "same runtime source (Claude Code total_cost_usd) in the Stage 5 harness",
      comparable: "YES, if and only if both arms are run under the same harness in the same window",
      note:
        "the two accountings inside VEXP's own published file disagree: re-pricing its token columns "
        + "with its own price table yields a different mean than its cost column",
    },
    {
      metric: "tokens used / tokens saved / saving %",
      vexpDefinition:
        "(token_budget - tokens_used) / token_budget read from the latest row of the capsule_feedback "
        + "table in .vexp/index.db — a product-internal estimate of how much of its OWN context budget "
        + "the capsule consumed",
      vtraceDefinition:
        "vtraceContextBudget telemetry — also a product-internal budget accounting, also not model tokens",
      comparable: "NO",
      reason:
        "neither quantity is a model-context token count, and neither is measured against a "
        + "counterfactual in which the tool was absent",
      observedInPublishedArtifact: `null on ${compliance.rowCount - compliance.rowsWithProductMetrics}/${compliance.rowCount} rows — never collected`,
    },
    {
      metric: "input tokens",
      vexpDefinition: "sum of usage.input_tokens over assistant events — UNCACHED input only",
      vtraceDefinition: "same field in the Stage 5 harness",
      comparable: "YES",
      note:
        `median 2 tokens in the published artifact; ${(
          ((totals.cacheRead + totals.cacheCreation) /
            (totals.input + totals.output + totals.cacheRead + totals.cacheCreation)) * 100
        ).toFixed(1)}% of all traffic is cache read/write, so "input tokens" is a near-empty column and `
        + "must never be read as the model's context size",
    },
    {
      metric: "cache read / cache creation tokens",
      vexpDefinition: "summed from assistant-event usage",
      vtraceDefinition: "same",
      comparable: "YES",
    },
    {
      metric: "total model traffic",
      vexpDefinition: "not reported; derivable as input + output + cacheRead + cacheCreation",
      vtraceDefinition: "same derivation",
      comparable: "YES",
    },
    {
      metric: "~60% fewer tokens (run_pipeline tool description)",
      vexpDefinition: "UNKNOWN — no measurement, baseline or boundary is published with the claim",
      vtraceDefinition: "n/a",
      comparable: "NO",
    },
    {
      metric: "70-90% token savings vs Read (get_skeleton tool description)",
      vexpDefinition: "UNKNOWN — presumably payload size of a skeleton against full file content",
      vtraceDefinition:
        "VTRACE makes the analogous structural claim but M166/M167 showed payload-size reductions "
        + "do not convert to model-token reductions in an envelope-bound response",
      comparable: "NO",
    },
    {
      metric: "58% lower cost per task / 90% fewer tool calls (npm package description)",
      vexpDefinition: "UNKNOWN — no baseline named, not reproducible from any artifact in the harness",
      vtraceDefinition: "n/a",
      comparable: "NO",
    },
    {
      metric: "competitor $/task on the public leaderboard",
      vexpDefinition:
        "each competitor's own published figure, imported from data/external and their leaderboards",
      vtraceDefinition: "n/a",
      comparable: "NO",
      reason:
        "VEXP's column is a caching-heavy Claude Code cost while the competitors' columns come from "
        + "unrelated scaffolds and their own accounting; the harness never runs those agents itself",
    },
  ],
});

// ── C. Tool-surface differential ────────────────────────────────────

/**
 * VEXP's default agent-facing surface. The bundled MCP server registers eleven
 * tools but serves only four from tools/list unless VEXP_ALL_TOOLS is set.
 * Description lengths are measured from the shipped bundle.
 */
const mcpBundle = readFileSync(join(VEXP_CLI_DIR, "mcp", "mcp-server.cjs"), "utf-8");

function vexpDescriptionChars(tool: string): number {
  const at = mcpBundle.indexOf(`name:"${tool}"`);
  if (at < 0) throw new Error(`vexp tool not found in bundle: ${tool}`);
  const start = mcpBundle.indexOf('description:"', at) + 'description:"'.length;
  let i = start;
  const out: string[] = [];
  while (i < mcpBundle.length) {
    const c = mcpBundle[i]!;
    if (c === "\\") { out.push(mcpBundle.slice(i, i + 2)); i += 2; continue; }
    if (c === '"') break;
    out.push(c);
    i++;
  }
  return JSON.parse(`"${out.join("")}"`).length as number;
}

const VEXP_DEFAULT_TOOLS = ["run_pipeline", "get_skeleton", "index_status", "expand_vexp_ref"];
const VEXP_ALL_TOOLS = [
  "run_pipeline", "get_context_capsule", "get_impact_graph", "search_logic_flow",
  "get_skeleton", "index_status", "workspace_setup", "get_session_context",
  "search_memory", "save_observation", "expand_vexp_ref",
];

const vexpSurface: ToolSurface = {
  system: `vexp-cli@${authority.vexpRuntime.versionInstalledOnThisMachine} (default)`,
  visible: VEXP_DEFAULT_TOOLS.map((t) => ({ toolId: t, descriptionChars: vexpDescriptionChars(t) })),
  hiddenCount: VEXP_ALL_TOOLS.length - VEXP_DEFAULT_TOOLS.length,
};

const vtraceMeta = defaultMcpToolRegistry.listMetadata() as unknown as {
  toolId: string;
  description?: string;
}[];

const vtraceSurface: ToolSurface = {
  system: "vtrace (default registry)",
  visible: vtraceMeta.map((m) => ({
    toolId: m.toolId,
    descriptionChars: (m.description ?? "").length,
  })),
  hiddenCount: defaultMcpToolRegistry.tools.length - vtraceMeta.length,
};

const surfaceDiff = diffToolSurfaces(vtraceSurface, vexpSurface);

write("stage5_m168_tool_schema_differential.json", {
  milestone: "M168-C",
  vexpSurface,
  vtraceSurface,
  vexpAllToolsGate: "VEXP_ALL_TOOLS=1 promotes the other seven into tools/list",
  differential: surfaceDiff,
  observations: [
    `VTRACE serves ${surfaceDiff.leftVisibleCount} tools by default; VEXP serves ${surfaceDiff.rightVisibleCount}`,
    `VEXP's four visible descriptions total ${surfaceDiff.rightDescriptionChars} chars against VTRACE's `
      + `${surfaceDiff.leftDescriptionChars} across fourteen — VEXP spends more words on fewer doors`,
    "on the one tool both call run_pipeline, VEXP's description asserts primacy "
      + "(PRIMARY TOOL / ALWAYS call this first / ALWAYS prefer this over Read, Grep, Glob) while "
      + "VTRACE's is a bare alias pointer to get_code_context",
    "VTRACE already has createRestrictedMcpToolRegistry, so matching VEXP's narrow surface is a "
      + "configuration of shipped behaviour and needs no product change",
  ],
});

// ── C2. Response architecture differential ──────────────────────────

write("stage5_m168_capability_differential.json", {
  milestone: "M168-C",
  basis: "observed behaviour and shipped source at the pinned versions; no tuning of either system",
  rows: [
    { capability: "first-call pipeline", vexp: "run_pipeline, one call, server-side composition", vtrace: "run_pipeline / get_code_context, same composition (M165)", equivalent: "YES" },
    { capability: "pivot/primary context", vexp: "full file content for pivot files by default", vtrace: "bounded primary items, include_item_content lever", equivalent: "SIMILAR" },
    { capability: "impact analysis", vexp: "get_impact_graph, folded into the pipeline by preset", vtrace: "get_impact_graph, folded in by preset", equivalent: "YES" },
    { capability: "memory / session", vexp: "search_memory + get_session_context + save_observation", vtrace: "same three tools", equivalent: "YES" },
    { capability: "skeleton / API context", vexp: "get_skeleton, three detail levels", vtrace: "get_skeleton, three detail levels", equivalent: "YES" },
    { capability: "logic flow", vexp: "search_logic_flow between two FQNs", vtrace: "search_logic_flow", equivalent: "YES" },
    { capability: "multi-repo", vexp: "repos[] + cross_repo flags", vtrace: "repos[] + repo_root routing (M146/M147)", equivalent: "YES" },
    { capability: "readiness truthfulness", vexp: "index_status; failures during setup are warned and swallowed", vtrace: "fail-closed on stale/missing index by default (M141/M164)", equivalent: "VTRACE STRICTER" },
    { capability: "default visible tool count", vexp: String(VEXP_DEFAULT_TOOLS.length), vtrace: String(vtraceMeta.length), equivalent: "NO" },
    { capability: "routing pressure in tool description", vexp: "explicit primacy and explicit displacement of Read/Grep/Glob", vtrace: "descriptive, hedged, states what it does NOT cover", equivalent: "NO" },
    { capability: "search suppression", vexp: "PreToolUse hook denying Grep|Glob while the daemon is live", vtrace: "none shipped", equivalent: "NO" },
    { capability: "result channel", vexp: "content[0].text only — one rendered markdown string", vtrace: "content[0].text plus structuredContent; the observed client reads structuredContent (M167)", equivalent: "NO" },
    { capability: "result shape", vexp: "markdown prose assembled server-side", vtrace: "JSON; 41.9% of model-visible payload is transport structure (M166)", equivalent: "NO" },
    { capability: "default first-call token budget", vexp: "max_tokens 10000 for the whole pipeline output", vtrace: "median 10,526 model-visible tokens measured in M167", equivalent: "SIMILAR BUDGET, DIFFERENT SHAPE" },
    { capability: "prose compression lever", vexp: "prose_compression off/lite/full/ultra, default lite", vtrace: "detail lever + section-priority truncation (M45/M166)", equivalent: "SIMILAR" },
    { capability: "licence requirement", vexp: "Pro or Team plan required for the benchmark path", vtrace: "none", equivalent: "NO" },
  ],
  notMeasuredHere: [
    "first-call payload content on matched tasks — requires running VEXP's pipeline, which needs "
    + "the native core and a paid licence (see stage5_m168_blockers)",
    "evidence density on matched tasks — same blocker",
    "retrieval quality on matched tasks — same blocker",
  ],
});

// ── C3. Corpus overlap ──────────────────────────────────────────────

const overlapTargets = [
  ["Broad100-A", "stage5_m160_broad100a_manifest.json"],
  ["Broad100-B", "stage5_m160_broad100b_manifest.json"],
  ["M158 corpus", "stage5_m158_corpus_manifest.json"],
  ["M155 paired30", "stage5_m155_paired30_manifest.json"],
  ["M162/M164 pilot", "stage5_m162_pilot_manifest.json"],
  ["M110 frozen", "stage5_m110_frozen_default_path_manifest.json"],
];

const idPattern = /\b[a-z0-9_-]+__[A-Za-z0-9_.-]+-\d+\b/g;
const vexpSet = new Set(instanceIds);

const overlaps = overlapTargets.map(([label, file]) => {
  const path = join(OUT, file!);
  if (!existsSync(path)) return { corpus: label, status: "MISSING", file };
  const found = new Set(readFileSync(path, "utf-8").match(idPattern) ?? []);
  const shared = [...found].filter((id) => vexpSet.has(id));
  return {
    corpus: label,
    file,
    status: "READ",
    taskCount: found.size,
    overlapWithVexp100: shared.length,
    overlapPct: found.size === 0 ? 0 : (shared.length / found.size) * 100,
    isExactlyVexp100: found.size === vexpSet.size && shared.length === vexpSet.size,
  };
});

write("stage5_m168_corpus_overlap.json", {
  milestone: "M168-A/§10",
  vexpManifestSize: vexpSet.size,
  corpora: overlaps,
  headline:
    "Broad100-A is the VEXP 100-task manifest exactly. VTRACE's broad retrieval evidence since M156 "
    + "was already measured on the competitor's own task set, and Broad100-B is disjoint from it, "
    + "so an uncontaminated holdout already exists.",
});

console.log("\nM168-A/B/C artifacts written to", OUT);
