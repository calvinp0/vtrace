import { describe, expect, test } from "bun:test";

import {
  ALLOWED_REPLACEMENT_REASONS,
  buildArmSchedule,
  buildLivePool,
  goldFilesInPatch,
  M161_SELECTION_SALT,
  manifestHash,
  orderCases,
  resolveReplacement,
  scheduleHash,
  selectAndOrder,
  type LiveExclusionReason,
  type LiveVerifiedInstance,
  type PoolCandidate,
} from "./m161Corpus";

const PATCH = [
  "diff --git a/pkg/mod.py b/pkg/mod.py",
  "--- a/pkg/mod.py",
  "+++ b/pkg/mod.py",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function row(overrides: Partial<LiveVerifiedInstance> = {}): LiveVerifiedInstance {
  return {
    instance_id: "acme__pkg-1",
    repo: "acme/pkg",
    base_commit: "a".repeat(40),
    patch: PATCH,
    problem_statement: "Something is broken.",
    difficulty: "<15 min fix",
    failToPass: ["tests/test_mod.py::test_it"],
    ...overrides,
  };
}

function build(rows: readonly LiveVerifiedInstance[], opts: {
  broadA?: ReadonlySet<string>;
  broadB?: ReadonlySet<string>;
  cloneExists?: (repo: string) => boolean;
} = {}) {
  return buildLivePool({
    verified: rows,
    broadA: opts.broadA ?? new Set<string>(),
    broadB: opts.broadB ?? new Set<string>(),
    benchCloneExists: opts.cloneExists ?? (() => true),
  });
}

function candidate(instanceId: string, repo: string, difficulty: string): PoolCandidate {
  return {
    instanceId,
    repo,
    baseCommit: "0".repeat(40),
    difficulty,
    expectedFiles: ["pkg/mod.py"],
    expectedSymbols: [],
    goldFilesCreatedByPatch: [],
  };
}

// ---------------------------------------------------------------------------
// §122/§123 — every exclusion detector must demonstrate a known positive before
// a zero count from it is allowed to mean anything.
// ---------------------------------------------------------------------------

describe("M161 pool exclusion detectors — known positives (§122)", () => {
  const cases: readonly { reason: LiveExclusionReason; mutate: () => Parameters<typeof build> }[] = [
    { reason: "IN_BROAD100A", mutate: () => [[row()], { broadA: new Set(["acme__pkg-1"]) }] },
    { reason: "IN_BROAD100B", mutate: () => [[row()], { broadB: new Set(["acme__pkg-1"]) }] },
    { reason: "NO_LOCAL_BENCH_CLONE", mutate: () => [[row()], { cloneExists: () => false }] },
    { reason: "MISSING_BASE_COMMIT", mutate: () => [[row({ base_commit: "  " })], {}] },
    { reason: "EMPTY_PROBLEM_STATEMENT", mutate: () => [[row({ problem_statement: "\n\t " })], {}] },
    { reason: "EMPTY_FAIL_TO_PASS", mutate: () => [[row({ failToPass: [] })], {}] },
    { reason: "NO_GOLD_FILES", mutate: () => [[row({ patch: "no diff here" })], {}] },
  ];

  for (const { reason, mutate } of cases) {
    test(`${reason} fires on a synthetic positive`, () => {
      const built = build(...mutate());
      expect(built.candidates).toHaveLength(0);
      expect(built.exclusions.map((e) => e.reason)).toEqual([reason]);
    });
  }

  test("a clean row survives every detector", () => {
    const built = build([row()]);
    expect(built.exclusions).toHaveLength(0);
    expect(built.candidates.map((c) => c.instanceId)).toEqual(["acme__pkg-1"]);
  });
});

describe("M161 keeps what a retrieval corpus would drop", () => {
  // M160 dropped both of these. A live-agent corpus must not: excluding the cases
  // VTRACE cannot help with is conditioning the sample on treatment performance.
  test("gold outside django's package subtree stays eligible", () => {
    const built = build([
      row({
        instance_id: "django__django-1",
        repo: "django/django",
        patch: PATCH.replaceAll("pkg/mod.py", "scripts/manage_translations.py"),
      }),
    ]);
    expect(built.exclusions).toHaveLength(0);
    expect(built.candidates[0]!.expectedFiles).toEqual(["scripts/manage_translations.py"]);
  });

  test("gold created entirely by the patch stays eligible and is flagged", () => {
    const created = [
      "diff --git a/pkg/new.py b/pkg/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/new.py",
      "@@ -0,0 +1 @@",
      "+x = 1",
    ].join("\n");
    const built = build([row({ patch: created })]);
    expect(built.exclusions).toHaveLength(0);
    expect(built.candidates[0]!.goldFilesCreatedByPatch).toEqual(["pkg/new.py"]);
  });
});

describe("M161 gold file extraction", () => {
  test("collects touched files and ignores /dev/null", () => {
    const patch = [
      "--- a/pkg/a.py",
      "+++ b/pkg/a.py",
      "--- a/pkg/b.py",
      "+++ b/pkg/b.py",
      "--- a/pkg/gone.py",
      "+++ /dev/null",
    ].join("\n");
    expect(goldFilesInPatch(patch)).toEqual(["pkg/a.py", "pkg/b.py"]);
  });
});

// ---------------------------------------------------------------------------
// Selection (§13-§17)
// ---------------------------------------------------------------------------

describe("M161 selection", () => {
  const pool: PoolCandidate[] = [];
  // A pool shaped like the real one: one dominant repository and several small.
  for (let i = 0; i < 60; i += 1) pool.push(candidate(`big__big-${i}`, "big/big", i % 2 ? "<15 min fix" : "1-4 hours"));
  for (let i = 0; i < 12; i += 1) pool.push(candidate(`mid__mid-${i}`, "mid/mid", "15 min - 1 hour"));
  for (let i = 0; i < 4; i += 1) pool.push(candidate(`sml__sml-${i}`, "sml/sml", "<15 min fix"));

  test("the repository quota is balanced, not proportional", () => {
    const { ordered, quotaByRepo } = selectAndOrder(pool, 24);
    expect(ordered).toHaveLength(24);
    // Proportional would give big/big ~19 of 24. Balanced water-fill caps it far lower.
    expect(quotaByRepo.get("big/big")!).toBeLessThan(12);
    expect(quotaByRepo.get("sml/sml")!).toBe(4); // whole pool, it is smaller than its share
  });

  test("selection is deterministic under the frozen salt", () => {
    const a = selectAndOrder(pool, 24);
    const b = selectAndOrder(pool, 24, M161_SELECTION_SALT);
    expect(a.ordered.map((c) => c.instance_id)).toEqual(b.ordered.map((c) => c.instance_id));
  });

  test("a different salt draws a different sample", () => {
    const a = selectAndOrder(pool, 24);
    const b = selectAndOrder(pool, 24, "some-other-salt");
    expect(a.ordered.map((c) => c.instance_id)).not.toEqual(b.ordered.map((c) => c.instance_id));
  });

  test("selection ignores fields it must not see (§14)", () => {
    // Adding treatment-shaped fields to every candidate changes nothing, because
    // selection reads only instanceId, repo and difficulty.
    const polluted = pool.map((c) => ({ ...c, top1Gold: true, goldDelivered: false, score: 0.9 }));
    expect(selectAndOrder(polluted, 24).ordered.map((c) => c.instance_id))
      .toEqual(selectAndOrder(pool, 24).ordered.map((c) => c.instance_id));
  });

  test("a prefix is approximately proportional to the drawn sample (§13)", () => {
    const { ordered } = selectAndOrder(pool, 40);
    const prefix = ordered.slice(0, 10);
    for (const repo of new Set(ordered.map((c) => c.repo))) {
      const wholeShare = ordered.filter((c) => c.repo === repo).length / ordered.length;
      const prefixShare = prefix.filter((c) => c.repo === repo).length / prefix.length;
      expect(Math.abs(prefixShare - wholeShare)).toBeLessThanOrEqual(0.2);
    }
  });

  test("the 30-prefix is a strict subset of the extension set (§13)", () => {
    const { ordered } = selectAndOrder(pool, 40);
    const thirty = new Set(ordered.slice(0, 30).map((c) => c.instance_id));
    const hundred = new Set(ordered.map((c) => c.instance_id));
    expect([...thirty].every((id) => hundred.has(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Arm schedule (§45-§46)
// ---------------------------------------------------------------------------

describe("M161 arm schedule", () => {
  const ordered = orderCases([
    { instance_id: "a__a-1", repo: "a/a", difficulty: "<15 min fix" },
    { instance_id: "b__b-1", repo: "b/b", difficulty: "<15 min fix" },
    { instance_id: "c__c-1", repo: "c/c", difficulty: "<15 min fix" },
    { instance_id: "d__d-1", repo: "d/d", difficulty: "<15 min fix" },
  ]);

  test("alternates the leading arm by rank", () => {
    const schedule = buildArmSchedule(ordered);
    expect(schedule.map((c) => c.armOrder[0])).toEqual(["baseline", "vtrace", "baseline", "vtrace"]);
    for (const kase of schedule) expect(new Set(kase.armOrder).size).toBe(2);
  });

  test("neither arm leads more than half the cases, rounded up", () => {
    const schedule = buildArmSchedule(ordered);
    const leads = schedule.filter((c) => c.armOrder[0] === "baseline").length;
    expect(Math.abs(leads - schedule.length / 2)).toBeLessThanOrEqual(0.5);
  });

  test("the schedule hash binds per-case arm order", () => {
    const schedule = buildArmSchedule(ordered);
    const flipped = schedule.map((c, i) =>
      i === 0 ? { ...c, armOrder: ["vtrace", "baseline"] as ["vtrace", "baseline"] } : c);
    expect(scheduleHash(flipped)).not.toBe(scheduleHash(schedule));
  });
});

// ---------------------------------------------------------------------------
// Replacement policy (§21-§22)
// ---------------------------------------------------------------------------

describe("M161 replacement policy", () => {
  const reserve = orderCases([
    { instance_id: "big__big-90", repo: "big/big", difficulty: "<15 min fix" },
    { instance_id: "mid__mid-90", repo: "mid/mid", difficulty: "<15 min fix" },
  ]);

  test("prefers a same-repository reserve case", () => {
    const got = resolveReplacement({ instanceId: "mid__mid-1", repo: "mid/mid" }, reserve, new Set());
    expect(got).toEqual({
      replacedInstanceId: "mid__mid-1",
      replacementInstanceId: "mid__mid-90",
      repoMatched: true,
    });
  });

  test("falls back to reserve rank when the repository is exhausted", () => {
    const got = resolveReplacement({ instanceId: "sml__sml-1", repo: "sml/sml" }, reserve, new Set());
    expect(got?.repoMatched).toBe(false);
    expect(got?.replacementInstanceId).toBe(reserve[0]!.instance_id);
  });

  test("never reuses an already-consumed reserve case", () => {
    const used = new Set(reserve.map((c) => c.instance_id));
    expect(resolveReplacement({ instanceId: "x__x-1", repo: "mid/mid" }, reserve, used)).toBeNull();
  });

  test("the allowed-reason list excludes every outcome-shaped reason (§22)", () => {
    for (const forbidden of ["RETRIEVAL_LOOKS_BAD", "AGENT_LIKELY_TO_FAIL", "REPO_IS_SLOW", "INCONVENIENT_OUTCOME"]) {
      expect(ALLOWED_REPLACEMENT_REASONS).not.toContain(forbidden);
    }
    expect(ALLOWED_REPLACEMENT_REASONS).toHaveLength(4);
  });
});

describe("M161 manifest hashing", () => {
  test("binds membership and order", () => {
    const a = [{ instanceId: "x", order: 1 }, { instanceId: "y", order: 2 }];
    const swapped = [{ instanceId: "y", order: 1 }, { instanceId: "x", order: 2 }];
    expect(manifestHash(a)).not.toBe(manifestHash(swapped));
    expect(manifestHash(a)).toBe(manifestHash([...a]));
  });
});
