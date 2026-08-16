// M154 search-safety evaluator.
//
// One runner for both M154 corpora, because they measure the same product path
// from two angles: whether naming the project distorts the lead (M154-C), and
// whether a bounded selection is presented as something stronger than it is
// (M154-D/E).
//
// It is written to run UNCHANGED inside a predecessor checkout. Everything that
// differs between arms — the corpus file, the fixture repositories, the output
// directory — arrives as an argument, and the only thing resolved relative to the
// script itself is `../../src`. That is what makes the two arms comparable: the
// same questions, over freshly materialized copies of the same source, answered by
// two different implementations of the same entry point.
//
// Session isolation (§57) is structural rather than promised: each arm materializes
// its own copies and indexes into their own `.vtrace/`, so no index or session
// state is ever shared between arms.

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
// The guidance block is projected from the capsule DOWNSTREAM of buildCapsuleV2,
// so measuring the capsule alone measures none of the prose an agent actually
// reads. The first baseline run reported zero anti-search advice for exactly that
// reason, while the predecessor emitted it on every single response.
import { buildInspectFirst, renderInspectFirstText } from "../../src/runPipeline/inspectFirst";
// buildCapsuleV2 returns the snake_case wire shape; the guidance projection reads
// the adapted camelCase product response. Skipping the adapter made every
// buildInspectFirst call throw into its own catch and report null — a silent zero
// that looked exactly like "no advice was emitted".
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { initRepo } from "../../src/setup/initRepo";

const execFile = promisify(execFileCallback);

const BUDGET_TOKENS = 8000;

interface Args {
  readonly corpus: string;
  readonly reuseCorpus: string;
  readonly sourceRoot: string;
  readonly reposRoot: string;
  readonly out: string;
  readonly label: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag);
    if (index === -1 || argv[index + 1] === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`missing required argument ${flag}`);
    }
    return argv[index + 1]!;
  };
  return {
    corpus: get("--project-name-corpus"),
    reuseCorpus: get("--reuse-corpus"),
    sourceRoot: get("--source-root"),
    reposRoot: get("--repos-root"),
    out: get("--out"),
    label: get("--label"),
  };
}

/** One delivered item, reduced to what a safety judgement actually needs. */
interface DeliveredItem {
  readonly role: string;
  readonly path: string;
  readonly symbol: string;
}

interface QueryOutcome {
  readonly query: string;
  readonly lead: DeliveredItem | null;
  readonly delivered: readonly DeliveredItem[];
  readonly deliveredCount: number;
  readonly resolved: boolean;
  readonly coverageMode: string | null;
  readonly absenceClaim: string | null;
  readonly enumerationComplete: boolean | null;
  readonly antiSearchAdvice: string | null;
  readonly guidanceBytes: number;
  readonly renderedBytes: number;
}

function itemsOf(response: unknown, key: "pivots" | "support"): DeliveredItem[] {
  const bag = (response as Record<string, unknown>)[key];
  if (!Array.isArray(bag)) return [];
  return bag.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      role: key === "pivots" ? "pivot" : "support",
      path: typeof item.path === "string" ? item.path : "",
      symbol: typeof item.symbol === "string" ? item.symbol : "",
    };
  });
}

/**
 * Advice that tells a reader not to keep looking. Detected on the rendered text
 * rather than on a flag, because the harm is done by the words the model reads —
 * a field nobody serializes cannot mislead anyone.
 */
/// The cue and the advice sit on different lines — the block renders an "Avoid
/// first:" heading above a bullet — so the span must be allowed to cross a
/// newline. A first pass that stopped at `\n` scored the predecessor at zero.
const ANTI_SEARCH_PATTERN =
  /(?:avoid|do not|don't|no need to|before manual)[\s\S]{0,60}?\b(?:grep|ripgrep|rg)\b/i;

function runQuery(repoRoot: string, query: string): QueryOutcome {
  const db = openIndexerDatabase(path.join(repoRoot, ".vtrace", "index.sqlite"));
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot,
      task: query,
      intent: CapsuleIntent.Auto,
      maxTokens: BUDGET_TOKENS,
    });
    const product = toCapsuleV2ProductResponse(result);
    const response = result as unknown as Record<string, unknown>;
    const pivots = itemsOf(response, "pivots");
    const support = itemsOf(response, "support");
    const delivered = [...pivots, ...support];
    const rendered = typeof response.renderedContext === "string"
      ? response.renderedContext
      : JSON.stringify(response);
    const guidance = renderInspectFirstText(buildInspectFirst(product));
    const coverage = response.coverage as Record<string, unknown> | undefined;
    const antiSearch = ANTI_SEARCH_PATTERN.exec(`${guidance}\n${rendered}`);

    return {
      query,
      lead: delivered[0] ?? null,
      delivered,
      deliveredCount: delivered.length,
      resolved: pivots.length > 0,
      coverageMode: typeof coverage?.mode === "string" ? coverage.mode : null,
      absenceClaim: typeof coverage?.absenceClaim === "string" ? coverage.absenceClaim : null,
      enumerationComplete: typeof coverage?.enumerationComplete === "boolean"
        ? coverage.enumerationComplete
        : null,
      antiSearchAdvice: antiSearch === null ? null : antiSearch[0],
      guidanceBytes: Buffer.byteLength(guidance, "utf8"),
      renderedBytes: Buffer.byteLength(rendered, "utf8"),
    };
  } finally {
    db.close();
  }
}

/**
 * A copy of the checkout whose ROOT BASENAME is the project name — the whole point
 * of the exercise, since the alias resolver reads the basename and the SWE-bench
 * directories are named after their instance instead.
 */
async function materializeRepo(
  sourceRoot: string,
  sourceWorkspace: string,
  reposRoot: string,
  project: string,
): Promise<string> {
  const destination = path.join(reposRoot, project);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await execFile("rsync", [
    "-a",
    "--exclude",
    ".git",
    "--exclude",
    ".vtrace",
    `${path.join(sourceRoot, sourceWorkspace)}/`,
    `${destination}/`,
  ]);
  // Some historical checkouts carry a file no current parser accepts — the
  // requests fixture vendors a Python 2 module with an invalid escape. Indexing
  // is fail-closed on that, so the fixture drops the offending files and records
  // it. They are vendored third-party modules, never a case's expected evidence.
  const removed: string[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await initRepo({ repoPath: destination });
      if (removed.length > 0) {
        process.stderr.write(`  unparseable, excluded from ${project}: ${removed.join(", ")}\n`);
      }
      return destination;
    } catch (error) {
      const failures = (error as { failures?: readonly { path?: string }[] }).failures;
      if (failures === undefined || failures.length === 0) throw error;
      for (const failure of failures) {
        if (typeof failure.path !== "string") continue;
        removed.push(failure.path);
        await rm(path.join(destination, failure.path), { force: true });
      }
    }
  }
  throw new Error(`could not index ${project} after excluding ${removed.length} unparseable file(s)`);
}

interface ProjectNameCase {
  readonly id: string;
  readonly kind: string;
  readonly project: string;
  readonly sourceWorkspace: string;
  readonly named: string;
  readonly plain?: string;
  readonly expectedPrimaryEvidence: { path: string; symbol: string } | null;
  readonly knownDistractors?: readonly string[];
  readonly mustRemainDiscoverable?: boolean;
}

interface ReuseCase {
  readonly id: string;
  readonly category: string;
  readonly project: string;
  readonly sourceWorkspace: string;
  readonly query: string;
  readonly implementationExists: boolean | null;
  readonly expectedPrimaryEvidence: { path: string; symbol: string } | null;
  readonly knownDistractors?: readonly string[];
  readonly crossRevision: boolean;
  readonly vtraceCanAuthoritativelyProveAbsence: boolean;
}

function hits(outcome: QueryOutcome, expected: { path: string; symbol: string } | null): boolean {
  if (expected === null) return false;
  return outcome.delivered.some((item) =>
    item.path.endsWith(expected.path) && item.symbol === expected.symbol);
}

function leadIs(outcome: QueryOutcome, expected: { path: string; symbol: string } | null): boolean {
  if (expected === null || outcome.lead === null) return false;
  return outcome.lead.path.endsWith(expected.path) && outcome.lead.symbol === expected.symbol;
}

function leadIsDistractor(outcome: QueryOutcome, distractors: readonly string[]): boolean {
  if (outcome.lead === null) return false;
  return distractors.some((distractor) => outcome.lead!.path.endsWith(distractor));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  await mkdir(args.reposRoot, { recursive: true });

  const projectCorpus = JSON.parse(await readFile(args.corpus, "utf8")) as {
    cases: readonly ProjectNameCase[];
  };
  const reuseCorpus = JSON.parse(await readFile(args.reuseCorpus, "utf8")) as {
    cases: readonly ReuseCase[];
  };

  const needed = new Map<string, string>();
  for (const entry of [...projectCorpus.cases, ...reuseCorpus.cases]) {
    needed.set(entry.project, entry.sourceWorkspace);
  }

  const repoRoots = new Map<string, string>();
  for (const [project, sourceWorkspace] of needed) {
    process.stderr.write(`materializing ${project} from ${sourceWorkspace}\n`);
    repoRoots.set(project, await materializeRepo(args.sourceRoot, sourceWorkspace, args.reposRoot, project));
  }

  // ---- M154-C: paired project-name measurement -----------------------------
  const projectRows = projectCorpus.cases.map((entry) => {
    const repoRoot = repoRoots.get(entry.project)!;
    const named = runQuery(repoRoot, entry.named);
    const plain = entry.plain === undefined ? null : runQuery(repoRoot, entry.plain);
    const distractors = entry.knownDistractors ?? [];

    return {
      id: entry.id,
      kind: entry.kind,
      project: entry.project,
      named: {
        query: entry.named,
        lead: named.lead,
        leadIsExpected: leadIs(named, entry.expectedPrimaryEvidence),
        expectedDelivered: hits(named, entry.expectedPrimaryEvidence),
        leadIsKnownDistractor: leadIsDistractor(named, distractors),
        deliveredCount: named.deliveredCount,
        antiSearchAdvice: named.antiSearchAdvice,
      },
      plain: plain === null ? null : {
        query: entry.plain,
        lead: plain.lead,
        leadIsExpected: leadIs(plain, entry.expectedPrimaryEvidence),
        expectedDelivered: hits(plain, entry.expectedPrimaryEvidence),
        deliveredCount: plain.deliveredCount,
      },
      // The paired verdict: naming the project must not lose evidence the plain
      // phrasing found. Losing it is the poisoning this milestone is about.
      pairedRegression: plain !== null
        && hits(plain, entry.expectedPrimaryEvidence)
        && !hits(named, entry.expectedPrimaryEvidence),
      pairedLeadDivergence: plain !== null
        && leadIs(plain, entry.expectedPrimaryEvidence)
        && !leadIs(named, entry.expectedPrimaryEvidence),
      explicitIdentifierPreserved: entry.mustRemainDiscoverable === true
        ? hits(named, entry.expectedPrimaryEvidence)
        : null,
    };
  });

  // ---- M154-D/E: reuse-before-write safety ---------------------------------
  const reuseRows = reuseCorpus.cases.map((entry) => {
    const repoRoot = repoRoots.get(entry.project)!;
    const outcome = runQuery(repoRoot, entry.query);
    const distractors = entry.knownDistractors ?? [];

    // A materially wrong actionable lead WHILE stronger source-backed evidence
    // exists, presented without the coverage caution its evidence warrants.
    const wrongActionableLead = entry.implementationExists === true
      && entry.expectedPrimaryEvidence !== null
      && outcome.lead !== null
      && !leadIs(outcome, entry.expectedPrimaryEvidence)
      && leadIsDistractor(outcome, distractors);
    const cautionPresent = outcome.coverageMode === "selective_task_retrieval"
      && outcome.absenceClaim === "not_observed"
      && outcome.enumerationComplete === false;

    // A selective miss serialized as, or left to read as, absence.
    const selectiveMiss = entry.implementationExists === true
      && !hits(outcome, entry.expectedPrimaryEvidence);

    return {
      id: entry.id,
      category: entry.category,
      project: entry.project,
      crossRevision: entry.crossRevision,
      lead: outcome.lead,
      deliveredCount: outcome.deliveredCount,
      resolved: outcome.resolved,
      expectedDelivered: hits(outcome, entry.expectedPrimaryEvidence),
      leadIsExpected: leadIs(outcome, entry.expectedPrimaryEvidence),
      coverageMode: outcome.coverageMode,
      absenceClaim: outcome.absenceClaim,
      enumerationComplete: outcome.enumerationComplete,
      cautionPresent,
      renderedBytes: outcome.renderedBytes,
      guidanceBytes: outcome.guidanceBytes,
      antiSearchAdvice: outcome.antiSearchAdvice,
      falseAuthority: wrongActionableLead && !cautionPresent,
      wrongActionableLead,
      selectiveMiss,
      // The hard target: a miss may never be presented as proof of absence
      // unless an exact lane actually proved it.
      falseAbsenceImplication: selectiveMiss
        && !entry.vtraceCanAuthoritativelyProveAbsence
        && (outcome.enumerationComplete === true || outcome.absenceClaim === "authoritative_absence"),
      unsupportedAntiSearchAdvice: outcome.antiSearchAdvice !== null,
    };
  });

  const summary = {
    label: args.label,
    projectName: {
      cases: projectRows.length,
      pairedRegressions: projectRows.filter((row) => row.pairedRegression).length,
      pairedLeadDivergences: projectRows.filter((row) => row.pairedLeadDivergence).length,
      explicitIdentifierControls: projectRows.filter((row) => row.explicitIdentifierPreserved !== null).length,
      explicitIdentifierPreserved: projectRows.filter((row) => row.explicitIdentifierPreserved === true).length,
      namedLeadIsDistractor: projectRows.filter((row) => row.named.leadIsKnownDistractor).length,
    },
    reuse: {
      cases: reuseRows.length,
      falseAuthority: reuseRows.filter((row) => row.falseAuthority).length,
      wrongActionableLead: reuseRows.filter((row) => row.wrongActionableLead).length,
      selectiveMiss: reuseRows.filter((row) => row.selectiveMiss).length,
      falseAbsenceImplication: reuseRows.filter((row) => row.falseAbsenceImplication).length,
      unsupportedAntiSearchAdvice: reuseRows.filter((row) => row.unsupportedAntiSearchAdvice).length,
      coverageStated: reuseRows.filter((row) => row.cautionPresent).length,
      meanRenderedBytes: Math.round(
        reuseRows.reduce((total, row) => total + row.renderedBytes, 0) / Math.max(1, reuseRows.length),
      ),
    },
  };

  const artifact = { summary, projectRows, reuseRows };
  const target = path.join(args.out, `stage5_m154_search_safety_${args.label}.json`);
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`wrote ${target}\n`);
}

await main();
