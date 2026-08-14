// M144-B §26-§28, §41, §45 — failure-evidence repository attribution audit.
//
// WHAT THIS ANSWERS
// -----------------
// M144-A measured that failure-LIKE text exists. It says nothing about whether
// that text can be RESOLVED to repository objects, which is the whole question
// §93 puts to Workstream B. This runner resolves every extracted evidence item
// against the real index and records, per item:
//
//   - does the path resolve INSIDE the active repository, and by which rule
//   - if it does not, is it external (stdlib / foreign checkout) or unresolved
//   - for traceback frames: depth, raising site, deepest in-repo frame
//   - does the frame's named symbol exist in the resolved file
//   - what BOUNDED direct relations (calls / references / imports) leave it
//
// and then — EVALUATION ONLY, never an input to any of the above (§79) — whether
// the resolved file, or anything one direct relation away from it, is gold.
//
// TWO RESOLUTION RULES ARE MEASURED, NOT ONE
// ------------------------------------------
// `localizationSignals.resolveFilePath` falls back to a BASENAME match when the
// segment-suffix match finds nothing. That fallback is why `psf/requests-1724`'s
// frame `/Users/hwkns/test_requests.py` — a path on the reporter's laptop that
// has nothing to do with the repository — "resolves" to the repository's own
// `test_requests.py`. §25 says an unknown path must stay unknown, so this audit
// reports strict segment-suffix resolution and basename-fallback resolution
// SEPARATELY, and counts the disagreements.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m144_failure_attribution_audit.ts \
//     --fixture <fixture.json> [--fixture <fixture.json>] [--out <dir> | --evidence]

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { listOutgoingEdgesForSymbols } from "../../src/db/repositories/edgesRepository";
import { getSymbolsByIds, listSymbolsByLocalName } from "../../src/db/repositories/symbolsRepository";
import { isLikelyTestCandidate } from "../../src/retrieval/searchSymbolsShared";
import { samePath } from "./run_stage5_m143b_ownership_evidence_audit";
import { extractRawEvidence, type ExtractedPath, type PathShape } from "./run_stage5_m144_failure_evidence_inventory";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m144_failure_attribution_audit";

/** §45 bound: how many direct relations one failure anchor may contribute. */
const MAX_DIRECT_RELATIONS_PER_ANCHOR = 24;

export type ResolutionOutcome =
  | "resolved_segment_suffix"
  | "resolved_basename_only"
  | "external_unresolved"
  | "ambiguous";

export interface ResolvedEvidence {
  readonly raw: string;
  readonly normalized: string;
  readonly form: ExtractedPath["form"];
  readonly shape: PathShape;
  readonly frameIndex?: number;
  readonly frameSymbol?: string;
  readonly raisingFrame?: boolean;
  /** The strict rule: a `/`-anchored segment-suffix match against indexed paths. */
  readonly strictOutcome: ResolutionOutcome;
  readonly strictPath: string | null;
  /** The permissive rule localizationSignals uses today (basename fallback). */
  readonly fallbackPath: string | null;
  /** True when the fallback invents a resolution the strict rule refuses. */
  readonly fallbackOnly: boolean;
  readonly resolvedFileIsTest: boolean | null;
  /** Exact symbols in the resolved file whose local name is the frame symbol. */
  readonly frameSymbolResolved: readonly string[];
  /** EVALUATION ONLY. */
  readonly evaluationOnly: { readonly resolvesToGold: boolean };
}

export interface DirectRelation {
  readonly fromSymbol: string;
  readonly edgeType: string;
  readonly toPath: string;
  readonly toSymbol: string;
  /** EVALUATION ONLY. */
  readonly evaluationOnly: { readonly targetIsGold: boolean };
}

export interface FrameRoleSummary {
  readonly totalFrames: number;
  readonly inRepoFrames: number;
  readonly externalFrames: number;
  /** 1-based frame index of the deepest frame that resolves inside the repo. */
  readonly deepestInRepoFrameIndex: number | null;
  readonly shallowestInRepoFrameIndex: number | null;
  /** Does the LAST frame (the raising site) resolve inside the repository? */
  readonly raisingFrameInRepo: boolean;
  /** EVALUATION ONLY — which frame role, if any, names a gold file. */
  readonly evaluationOnly: {
    readonly deepestInRepoIsGold: boolean | null;
    readonly shallowestInRepoIsGold: boolean | null;
    readonly anyInRepoFrameIsGold: boolean;
    readonly goldReachedByDirectRelationFromDeepest: boolean;
  };
}

export interface CaseAttribution {
  readonly instanceId: string;
  readonly repo: string;
  readonly evidenceItems: readonly ResolvedEvidence[];
  readonly failingTestNames: readonly string[];
  readonly failingTestsResolved: readonly string[];
  readonly frameRoles: FrameRoleSummary | null;
  readonly directRelationsFromDeepestFrame: readonly DirectRelation[];
  readonly relationsInspected: number;
  readonly evaluationOnly: { readonly goldFiles: readonly string[] };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Strict resolution: the hint must match an indexed path on a `/`-anchored
 * segment boundary, in either direction. Deliberately has NO basename fallback —
 * that is measured separately so the difference between "the repository contains
 * this file" and "the repository contains a file with the same last component"
 * stays visible.
 */
export function resolveStrict(hint: string, allPaths: readonly string[]): {
  outcome: ResolutionOutcome;
  resolved: string | null;
} {
  const cleaned = hint.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (cleaned.length === 0 || /^<.*>$/.test(hint.trim())) {
    return { outcome: "external_unresolved", resolved: null };
  }
  const matches = allPaths.filter((indexed) => samePath(indexed, cleaned));
  if (matches.length === 0) return { outcome: "external_unresolved", resolved: null };
  if (matches.length > 1) {
    // Deterministic pick for reporting, but the AMBIGUOUS outcome is what the
    // capability must respect: §24 forbids guessing which repository object a
    // path string meant when the repository holds several.
    const sorted = [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { outcome: "ambiguous", resolved: sorted[0] ?? null };
  }
  return { outcome: "resolved_segment_suffix", resolved: matches[0]! };
}

/** The permissive rule in `localizationSignals` today, reproduced for comparison. */
export function resolveWithBasenameFallback(hint: string, allPaths: readonly string[]): string | null {
  const strict = resolveStrict(hint, allPaths);
  if (strict.resolved !== null) return strict.resolved;
  const cleaned = hint.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const base = cleaned.includes("/") ? cleaned.slice(cleaned.lastIndexOf("/") + 1) : cleaned;
  if (base.length === 0) return null;
  const matches = allPaths.filter((p) => p === base || p.endsWith(`/${base}`));
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

function isGold(candidate: string | null, goldFiles: readonly string[]): boolean {
  if (candidate === null) return false;
  return goldFiles.some((gold) => samePath(gold, candidate));
}

// ---------------------------------------------------------------------------
// Per-case attribution
// ---------------------------------------------------------------------------

interface FixtureCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly expected_files?: readonly string[];
}

function attributeCase(entry: FixtureCase): CaseAttribution | null {
  const dbPath = path.join(path.resolve(entry.workspace), ".vtrace", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  const raw = extractRawEvidence(entry.task);
  const goldFiles = entry.expected_files ?? [];
  const db = openIndexerDatabase(dbPath);
  try {
    const allPaths = listAllFilePaths(db);

    const evidenceItems: ResolvedEvidence[] = raw.paths.map((item) => {
      const strict = resolveStrict(item.raw, allPaths);
      const fallback = resolveWithBasenameFallback(item.raw, allPaths);
      const resolvedPath = strict.resolved;
      const frameSymbolResolved = resolvedPath === null || item.frameSymbol === undefined
        ? []
        : listSymbolsByLocalName(db, item.frameSymbol)
          .filter((symbol) => samePath(symbol.filePath, resolvedPath))
          .map((symbol) => symbol.fqName);
      return {
        raw: item.raw,
        normalized: item.normalized,
        form: item.form,
        shape: item.shape,
        frameIndex: item.frameIndex,
        frameSymbol: item.frameSymbol,
        raisingFrame: item.raisingFrame,
        strictOutcome: strict.outcome,
        strictPath: resolvedPath,
        fallbackPath: fallback,
        fallbackOnly: resolvedPath === null && fallback !== null,
        resolvedFileIsTest: resolvedPath === null
          ? null
          : isLikelyTestCandidate({ filePath: resolvedPath, localName: "", fqName: resolvedPath }),
        frameSymbolResolved,
        evaluationOnly: { resolvesToGold: isGold(resolvedPath, goldFiles) },
      };
    });

    // --- traceback frame roles ------------------------------------------------
    const frames = evidenceItems
      .filter((item) => item.form === "traceback_frame")
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
    const inRepoFrames = frames.filter((frame) => frame.strictPath !== null);
    const deepest = inRepoFrames.at(-1) ?? null;
    const shallowest = inRepoFrames[0] ?? null;

    // --- bounded direct relations from the deepest in-repo frame (§45) ---------
    const directRelations: DirectRelation[] = [];
    let relationsInspected = 0;
    if (deepest !== null && deepest.frameSymbolResolved.length > 0) {
      const symbolIds = listSymbolsByLocalName(db, deepest.frameSymbol ?? "")
        .filter((symbol) => samePath(symbol.filePath, deepest.strictPath!))
        .map((symbol) => symbol.id);
      const edges = listOutgoingEdgesForSymbols(db, symbolIds);
      relationsInspected = edges.length;
      const byId = getSymbolsByIds(db, edges.map((edge) => edge.dstSymbolId));
      for (const edge of edges.slice(0, MAX_DIRECT_RELATIONS_PER_ANCHOR)) {
        const target = byId.get(edge.dstSymbolId);
        if (target === undefined) continue;
        directRelations.push({
          fromSymbol: deepest.frameSymbolResolved[0] ?? "",
          edgeType: edge.edgeType,
          toPath: target.filePath,
          toSymbol: target.fqName,
          evaluationOnly: { targetIsGold: isGold(target.filePath, goldFiles) },
        });
      }
    }

    const frameRoles: FrameRoleSummary | null = frames.length === 0
      ? null
      : {
        totalFrames: frames.length,
        inRepoFrames: inRepoFrames.length,
        externalFrames: frames.length - inRepoFrames.length,
        deepestInRepoFrameIndex: deepest?.frameIndex ?? null,
        shallowestInRepoFrameIndex: shallowest?.frameIndex ?? null,
        raisingFrameInRepo: frames.at(-1)?.strictPath !== null && frames.at(-1) !== undefined,
        evaluationOnly: {
          deepestInRepoIsGold: deepest === null ? null : deepest.evaluationOnly.resolvesToGold,
          shallowestInRepoIsGold: shallowest === null ? null : shallowest.evaluationOnly.resolvesToGold,
          anyInRepoFrameIsGold: inRepoFrames.some((frame) => frame.evaluationOnly.resolvesToGold),
          goldReachedByDirectRelationFromDeepest: directRelations.some((r) => r.evaluationOnly.targetIsGold),
        },
      };

    // --- failing test names ---------------------------------------------------
    const failingTestsResolved = raw.failingTestNames.flatMap((name) =>
      listSymbolsByLocalName(db, name).map((symbol) => `${symbol.filePath}::${symbol.fqName}`),
    );

    return {
      instanceId: entry.instance_id,
      repo: entry.repo,
      evidenceItems,
      failingTestNames: raw.failingTestNames,
      failingTestsResolved,
      frameRoles,
      directRelationsFromDeepestFrame: directRelations,
      relationsInspected,
      evaluationOnly: { goldFiles },
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fixtureArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--fixture") {
      const value = argv[index + 1];
      if (value !== undefined) out.push(value);
    }
  });
  return out;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun ${RUNNER_NAME}.ts --fixture <f.json> [--fixture …]\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const fixtures = fixtureArgs(process.argv);
  if (fixtures.length === 0) throw new Error("at least one --fixture is required");
  const target = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const cases: CaseAttribution[] = [];
  const skipped: string[] = [];
  for (const fixture of fixtures) {
    const entries = JSON.parse(await readFile(fixture, "utf8")) as FixtureCase[];
    for (const entry of entries) {
      const raw = extractRawEvidence(entry.task);
      // Only cases with at least one PATH-bearing evidence item or a failing-test
      // name have anything to resolve. Everything else is a no-evidence control.
      if (raw.paths.length === 0 && raw.failingTestNames.length === 0) continue;
      const attribution = attributeCase(entry);
      if (attribution === null) skipped.push(entry.instance_id);
      else cases.push(attribution);
    }
  }

  const allItems = cases.flatMap((entry) => entry.evidenceItems);
  const summary = {
    casesWithResolvableEvidence: cases.length,
    evidenceItems: allItems.length,
    strictResolved: allItems.filter((item) => item.strictOutcome === "resolved_segment_suffix").length,
    ambiguous: allItems.filter((item) => item.strictOutcome === "ambiguous").length,
    externalOrUnresolved: allItems.filter((item) => item.strictOutcome === "external_unresolved").length,
    // §25's live risk, quantified.
    basenameFallbackOnly: allItems.filter((item) => item.fallbackOnly).length,
    basenameFallbackOnlyExamples: allItems
      .filter((item) => item.fallbackOnly)
      .map((item) => `${item.raw} -> ${item.fallbackPath}`),
    framesResolvedToTestFile: allItems.filter(
      (item) => item.form === "traceback_frame" && item.resolvedFileIsTest === true,
    ).length,
    failingTestNames: cases.reduce((n, c) => n + c.failingTestNames.length, 0),
    failingTestNamesResolved: cases.filter((c) => c.failingTestsResolved.length > 0).length,
    // §41's candidate ordering, MEASURED rather than assumed.
    frameRoleAccuracy: {
      casesWithFrames: cases.filter((c) => c.frameRoles !== null).length,
      deepestInRepoIsGold: cases.filter((c) => c.frameRoles?.evaluationOnly.deepestInRepoIsGold === true).length,
      shallowestInRepoIsGold: cases.filter((c) => c.frameRoles?.evaluationOnly.shallowestInRepoIsGold === true).length,
      anyInRepoFrameIsGold: cases.filter((c) => c.frameRoles?.evaluationOnly.anyInRepoFrameIsGold === true).length,
      goldOnlyViaDirectRelationFromDeepest: cases.filter(
        (c) => c.frameRoles?.evaluationOnly.anyInRepoFrameIsGold === false
          && c.frameRoles.evaluationOnly.goldReachedByDirectRelationFromDeepest,
      ).length,
    },
  };

  const artifact = {
    schemaVersion: "stage5.m144.failure-attribution-audit.v1",
    milestone: "M144-B",
    section: "§24-§28, §41, §45, §93",
    bounds: { maxDirectRelationsPerAnchor: MAX_DIRECT_RELATIONS_PER_ANCHOR },
    summary,
    skippedUnindexedWorkspaces: skipped,
    cases,
  };
  await writeFile(
    path.join(target.dir, "stage5_m144_failure_path_resolution.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  // §123: the traceback half on its own, because frame ROLE is the question the
  // milestone actually had to settle and it deserves an artifact that is not
  // buried inside general path resolution.
  const tracebackCases = cases.filter((entry) => entry.frameRoles !== null);
  await writeFile(
    path.join(target.dir, "stage5_m144_traceback_attribution.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m144.traceback-attribution.v1",
      milestone: "M144-B",
      section: "§21, §22, §38, §41, §52, §53, §66, §67",
      question:
        "Which frame of a traceback names the code that must change? Measured per role "
        + "(deepest in-repository, shallowest in-repository, raising) against gold, plus "
        + "whether a bounded direct relation from the deepest frame reaches gold.",
      roleAccuracy: summary.frameRoleAccuracy,
      // §45/§78: what admitting every direct relation from the deepest frame
      // would COST, so the decision not to ship that lane rests on a number.
      directRelationPrecision: (() => {
        const relations = tracebackCases.flatMap((entry) => entry.directRelationsFromDeepestFrame);
        const gold = relations.filter((relation) => relation.evaluationOnly.targetIsGold).length;
        return {
          relations: relations.length,
          targetingGold: gold,
          targetingNonGold: relations.length - gold,
          precision: relations.length === 0 ? null : Math.round((gold / relations.length) * 1000) / 1000,
        };
      })(),
      cases: tracebackCases.map((entry) => ({
        instanceId: entry.instanceId,
        frameRoles: entry.frameRoles,
        frames: entry.evidenceItems.filter((item) => item.form === "traceback_frame"),
        directRelationsFromDeepestFrame: entry.directRelationsFromDeepestFrame,
        relationsInspected: entry.relationsInspected,
        evaluationOnly: entry.evaluationOnly,
      })),
    }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote attribution audit to ${target.dir}`);
}

if (import.meta.main) {
  await main();
}
