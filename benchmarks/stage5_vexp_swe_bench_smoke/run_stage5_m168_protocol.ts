/**
 * M168-E protocol freeze — select the sample and fix the three arms BEFORE any
 * treatment executes and before any money is spent.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_protocol.ts
 *
 * Order matters and is enforced by writing everything in one pass: the sample
 * is drawn from the frozen public manifest using published, treatment-independent
 * variables only, and the arm bytes are hashed from live source rather than
 * restated, so "the arms differ only in policy" is checked here rather than
 * asserted in prose.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { selectSample, type SelectableInstance } from "./m168Sample";
import {
  M168_ALLOWED_TOOLS,
  M168_ARMS,
  M168_MANDATE_TEXT,
  M168_PIPELINE_TOOL_NAME,
  M168_POLICY_ENFORCEMENT,
  M168_PROHIBITION_TEXT,
  M168_VISIBLE_TOOL_IDS,
  allowedToolsForArm,
  armDefinition,
  buildSchedule,
  claudeMdForArm,
  guardScript,
  mcpConfigForArm,
  settingsJsonForArm,
  sha256,
} from "./m168Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const VEXP_MANIFEST = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

mkdirSync(RESULTS, { recursive: true });

const write = (name: string, value: unknown) => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${name}`);
};

// ── the pool, verified against M168-A's frozen hash ─────────────────

const manifestRaw = readFileSync(VEXP_MANIFEST, "utf8");
const manifestSha = createHash("sha256").update(manifestRaw).digest("hex");

const authority = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m168_vexp_manifest.json"), "utf8"),
) as { fileSha256: string; taskCount: number };

if (manifestSha !== authority.fileSha256) {
  throw new Error(
    `VEXP manifest drifted since M168-A: ${manifestSha} != ${authority.fileSha256}. `
    + "The sample must be drawn from the frozen pool, so this fails closed.",
  );
}

const pool: SelectableInstance[] = manifestRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as SelectableInstance);

// ── select, before any arm exists ───────────────────────────────────

const sample = selectSample(pool, 42);

if (sample.selected.length !== 12) {
  throw new Error(`expected 12 selected tasks, got ${sample.selected.length}`);
}
if (sample.holdoutInstanceIds.length !== 88) {
  throw new Error(`expected an 88-task holdout, got ${sample.holdoutInstanceIds.length}`);
}

const selectedIds = sample.selected.map((t) => t.instanceId);

write("stage5_m168_sample_manifest.json", {
  milestone: "M168-E",
  drawnFrom: {
    source: "Vexp-ai/vexp-swe-bench@d658e345:data/swe-bench-100.jsonl",
    fileSha256: manifestSha,
    poolSize: pool.length,
    verifiedAgainstM168A: true,
  },
  selectedBefore: "any arm definition was materialised and any treatment executed",
  selectionVariables: {
    used: ["repo", "FAIL_TO_PASS count", "gold patch +/- line count"],
    rationale:
      "all three are published with the task and independent of every treatment; "
      + "the complexity proxy is VEXP's own published formula",
    forbidden: [
      "VTRACE success", "VEXP success", "gold localisation", "retrieval quality",
      "any prior Stage 5 outcome",
    ],
  },
  design: {
    shape: "one task per repository, twelve repositories, twelve tasks",
    seed: 42,
    complexitySpread:
      "repository i of n takes the (i+0.5)/n quantile of its own complexity distribution; "
      + "repository order is a fixed seeded permutation, not alphabetical",
    whyNotProportional:
      "at n=12 proportional allocation spends five slots on django and leaves seven "
      + "repositories unrepresented. The primary comparison is paired, so task difficulty "
      + "is already controlled; repository shape is not, and it is what a search-suppression "
      + "policy should interact with.",
  },
  sampleSize: sample.selected.length,
  repositories: sample.repositories,
  selected: sample.selected,
  selectedIdListSha256: sha256([...selectedIds].sort().join("\n")),
  complexity: {
    min: Math.min(...sample.selected.map((t) => t.complexity)),
    max: Math.max(...sample.selected.map((t) => t.complexity)),
    values: sample.selected.map((t) => t.complexity).sort((a, b) => a - b),
    poolCeilingObserved: Math.max(
      ...pool.map((p) => sample.selected.find((s) => s.instanceId === p.instance_id)?.complexity ?? 0),
    ),
  },
  holdout: {
    size: sample.holdoutInstanceIds.length,
    status: "UNTOUCHED — reserved for extension, never read by this experiment",
    idListSha256: sha256([...sample.holdoutInstanceIds].sort().join("\n")),
    instanceIds: sample.holdoutInstanceIds,
  },
});

// ── freeze the arms ─────────────────────────────────────────────────

const vtraceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT, encoding: "utf-8",
}).trim();
const vtraceDirty = execFileSync("git", ["status", "--porcelain", "src"], {
  cwd: ROOT, encoding: "utf-8",
}).trim();

const exampleRepoPath = "<WORKSPACE>/<instance_id>";
const exampleEventLog = "<RESULTS>/_m168_guard_events/<label>.jsonl";
const exampleHookPath = `${exampleRepoPath}/.claude/hooks/vtrace-guard.sh`;

const arms = M168_ARMS.map((arm) => {
  const claudeMd = claudeMdForArm(arm);
  const settings = settingsJsonForArm(arm, exampleHookPath);
  const mcp = mcpConfigForArm(arm, exampleRepoPath, `${ROOT}/src/cli/index.ts`);
  return {
    ...armDefinition(arm),
    allowedTools: allowedToolsForArm(arm),
    policyEnforcement: M168_POLICY_ENFORCEMENT[arm],
    claudeMdText: claudeMd,
    settingsJson: settings,
    settingsJsonSha256: settings === null ? null : sha256(JSON.stringify(settings, null, 2)),
    mcpConfigTemplateSha256: sha256(JSON.stringify(mcp, null, 2)),
    guardScriptSha256: arm === "vtrace_strict" ? sha256(guardScript(exampleRepoPath, exampleEventLog)) : null,
  };
});

const strict = arms.find((a) => a.arm === "vtrace_strict")!;
const clean = arms.find((a) => a.arm === "vtrace_clean")!;
const baseline = arms.find((a) => a.arm === "baseline")!;

/**
 * The invariant this whole experiment rests on, checked rather than claimed:
 * B and C share everything except the coercive policy, and A shares nothing.
 */
const isolation = {
  toolInventoryIdentical:
    JSON.stringify(strict.visibleToolIds) === JSON.stringify(clean.visibleToolIds),
  mcpConfigIdentical: strict.mcpConfigTemplateSha256 === clean.mcpConfigTemplateSha256,
  allowedToolsIdentical:
    JSON.stringify(strict.allowedTools) === JSON.stringify(clean.allowedTools),
  mandateShared: claudeMdForArm("vtrace_strict")!.includes(M168_MANDATE_TEXT.split("\n### Workflow")[0]!),
  cleanPolicyIsExactlyTheMandate: clean.claudeMdSha256 === sha256(M168_MANDATE_TEXT),
  strictMinusProhibitionEqualsClean:
    sha256(claudeMdForArm("vtrace_strict")!.replace(M168_PROHIBITION_TEXT, ""))
      === clean.claudeMdSha256,
  onlyStrictHasGuard: strict.searchGuard && !clean.searchGuard && !baseline.searchGuard,
  baselineCarriesNoVtrace:
    !baseline.vtracePresent
    && baseline.claudeMdSha256 === null
    && baseline.visibleToolIds.length === 0
    && baseline.allowedTools.every((t) => !t.startsWith("mcp__")),
};

const isolationHolds = Object.values(isolation).every(Boolean);
if (!isolationHolds) {
  throw new Error(`arm isolation invariant failed: ${JSON.stringify(isolation, null, 2)}`);
}

write("stage5_m168_arm_schedule.json", {
  milestone: "M168-E",
  reframing:
    "Does the VEXP-published coercive investigation policy change the utility or economics "
    + "of VTRACE's already-qualified run_pipeline treatment? This tests the POLICY MECHANISM "
    + "the public VEXP benchmark code implements, with VTRACE as the intelligence engine. "
    + "It does not reproduce and does not claim to reproduce the historical VEXP 73%.",
  preservedM168Conclusions: {
    historicalVexpGradingResult: "REAL",
    historicalIntendedTreatmentCompliance: "NOT SUPPORTED BY COMMITTED TELEMETRY",
    pairedHistoricalNoVexpBaseline: "ABSENT",
    accounting: "ACCOUNTING_DEFINITION_GAP_CONFIRMED",
    broad100A: "EXACT VEXP 100-TASK MANIFEST",
  },
  vtrace: {
    commit: vtraceCommit,
    srcClean: vtraceDirty === "",
    frozenFor: "the whole live phase — no retrieval, ranking, composition, budget, schema or rendering change",
  },
  pipelineToolName: M168_PIPELINE_TOOL_NAME,
  pipelineToolNameVerifiedAtRuntime: true,
  visibleToolIds: M168_VISIBLE_TOOL_IDS,
  normalToolsAllArms: M168_ALLOWED_TOOLS,
  arms,
  armIsolationInvariant: { ...isolation, holds: isolationHolds },
  comparisons: {
    primary: "B vs C — does coercion change work, economics or outcome?",
    secondary: ["C vs A — clean pipeline utility", "B vs A — full VEXP-shaped scaffold utility"],
  },
  plannedRuns: { tasks: 12, arms: 3, total: 36 },
  schedule: buildSchedule(selectedIds),
});

console.log("\nsample and arms frozen");
console.log(`  tasks: ${selectedIds.length}, holdout: ${sample.holdoutInstanceIds.length}`);
console.log(`  arm isolation invariant: ${isolationHolds ? "HOLDS" : "FAILED"}`);
