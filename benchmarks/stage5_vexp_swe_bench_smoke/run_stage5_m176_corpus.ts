/**
 * M176-E — response totality, qualified on Broad100-A and Broad100-B.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_corpus.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_corpus.ts --corpus broad100b
 *
 * TWO CHECKOUTS, ONE CORPUS, ONE INDEX. The `before` arm is served by a worktree
 * pinned to the pre-repair commit and the `after` arm by this one, both answering
 * against the SAME absolute workspaces and the SAME indexes over the real MCP
 * stdio transport. Retrieval and ranking are not merely expected to be unchanged —
 * they are the same code reading the same database, and the only difference
 * between the arms is what happens when the response envelope cannot be met.
 *
 * TWO BUDGETS, BECAUSE ONE WOULD ANSWER THE WRONG QUESTION.
 *
 *   default   what an ordinary caller asks for. Measures §43: the safety net must
 *             be invisible, and every response that already worked must come
 *             through byte-identical.
 *   pressured what makes the defect reachable. Measures §44: every case that
 *             ended in handler_failed must now end in a bounded truthful
 *             response, and none may end in a fabricated absence.
 *
 * Measuring only the default budget would report totality on a corpus where the
 * condition never arises, which is not a measurement of totality.
 *
 * GOLD IS NOT SCORED. Retrieval is unchanged by construction. There is no
 * retrieval claim in this milestone and none is derivable from it.
 *
 * Offline. Local index reads only; no agent, no Docker, no paid API.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callRunPipeline, loadProblemStatements } from "./m175Capture";
import { isRecord, PROVIDER_TOKENS_PER_CHARACTER } from "./m176Envelope";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CACHE = path.join(RESULTS, "_m176_corpus");

/** The pre-repair checkout. Created by M176; nothing else owns it. */
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m176/pre-repair";

/**
 * The pressured budget.
 *
 * Chosen from measurement, not taste: M176-A's floor search put the tightest real
 * specimen's envelope floor at 193 estimator tokens, and the live threshold on that
 * case sits exactly there — `max_tokens` 150 throws, 193 does not. 150 is therefore
 * the smallest budget that is a valid request and is known to reach the condition
 * on real corpus data rather than on a fixture.
 */
const PRESSURED_MAX_TOKENS = 150;

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";

interface ManifestCase { readonly instanceId: string; readonly repoRoot: string }

/** One terminal outcome, as a caller receives it. */
interface Outcome {
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  /** orientation | decline | authoritative | refused */
  readonly kind: string;
  readonly declineState: string | null;
  readonly focusAt: string | null;
  readonly relatedCount: number;
  readonly characters: number;
  readonly billedTokens: number;
  readonly serialized: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function readOutcome(raw: unknown): Outcome {
  const envelope = isRecord(raw) ? raw : {};
  const result = isRecord(envelope.result) ? envelope.result : null;
  const output = result?.output ?? null;
  const error = isRecord(result?.error) ? result!.error : null;
  const serialized = JSON.stringify(output ?? null);
  const record = isRecord(output) ? output : {};
  const schemaVersion = text(record.schemaVersion);

  const kind = result?.ok !== true
    ? "refused"
    : schemaVersion === "run_pipeline.orientation/1"
      ? "orientation"
      : schemaVersion === "run_pipeline.orientation.none/1"
        ? "decline"
        : "authoritative";

  const focus = isRecord(record.focus) ? record.focus : null;
  return {
    ok: result?.ok === true,
    errorCode: typeof error?.code === "string" ? error.code : null,
    errorDetail: isRecord(error?.details) && typeof error!.details.error === "string" ? error!.details.error : null,
    kind,
    declineState: kind === "decline" ? text(record.state) : null,
    focusAt: focus === null ? null : text(focus.at) || null,
    relatedCount: Array.isArray(record.related) ? record.related.length : 0,
    characters: serialized.length,
    billedTokens: Math.round(serialized.length * PROVIDER_TOKENS_PER_CHARACTER),
    serialized,
  };
}

/** Capture once and cache on disk; re-runs are free and byte-stable. */
async function cached(
  instanceId: string,
  repoRoot: string,
  task: string,
  arm: string,
  cliRoot: string,
  maxTokens: number | undefined,
): Promise<Outcome> {
  const dir = path.join(CACHE, corpus, arm);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${instanceId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Outcome;

  let outcome: Outcome;
  try {
    // `callRunPipeline` resolves the whole MCP result envelope, refusals included,
    // so a handler failure arrives here as data rather than as a thrown error.
    outcome = readOutcome(await callRunPipeline(repoRoot, task, null, maxTokens, 900_000, cliRoot));
  } catch (cause) {
    outcome = {
      ok: false, errorCode: "harness_error",
      errorDetail: cause instanceof Error ? cause.message : String(cause),
      kind: "refused", declineState: null, focusAt: null, relatedCount: 0,
      characters: 0, billedTokens: 0, serialized: "null",
    };
  }
  writeFileSync(file, `${JSON.stringify(outcome)}\n`);
  return outcome;
}

interface Row {
  readonly instanceId: string;
  readonly taskCharacters: number;
  readonly defaultBefore: Outcome;
  readonly defaultAfter: Outcome;
  readonly pressuredBefore: Outcome;
  readonly pressuredAfter: Outcome;
  readonly defaultIdentical: boolean;
  readonly pressuredRecovered: boolean;
  readonly pressuredStillFails: boolean;
}

const tally = (outcomes: readonly Outcome[]) => {
  const counts: Record<string, number> = {
    orientation: 0, decline_no_relevant_evidence: 0, decline_evidence_found_but_undelivered: 0,
    decline_repository_not_ready: 0, decline_no_focus_selected: 0, authoritative: 0,
    refused_repo_not_ready: 0, refused_invalid_request: 0, refused_handler_failed_envelope: 0,
    refused_handler_failed_other: 0, refused_other: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.kind === "orientation") counts.orientation! += 1;
    else if (outcome.kind === "decline") counts[`decline_${outcome.declineState ?? "unknown"}`] = (counts[`decline_${outcome.declineState ?? "unknown"}`] ?? 0) + 1;
    else if (outcome.kind === "authoritative") counts.authoritative! += 1;
    else if (outcome.errorCode === "repo_not_ready") counts.refused_repo_not_ready! += 1;
    else if (outcome.errorCode === "invalid_request") counts.refused_invalid_request! += 1;
    else if (outcome.errorCode === "handler_failed") {
      if (outcome.errorDetail === "product_response_envelope_unreachable") counts.refused_handler_failed_envelope! += 1;
      else counts.refused_handler_failed_other! += 1;
    } else counts.refused_other! += 1;
  }
  return counts;
};

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_ROOT)) {
    throw new Error(
      `M176-E needs the pre-repair worktree at ${PRE_REPAIR_ROOT}.\n`
      + "  git worktree add --detach /home/calvin/bench/vtrace-m176/pre-repair eec70c3c\n"
      + `  ln -s ${ROOT}/node_modules ${PRE_REPAIR_ROOT}/node_modules`,
    );
  }
  const statements = loadProblemStatements(DATASET);
  const manifestPath = path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: readonly ManifestCase[] };

  const rows: Row[] = [];
  let index = 0;
  for (const entry of manifest.cases) {
    index += 1;
    const task = statements.get(entry.instanceId);
    if (task === undefined || !existsSync(entry.repoRoot)) {
      console.log(`[${index}/${manifest.cases.length}] ${entry.instanceId} SKIPPED (no task or workspace)`);
      continue;
    }
    const defaultBefore = await cached(entry.instanceId, entry.repoRoot, task, "default.before", PRE_REPAIR_ROOT, undefined);
    const defaultAfter = await cached(entry.instanceId, entry.repoRoot, task, "default.after", ROOT, undefined);
    const pressuredBefore = await cached(entry.instanceId, entry.repoRoot, task, "pressured.before", PRE_REPAIR_ROOT, PRESSURED_MAX_TOKENS);
    const pressuredAfter = await cached(entry.instanceId, entry.repoRoot, task, "pressured.after", ROOT, PRESSURED_MAX_TOKENS);

    const row: Row = {
      instanceId: entry.instanceId,
      taskCharacters: task.length,
      defaultBefore, defaultAfter, pressuredBefore, pressuredAfter,
      defaultIdentical: defaultBefore.serialized === defaultAfter.serialized,
      pressuredRecovered: pressuredBefore.errorDetail === "product_response_envelope_unreachable" && pressuredAfter.ok,
      pressuredStillFails: pressuredAfter.errorDetail === "product_response_envelope_unreachable",
    };
    rows.push(row);
    console.log(
      `[${index}/${manifest.cases.length}] ${entry.instanceId.padEnd(34)}`
      + ` default ${defaultBefore.kind}→${defaultAfter.kind}${row.defaultIdentical ? " =" : " CHANGED"}`
      + `  pressured ${pressuredBefore.ok ? pressuredBefore.kind : "REFUSED"}→${pressuredAfter.ok ? pressuredAfter.kind : "REFUSED"}`,
    );
  }

  const defaultBeforeCounts = tally(rows.map((row) => row.defaultBefore));
  const defaultAfterCounts = tally(rows.map((row) => row.defaultAfter));
  const pressuredBeforeCounts = tally(rows.map((row) => row.pressuredBefore));
  const pressuredAfterCounts = tally(rows.map((row) => row.pressuredAfter));

  const changed = rows.filter((row) => !row.defaultIdentical);
  const recovered = rows.filter((row) => row.pressuredRecovered);
  const stillFailing = rows.filter((row) => row.pressuredStillFails);
  // §25: no recovered case may report an absence it did not observe.
  const fabricatedAbsence = recovered.filter((row) => row.pressuredAfter.declineState === "no_relevant_evidence");

  const report = {
    schemaVersion: "stage5.m176.corpus.v1",
    milestone: "M176",
    workstream: "E",
    corpus,
    question: "Does every valid request terminate in a bounded product response, and are responses "
      + "that already worked unchanged?",
    method: "Two checkouts, one corpus, one index, real MCP stdio transport. Retrieval and ranking "
      + "are the same code reading the same database in both arms.",
    preRepairRoot: PRE_REPAIR_ROOT,
    pressuredMaxTokens: PRESSURED_MAX_TOKENS,
    pressuredMaxTokensWhy: "M176-A measured the tightest real specimen's envelope floor at 193 "
      + "estimator tokens and the live threshold sits exactly there. 150 is the smallest valid "
      + "budget known to reach the condition on real corpus data.",
    validRequests: rows.length,
    denominators: {
      note: "Every count below is over the same denominator: the cases with a task and a workspace. "
        + "States are reported separately and never pooled.",
      cases: rows.length,
      manifestCases: manifest.cases.length,
    },
    defaultBudget: {
      before: defaultBeforeCounts,
      after: defaultAfterCounts,
      identical: rows.length - changed.length,
      changed: changed.map((row) => ({
        instanceId: row.instanceId,
        before: { kind: row.defaultBefore.kind, characters: row.defaultBefore.characters },
        after: { kind: row.defaultAfter.kind, characters: row.defaultAfter.characters },
      })),
      envelopeInducedHandlerFailures: defaultAfterCounts.refused_handler_failed_envelope,
    },
    pressuredBudget: {
      before: pressuredBeforeCounts,
      after: pressuredAfterCounts,
      envelopeInducedHandlerFailuresBefore: pressuredBeforeCounts.refused_handler_failed_envelope,
      envelopeInducedHandlerFailuresAfter: pressuredAfterCounts.refused_handler_failed_envelope,
      recovered: recovered.length,
      recoveredInstances: recovered.map((row) => row.instanceId),
      stillFailing: stillFailing.map((row) => row.instanceId),
      fabricatedAbsence: fabricatedAbsence.map((row) => row.instanceId),
      maxModelFacingBilledTokens: rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.pressuredAfter.billedTokens)),
    },
    maxModelFacingBilledTokensDefaultAfter: rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.defaultAfter.billedTokens)),
    goldScored: false,
    goldScoredWhy: "Retrieval is unchanged by construction; there is no retrieval claim in M176 and "
      + "none is derivable from it.",
    rows: rows.map((row) => ({
      instanceId: row.instanceId,
      taskCharacters: row.taskCharacters,
      defaultBefore: { kind: row.defaultBefore.kind, declineState: row.defaultBefore.declineState, ok: row.defaultBefore.ok, errorDetail: row.defaultBefore.errorDetail, billedTokens: row.defaultBefore.billedTokens },
      defaultAfter: { kind: row.defaultAfter.kind, declineState: row.defaultAfter.declineState, ok: row.defaultAfter.ok, errorDetail: row.defaultAfter.errorDetail, billedTokens: row.defaultAfter.billedTokens },
      defaultIdentical: row.defaultIdentical,
      pressuredBefore: { kind: row.pressuredBefore.kind, declineState: row.pressuredBefore.declineState, ok: row.pressuredBefore.ok, errorDetail: row.pressuredBefore.errorDetail, billedTokens: row.pressuredBefore.billedTokens },
      pressuredAfter: { kind: row.pressuredAfter.kind, declineState: row.pressuredAfter.declineState, ok: row.pressuredAfter.ok, errorDetail: row.pressuredAfter.errorDetail, billedTokens: row.pressuredAfter.billedTokens },
      pressuredRecovered: row.pressuredRecovered,
    })),
  };

  writeFileSync(path.join(RESULTS, `stage5_m176_${corpus}.json`), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n── ${corpus} ──`);
  console.log(`valid requests                                    ${rows.length}`);
  console.log(`default budget, byte-identical before→after       ${rows.length - changed.length}/${rows.length}`);
  console.log(`default budget, envelope handler failures after   ${defaultAfterCounts.refused_handler_failed_envelope}`);
  console.log(`pressured budget, envelope handler failures before ${pressuredBeforeCounts.refused_handler_failed_envelope}`);
  console.log(`pressured budget, envelope handler failures after  ${pressuredAfterCounts.refused_handler_failed_envelope}`);
  console.log(`pressured budget, recovered                        ${recovered.length}`);
  console.log(`pressured budget, fabricated absence               ${fabricatedAbsence.length}`);
  console.log(`wrote results/stage5_m176_${corpus}.json`);
}

await main();
