/**
 * M173-A protocol freeze — fix the sample, the two arms and the PRODUCT STATE
 * before any treatment executes and before any money is spent.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_protocol.ts
 *
 * M168 froze arms against a policy. M173 freezes them against a product: the
 * manipulated variable is what `run_pipeline` hands the model, which changed at
 * b173df2d and must not change again while the sweep runs. So the freeze hashes
 * the projector, the tool module and the runner from live source, records the
 * HEAD and the cleanliness of `src/`, and refuses to write itself if the sample
 * is not the exact M168/M169 twelve.
 *
 * Everything held fixed is held by import from `m168Treatment`, so "only the
 * product moved" is a checked identity rather than a sentence.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ECONOMIC_THRESHOLDS } from "./m169Economics";
import { M168_MANDATE_TEXT, M168_PROHIBITION_TEXT } from "./m168Treatment";
import {
  M168_CLEAN_POLICY_SHA256,
  M173_ALLOWED_TOOLS,
  M173_ARMS,
  M173_MANDATE_TEXT,
  M173_PIPELINE_TOOL_NAME,
  M173_VISIBLE_TOOL_IDS,
  ORIENTATION_SCHEMA_VERSION,
  allowedToolsForArm,
  armDefinition,
  buildSchedule,
  claudeMdForArm,
  mcpConfigForArm,
  sha256,
} from "./m173Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

mkdirSync(RESULTS, { recursive: true });

const write = (name: string, value: unknown) => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${name}`);
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();

const fileSha = (relative: string): string =>
  createHash("sha256").update(readFileSync(path.join(ROOT, relative))).digest("hex");

// ── the sample: the exact M168/M169 twelve, or nothing ──────────────

const m168Sample = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m168_sample_manifest.json"), "utf8"),
) as { selected: { instanceId: string; repo: string; baseCommit: string; complexity: number; difficulty: string }[]; selectedIdListSha256: string };

const selected = m168Sample.selected;
const selectedIds = selected.map((t) => t.instanceId);
const recomputedSha = sha256([...selectedIds].sort().join("\n"));

if (selected.length !== 12) {
  throw new Error(`expected the frozen twelve, got ${selected.length}`);
}
if (recomputedSha !== m168Sample.selectedIdListSha256) {
  throw new Error(
    `the M168 sample manifest no longer hashes to its own recorded id list: `
    + `${recomputedSha} != ${m168Sample.selectedIdListSha256}`,
  );
}
// §13 — the sample may not be re-selected, filtered or trimmed. Named
// explicitly because the temptation is specific and documented.
if (!selectedIds.includes("sphinx-doc__sphinx-7462")) {
  throw new Error("sphinx-doc__sphinx-7462 is missing: the sample must not drop known failures");
}

// ── the product under test, hashed from live source ─────────────────

const PROJECTOR = "src/runPipeline/orientationProjection.ts";
const TOOLS = "src/mcp/tools.ts";
const RUNNER = "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts";
const WIRING = "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_arm_wiring.ts";
const TREATMENT = "benchmarks/stage5_vexp_swe_bench_smoke/m173Treatment.ts";

const productState = {
  vtraceCommit: git("rev-parse", "HEAD"),
  vtraceCommitSubject: git("log", "-1", "--pretty=%s"),
  srcTreeHash: git("rev-parse", "HEAD:src"),
  srcClean: git("status", "--porcelain", "src") === "",
  m172ShippedAt: "b173df2d",
  files: {
    [PROJECTOR]: fileSha(PROJECTOR),
    [TOOLS]: fileSha(TOOLS),
    [RUNNER]: fileSha(RUNNER),
    [WIRING]: fileSha(WIRING),
    [TREATMENT]: fileSha(TREATMENT),
  },
  orientationSchemaVersion: ORIENTATION_SCHEMA_VERSION,
  disclosureContract:
    "run_pipeline default returns the bounded orientation projection; the authoritative "
    + "orchestration result stays server-side and is reachable only at detail=debug. "
    + "No arm passes a detail argument.",
  frozenFor:
    "the whole live phase — no product, projector, retrieval, ranking, prompt, budget or "
    + "schema change once the first live task starts",
};

if (!productState.srcClean) {
  throw new Error("src/ is dirty; the product under test must be a committed state");
}

// ── the arms ────────────────────────────────────────────────────────

const exampleRepoPath = "<RESULTS>/workspaces/<label>/<instance_id>";

const arms = M173_ARMS.map((arm) => {
  const claudeMd = claudeMdForArm(arm);
  const mcp = mcpConfigForArm(arm, exampleRepoPath, `${ROOT}/src/cli/index.ts`);
  return {
    ...armDefinition(arm),
    allowedTools: allowedToolsForArm(arm),
    claudeMdText: claudeMd,
    mcpConfigTemplateSha256: sha256(JSON.stringify(mcp, null, 2)),
    hooks: null,
    settingsJson: null,
  };
});

const baseline = arms.find((a) => a.arm === "baseline")!;
const compact = arms.find((a) => a.arm === "vtrace_compact")!;

/**
 * The invariants the causal claim rests on, each checked rather than asserted.
 *
 * The first is the one that makes M173 a requalification instead of a new
 * experiment: arm B's prose is M168's clean arm to the byte, so the difference
 * between M169's economics and M173's cannot be a difference in what the agent
 * was told.
 */
const isolation = {
  treatmentProseIsM168CleanArmExactly: compact.claudeMdSha256 === M168_CLEAN_POLICY_SHA256,
  mandateTextHeldByImport: M173_MANDATE_TEXT === M168_MANDATE_TEXT,
  noProhibitionAnywhere: arms.every(
    (a) => a.claudeMdText === null || !a.claudeMdText.includes(M168_PROHIBITION_TEXT.trim()),
  ),
  noArmHasAHook: arms.every((a) => a.settingsJson === null && a.searchGuard === false),
  noArmNamesADetailLevel: arms.every(
    (a) => a.claudeMdText === null || !a.claudeMdText.includes("detail"),
  ),
  toolInventoryIsTheM168FrozenTwo:
    JSON.stringify(compact.visibleToolIds) === JSON.stringify(M173_VISIBLE_TOOL_IDS)
    && M173_VISIBLE_TOOL_IDS.length === 2,
  baselineCarriesNoVtrace:
    !baseline.vtracePresent
    && baseline.claudeMdSha256 === null
    && baseline.visibleToolIds.length === 0
    && baseline.allowedTools.every((t) => !t.startsWith("mcp__")),
  baselineMcpConfigIsEmpty:
    baseline.mcpConfigTemplateSha256 === sha256(JSON.stringify({ mcpServers: {} }, null, 2)),
};

const isolationHolds = Object.values(isolation).every(Boolean);
if (!isolationHolds) {
  throw new Error(`arm isolation invariant failed: ${JSON.stringify(isolation, null, 2)}`);
}

// ── freeze ──────────────────────────────────────────────────────────

write("stage5_m173_start_state.json", {
  milestone: "M173",
  question:
    "Does the shipped M172 compact automatic orientation produce measurable end-to-end "
    + "coding-agent benefit now that its attributable first-call cost has fallen by roughly "
    + "an order of magnitude?",
  productState,
  inheritedFrom: {
    m168: "the twelve-task frozen sample, the mandate prose, the tool inventory, the live driver shape",
    m169: "the economic definitions, the corrected runtime accounting, the frozen thresholds",
    m172: "the shipped compact orientation default, which IS the manipulated variable",
  },
  notInherited: {
    m169Verdict: "NO_FURTHER_PROACTIVE_PIPELINE_WORK",
    why:
      "that verdict priced a treatment that no longer exists. M172 changed the first-call "
      + "disclosure from a median 6,884 model-visible tokens to 621, so the causal comparison "
      + "is rerun rather than inherited.",
  },
  outOfScope: [
    "retrieval tuning", "pivot tuning", "output-size tuning", "VEXP reproduction",
    "search coercion", "optional-tool adoption", "transparent Read/Grep mediation",
  ],
});

write("stage5_m173_arm_contracts.json", {
  milestone: "M173",
  design: "two arms, one manipulated variable, and the variable is the product's default disclosure",
  pipelineToolName: M173_PIPELINE_TOOL_NAME,
  visibleToolIds: M173_VISIBLE_TOOL_IDS,
  declaredNormalTools: M173_ALLOWED_TOOLS,
  declaredVsObserved:
    "M173_ALLOWED_TOOLS is the harness's declared whitelist. The agent process is spawned by "
    + "the external VEXP harness and inherits the full Claude Code tool set, so the OBSERVED "
    + "inventory is read from each run's system/init event and recorded per run. The declared "
    + "list is not evidence of the observed one.",
  arms,
  armIsolationInvariant: { ...isolation, holds: isolationHolds },
  detailArgument: {
    passedByAnyArm: false,
    reachableByTheAgent: true,
    note:
      "`detail` is an agent-settable parameter of the shipped tool and its output schema says "
      + "detail=debug returns the authoritative result. No arm asks for it, and blocking it "
      + "would be a product change M173 is forbidden to make. Whether an agent reaches for it "
      + "is therefore a MEASURED product behaviour, classified per run, not an assumed absence.",
  },
});

write("stage5_m173_manifest.json", {
  milestone: "M173",
  source: "stage5_m168_sample_manifest.json — the exact frozen M168/M169 twelve, unmodified",
  selectedIdListSha256: recomputedSha,
  matchesM168: recomputedSha === m168Sample.selectedIdListSha256,
  sampleSize: selected.length,
  reselection: "FORBIDDEN — §13. No task removed for expected outcome; sphinx-7462 verified present.",
  selected,
});

write("stage5_m173_schedule.json", {
  milestone: "M173",
  scheduling:
    "per-task paired, arm order alternating by task position so neither arm systematically "
    + "owns the earlier half of the execution window or the first attempt at a fresh clone",
  frozenBeforeExecution: true,
  plannedRuns: { tasks: selected.length, arms: M173_ARMS.length, total: selected.length * M173_ARMS.length },
  sequential: "REQUIRED — the first pass writes a shared results/_agent_stream.jsonl",
  schedule: buildSchedule(selectedIds),
});

write("stage5_m173_economic_thresholds.json", {
  milestone: "M173",
  frozenBefore: "any M173 live run existed",
  inheritedFrom: "M169, unchanged",
  thresholds: ECONOMIC_THRESHOLDS,
  classes: {
    ORIENTATION_ECONOMIC_WIN: `ratio <= ${ECONOMIC_THRESHOLDS.winAtOrBelow}`,
    ROUGH_BREAK_EVEN: `${ECONOMIC_THRESHOLDS.winAtOrBelow} < ratio <= ${ECONOMIC_THRESHOLDS.breakEvenAtOrBelow}`,
    ORIENTATION_ECONOMIC_LOSS: `ratio > ${ECONOMIC_THRESHOLDS.breakEvenAtOrBelow}, or displaced nothing while costing something`,
    NOT_MEASURABLE: "a censored arm, or a broken cache identity, in the pair",
  },
  ratio: "orientation attributable cost / paired pre-edit investigation displaced",
  investigationDefinition: {
    kinds: ["SEARCH", "READ", "SHELL_INSPECTION"],
    source: "m169Economics.INVESTIGATION_KINDS, imported not restated",
    redefinitionAfterResults: "FORBIDDEN — §27",
  },
  winRule:
    "§38 — a win requires the orientation's attributable cost to be offset by measured reduced "
    + "investigation or whole-run cost. Fewer grep calls are not savings.",
});

console.log("\nM173 protocol frozen");
console.log(`  product: ${productState.vtraceCommit.slice(0, 8)} (src clean: ${productState.srcClean})`);
console.log(`  tasks: ${selected.length}, arms: ${M173_ARMS.length}, planned runs: ${selected.length * M173_ARMS.length}`);
console.log(`  arm isolation invariant: ${isolationHolds ? "HOLDS" : "FAILED"}`);
console.log(`  treatment prose == M168 clean arm: ${isolation.treatmentProseIsM168CleanArmExactly}`);
