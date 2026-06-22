/**
 * M61B — No-live replay of the M60 selected set to measure structured digest+contract
 * budget validity AFTER the M61 atomic-truncation fix.
 *
 * For every one of the 15 M60-preregistered tasks this builds the EXACT Stage 5 injected
 * v2 context for the structured-bounded treatment
 *   (--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
 *    --compact-digest-injection),
 * applies the same 12,000-char `truncateContextByPriority` step the harness applies before
 * the agent sees it (with the M61 atomic sentinel blocks), and records:
 *   - validity status (VALID / FAIL_CLOSED_OMITTED / INVALID_* ),
 *   - digest / contract / combined sizes vs the 12,000 budget,
 *   - sentinel integrity (no partial / dangling sentinel),
 *   - structured-grammar + impact checks,
 *   - an approximate component-size breakdown for over/near-budget cases.
 *
 * NO live agents, NO Docker, NO API spend, NO patch evaluation. Pure offline replay over
 * the persisted M60 workspaces under results/workspaces/m60_structured_bounded_<safe>/.
 *
 * Usage:
 *   bun run_stage5_m61b_budget_replay.ts [--out results] [--dataset path.jsonl]
 * Writes:
 *   <out>/stage5_m61b_m60_budget_replay.json   (compact per-case + summary)
 * and prints a RESULT_JSON: line + a human table for the Markdown report.
 */
import path from "node:path";
import {
  loadSweBenchData,
  findSweBenchRecord,
  toSweBenchInstance,
  buildCapsuleV2Task,
  buildVtraceQueryCommand,
  capsuleModeForInstance,
  classifyCapsuleOutput,
  buildStage5DigestEnrichmentsBestEffort,
  STAGE5_ATOMIC_SENTINEL_BLOCKS,
  type CliConfig,
} from "./run_stage5_vexp_swe_bench_smoke.ts";
import { parseDigestDecisionContract } from "../../src/capsuleV2/digestDecisionContract.ts";
import {
  truncateContextByPriority,
  STRUCTURED_CONTRACT_OMITTED_MARKER,
} from "../../src/capsuleV2/sectionBudgetAccounting.ts";

const ROOT = "/home/calvin/code/vtrace";
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const FIXTURE = path.join(RESULTS, "stage5_m60_structured_bounded_breadth_preregistration.json");
const DEFAULT_DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const VTRACE_CONTEXT_MAX_CHARS = 12_000;
const NEAR_BUDGET_THRESHOLD = 10_800; // 90% of 12,000

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}
const OUT = arg("--out", RESULTS);
const DATASET = arg("--dataset", DEFAULT_DATASET);

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}
function block(text: string, start: string, end: string): string {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  return s >= 0 && e >= 0 ? text.slice(s, e + end.length) : "";
}

/** Approximate per-line component sizing of the digest block. */
function digestComponents(digest: string) {
  const comp = {
    header_chars: 0,
    pivot_lines_chars: 0,
    support_lines_chars: 0,
    impact_section_chars: 0,
    budget_warnings_chars: 0,
  };
  let section: keyof typeof comp = "header_chars";
  for (const raw of digest.split("\n")) {
    const line = raw;
    const len = line.length + 1; // include the newline
    if (/^● /.test(line)) section = "pivot_lines_chars";
    else if (/^○ /.test(line)) section = "support_lines_chars";
    else if (/^→ impact/.test(line)) section = "impact_section_chars";
    else if (/^budget:/.test(line) || /^warnings:/.test(line)) section = "budget_warnings_chars";
    else if (/^ {4}why:/.test(line)) {
      /* continuation: stay in current pivot/support section */
    } else if (/^ {4}dependent /.test(line)) section = "impact_section_chars";
    else if (
      section !== "pivot_lines_chars" &&
      section !== "support_lines_chars" &&
      section !== "impact_section_chars" &&
      section !== "budget_warnings_chars"
    ) {
      section = "header_chars";
    }
    comp[section] += len;
  }
  return comp;
}

/** Approximate per-section sizing of the decision-contract block. */
function contractComponents(contract: string) {
  const comp = {
    instructions_chars: 0,
    required_target_table_chars: 0,
    anti_over_edit_rules_chars: 0,
  };
  let section: keyof typeof comp = "instructions_chars";
  for (const raw of contract.split("\n")) {
    const line = raw;
    const len = line.length + 1;
    if (/^Required target decisions/.test(line)) section = "required_target_table_chars";
    else if (/^Anti-over-edit rules/.test(line)) section = "anti_over_edit_rules_chars";
    comp[section] += len;
  }
  return comp;
}

function digestCounts(digest: string) {
  const pivots = countOcc(digest, "\n● ");
  const support = countOcc(digest, "\n○ ");
  const impactReps = (digest.match(/\n {4}dependent /g) ?? []).length;
  const warnMatch = digest.match(/\nwarnings:\s*(.*)/);
  let warnings = 0;
  if (warnMatch && warnMatch[1] !== undefined) {
    const v = warnMatch[1].trim();
    warnings = v === "" || v.toLowerCase() === "none" ? 0 : v.split(",").length;
  }
  return { pivots, support, impactReps, warnings };
}

interface FixtureInstance {
  instance_id: string;
  safe: string;
  repo: string;
  category: string;
  locked_sentinel?: boolean;
}

const fixture = JSON.parse(await Bun.file(FIXTURE).text());
const fixtureInstances: FixtureInstance[] = fixture.instances;
const records = await loadSweBenchData(DATASET);

function workspaceFor(safe: string, instanceId: string): string | null {
  const wsRoot = path.join(RESULTS, "workspaces", `m60_structured_bounded_${safe}`, instanceId);
  if (Bun.file(path.join(wsRoot, ".vtrace", "index.sqlite")).size > 0) return wsRoot;
  return null;
}

interface CaseResult {
  instance_id: string;
  repo: string;
  category: string;
  locked_sentinel: boolean;
  final_status: string;
  budget_chars: number;
  raw_context_chars: number;
  final_context_chars: number;
  digest_chars: number;
  contract_chars: number;
  digest_plus_contract_chars: number;
  free_context_chars_before_truncation: number;
  free_context_chars_after_truncation: number;
  omission_marker_present: boolean;
  essential_blocks_fit_budget: boolean;
  essential_blocks_over_budget_by: number;
  required_target_count: number;
  impact_representative_count: number;
  optional_context_target_count: number;
  digest_pivot_count: number;
  digest_support_count: number;
  digest_warning_count: number;
  truncation_mode: string;
  atomic_preserved: string[];
  atomic_omitted: string[];
  partial_sentinel: boolean;
  near_budget: boolean;
  // diagnostics
  post_digest_ok: boolean;
  post_contract_ok: boolean;
  post_contract_present: boolean;
  impact_present: boolean;
  impact_warning_only: boolean;
  structured_grammar_present: boolean;
  compact_mode_applied: boolean;
  component_breakdown?: Record<string, number>;
}

const cases: CaseResult[] = [];

for (const fi of fixtureInstances) {
  const ws = workspaceFor(fi.safe, fi.instance_id);
  if (ws === null) {
    cases.push({
      instance_id: fi.instance_id,
      repo: fi.repo,
      category: fi.category,
      locked_sentinel: fi.locked_sentinel ?? false,
      final_status: "OTHER_INVALID",
      budget_chars: VTRACE_CONTEXT_MAX_CHARS,
      raw_context_chars: 0,
      final_context_chars: 0,
      digest_chars: 0,
      contract_chars: 0,
      digest_plus_contract_chars: 0,
      free_context_chars_before_truncation: 0,
      free_context_chars_after_truncation: 0,
      omission_marker_present: false,
      essential_blocks_fit_budget: false,
      essential_blocks_over_budget_by: 0,
      required_target_count: 0,
      impact_representative_count: 0,
      optional_context_target_count: 0,
      digest_pivot_count: 0,
      digest_support_count: 0,
      digest_warning_count: 0,
      truncation_mode: "n/a",
      atomic_preserved: [],
      atomic_omitted: [],
      partial_sentinel: false,
      near_budget: false,
      post_digest_ok: false,
      post_contract_ok: false,
      post_contract_present: false,
      impact_present: false,
      impact_warning_only: false,
      structured_grammar_present: false,
      compact_mode_applied: false,
    });
    console.error(`[skip] ${fi.instance_id}: no persisted workspace index`);
    continue;
  }

  const record = findSweBenchRecord(records, fi.instance_id);
  if (record === null) throw new Error(`instance ${fi.instance_id} not in ${DATASET}`);
  const instance = toSweBenchInstance(record);
  const queryText = buildCapsuleV2Task(instance);

  const config = {
    vtraceCommand: "bun src/cli/index.ts",
    vtraceQueryArgs: "",
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    injectCapsuleDigest: true,
  } as unknown as CliConfig;

  const spec = buildVtraceQueryCommand(config, ws, queryText, capsuleModeForInstance(instance));
  const proc = Bun.spawnSync([spec.command, ...spec.args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    console.error(new TextDecoder().decode(proc.stderr));
    throw new Error(`vtrace capsule query failed exit ${proc.exitCode} for ${fi.instance_id}`);
  }
  const stdout = new TextDecoder().decode(proc.stdout);

  const provider = (parsed: Parameters<typeof buildStage5DigestEnrichmentsBestEffort>[0]["result"]) =>
    buildStage5DigestEnrichmentsBestEffort({
      dbPath: path.join(ws, ".vtrace", "index.sqlite"),
      repoRoot: ws,
      query: queryText,
      result: parsed,
      intent: config.capsuleIntent,
    });

  const classify = (opts: { compact: boolean }) =>
    classifyCapsuleOutput(stdout, {
      injectDigest: true,
      query: queryText,
      digestEnrichmentProvider: provider,
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: opts.compact,
    }).context ?? "";

  const ctx = classify({ compact: true }); // the actual M60 treatment context
  const ctxNoCompact = classify({ compact: false });

  const truncated = truncateContextByPriority(ctx, VTRACE_CONTEXT_MAX_CHARS, {
    atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS,
  });
  const ctxTruncated = truncated.text;

  const digest = block(ctx, DIGEST_START, DIGEST_END);
  const contractBlock = block(ctx, CONTRACT_START, CONTRACT_END);
  const digestChars = digest.length;
  const contractChars = contractBlock.length;
  const combined = digestChars + contractChars;

  const contract = parseDigestDecisionContract(ctx);
  const requiredCount = contract.targets.length;
  const counts = digestCounts(digest);

  const hasImpact = /→ impact/.test(digest);
  const impactWarnOnly = /impact_not_threaded_into_digest/.test(digest) && !hasImpact;
  const hasBoundedChoices = /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(ctx);
  const hasTargetId = /target_id/.test(ctx);
  const hasDecisionField = /decision:/.test(ctx);
  const hasReasonField = /reason:/.test(ctx);
  const hasFilesTouched = /files_touched/.test(ctx);
  const structuredGrammarPresent = hasTargetId && hasDecisionField && hasReasonField && hasFilesTouched;
  const compactApplied = countOcc(ctxNoCompact, INSPECT_FIRST) >= 1 && countOcc(ctx, INSPECT_FIRST) === 0;

  // post-truncation sentinel integrity
  const dStart = countOcc(ctxTruncated, DIGEST_START);
  const dEnd = countOcc(ctxTruncated, DIGEST_END);
  const cStart = countOcc(ctxTruncated, CONTRACT_START);
  const cEnd = countOcc(ctxTruncated, CONTRACT_END);
  const postDigestOk = dStart === 1 && dEnd === 1;
  const postContractOk = cStart === 1 && cEnd === 1;
  const postContractPresent = parseDigestDecisionContract(ctxTruncated).present;
  const partialSentinel = (dStart !== dEnd) || (cStart !== cEnd);
  const omissionMarker = ctxTruncated.includes(STRUCTURED_CONTRACT_OMITTED_MARKER);

  // optional context targets: only present in non-compact mode (## VTRACE inspect-first
  // optional-context list). Compact mode drops it → 0 here, but count defensively.
  const optionalContextTargets = (ctx.match(/optional context/gi) ?? []).length;

  const essentialFit = combined <= VTRACE_CONTEXT_MAX_CHARS;
  const overBy = Math.max(0, combined - VTRACE_CONTEXT_MAX_CHARS);
  const freeBefore = ctx.length - combined;
  // free chars after truncation = final length minus whatever atomic blocks survived
  const survivingDigest = postDigestOk ? digestChars : 0;
  const survivingContract = postContractOk ? contractChars : 0;
  const freeAfter = ctxTruncated.length - survivingDigest - survivingContract;

  // classify status
  let status: string;
  if (partialSentinel) {
    status = "INVALID_PARTIAL_SENTINEL";
  } else if (!postDigestOk || !postContractOk || !postContractPresent) {
    // one/both essential blocks omitted
    if (omissionMarker) status = "FAIL_CLOSED_OMITTED";
    else status = "OTHER_INVALID";
  } else if (!hasImpact || impactWarnOnly) {
    status = "INVALID_IMPACT";
  } else if (!structuredGrammarPresent || !hasBoundedChoices || !(requiredCount > 0 && requiredCount <= 4)) {
    status = "INVALID_STRUCTURED_GRAMMAR";
  } else if (!compactApplied) {
    status = "OTHER_INVALID";
  } else {
    status = "VALID";
  }

  const nearBudget = combined >= NEAR_BUDGET_THRESHOLD;

  const result: CaseResult = {
    instance_id: fi.instance_id,
    repo: fi.repo,
    category: fi.category,
    locked_sentinel: fi.locked_sentinel ?? false,
    final_status: status,
    budget_chars: VTRACE_CONTEXT_MAX_CHARS,
    raw_context_chars: ctx.length,
    final_context_chars: ctxTruncated.length,
    digest_chars: digestChars,
    contract_chars: contractChars,
    digest_plus_contract_chars: combined,
    free_context_chars_before_truncation: freeBefore,
    free_context_chars_after_truncation: freeAfter,
    omission_marker_present: omissionMarker,
    essential_blocks_fit_budget: essentialFit,
    essential_blocks_over_budget_by: overBy,
    required_target_count: requiredCount,
    impact_representative_count: counts.impactReps,
    optional_context_target_count: optionalContextTargets,
    digest_pivot_count: counts.pivots,
    digest_support_count: counts.support,
    digest_warning_count: counts.warnings,
    truncation_mode: truncated.budget.truncationMode,
    atomic_preserved: [...(truncated.budget.atomicBlocksPreserved ?? [])],
    atomic_omitted: [...(truncated.budget.atomicBlocksOmitted ?? [])],
    partial_sentinel: partialSentinel,
    near_budget: nearBudget,
    post_digest_ok: postDigestOk,
    post_contract_ok: postContractOk,
    post_contract_present: postContractPresent,
    impact_present: hasImpact,
    impact_warning_only: impactWarnOnly,
    structured_grammar_present: structuredGrammarPresent,
    compact_mode_applied: compactApplied,
  };

  if (overBy > 0 || nearBudget) {
    result.component_breakdown = { ...digestComponents(digest), ...contractComponents(contractBlock) };
  }

  cases.push(result);
  console.error(
    `[done] ${fi.instance_id} status=${status} d=${digestChars} c=${contractChars} sum=${combined} mode=${truncated.budget.truncationMode}`,
  );
}

const summary = {
  milestone: "M61B",
  kind: "no-live offline budget replay (no agents, no Docker, no API spend, no evaluation)",
  budget_chars: VTRACE_CONTEXT_MAX_CHARS,
  near_budget_threshold: NEAR_BUDGET_THRESHOLD,
  fixture_path: path.relative(ROOT, FIXTURE),
  selected_cases: cases.length,
  valid: cases.filter((c) => c.final_status === "VALID").length,
  fail_closed_omitted: cases.filter((c) => c.final_status === "FAIL_CLOSED_OMITTED").length,
  invalid_partial_sentinel: cases.filter((c) => c.final_status === "INVALID_PARTIAL_SENTINEL").length,
  invalid_structured_grammar: cases.filter((c) => c.final_status === "INVALID_STRUCTURED_GRAMMAR").length,
  invalid_impact: cases.filter((c) => c.final_status === "INVALID_IMPACT").length,
  other_invalid: cases.filter((c) => c.final_status === "OTHER_INVALID").length,
  over_budget_cases: cases.filter((c) => c.essential_blocks_over_budget_by > 0).map((c) => c.instance_id),
  near_budget_cases: cases
    .filter((c) => c.near_budget && c.essential_blocks_over_budget_by === 0)
    .map((c) => c.instance_id),
  partial_sentinel_cases: cases.filter((c) => c.partial_sentinel).map((c) => c.instance_id),
  cases,
};

await Bun.write(
  path.join(OUT, "stage5_m61b_m60_budget_replay.json"),
  JSON.stringify(summary, null, 2) + "\n",
);

console.log("RESULT_JSON: " + JSON.stringify({
  selected: summary.selected_cases,
  valid: summary.valid,
  fail_closed: summary.fail_closed_omitted,
  invalid_partial: summary.invalid_partial_sentinel,
  over_budget: summary.over_budget_cases,
  near_budget: summary.near_budget_cases,
}));
