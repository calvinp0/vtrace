import { describe, expect, test } from "bun:test";

import {
  buildFrozenDefaultPathManifest,
  checkDenominatorWording,
  checkProhibitedWording,
  CLAIM_MATRIX,
  EVIDENCE_ARTIFACTS,
  findForbiddenIndexPaths,
  GROUP_ORDER,
  MILESTONE_COMMITS,
  NO_CONTEXT_EXCLUSIONS,
  renderArtifactIndexMd,
  renderClaimMatrixMd,
  REQUIRED_CLAIM_IDS,
  resolveArtifacts,
  stripProhibitedListingLines,
} from "./run_stage5_m110_lib";

describe("frozen default path manifest", () => {
  const manifest = buildFrozenDefaultPathManifest("abc1234");

  test("carries the packaging head commit and every milestone commit M94-M109", () => {
    expect(manifest.current_head_commit).toBe("abc1234");
    for (let n = 94; n <= 109; n += 1) {
      expect(manifest.milestone_commits[`M${n}`]).toMatch(/^[0-9a-f]{7}$/);
    }
    expect(manifest.milestone_commits.M103).toBe("199769f");
    expect(manifest.milestone_commits.M109).toBe("d9364a9");
  });

  test("default path pins the M92/M105 clean-core settings", () => {
    const dp = manifest.default_path;
    expect(dp.capsule_engine).toBe("v2");
    expect(dp.capsule_budget).toBe(8000);
    expect(dp.context_policy).toBe("force-inject");
    expect(dp.capsule_intent).toContain("debug");
    for (const field of [
      "digest_injection",
      "digest_decision_contract",
      "bounded_digest_decisions",
      "compact_digest_injection",
      "pivot_confidence_gate",
      "structured_task_derivation",
    ] as const) {
      expect(dp[field]).toStartWith("ON");
    }
    expect(dp.env_guard).toContain("MANDATORY");
    expect(dp.shell_guard).toContain("MANDATORY");
  });

  test("disabled paths and invalid contexts cover the required list", () => {
    const disabled = manifest.disabled_paths;
    expect(Object.keys(disabled)).toEqual(
      expect.arrayContaining(["V4", "C7_D", "revision_corrective_arms", "VEXP", "baseline_arm", "legacy_fallback_validity"]),
    );
    expect(manifest.known_invalid_contexts.join(" ")).toContain("legacy fallback");
    expect(manifest.known_invalid_contexts.join(" ")).toContain("revision/corrective");
  });

  test("records exactly the three pre-registered no-context exclusions", () => {
    expect([...manifest.no_context_exclusions].sort()).toEqual(
      ["django__django-11740", "django__django-15572", "sphinx-doc__sphinx-9320"].sort(),
    );
    expect(manifest.no_context_exclusions).toBe(NO_CONTEXT_EXCLUSIONS);
  });

  test("claim boundaries include the three prohibitions and pass the wording guards", () => {
    const joined = manifest.claim_boundaries.join(" ");
    expect(joined).toContain("internal confirmation only");
    expect(joined).toContain("pass@1");
    expect(joined).toContain("VEXP");
    expect(joined).toContain("live-attempted");
    expect(checkProhibitedWording(JSON.stringify(manifest))).toEqual([]);
  });
});

describe("evidence artifact index", () => {
  test("never indexes raw runs, streams, logs, or workspaces", () => {
    expect(findForbiddenIndexPaths(EVIDENCE_ARTIFACTS)).toEqual([]);
    expect(
      findForbiddenIndexPaths([{ ...EVIDENCE_ARTIFACTS[0], path: "benchmarks/stage5_vexp_swe_bench_smoke/results/runs/x/raw/vtrace/r.jsonl" }]),
    ).toHaveLength(1);
    expect(
      findForbiddenIndexPaths([{ ...EVIDENCE_ARTIFACTS[0], path: "benchmarks/stage5_vexp_swe_bench_smoke/results/_m108_driver_ledger.jsonl" }]),
    ).toHaveLength(1);
  });

  test("covers all six required groups with canonical entries and unique paths", () => {
    for (const group of GROUP_ORDER) {
      const rows = EVIDENCE_ARTIFACTS.filter((e) => e.group === group);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((e) => e.canonical_or_supporting === "canonical")).toBe(true);
    }
    const paths = EVIDENCE_ARTIFACTS.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("resolveArtifacts marks tracked/untracked/missing from the injected resolver", () => {
    const resolved = resolveArtifacts(EVIDENCE_ARTIFACTS.slice(0, 3), (p) => ({
      exists: !p.endsWith(".json"),
      tracked: p.endsWith(".md"),
      sha256: p.endsWith(".md") ? "a".repeat(64) : null,
    }));
    expect(resolved[0].tracked_status).toBe("tracked");
    expect(resolved[0].sha256).toHaveLength(64);
    expect(resolved.find((e) => e.path.endsWith(".json"))?.tracked_status).toBe("missing");
  });

  test("rendered index passes the wording guards and groups in canonical order", () => {
    const resolved = resolveArtifacts(EVIDENCE_ARTIFACTS, () => ({ exists: true, tracked: true, sha256: "b".repeat(64) }));
    const md = renderArtifactIndexMd(resolved, "abc1234");
    expect(checkProhibitedWording(md)).toEqual([]);
    expect(checkDenominatorWording(md)).toEqual([]);
    expect(md.indexOf("Deterministic core")).toBeLessThan(md.indexOf("Live confirmation"));
    expect(md.indexOf("Live confirmation")).toBeLessThan(md.indexOf("Historical comparison"));
    expect(md).toContain("never package");
  });
});

describe("claim matrix", () => {
  test("contains every required claim id", () => {
    for (const id of REQUIRED_CLAIM_IDS) {
      expect(CLAIM_MATRIX.some((c) => c.id === id)).toBe(true);
    }
  });

  test("every claim is fully specified", () => {
    for (const c of CLAIM_MATRIX) {
      expect(c.claim.length).toBeGreaterThan(0);
      expect(c.allowed_wording.length).toBeGreaterThan(0);
      expect(c.supporting_artifacts.length).toBeGreaterThan(0);
      expect(c.scope.length).toBeGreaterThan(0);
      expect(c.denominator.length).toBeGreaterThan(0);
      expect(c.caveats.length).toBeGreaterThan(0);
      expect(c.prohibited_stronger_forms.length).toBeGreaterThan(0);
    }
  });

  test("allowed wording never trips the prohibited-claim guard", () => {
    for (const c of CLAIM_MATRIX) {
      expect(checkProhibitedWording(c.allowed_wording)).toEqual([]);
    }
  });

  test("the live headline claim carries the full denominator framing", () => {
    const live = CLAIM_MATRIX.find((c) => c.id === "live_97_valid_55_resolved")!;
    expect(checkDenominatorWording(live.allowed_wording)).toEqual([]);
    expect(live.denominator).toContain("100");
    expect(live.denominator).toContain("97");
    expect(live.denominator).toContain("3");
  });

  test("rendered matrix passes the wording guards (prohibited examples are ✗-quoted)", () => {
    const md = renderClaimMatrixMd(CLAIM_MATRIX);
    expect(md).toContain('✗ "VTRACE pass@1 is 56.7%"');
    expect(checkProhibitedWording(md)).toEqual([]);
    expect(checkDenominatorWording(md)).toEqual([]);
  });
});

describe("prohibited-wording guard", () => {
  test("detects each prohibited claim family", () => {
    const bad = [
      "VTRACE pass@1 is 56.7 on this benchmark",
      "VTRACE achieved 56.7% on SWE-bench",
      "we are validated on SWE-bench Verified",
      "100/100 live cases were run",
      "all 100 cases were run yesterday",
      "VTRACE beats VEXP decisively",
      "VEXP parity achieved this quarter",
      "no leakage is possible under this design",
      "token reduction is guaranteed for all workloads",
      "guaranteed token reduction on any repo",
    ];
    for (const text of bad) {
      expect(checkProhibitedWording(text).length).toBeGreaterThan(0);
    }
  });

  test("passes the M109 allowed wording verbatim", () => {
    const allowed = [
      "On the frozen internal 100-case Stage 5 pool, the current default VTRACE path produced 97 valid guarded live runs, with 55 resolved patches (56.7% of valid live runs). Three cases were pre-registered no-context exclusions under the parity contract.",
      "This is an internal live confirmation, not a public SWE-bench pass@1 claim and not a VEXP parity claim.",
      "In the one paired same-protocol measurement (M92, 50 tasks, both arms valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% with resolution preserved.",
    ];
    for (const text of allowed) {
      expect(checkProhibitedWording(text)).toEqual([]);
    }
  });

  test("✗-prefixed listing lines are stripped before scanning", () => {
    const listing = '- ✗ "VTRACE beats VEXP"\n> ✗ "token reduction is guaranteed"';
    expect(stripProhibitedListingLines(listing).trim()).toBe("");
    expect(checkProhibitedWording(listing)).toEqual([]);
    expect(checkProhibitedWording('unmarked: VTRACE beats VEXP')).toHaveLength(1);
  });
});

describe("denominator-wording guard", () => {
  test("flags the headline without the 97-valid + no-context framing", () => {
    expect(checkDenominatorWording("55 resolved out of 100 cases").length).toBe(2);
    expect(checkDenominatorWording("resolution reached 56.7% overall")).toHaveLength(2);
    expect(checkDenominatorWording("55 resolved of 97 valid runs")).toHaveLength(1);
  });

  test("passes the canonical sentence and text without the headline", () => {
    expect(
      checkDenominatorWording(
        "97 valid guarded live runs, with 55 resolved patches (56.7% of valid live runs); three pre-registered no-context exclusions.",
      ),
    ).toEqual([]);
    expect(checkDenominatorWording("deterministic recall improved")).toEqual([]);
  });
});

describe("milestone commit map", () => {
  test("matches the ledger-recorded chain", () => {
    expect(MILESTONE_COMMITS.M94).toBe("8d52a78");
    expect(MILESTONE_COMMITS.M104).toBe("4ca4948");
    expect(MILESTONE_COMMITS.M108).toBe("a0bc3a6");
    expect(Object.keys(MILESTONE_COMMITS)).toHaveLength(16);
  });
});
