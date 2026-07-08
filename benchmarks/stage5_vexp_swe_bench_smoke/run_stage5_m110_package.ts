// Stage 5 M110 — internal evidence package generator. Documentation-only:
// NO agents, NO Docker, NO API spend, NO network. Parses the canonical
// committed artifacts (fails loudly if any cannot be parsed), hashes the
// tracked evidence files, and writes the M110 package artifacts:
//
//   stage5_m110_frozen_default_path_manifest.json
//   stage5_m110_evidence_artifact_index.{md,json}
//   stage5_m110_claim_matrix.{md,json}
//   stage5_m110_new_chat_handoff.md
//   stage5_m110_internal_evidence_package.{md,json}
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m110_package.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildFrozenDefaultPathManifest,
  checkDenominatorWording,
  checkProhibitedWording,
  CLAIM_MATRIX,
  EVIDENCE_ARTIFACTS,
  findForbiddenIndexPaths,
  M110_DATE,
  MILESTONE_COMMITS,
  NO_CONTEXT_EXCLUSIONS,
  renderArtifactIndexMd,
  renderClaimMatrixMd,
  REQUIRED_CLAIM_IDS,
  resolveArtifacts,
} from "./run_stage5_m110_lib";

const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function mustParseJson(relPath: string): unknown {
  const raw = readFileSync(relPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`canonical artifact cannot be parsed: ${relPath}: ${String(err)}`);
  }
}

function guardText(label: string, text: string): void {
  const prohibited = checkProhibitedWording(text);
  if (prohibited.length > 0) {
    throw new Error(`prohibited wording in ${label}: ${prohibited.map((v) => `${v.rule} ("${v.match}")`).join("; ")}`);
  }
  const denom = checkDenominatorWording(text);
  if (denom.length > 0) {
    throw new Error(`denominator wording violation in ${label}: ${denom.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const outDir = argValue("--out", RESULTS_ROOT);
  const headCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();

  // --- parse the canonical inputs (FAIL criterion: unparseable canonicals) ---
  const m109Summary = mustParseJson(path.join(RESULTS_ROOT, "stage5_m109_final_internal_summary.json")) as Record<string, any>;
  const m108Report = mustParseJson(path.join(RESULTS_ROOT, "stage5_m108_100_case_live_confirmation.json")) as Record<string, any>;
  const hardStratum = mustParseJson(path.join(RESULTS_ROOT, "stage5_m109_hard_stratum_analysis.json")) as Record<string, any>;
  const m103Scoreboard = mustParseJson(path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.json")) as Record<string, any>;
  const m94Scoreboard = mustParseJson(path.join(RESULTS_ROOT, "stage5_m94_deterministic_scoreboard.json")) as Record<string, any>;
  const m92Validation = mustParseJson(path.join(RESULTS_ROOT, "stage5_m92_core_reduction50_validation.json")) as Record<string, any>;
  const m73Paired = mustParseJson(path.join(RESULTS_ROOT, "stage5_m73_final_100_paired_summary.json")) as Record<string, any>;

  // cross-check the frozen headline numbers straight from the canonical JSONs
  const live = m109Summary.live_confirmation_result;
  if (live.valid_live_runs !== 97 || live.resolved !== 55 || live.pool_cases !== 100) {
    throw new Error(`M109 live result does not match the frozen headline: ${JSON.stringify(live)}`);
  }
  const exclusions: string[] = live.no_context_exclusions;
  if (JSON.stringify([...exclusions].sort()) !== JSON.stringify([...NO_CONTEXT_EXCLUSIONS].sort())) {
    throw new Error(`no-context exclusion mismatch vs M109: ${JSON.stringify(exclusions)}`);
  }
  if (m109Summary.verdict !== "PASS" || m108Report.verdict !== "PASS") {
    throw new Error("M108/M109 verdicts are not PASS — packaging basis is wrong");
  }
  void hardStratum;
  void m103Scoreboard;
  void m94Scoreboard;
  void m92Validation;
  void m73Paired;

  // --- resolve tracked status + sha256 for every indexed artifact ---
  const trackedSet = new Set(
    execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean),
  );
  const resolved = resolveArtifacts(EVIDENCE_ARTIFACTS, (p) => {
    const exists = existsSync(p);
    return {
      exists,
      tracked: trackedSet.has(p),
      sha256: exists ? createHash("sha256").update(readFileSync(p)).digest("hex") : null,
    };
  });
  const missing = resolved.filter((e) => e.tracked_status === "missing").map((e) => e.path);
  if (missing.length > 0) throw new Error(`indexed artifacts missing on disk: ${missing.join(", ")}`);
  const untracked = resolved.filter((e) => e.tracked_status !== "tracked").map((e) => e.path);
  if (untracked.length > 0) throw new Error(`indexed artifacts are not git-tracked: ${untracked.join(", ")}`);
  const forbidden = findForbiddenIndexPaths(EVIDENCE_ARTIFACTS);
  if (forbidden.length > 0) throw new Error(`raw/untracked paths must not be indexed: ${forbidden.join(", ")}`);
  const missingClaims = REQUIRED_CLAIM_IDS.filter((id) => !CLAIM_MATRIX.some((c) => c.id === id));
  if (missingClaims.length > 0) throw new Error(`claim matrix is missing required claims: ${missingClaims.join(", ")}`);

  // --- assemble outputs ---
  const manifest = buildFrozenDefaultPathManifest(headCommit);

  const indexJson = {
    milestone: "M110",
    kind: "evidence artifact index for the frozen default VTRACE path",
    date: M110_DATE,
    packaging_basis_commit: headCommit,
    hash_algorithm: "sha256 over file bytes at the packaging commit",
    excluded_by_policy: "raw run folders, streams, logs, workspaces, prompt dumps, guard state, pre-existing dirty ledgers",
    artifacts: resolved,
  };
  const indexMd = renderArtifactIndexMd(resolved, headCommit);

  const claimJson = {
    milestone: "M110",
    kind: "claim matrix for the frozen default VTRACE path",
    date: M110_DATE,
    denominator_rule: m109Summary.live_confirmation_result.denominator_rule,
    claims: CLAIM_MATRIX,
  };
  const claimMd = renderClaimMatrixMd(CLAIM_MATRIX);

  const handoffMd = buildHandoffMd(headCommit);
  const packageMd = buildPackageMd(headCommit);
  const packageJson = {
    milestone: "M110",
    kind: "internal evidence package summary — freezes the default path and indexes the validation artifacts; documentation-only, no-spend",
    date: M110_DATE,
    verdict: "PASS",
    recommendation: "freeze and archive",
    packaging_basis_commit: headCommit,
    package_artifacts: [
      `${RESULTS_ROOT}/stage5_m110_package_plan.md`,
      `${RESULTS_ROOT}/stage5_m110_frozen_default_path_manifest.json`,
      `${RESULTS_ROOT}/stage5_m110_evidence_artifact_index.md`,
      `${RESULTS_ROOT}/stage5_m110_evidence_artifact_index.json`,
      `${RESULTS_ROOT}/stage5_m110_claim_matrix.md`,
      `${RESULTS_ROOT}/stage5_m110_claim_matrix.json`,
      `${RESULTS_ROOT}/stage5_m110_new_chat_handoff.md`,
      `${RESULTS_ROOT}/stage5_m110_internal_evidence_package.md`,
    ],
    frozen_default_path: manifest.default_path,
    disabled_paths: manifest.disabled_paths,
    no_context_exclusions: NO_CONTEXT_EXCLUSIONS,
    claim_boundaries: manifest.claim_boundaries,
    canonical_evidence_counts: {
      indexed_artifacts: resolved.length,
      canonical: resolved.filter((e) => e.canonical_or_supporting === "canonical").length,
      supporting: resolved.filter((e) => e.canonical_or_supporting === "supporting").length,
      claims: CLAIM_MATRIX.length,
    },
    docs_status: {
      "docs/current_product_state.md": "confirmed claim-safe (M109 wording present; freeze note present); no M110 change",
      "README.md": "claim-safe; one stale 'planned M94 scoreboard' sentence updated to reference the completed M94->M103 scoreboard (tense fix only, no new claims)",
    },
    no_spend_confirmation: "no live agents, no Docker, no API calls, no VEXP, no baseline arms, no retrieval evals run in M110",
  };

  // --- wording guards over everything we generate ---
  guardText("frozen_default_path_manifest.json", JSON.stringify(manifest));
  guardText("evidence_artifact_index.md", indexMd);
  guardText("claim_matrix.md", claimMd);
  guardText("claim_matrix.json (allowed wording)", CLAIM_MATRIX.map((c) => c.allowed_wording).join("\n"));
  guardText("new_chat_handoff.md", handoffMd);
  guardText("internal_evidence_package.md", packageMd);
  guardText("internal_evidence_package.json", JSON.stringify(packageJson));

  // --- write ---
  const singleTrailingNewline = (s: string): string => `${s.replace(/\n+$/, "")}\n`;
  const writes: Array<[string, string]> = [
    ["stage5_m110_frozen_default_path_manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["stage5_m110_evidence_artifact_index.json", `${JSON.stringify(indexJson, null, 2)}\n`],
    ["stage5_m110_evidence_artifact_index.md", indexMd],
    ["stage5_m110_claim_matrix.json", `${JSON.stringify(claimJson, null, 2)}\n`],
    ["stage5_m110_claim_matrix.md", claimMd],
    ["stage5_m110_new_chat_handoff.md", handoffMd],
    ["stage5_m110_internal_evidence_package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["stage5_m110_internal_evidence_package.md", packageMd],
  ];
  for (const [name, content] of writes) {
    await writeFile(path.join(outDir, name), singleTrailingNewline(content), "utf8");
    console.log(`wrote ${path.join(outDir, name)}`);
  }
  console.log(`M110 package generated at commit ${headCommit}: ${resolved.length} artifacts indexed, ${CLAIM_MATRIX.length} claims.`);
}

// ---------------------------------------------------------------------------
// Handoff + package markdown (prose lives here, guarded above)
// ---------------------------------------------------------------------------

function milestoneCommitTable(): string {
  return Object.entries(MILESTONE_COMMITS)
    .map(([m, c]) => `| ${m} | \`${c}\` |`)
    .join("\n");
}

function buildHandoffMd(headCommit: string): string {
  return `# VTRACE Stage 5 — New-Chat Handoff (M110)

_${M110_DATE}. Self-contained handoff: paste this into a new chat to continue
VTRACE work without rerunning anything. Everything below is backed by
committed artifacts indexed in \`stage5_m110_evidence_artifact_index.md\`._

## Project goal

VTRACE is a deterministic, repo-local structural context engine (SQLite
symbol index -> retrieval -> Capsule v2 context capsules) for lower-token
coding agents. Stage 5 is the internal SWE-bench-style validation harness: a
thin wrapper around the external \`vexp-swe-bench\` runner that injects VTRACE
context into a real agent loop and Docker-evaluates the resulting patches.

## Current default path (FROZEN at M109, packaged at M110)

- Task: \`deriveStructuredTaskFromProblemStatement\` (M103 V5 shape — V0 base +
  exceptions <=6 + issue-mentioned failing tests <=6 + traceback frames <=8,
  1200-char cap), shared by the deterministic scoreboard AND the live runner
  (M104 parity).
- Retrieval/capsule: Capsule v2 + M95 strong-lexical fix + M96
  direct-evidence lanes + M97/M98 tiered co-edit expansion + M99
  import_reexport_rescue + M100 file-evidence rescue + M101 anchored pivot
  guard.
- Live clean-core flags: \`--protocol vtrace-indexed --context-policy
  force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget
  8000 --inject-capsule-digest --digest-decision-contract
  --bounded-digest-decisions --compact-digest-injection
  --pivot-confidence-gate\`.
- Mandatory safety (fail-closed): M89 env guard + drift check + pinned
  testbed prefix; M90A agent shell guard + host-pip firewall.
- Default-off / invalid: V4 tool-loop guard, C7_D cost guard, M12
  enforcement, M14/M15 revision + rule-out corrective arms (they inject
  FAIL_TO_PASS -> parity-invalid), M7.3 traceback skip, VEXP, baseline arms,
  the unguarded escape hatch; a legacy-fallback fire makes a run
  parity-invalid (0 fires observed).
- Full machine-readable record: \`stage5_m110_frozen_default_path_manifest.json\`.

## What changed M95–M103 (deterministic chain)

M94 baseline -> M103 final, gold-blind pre-agent scoreboard: recall@5 .637 ->
.748, all-gold-in-capsule 60.6% -> 75.0%, lead-pivot=source-gold 45.5% ->
59.0%, hidden-coedit recall .222 -> .622, multi-file all-gold 6.7% -> 53.3%,
miss 30 -> 21, wrong_pivot 10 -> 7, at flat median capsule size and p90 -20%.
Accepted cost: overpacked 7 -> 14. Steps: M95 strong-lexical fix, M96
direct-evidence lanes, M97/M98 co-edit expansion + precision tiers, M99
import rescue, M100 file-evidence rescue, M101 anchored pivot guard, M102
derivation audit (report-only), M103 structured task derivation + provenance
leakage policy.

## What M104 proved

Live and deterministic tasks are the SAME function (14/14 byte-exact parity,
leak-clean, no agents). The pre-M104 live composite (full problem statement +
FAIL_TO_PASS labels + hints) is gone. From M105 on, any live-vs-deterministic
delta is agent/config-attributable, never task derivation. Before ANY live
spend, re-prove parity with \`run_stage5_m104_live_context_smoke.ts\`.

## What M105–M108 proved

Guarded live confirmation over the frozen internal 100-case pool, grown 14 ->
24 -> 50 -> 100 under an artifact-reuse contract (committed runs never
rerun): 97 valid guarded live runs, 55 resolved (56.7% of valid), 3
pre-registered no-context exclusions (django__django-11740,
django__django-15572, sphinx-doc__sphinx-9320 — nothing to inject, never
spawned). Safety clean sweep: 0 unexplained leakage, 0 fallback fires, 0
env/shell-guard failures, 0 drift, 0 host-pip blocks, 0 unguarded runs, 0
revision artifacts. Cost $56.69 / 104.6M tokens / 93.9% cache-read.

## What M109 concluded

- Strict M73-treatment comparison (93 comparable): expectation 64, live 54,
  per-case agreement 77/93 (82.8%). M73-baseline 61/97 vs live 55/97. M92
  overlap 49: live 16 vs 20, agreement 41/49.
- 13 strict live losses; 10 had ALL gold files in the capsule. Reason split:
  10 agent-variance, 1 single-file-patch-on-multifile-gold (xarray-6938), 2
  deterministic context gaps (pytest-6197, sympy-15875). Conclusion: the
  deficit is hard-stratum agent-side variance, NOT a retrieval/context
  regression.
- The whole M7.x live-regression list (sympy-12419, astropy-14539,
  pylint-8898) is live-recovered under the current path.
- Verdict PASS; default path frozen; no more live spend until
  captured-artifact analysis questions are exhausted.

## Claim-safe final wording (reuse verbatim)

> On the frozen internal 100-case Stage 5 pool, the current default VTRACE
> path produced 97 valid guarded live runs, with 55 resolved patches (56.7%
> of valid live runs). Three cases were pre-registered no-context exclusions
> under the parity contract.

> Across the 97 valid runs, the default path was leak-clean: zero
> model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, zero
> fallback-context fires, zero unguarded env/shell runs, and zero host-pip
> mutation escapes.

> In the one paired same-protocol measurement (M92, 50 tasks, both arms
> valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% with
> resolution preserved.

> This is an internal live confirmation, not a public SWE-bench pass@1 claim
> and not a VEXP parity claim.

## What NOT to claim (prohibited forms)

- ✗ "VTRACE achieved 56.7% on SWE-bench" / ✗ "VTRACE pass@1 is 56.7%"
- ✗ "100/100 live cases were run"
- ✗ "VTRACE beats VEXP" (or any VEXP parity/superiority claim)
- ✗ "VTRACE is validated on SWE-bench Verified"
- ✗ "no leakage is possible" (measured-zero on this protocol, not impossible)
- ✗ "token reduction is guaranteed"

Denominator rule: always report all three numbers together — 100 frozen pool
cases, 97 valid live runs, 3 pre-registered no-context exclusions.

## Remaining bottlenecks

1. Agent-variance losses despite complete context (10 of 13 strict losses had
   all gold in the capsule) — patch-shape/convergence levers, not retrieval.
2. Cache-read dominance (93.9% of tokens): turn efficiency is the cost lever,
   not capsule size.
3. Deterministic residue: 21 miss / 14 overpacked / 7 wrong_pivot (mined-out
   or deliberate conservatism per M100/M103/M96).
4. 3 no-context pool cases (3% of pool) — candidate-recall work only if the
   class grows.
5. High-cost tool-loop structural ceiling (django-16263, pylint-4551,
   sympy-20428 signatures); V4/C7_D stay default-off per M78/M83.

## Recommended next milestones (ranked, from M109)

1. No live spend until captured-artifact analysis questions are exhausted.
2. Hard-stratum transcript study: the 9+4 agent-variance losses' tool
   logs/transcripts (cheapest expected gain; captured artifacts only).
3. no_context candidate-recall work only if the class grows beyond 3/100.
4. VEXP comparison ONLY under a separate preregistered paired protocol.

## Key artifact paths

- Package: \`benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m110_*\`
  (manifest, artifact index, claim matrix, this handoff, package summary).
- Final summary: \`results/stage5_m109_final_internal_summary.{md,json}\`;
  hard-stratum: \`results/stage5_m109_hard_stratum_analysis.json\`.
- Live: \`results/stage5_m108_100_case_live_confirmation.{md,json}\` +
  \`stage5_m10{5,6,7,8}_live_{runs,preflight}.detail.json\`.
- Deterministic: \`results/stage5_m94_deterministic_scoreboard.json\` ->
  \`results/stage5_m103_deterministic_scoreboard.json\`.
- History: \`results/stage5_m73_final_100_paired_summary.json\`,
  \`results/stage5_m92_core_reduction50_validation.json\`.
- Docs: \`docs/current_product_state.md\`, \`README.md\`,
  \`results/stage5_milestone_ledger.md\` (READ FIRST each milestone).

## Current branch/commit

Branch \`main\`; M110 packaging basis commit \`${headCommit}\`. Milestone
commits:

| milestone | commit |
| --- | --- |
${milestoneCommitTable()}

## Workflow rules (standing)

- Work on \`main\`; commit locally; do NOT push; no co-author trailers.
- Read \`results/stage5_milestone_ledger.md\` at milestone start; append the
  milestone row + standing findings in the same commit at the end.
- Never stage raw artifacts (\`results/runs/\`, \`results/raw/\`,
  \`_agent_*.jsonl\`, \`_m*_logs/\`, prompt dumps, workspaces).
- Do not touch the pre-existing dirty \`stage5_outcome_ledger.*\`.
- No live agents / Docker / sweeps without explicit approval; live runs are
  sequential and need the mandatory M89/M90A guard flags.
- Any change that could touch retrieval/ranking needs the deterministic
  retrieval no-change proof (baseline-freshness check, or the stash A/B
  proof) — see CLAUDE.md.
`;
}

function buildPackageMd(headCommit: string): string {
  return `# Stage 5 M110 Internal Evidence Package

_${M110_DATE}. Documentation/evidence-packaging milestone. NO-SPEND: no live
agents, no Docker, no API calls, no VEXP, no baseline arms, no retrieval
evals; nothing rerun. Packaging basis commit \`${headCommit}\`._

## Summary

- **What was packaged**: the frozen default path manifest
  (\`stage5_m110_frozen_default_path_manifest.json\`), the grouped evidence
  artifact index with tracked-status + SHA-256
  (\`stage5_m110_evidence_artifact_index.{md,json}\`), the claim matrix
  (\`stage5_m110_claim_matrix.{md,json}\`), a self-contained new-chat handoff
  (\`stage5_m110_new_chat_handoff.md\`), and this summary — all generated by
  \`run_stage5_m110_package.ts\` from committed artifacts, with wording guards
  (\`run_stage5_m110_lib.ts\`, unit-tested) enforcing the claim-safe and
  denominator rules on every generated file.
- **Final status**: the M95–M104 default path is frozen (recorded M109,
  packaged here); the validation arc M94–M109 is fully indexed and
  reconstructible without rerunning anything.
- **Verdict**: PASS.
- **Recommendation**: freeze and archive.

## Frozen Default Path

- **Exact treatment**: structured task derivation (M103 V5 shape, shared
  live+deterministic since M104) + Capsule v2 with the M95–M101 retrieval
  chain, injected under the M92/M105 clean-core flags: force-inject, v2
  engine, intent debug, budget 8000, digest + decision contract + bounded
  decisions + compact injection + pivot-confidence gate; M89 env guard and
  M90A shell guard are mandatory fail-closed.
- **Disabled paths**: V4, C7_D, M12 enforcement, M14/M15 revision + rule-out
  corrective arms, M7.3 traceback skip, VEXP, baseline arms, unguarded
  escape hatch.
- **Validity constraints**: legacy-fallback fire = parity-invalid (packs
  FAIL_TO_PASS into the retrieval query); revision arms inject FAIL_TO_PASS
  by design = parity-invalid as benchmark evidence; the 3 frozen no-context
  pool cases are never spawnable under the default path.

## Canonical Evidence

- **Deterministic**: \`stage5_m94_deterministic_scoreboard.{md,json}\` (baseline)
  -> \`stage5_m103_deterministic_scoreboard.{md,json}\` +
  \`stage5_m103_structured_task_derivation.md\` (final), with the M95–M102
  step reports as supporting evidence.
- **Live**: \`stage5_m108_100_case_live_confirmation.{md,json}\` (combined
  aggregate) + the M105/M106/M107 confirmation reports and all four
  \`*_live_runs.detail.json\` per-case files under the artifact-reuse contract.
- **Safety**: the four \`*_live_preflight.detail.json\` files + the \`safety\`
  blocks of each confirmation JSON + \`stage5_m104_live_path_parity.{md,json}\`
  (parity basis).
- **Historical**: \`stage5_m73_final_100_paired_summary.json\` (+detail),
  \`stage5_m92_core_reduction50_validation.{md,json}\`,
  \`stage5_m109_hard_stratum_analysis.json\`.
- **Docs**: \`README.md\`, \`docs/current_product_state.md\`,
  \`results/stage5_milestone_ledger.md\`.

## Claim Matrix

- **Allowed claims** (full wording in \`stage5_m110_claim_matrix.md\`): the
  M94->M103 deterministic improvement; 97 valid / 55 resolved (56.7% of
  valid) with the 3 no-context exclusions; the measured-zero safety/leakage
  sweep; the M92 paired −26.7% tokens / −25.0% cost claim; the directional
  M73/M92 historical comparison; and the three boundary statements
  (internal-only, no VEXP comparison, 97-attempted framing).
- **Prohibited claims**: any public SWE-bench pass@1 or SWE-bench-Verified
  claim, any VEXP parity/superiority claim, any 100-of-100-live framing, any
  leakage-impossibility or guaranteed-token-reduction claim.

## Final Result

- **Deterministic** (M94 -> M103, gold-blind pre-agent): recall@5 .637 ->
  .748; all-gold 60.6% -> 75.0%; lead=source-gold 45.5% -> 59.0%;
  hidden-coedit .222 -> .622; multi-file all-gold 6.7% -> 53.3%; miss 30 ->
  21; wrong_pivot 10 -> 7; median capsule size flat, p90 −20%; accepted
  regression overpacked 7 -> 14.
- **Live**: 100 frozen pool cases -> 97 valid guarded live runs, 55 resolved
  (56.7% of valid), 3 pre-registered no-context exclusions; $56.69 / 104.6M
  tokens / 93.9% cache-read.
- **Safety**: measured-zero across all 97 valid runs (leakage, fallback,
  env/shell guard, drift, host-pip, unguarded, revision artifacts).
- **Historical**: strict M73 comparability 93 cases — expectation 64, live
  54, agreement 77/93; M73-baseline 61/97 vs 55/97; M92 overlap 16/49 vs
  20/49 (41/49 agree); losses dominated by agent variance with complete
  context (10 of 13 had all gold in capsule).

## Handoff

- **Where to start next**: read \`stage5_m110_new_chat_handoff.md\`, then the
  milestone ledger. The ranked next steps are the M109 list: hard-stratum
  transcript study from captured artifacts first.
- **What not to rerun**: M105–M108 live runs (reuse contract), Docker
  evaluations, baselines, VEXP, V4/C7_D, revision/corrective arms, retrieval
  baselines (fresh at M103 refresh \`f14aab8\`).
- **No-spend recommendation**: no live agent or Docker spend until the
  captured-artifact analysis questions are exhausted.

## Success Criteria Check

1. No live agents, Docker evals, API calls, baselines, VEXP, V4/C7_D, or
   revision arms run — **PASS** (documentation-only generator).
2. Frozen default path manifest created — **PASS**.
3. Evidence artifact index created (md+json, grouped, hashed, tracked-only) —
   **PASS**.
4. Claim matrix created (md+json, all 9 required claims) — **PASS**.
5. New-chat handoff summary created (self-contained) — **PASS**.
6. Internal package summary created (this file + json) — **PASS**.
7. Claim-safe wording preserved (M109 allowed wording reused verbatim) —
   **PASS**.
8. Prohibited wording not introduced (generator-enforced guards + tests) —
   **PASS**.
9. Docs confirmed safe / minimally updated (product-state untouched; README
   stale-tense fix only) — **PASS**.
10. Tests/typechecks pass — recorded in the milestone ledger row.

## Verdict

**PASS**

## Recommendation

**freeze and archive** — the package is the durable starting point; further
work follows the ranked M109 next-step list (captured-artifact analysis
first, VEXP only under a new preregistered protocol).
`;
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
