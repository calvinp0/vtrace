/**
 * M149 §119 — evidence CONSUMERS may not strengthen what the producer knew.
 *
 * M146-M148 taught the routing and access layers to tell the truth about their
 * own coverage. This file guards the step after that: a consumer composing those
 * outputs may narrow a claim freely, but it may never widen the SCOPE or
 * strengthen the AUTHORITY of what it was given.
 *
 * The four upgrades that must stay impossible:
 *
 *   "I did not observe it"        -> "it is not there"
 *   "A has supporting code"       -> "A owns the behaviour"
 *   "routing refused B"           -> "B does not contain it"
 *   "no candidate was retrieved"  -> "no implementation exists"
 *
 * Members here are synthetic on purpose. Every case is about what a set of
 * ANSWERS licenses, and building real indexes to ask questions that are already
 * decided by the observation set would buy nothing but runtime — M146 recorded
 * what expensive workspace fixtures cost the suite.
 */
import { describe, expect, test } from "bun:test";

import {
  aggregateCrossRepoContext,
  formatRepositoryProvenance,
  type CrossRepoCandidate,
} from "./crossRepoAggregation";
import { EvidenceCapability, NegativeClaimStrength, classifyNegativeClaim } from "./evidenceClaims";
import type { WorkspaceReadiness } from "./readiness";
import { RegistrationStatus, type RegisteredRepository, type WorkspaceRegistry } from "./registry";
import { UniquenessProofStatus } from "./repositoryPresence";
import {
  nominateRepositories,
  RepositoryRelevanceStatus,
  type RepositoryProbe,
} from "./repositoryRelevance";

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
  notReadyReason = "source_stale (indexed snapshot is behind the checkout)",
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

function probeOver(
  paths: Readonly<Record<string, readonly string[]>>,
  symbols: Readonly<Record<string, readonly string[]>> = {},
) {
  const opened: string[] = [];
  const probe = (repo: RegisteredRepository): RepositoryProbe | null => {
    opened.push(repo.alias);
    return {
      indexedPaths: () => paths[repo.alias] ?? [],
      hasExactSymbol: (name: string) => (symbols[repo.alias] ?? []).includes(name),
    };
  };
  return { probe, opened };
}

const candidate = (
  alias: string,
  worktreeId: string | null,
  relativePath: string,
  symbol: string | null,
  localRank: number,
): CrossRepoCandidate => ({
  repositoryAlias: alias,
  repositoryId: `repo-${alias}`,
  worktreeId,
  relativePath,
  symbol,
  localRank,
  tokens: 100,
});

describe("M149 negative evidence (§16, §26, §100)", () => {
  test("a request with nothing to check does not produce an absence claim", () => {
    // The M149 headline defect. Predecessor emitted the same sentence it used
    // for a fully-checked negative: "No repository carries evidence for this
    // request." — with zero members probed.
    const repos = [member("a"), member("b")];
    const { probe } = probeOver({ a: ["src/utils.py"] }, { a: ["parse"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      probe,
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(relevance.diagnostics.reposDeepProbed).toBe(0);
    expect(relevance.reason).toBe(
      "This request names no path or symbol to route on, so no repository was checked.",
    );
    expect(relevance.reason).not.toContain("No repository carries evidence");
    // Nothing ran, so nothing is claimed.
    expect(relevance.diagnostics.coverage).toEqual([]);
  });

  test("a lane that could not run reports why, not that the target is missing", () => {
    const repos = [member("a"), member("b")];

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      symbolHints: ["parse"],
      // No probe: the question was asked and could not be put to anyone.
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(relevance.reason).toBe(
      "No repository could be checked for this request: no index probe was available.",
    );
  });

  test("a complete exact scan DOES earn its negative", () => {
    // §100: the legitimate case must stay sayable, or the fix is just silence.
    const repos = [member("a"), member("b")];
    const { probe } = probeOver({}, { a: ["parse"], b: ["render"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      symbolHints: ["nowhere_at_all"],
      probe,
    });

    expect(relevance.reason).toBe("No eligible repository defines this name; all 2 were checked.");
    expect(relevance.diagnostics.presenceProof?.status).toBe(UniquenessProofStatus.Absent);
    const [coverage] = relevance.diagnostics.coverage;
    expect(coverage?.complete).toBe(true);
    expect(classifyNegativeClaim(coverage!)).toBe(NegativeClaimStrength.AuthoritativeAbsence);
  });

  test("an unknown member weakens the negative and is never auto-repaired", () => {
    // §46: `b` is refused. Its index must not be opened, and its silence must
    // not be read as an answer.
    const repos = [member("a"), member("b")];
    const { probe, opened } = probeOver({}, { a: ["parse"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, (alias) => alias !== "b"),
      symbolHints: ["nowhere_at_all"],
      probe,
    });

    expect(opened).not.toContain("b");
    expect(relevance.diagnostics.presenceProof?.status).toBe(UniquenessProofStatus.Unproven);
    expect(relevance.reason).toContain("could not be checked");
    const [coverage] = relevance.diagnostics.coverage;
    expect(coverage?.complete).toBe(false);
    expect(coverage?.refusedWithoutEvidence).toBe(1);
    expect(classifyNegativeClaim(coverage!)).toBe(NegativeClaimStrength.BoundedAbsence);
  });

  test("omission by bound weakens the negative exactly as refusal does", () => {
    // §27: a member the scan never reached contributes no absence truth, and the
    // remedy differs from a refused index even though the claim effect matches.
    const repos = Array.from({ length: 6 }, (_, index) => member(`m${index}`));
    const { probe } = probeOver({}, {});

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      symbolHints: ["nowhere_at_all"],
      probe,
      limits: { maxPresenceScans: 2 },
    });

    const [coverage] = relevance.diagnostics.coverage;
    expect(coverage?.answered).toBe(2);
    expect(coverage?.omittedByBound).toBe(4);
    expect(coverage?.refusedWithoutEvidence).toBe(0);
    expect(classifyNegativeClaim(coverage!)).toBe(NegativeClaimStrength.BoundedAbsence);
    expect(relevance.reason).toContain("beyond_scan_bound");
  });

  test("abstention is reported as ambiguity, never as absence", () => {
    // §26. Two owners settle the count; the answer is "we will not choose",
    // which is a different fact from "nothing is there".
    const repos = [member("a"), member("b")];
    const { probe } = probeOver({}, { a: ["parse"], b: ["parse"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      symbolHints: ["parse"],
      probe,
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.reason).not.toContain("No ");
    expect(relevance.diagnostics.presenceProof?.status).toBe(UniquenessProofStatus.Ambiguous);
  });
});

describe("M149 refused and stale members (§18, §20, §44)", () => {
  test("a refused member is identified without its index being read", () => {
    // §18: "refused for retrieval" must not become "does not contain it". The
    // index-free containment tier still names the right repository.
    const repos = [member("a"), member("b")];
    const { probe, opened } = probeOver({ a: ["src/utils.py"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, (alias) => alias !== "b"),
      pathHints: ["/ws/b/src/thing.py"],
      probe,
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NotReady);
    expect(relevance.candidates[0]?.alias).toBe("b");
    expect(relevance.reason).toContain("cannot answer");
    // The whole point: identified, and still never opened.
    expect(opened).not.toContain("b");
  });

  test("a source-stale member's exclusion names the snapshot, not relevance", () => {
    // §20/§52: the reason a member cannot answer is a statement about its INDEX,
    // and calling it "low relevance" would send someone to the wrong problem.
    const repos = [member("a"), member("b")];
    const { probe } = probeOver({}, { a: ["parse"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, (alias) => alias !== "b"),
      symbolHints: ["parse"],
      probe,
    });

    const excluded = relevance.diagnostics.reposExcludedNotReady;
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.alias).toBe("b");
    expect(excluded[0]?.reason).toContain("source_stale");
    expect(excluded[0]?.reason).not.toContain("relevan");
  });
});

describe("M149 support is not ownership (§22, §24, §38)", () => {
  test("supporting repositories are reported as support, never as the lead", () => {
    // `owner` defines the name; `client` merely also indexes the shared path.
    // The lead is chosen by tier, not by how much evidence a supporter carries.
    const repos = [member("owner"), member("client")];
    const { probe } = probeOver(
      { owner: ["core/engine.py"], client: ["core/engine.py"] },
      { client: ["parse", "parse2", "parse3"], owner: [] },
    );

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      pathHints: ["/ws/owner/core/engine.py"],
      symbolHints: ["parse", "parse2", "parse3"],
      probe,
      collectSupportingEvidence: true,
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected[0]?.alias).toBe("owner");
    expect(relevance.supporting.map((repo) => repo.alias)).toEqual(["client"]);
    // The reason names the EVIDENCE that decided, not an ownership verdict.
    expect(relevance.reason).toBe("owner selected on path_containment evidence.");
    expect(relevance.reason).not.toContain("owns");
  });

  test("a truncated support scan says so instead of implying completeness", () => {
    // §27/§110. Twenty members index the path; eight are asked. An empty or
    // short `supporting` list must not read as "nobody else contributes".
    const repos = [member("lead"), ...Array.from({ length: 20 }, (_, i) => member(`s${i}`))];
    const paths = Object.fromEntries(repos.map((repo) => [repo.alias, ["shared/pipeline.py"]]));
    const { probe } = probeOver(paths);

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      pathHints: ["/ws/lead/shared/pipeline.py"],
      probe,
      collectSupportingEvidence: true,
    });

    const coverage = relevance.diagnostics.coverage.find((entry) => entry.purpose === "support");
    expect(coverage).toBeDefined();
    expect(coverage?.considered).toBe(21);
    expect(coverage?.answered).toBe(8);
    expect(coverage?.omittedByBound).toBe(13);
    expect(coverage?.complete).toBe(false);
    expect(coverage?.capability).toBe(EvidenceCapability.PathMembership);
  });
});

describe("M149 provenance through composition (§35, §36, §37, §69)", () => {
  test("the same relative path in two repositories stays two items", () => {
    const aggregation = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "wt-a", "src/utils.py", null, 1)] },
        { alias: "b", candidates: [candidate("b", "wt-b", "src/utils.py", null, 1)] },
      ],
    });

    expect(aggregation.selected).toHaveLength(2);
    expect(aggregation.selected.map((item) => item.repositoryAlias)).toEqual(["a", "b"]);
  });

  test("the same fully-qualified name in two repositories stays two items", () => {
    const aggregation = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "wt-a", "foo.py", "foo.parse", 1)] },
        { alias: "b", candidates: [candidate("b", "wt-b", "foo.py", "foo.parse", 1)] },
      ],
    });

    expect(aggregation.selected).toHaveLength(2);
    expect(new Set(aggregation.selected.map((item) => item.worktreeId)).size).toBe(2);
  });

  test("members without recorded identity still do not collapse into one", () => {
    // A path plus a name is not an identity. When `worktreeId` is missing the
    // alias carries the distinction rather than the two silently merging.
    const aggregation = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [
        { alias: "a", candidates: [candidate("a", null, "src/utils.py", "parse", 1)] },
        { alias: "b", candidates: [candidate("b", null, "src/utils.py", "parse", 1)] },
      ],
    });

    expect(aggregation.selected).toHaveLength(2);
  });

  test("provenance is rendered when it disambiguates and suppressed when it cannot", () => {
    // §111: an ordinary single-repository answer pays no provenance tax.
    const shared = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "wt-a", "src/utils.py", null, 1)] },
        { alias: "b", candidates: [candidate("b", "wt-b", "src/utils.py", null, 1)] },
      ],
    });
    const alone = aggregateCrossRepoContext({
      totalBudget: 10_000,
      repositories: [{ alias: "a", candidates: [candidate("a", "wt-a", "src/utils.py", null, 1)] }],
    });

    expect(formatRepositoryProvenance(shared.selected[0]!, shared.budget.repositoriesContributing))
      .toBe("[repository: a] src/utils.py");
    expect(formatRepositoryProvenance(alone.selected[0]!, alone.budget.repositoriesContributing))
      .toBe("src/utils.py");
  });
});

describe("M149 bounded presentation at workspace scale (§81, §134)", () => {
  test("routing output stays flat from 11 to 1000 members", () => {
    // Predecessor: the reason string alone reached 23,100 characters here,
    // because it interpolated one alias per unknown member.
    const sizes = [11, 100, 1000].map((count) => {
      const repos = Array.from({ length: count }, (_, index) => member(`m${index}`));
      const { probe } = probeOver({}, { m0: ["parse"] });
      const relevance = nominateRepositories({
        registry: registryOf(repos),
        readiness: readinessOf(repos, (alias) => alias === "m0"),
        symbolHints: ["parse"],
        probe,
      });
      return {
        count,
        reasonChars: relevance.reason.length,
        excludedRows: relevance.diagnostics.reposExcludedNotReady.length,
        proofUnknownRows: relevance.diagnostics.presenceProof?.unknown.length ?? 0,
        coverageExampleRows: relevance.diagnostics.coverage[0]?.examples.length ?? 0,
        excludedTotal: relevance.diagnostics.reposExcludedNotReadyTotal,
      };
    });

    for (const size of sizes) {
      expect(size.reasonChars).toBeLessThan(400);
      expect(size.excludedRows).toBeLessThanOrEqual(4);
      expect(size.proofUnknownRows).toBeLessThanOrEqual(4);
      expect(size.coverageExampleRows).toBeLessThanOrEqual(4);
    }
    // Bounded lists, but the COUNTS still tell the truth about the workspace.
    expect(sizes.map((size) => size.excludedTotal)).toEqual([10, 99, 999]);
  });

  test("a single-member workspace produces no cross-repository apparatus", () => {
    // §112/§113: the machinery must collapse, not merely stay small.
    const repos = [member("solo")];
    const { probe } = probeOver({}, { solo: ["parse"] });

    const relevance = nominateRepositories({
      registry: registryOf(repos),
      readiness: readinessOf(repos, () => true),
      symbolHints: ["parse"],
      probe,
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.supporting).toEqual([]);
    expect(relevance.diagnostics.reposExcludedNotReady).toEqual([]);
    expect(relevance.diagnostics.reposExcludedNotReadyTotal).toBe(0);
    const [coverage] = relevance.diagnostics.coverage;
    expect(coverage?.considered).toBe(1);
    expect(coverage?.complete).toBe(true);
  });
});
