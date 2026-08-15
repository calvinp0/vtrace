// M149 evidence: do consumers below routing claim only what the evidence supports?
//
// The corpus below is executed TWICE — once against the M148 predecessor's
// `nominateRepositories`, imported from a detached worktree, and once against
// this tree's. §97 is the reason: a suite that only validates already-correct
// behaviour proves nothing about the milestone, so every scenario records what
// the predecessor said as well as what the candidate says, and each is
// classified `already_correct`, `defect_reproduced` or `not_applicable`.
//
// Members are synthetic. Every question here is about what a set of ANSWERS
// licenses a consumer to state, and building real indexes to produce answers the
// scenario already specifies would add runtime without adding evidence. The real
// ARC/TCKDB acceptance runs separately and read-only.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceReadiness } from "../../src/workspace/readiness";
import { RegistrationStatus, type RegisteredRepository, type WorkspaceRegistry } from "../../src/workspace/registry";
import {
  aggregateCrossRepoContext,
  formatRepositoryProvenance,
  type CrossRepoCandidate,
} from "../../src/workspace/crossRepoAggregation";
import {
  classifyNegativeClaim,
  NegativeClaimStrength,
  type EvidenceCoverage,
} from "../../src/workspace/evidenceClaims";
import {
  nominateRepositories as candidateNominate,
  type RepositoryProbe,
  type RepositoryRelevance,
  type RepositoryRelevanceRequest,
} from "../../src/workspace/repositoryRelevance";

/** The predecessor router, loaded from a worktree checked out at its commit. */
type Nominate = (request: RepositoryRelevanceRequest) => RepositoryRelevance;

async function loadPredecessor(root: string): Promise<Nominate> {
  const module = await import(path.join(root, "src/workspace/repositoryRelevance.ts")) as {
    nominateRepositories: Nominate;
  };
  return module.nominateRepositories;
}

function member(alias: string, rootPath = `/ws/${alias}`): RegisteredRepository {
  return {
    alias,
    displayName: alias,
    rootPath,
    statePath: `${rootPath}/.vtrace`,
    dbPath: `${rootPath}/.vtrace/index.db`,
    configPath: "/ws/vtrace-workspace.json",
    enabled: true,
    identity: null,
    repositoryId: `repo-${alias}`,
    worktreeId: `wt-${alias}`,
    registration: RegistrationStatus.Verified,
    registrationMismatches: [],
  };
}

function registryOf(repositories: readonly RegisteredRepository[]): WorkspaceRegistry {
  return {
    workspaceId: "ws",
    configPath: "/ws/vtrace-workspace.json",
    isWorkspace: true,
    repositories,
    defaultAlias: null,
  };
}

function readinessOf(
  repositories: readonly RegisteredRepository[],
  isReady: (alias: string) => boolean,
  notReadyReason: string,
): WorkspaceReadiness {
  const repos = repositories.map((repo) => ({
    alias: repo.alias,
    rootPath: repo.rootPath,
    repositoryId: repo.repositoryId,
    worktreeId: repo.worktreeId,
    enabled: true,
    registration: repo.registration,
    index: null,
    ready: isReady(repo.alias),
    reason: isReady(repo.alias) ? "ready" : notReadyReason,
  }));
  return {
    workspaceId: "ws",
    total: repos.length,
    ready: repos.filter((repo) => repo.ready).length,
    stale: repos.filter((repo) => !repo.ready).length,
    missing: 0,
    mismatched: 0,
    unavailable: 0,
    repos,
  };
}

interface Scenario {
  readonly id: string;
  readonly section: string;
  /** What the producer knows, in one line. */
  readonly producerEvidence: string;
  /** The upgrade this scenario exists to forbid, or null when it is a control. */
  readonly forbiddenUpgrade: string | null;
  readonly build: () => {
    readonly request: Omit<RepositoryRelevanceRequest, "registry" | "readiness"> & {
      readonly registry: WorkspaceRegistry;
      readonly readiness: WorkspaceReadiness;
    };
    /** Aliases whose index must never be opened. */
    readonly mustNotOpen?: readonly string[];
  };
}

function probeOver(
  paths: Readonly<Record<string, readonly string[]>>,
  symbols: Readonly<Record<string, readonly string[]>>,
  opened: string[],
) {
  return (repo: RegisteredRepository): RepositoryProbe | null => {
    opened.push(repo.alias);
    return {
      indexedPaths: () => paths[repo.alias] ?? [],
      hasExactSymbol: (name: string) => (symbols[repo.alias] ?? []).includes(name),
    };
  };
}

const STALE = "source_stale (indexed snapshot is behind the checkout)";
const REFUSED = "derivation_changed (indexer fingerprint moved)";

const SCENARIOS: readonly Scenario[] = [
  {
    id: "complete_exact_path_absence",
    section: "§42",
    producerEvidence: "3 enabled members, all ready, none indexes the path",
    forbiddenUpgrade: null,
    build: () => {
      const repos = [member("a"), member("b"), member("c")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          pathHints: ["src/nothing_indexes_this.py"],
          probe: probeOver({ a: ["src/a.py"], b: ["src/b.py"], c: ["src/c.py"] }, {}, opened),
        },
      };
    },
  },
  {
    id: "complete_exact_symbol_absence",
    section: "§55",
    producerEvidence: "2 enabled members, all ready, neither defines the name",
    forbiddenUpgrade: null,
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["nowhere_at_all"],
          probe: probeOver({}, { a: ["parse"], b: ["render"] }, opened),
        },
      };
    },
  },
  {
    id: "incomplete_absence_unknown_member",
    section: "§43/§46",
    producerEvidence: "3 members; one refused, two ready and absent",
    forbiddenUpgrade: "all inspected members lack target -> all enabled members lack target",
    build: () => {
      const repos = [member("a"), member("b"), member("c")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, (alias) => alias !== "c", REFUSED),
          symbolHints: ["nowhere_at_all"],
          probe: probeOver({}, { a: ["parse"], b: ["render"] }, opened),
        },
        mustNotOpen: ["c"],
      };
    },
  },
  {
    id: "refused_member_with_positive_membership",
    section: "§44",
    producerEvidence: "b is refused for retrieval but does index the path",
    forbiddenUpgrade: "routing refused B -> B does not contain the target",
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, (alias) => alias !== "b", REFUSED),
          pathHints: ["shared/pipeline.py"],
          probe: probeOver({ a: ["shared/pipeline.py"], b: ["shared/pipeline.py"] }, {}, opened),
        },
        mustNotOpen: ["b"],
      };
    },
  },
  {
    id: "refused_member_without_usable_membership",
    section: "§45",
    producerEvidence: "b refused, no authoritative membership evidence available",
    forbiddenUpgrade: "no usable evidence -> absence",
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, (alias) => alias !== "b", REFUSED),
          symbolHints: ["parse"],
          probe: probeOver({}, { a: [] }, opened),
        },
        mustNotOpen: ["b"],
      };
    },
  },
  {
    id: "omitted_by_bound",
    section: "§27",
    producerEvidence: "6 ready members, scan bound of 2",
    forbiddenUpgrade: "member omitted because bound reached -> negative evidence",
    build: () => {
      const repos = Array.from({ length: 6 }, (_, index) => member(`m${index}`));
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["nowhere_at_all"],
          probe: probeOver({}, {}, opened),
          limits: { maxPresenceScans: 2 },
        },
      };
    },
  },
  {
    id: "abstention_not_absence",
    section: "§26",
    producerEvidence: "two members both define the name",
    forbiddenUpgrade: "routing abstained -> target not present anywhere",
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
          probe: probeOver({}, { a: ["parse"], b: ["parse"] }, opened),
        },
      };
    },
  },
  {
    id: "nothing_checked_no_hints",
    section: "§26/§110",
    producerEvidence: "2 ready members; the request names no path or symbol",
    forbiddenUpgrade: "no candidate found in usable indexes -> no implementation exists",
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          probe: probeOver({ a: ["src/a.py"] }, { a: ["parse"] }, opened),
        },
      };
    },
  },
  {
    id: "nothing_checked_no_probe",
    section: "§23/§114",
    producerEvidence: "a symbol hint, but no index probe is available",
    forbiddenUpgrade: "retrieval could not run -> implementation absent",
    build: () => {
      const repos = [member("a"), member("b")];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
        },
      };
    },
  },
  {
    id: "source_stale_indexed_snapshot",
    section: "§20/§47",
    producerEvidence: "b is source_stale; its exclusion must name the snapshot",
    forbiddenUpgrade: "stale index -> repository is irrelevant",
    build: () => {
      const repos = [member("a"), member("b")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, (alias) => alias !== "b", STALE),
          symbolHints: ["parse"],
          probe: probeOver({}, { a: ["parse"] }, opened),
        },
        mustNotOpen: ["b"],
      };
    },
  },
  {
    id: "support_repo_is_not_owner",
    section: "§38/§62",
    producerEvidence: "owner holds the located path; client carries weaker-tier evidence",
    forbiddenUpgrade: "repository A contains supporting code -> A owns the behaviour",
    build: () => {
      const repos = [member("owner"), member("client")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          pathHints: ["/ws/owner/core/engine.py"],
          symbolHints: ["parse", "parse2", "parse3"],
          probe: probeOver(
            { owner: ["core/engine.py"], client: ["core/engine.py"] },
            { client: ["parse", "parse2", "parse3"] },
            opened,
          ),
          collectSupportingEvidence: true,
        },
      };
    },
  },
  {
    id: "tests_only_support",
    section: "§40",
    producerEvidence: "impl defines the name; tests repo only holds a test path",
    forbiddenUpgrade: "supporting evidence in B -> implementation lives in B",
    build: () => {
      const repos = [member("impl"), member("tests")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
          probe: probeOver({}, { impl: ["parse"] }, opened),
        },
      };
    },
  },
  {
    id: "config_docs_only_support",
    section: "§41",
    producerEvidence: "impl defines the name; docs repo only references it in prose",
    forbiddenUpgrade: "config/doc reference -> ownership",
    build: () => {
      const repos = [member("impl"), member("docs")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
          probe: probeOver({ docs: ["docs/parse.md"] }, { impl: ["parse"] }, opened),
        },
      };
    },
  },
  {
    id: "reverse_support_direction",
    section: "§39",
    producerEvidence: "wrapper is registered first; impl actually defines the name",
    forbiddenUpgrade: "first-success ordering -> ownership assigned to the wrapper",
    build: () => {
      const repos = [member("wrapper"), member("impl")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
          probe: probeOver({}, { impl: ["parse"] }, opened),
        },
      };
    },
  },
  {
    id: "single_repo_collapse",
    section: "§112",
    producerEvidence: "one enabled member, ready, defines the name",
    forbiddenUpgrade: null,
    build: () => {
      const repos = [member("solo")];
      const opened: string[] = [];
      return {
        request: {
          registry: registryOf(repos),
          readiness: readinessOf(repos, () => true, STALE),
          symbolHints: ["parse"],
          probe: probeOver({}, { solo: ["parse"] }, opened),
        },
      };
    },
  },
];

interface SideResult {
  readonly status: string;
  readonly reason: string;
  readonly selected: readonly string[];
  readonly supporting: readonly string[];
  readonly decidingTier: string | null;
  readonly presenceProofStatus: string | null;
  readonly indexedPathProofStatus: string | null;
  readonly reasonChars: number;
  readonly excludedRows: number;
  readonly coverage: readonly EvidenceCoverage[] | null;
  readonly negativeStrength: string | null;
  readonly openedIndexes: readonly string[];
}

function runSide(nominate: Nominate, scenario: Scenario): SideResult {
  const built = scenario.build();
  const opened: string[] = [];
  // Re-wrap the probe so index opens are observed on this side only.
  const inner = built.request.probe;
  const request = {
    ...built.request,
    probe: inner === undefined ? undefined : (repo: RegisteredRepository) => {
      opened.push(repo.alias);
      return inner(repo);
    },
  } as RepositoryRelevanceRequest;

  const relevance = nominate(request);
  const diagnostics = relevance.diagnostics as RepositoryRelevance["diagnostics"] & {
    coverage?: readonly EvidenceCoverage[];
  };
  const coverage = diagnostics.coverage ?? null;
  const deciding = coverage?.find((entry) => entry.purpose === "deciding") ?? null;

  return {
    status: relevance.status,
    reason: relevance.reason,
    selected: relevance.selected.map((repo) => repo.alias),
    supporting: relevance.supporting.map((repo) => repo.alias),
    decidingTier: diagnostics.decidingTier,
    presenceProofStatus: diagnostics.presenceProof?.status ?? null,
    indexedPathProofStatus: diagnostics.indexedPathProof?.status ?? null,
    reasonChars: relevance.reason.length,
    excludedRows: diagnostics.reposExcludedNotReady.length,
    coverage,
    negativeStrength: deciding === null ? null : classifyNegativeClaim(deciding),
    openedIndexes: [...new Set(opened)].sort(),
  };
}

/**
 * Does this sentence assert a global negative? Deliberately keyword-based and
 * conservative: the point is to catch a claim the evidence did not earn, and a
 * checker that only recognised the exact predecessor string would pass the
 * moment someone reworded it.
 */
function assertsGlobalAbsence(reason: string): boolean {
  const lowered = reason.toLowerCase();
  if (lowered.includes("could not be checked")) return false;
  if (lowered.includes("no repository was checked")) return false;
  if (lowered.includes("no repository could be checked")) return false;
  if (lowered.includes("names no path or symbol")) return false;
  return lowered.includes("no repository carries evidence")
    || (lowered.includes("no eligible repository") && !lowered.includes("were checked"));
}

function classify(before: SideResult, after: SideResult, scenario: Scenario): string {
  if (scenario.forbiddenUpgrade === null) {
    return before.reason === after.reason && before.status === after.status
      ? "already_correct"
      : "already_correct_wording_sharpened";
  }
  const beforeOverclaims = assertsGlobalAbsence(before.reason)
    || before.reasonChars > 400
    || before.excludedRows > 4;
  const afterOverclaims = assertsGlobalAbsence(after.reason)
    || after.reasonChars > 400
    || after.excludedRows > 4;
  if (beforeOverclaims && !afterOverclaims) return "defect_reproduced_and_fixed";
  if (beforeOverclaims && afterOverclaims) return "defect_reproduced_still_present";
  return "already_correct";
}

function coverageScale(nominate: Nominate, counts: readonly number[]) {
  return counts.map((count) => {
    const repos = Array.from({ length: count }, (_, index) => member(`m${index}`));
    const opened: string[] = [];
    const relevance = nominate({
      registry: registryOf(repos),
      readiness: readinessOf(repos, (alias) => alias === "m0", REFUSED),
      symbolHints: ["parse"],
      probe: probeOver({}, { m0: ["parse"] }, opened),
    });
    const diagnostics = relevance.diagnostics as RepositoryRelevance["diagnostics"] & {
      coverage?: readonly EvidenceCoverage[];
    };
    // The shape a product response would carry: routing summary fields only.
    const normalResponse = {
      status: relevance.status,
      reason: relevance.reason,
      excludedNotReady: diagnostics.reposExcludedNotReady,
      candidates: relevance.candidates.map((repo) => repo.alias),
      coverage: diagnostics.coverage ?? [],
    };
    return {
      members: count,
      responseBytes: JSON.stringify(normalResponse).length,
      reasonChars: relevance.reason.length,
      detailedMemberRecords: diagnostics.reposExcludedNotReady.length
        + (diagnostics.presenceProof?.unknown.length ?? 0)
        + (diagnostics.coverage?.[0]?.examples.length ?? 0),
      summaryCounts: {
        excludedTotal: (diagnostics as { reposExcludedNotReadyTotal?: number }).reposExcludedNotReadyTotal ?? null,
        unknownTotal: (diagnostics.presenceProof as { unknownTotal?: number } | null)?.unknownTotal ?? null,
        considered: diagnostics.coverage?.[0]?.considered ?? null,
        answered: diagnostics.coverage?.[0]?.answered ?? null,
      },
    };
  });
}

/** §102: what composition does with colliding cross-repository identities. */
function provenanceDedupeMatrix() {
  const make = (
    alias: string,
    worktreeId: string | null,
    relativePath: string,
    symbol: string | null,
  ): CrossRepoCandidate => ({
    repositoryAlias: alias,
    repositoryId: `repo-${alias}`,
    worktreeId,
    relativePath,
    symbol,
    localRank: 1,
    tokens: 100,
  });

  const cases = [
    {
      id: "same_path_different_repo",
      left: make("a", "wt-a", "src/utils.py", null),
      right: make("b", "wt-b", "src/utils.py", null),
    },
    {
      id: "same_fqn_different_repo",
      left: make("a", "wt-a", "foo.py", "foo.parse"),
      right: make("b", "wt-b", "foo.py", "foo.parse"),
    },
    {
      id: "identical_content_different_repo",
      left: make("a", "wt-a", "src/utils.py", "parse"),
      right: make("b", "wt-b", "src/utils.py", "parse"),
    },
    {
      id: "divergent_content_same_path",
      left: make("a", "wt-a", "src/utils.py", "parse"),
      right: make("b", "wt-b", "src/utils.py", "parse_v2"),
    },
    {
      id: "same_path_no_recorded_identity",
      left: make("a", null, "src/utils.py", "parse"),
      right: make("b", null, "src/utils.py", "parse"),
    },
  ];

  return cases.map((entry) => {
    const aggregation = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [
        { alias: entry.left.repositoryAlias, candidates: [entry.left] },
        { alias: entry.right.repositoryAlias, candidates: [entry.right] },
      ],
    });
    return {
      id: entry.id,
      deduped: aggregation.selected.length === 1,
      modelVisibleItems: aggregation.selected.length,
      repositoryProvenanceRetained:
        new Set(aggregation.selected.map((item) => item.repositoryAlias)).size
          === aggregation.selected.length,
      rendered: aggregation.selected.map((item) =>
        formatRepositoryProvenance(item, aggregation.budget.repositoriesContributing)),
    };
  });
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index]!, argv[index + 1]!);
  const predecessorRoot = path.resolve(values.get("--predecessor-root") ?? "");
  const outDir = path.resolve(
    values.get("--out-dir") ?? "benchmarks/stage5_vexp_swe_bench_smoke/results",
  );

  const predecessorNominate = await loadPredecessor(predecessorRoot);

  const rows = SCENARIOS.map((scenario) => {
    const before = runSide(predecessorNominate, scenario);
    const after = runSide(candidateNominate, scenario);
    const built = scenario.build();
    const mustNotOpen = built.mustNotOpen ?? [];
    return {
      scenario: scenario.id,
      section: scenario.section,
      producerEvidence: scenario.producerEvidence,
      forbiddenUpgrade: scenario.forbiddenUpgrade,
      classification: classify(before, after, scenario),
      before,
      after,
      routingUnchanged: before.status === after.status
        && JSON.stringify(before.selected) === JSON.stringify(after.selected),
      refusedMemberNeverOpened: mustNotOpen.every((alias) => !after.openedIndexes.includes(alias)),
      mustNotOpen,
    };
  });

  const corpus = {
    schemaVersion: "stage5.m149.truthfulness-corpus.v1",
    milestone: "M149",
    predecessor: { root: predecessorRoot },
    scenarioCount: rows.length,
    classifications: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.classification] = (counts[row.classification] ?? 0) + 1;
      return counts;
    }, {}),
    routingUnchangedCount: rows.filter((row) => row.routingUnchanged).length,
    refusedMemberNeverOpened: rows.every((row) => row.refusedMemberNeverOpened),
    rows,
  };

  const scale = {
    schemaVersion: "stage5.m149.coverage-scale.v1",
    milestone: "M149",
    note:
      "Synthetic composition (§103): this measures RESPONSE SIZE, not latency. "
      + "The 100/1000-member rows are real serializations of real routing output, "
      + "not projections.",
    predecessor: coverageScale(predecessorNominate, [11, 100, 1000]),
    candidate: coverageScale(candidateNominate, [11, 100, 1000]),
  };

  const dedupe = {
    schemaVersion: "stage5.m149.provenance-dedupe.v1",
    milestone: "M149",
    note: "Composition is shared by both sides; M149 changed nothing here (§129).",
    cases: provenanceDedupeMatrix(),
  };

  await writeFile(
    path.join(outDir, "stage5_m149_truthfulness_before_after.json"),
    `${JSON.stringify(corpus, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "stage5_m149_coverage_scale.json"),
    `${JSON.stringify(scale, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "stage5_m149_provenance_dedupe_matrix.json"),
    `${JSON.stringify(dedupe, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(`scenarios=${rows.length}\n`);
  for (const [key, count] of Object.entries(corpus.classifications)) {
    process.stdout.write(`  ${key}: ${count}\n`);
  }
  process.stdout.write(
    `routingUnchanged=${corpus.routingUnchangedCount}/${rows.length} `
    + `refusedNeverOpened=${corpus.refusedMemberNeverOpened}\n`,
  );
  for (const row of scale.candidate) {
    const before = scale.predecessor.find((entry) => entry.members === row.members)!;
    process.stdout.write(
      `  members=${row.members} bytes ${before.responseBytes} -> ${row.responseBytes}, `
      + `memberRecords ${before.detailedMemberRecords} -> ${row.detailedMemberRecords}\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
