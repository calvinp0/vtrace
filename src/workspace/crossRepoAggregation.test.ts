/**
 * M146-B: bounded cross-repository aggregation.
 *
 * The invariants under test are the ones that make cross-repository context safe
 * rather than merely possible: one budget shared by all repositories, provenance
 * that survives aggregation, collisions that stay distinct, and a primary direct
 * answer that support cannot evict.
 */
import { describe, expect, test } from "bun:test";

import {
  aggregateCrossRepoContext,
  formatRepositoryProvenance,
  type CrossRepoCandidate,
} from "./crossRepoAggregation";

function candidate(
  alias: string,
  relativePath: string,
  localRank: number,
  tokens: number,
  symbol: string | null = null,
): CrossRepoCandidate {
  return {
    repositoryAlias: alias,
    repositoryId: `repo-${alias}`,
    worktreeId: `wt-${alias}`,
    relativePath,
    symbol,
    localRank,
    tokens,
  };
}

describe("M146-B shared budget (§37)", () => {
  test("N repositories do not multiply the budget", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 300,
      repositories: [
        { alias: "a", candidates: [candidate("a", "src/a1.py", 1, 200), candidate("a", "src/a2.py", 2, 200)] },
        { alias: "b", candidates: [candidate("b", "src/b1.py", 1, 200), candidate("b", "src/b2.py", 2, 200)] },
        { alias: "c", candidates: [candidate("c", "src/c1.py", 1, 200)] },
      ],
    });

    expect(result.budget.totalSelectedTokens).toBeLessThanOrEqual(300);
    // Three repositories offering 1000 tokens still deliver one budget.
    expect(result.budget.perRepository.reduce((sum, repo) => sum + repo.selectedTokens, 0))
      .toBe(result.budget.totalSelectedTokens);
  });

  test("per-repository accounting adds up and reports omissions", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 250,
      repositories: [
        { alias: "a", candidates: [candidate("a", "src/a1.py", 1, 100), candidate("a", "src/a2.py", 2, 100)] },
        { alias: "b", candidates: [candidate("b", "src/b1.py", 1, 100), candidate("b", "src/b2.py", 2, 100)] },
      ],
    });

    expect(result.budget.totalBudget).toBe(250);
    expect(result.budget.repositoriesConsidered).toBe(2);
    for (const repo of result.budget.perRepository) {
      expect(repo.candidatesSelected + repo.candidatesOmitted).toBe(repo.candidatesAvailable);
    }
    expect(result.budget.perRepository.reduce((sum, repo) => sum + repo.candidatesOmitted, 0))
      .toBeGreaterThan(0);
  });

  test("a tight budget still delivers the primary lead", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 100,
      repositories: [
        { alias: "a", candidates: [candidate("a", "src/answer.py", 1, 100)] },
        { alias: "b", candidates: [candidate("b", "src/other.py", 1, 100)] },
      ],
    });

    expect(result.lead?.repositoryAlias).toBe("a");
    expect(result.selected).toHaveLength(1);
    expect(result.budget.totalSelectedTokens).toBe(100);
  });
});

describe("M146-B lead and support (§34/§72)", () => {
  test("the primary repository's best candidate leads", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        { alias: "primary", candidates: [candidate("primary", "src/exact.py", 1, 50, "exactAnswer")] },
        {
          alias: "support",
          candidates: [candidate("support", "src/weak1.py", 1, 50), candidate("support", "src/weak2.py", 2, 50)],
        },
      ],
    });

    expect(result.lead?.repositoryAlias).toBe("primary");
    expect(result.lead?.symbol).toBe("exactAnswer");
    expect(result.lead?.role).toBe("lead");
    // Support is admitted, but only after the direct answer.
    expect(result.selected.filter((entry) => entry.role === "support").every((entry) => entry.globalRank > 1)).toBe(true);
  });

  test("weak support never evicts a strong direct answer", async () => {
    // §35/§62: cross-repository mode is not a reason to guarantee every
    // repository a slot at the expense of the answer.
    const result = aggregateCrossRepoContext({
      totalBudget: 120,
      repositories: [
        { alias: "primary", candidates: [candidate("primary", "src/exact.py", 1, 100, "exactAnswer")] },
        { alias: "support", candidates: [candidate("support", "src/weak.py", 1, 100)] },
      ],
    });

    expect(result.lead?.repositoryAlias).toBe("primary");
    expect(result.selected.map((entry) => entry.repositoryAlias)).toEqual(["primary"]);
    expect(result.budget.perRepository.find((repo) => repo.repositoryAlias === "support")!.candidatesOmitted).toBe(1);
  });

  test("a genuine two-repository task retrieves from both (§36)", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 400,
      repositories: [
        { alias: "backend", candidates: [candidate("backend", "src/api/handler.py", 1, 100, "handle")] },
        { alias: "client", candidates: [candidate("client", "src/client.ts", 1, 100, "callHandle")] },
      ],
    });

    expect(result.budget.repositoriesContributing).toBe(2);
    expect(result.selected.map((entry) => entry.repositoryAlias)).toEqual(["backend", "client"]);
    expect(result.lead?.repositoryAlias).toBe("backend");
    expect(result.budget.totalSelectedTokens).toBe(200);
  });
});

describe("M146-B provenance and collisions (§39-§43)", () => {
  test("every delivered candidate keeps its repository identity", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "src/utils.py", 1, 10, "parse")] },
        { alias: "b", candidates: [candidate("b", "src/utils.py", 1, 10, "parse")] },
      ],
    });

    for (const entry of result.selected) {
      expect(entry.repositoryId).not.toBeNull();
      expect(entry.worktreeId).not.toBeNull();
      expect(entry.relativePath.length).toBeGreaterThan(0);
    }
  });

  test("the same relative path in two repositories stays two candidates", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "src/utils.py", 1, 10)] },
        { alias: "b", candidates: [candidate("b", "src/utils.py", 1, 10)] },
      ],
    });

    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((entry) => entry.worktreeId)).size).toBe(2);
  });

  test("the same fully-qualified name in two repositories stays two candidates", async () => {
    const result = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        { alias: "a", candidates: [candidate("a", "utils.py", 1, 10, "utils.parse")] },
        { alias: "b", candidates: [candidate("b", "utils.py", 1, 10, "utils.parse")] },
      ],
    });

    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((entry) => entry.repositoryAlias)).size).toBe(2);
  });

  test("a repository does not duplicate its own candidate", async () => {
    // Dedupe is by full identity, so a genuine repeat inside one repository is
    // still collapsed — the rule targets provenance loss, not all dedupe.
    const result = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        {
          alias: "a",
          candidates: [candidate("a", "src/utils.py", 1, 10, "parse"), candidate("a", "src/utils.py", 2, 10, "parse")],
        },
      ],
    });

    expect(result.selected).toHaveLength(1);
  });

  test("provenance is labelled only when repositories actually differ (§46)", async () => {
    const single = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [{ alias: "solo", candidates: [candidate("solo", "src/a.py", 1, 10, "fn")] }],
    });
    expect(formatRepositoryProvenance(single.selected[0]!, single.budget.repositoriesContributing))
      .toBe("src/a.py::fn");

    const multi = aggregateCrossRepoContext({
      totalBudget: 1000,
      repositories: [
        { alias: "backend", candidates: [candidate("backend", "src/a.py", 1, 10, "fn")] },
        { alias: "client", candidates: [candidate("client", "src/b.ts", 1, 10, "call")] },
      ],
    });
    expect(formatRepositoryProvenance(multi.selected[0]!, multi.budget.repositoriesContributing))
      .toBe("[repository: backend] src/a.py::fn");
  });
});

describe("M146-B single-repository equivalence (§46)", () => {
  test("one repository delivers its own ranking untouched", async () => {
    const candidates = [
      candidate("solo", "src/a.py", 1, 10, "first"),
      candidate("solo", "src/b.py", 2, 10, "second"),
      candidate("solo", "src/c.py", 3, 10, "third"),
    ];

    const result = aggregateCrossRepoContext({ totalBudget: 1000, repositories: [{ alias: "solo", candidates }] });

    expect(result.selected.map((entry) => entry.relativePath)).toEqual(["src/a.py", "src/b.py", "src/c.py"]);
    expect(result.lead?.relativePath).toBe("src/a.py");
    expect(result.budget.repositoriesContributing).toBe(1);
  });

  test("an empty workspace produces no lead rather than an invented one", async () => {
    const result = aggregateCrossRepoContext({ totalBudget: 1000, repositories: [] });

    expect(result.lead).toBeNull();
    expect(result.selected).toEqual([]);
    expect(result.budget.repositoriesContributing).toBe(0);
  });
});
