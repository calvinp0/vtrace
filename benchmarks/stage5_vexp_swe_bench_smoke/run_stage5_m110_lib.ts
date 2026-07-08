// Stage 5 M110 — pure builders for the internal evidence package: the frozen
// default-path manifest, the evidence artifact index, the claim matrix, and
// the wording guards (prohibited-claim + denominator-framing checks). NO I/O
// — file hashing/tracked-status lookups are injected by the generator
// (`run_stage5_m110_package.ts`) so everything here is unit-testable.

export const M110_DATE = "2026-07-08";

export const MILESTONE_COMMITS: Readonly<Record<string, string>> = {
  M94: "8d52a78",
  M95: "978458b",
  M96: "ca3d87a",
  M97: "81902d2",
  M98: "8157a72",
  M99: "29c65ca",
  M100: "49577bc",
  M101: "48379f1",
  M102: "a5ec283",
  M103: "199769f",
  M104: "4ca4948",
  M105: "fb791b0",
  M106: "5043a63",
  M107: "1dc69b2",
  M108: "a0bc3a6",
  M109: "d9364a9",
};

export const RETRIEVAL_BASELINE_REFRESH_COMMITS: Readonly<Record<string, string>> = {
  M99: "4648ea0",
  M100: "46e081d",
  M101: "e5f6e35",
  M103: "f14aab8",
};

export const NO_CONTEXT_EXCLUSIONS: readonly string[] = [
  "django__django-11740",
  "django__django-15572",
  "sphinx-doc__sphinx-9320",
];

// ---------------------------------------------------------------------------
// Frozen default path manifest
// ---------------------------------------------------------------------------

export function buildFrozenDefaultPathManifest(currentHeadCommit: string) {
  return {
    milestone: "M110",
    kind: "frozen default path manifest — the exact VTRACE Stage 5 treatment validated live in M105-M108 and frozen in M109",
    date: M110_DATE,
    current_head_commit: currentHeadCommit,
    milestone_commits: MILESTONE_COMMITS,
    retrieval_baseline_refresh_commits: RETRIEVAL_BASELINE_REFRESH_COMMITS,
    default_path: {
      protocol: "vtrace-indexed (sequential guarded live runs; external vexp-swe-bench harness owns the agent turn loop)",
      capsule_engine: "v2",
      capsule_intent: "debug (live clean-core pin; deterministic scoreboard pins the same Debug intent)",
      capsule_budget: 8000,
      context_policy: "force-inject",
      digest_injection: "ON (--inject-capsule-digest)",
      digest_decision_contract: "ON (--digest-decision-contract)",
      bounded_digest_decisions: "ON (--bounded-digest-decisions)",
      compact_digest_injection: "ON (--compact-digest-injection)",
      pivot_confidence_gate: "ON (--pivot-confidence-gate)",
      structured_task_derivation:
        "ON — deriveStructuredTaskFromProblemStatement (stage5_task_derivation.ts; M103 V5 shape: V0 base + exceptions <=6 + issue-mentioned failing tests <=6 + traceback frames <=8, 1200-char cap); shared by deterministic scoreboard AND live runner since M104",
      retrieval_capsule_chain:
        "Capsule v2 + M95 strong-lexical fix + M96 direct-evidence lanes + M97/M98 tiered co-edit expansion + M99 import_reexport_rescue + M100 file-evidence rescue + M101 anchored pivot guard",
      env_guard:
        "MANDATORY fail-closed (M89): --stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix <pinned testbed prefix>",
      shell_guard: "MANDATORY (M90A): --stage5-agent-shell-guard --stage5-host-pip-firewall",
    },
    disabled_paths: {
      V4: "tool-loop guard — default-off diagnostic (M78/M82/M85/M88: harmless, no resolution benefit)",
      C7_D: "cost guard — default-off diagnostic (fires neutral-late on cap targets)",
      revision_corrective_arms:
        "M12 pivot-inspection enforcement, M14/M15 revision passes, rule-out corrective — default-off; revision arms inject FAIL_TO_PASS by design and are parity-INVALID as benchmark evidence",
      VEXP: "no VEXP arm run or claimed; comparison requires a separate preregistered protocol",
      baseline_arm: "no fresh baseline arm; M73/M92 frozen history is the only comparison basis",
      legacy_fallback_validity:
        "v2->legacy fallback packs FAIL_TO_PASS into the retrieval query — any fire makes the run parity-invalid by contract (0 fires across the 97 valid runs)",
      m7_3_traceback_skip: "default-off since 7863c80",
      unguarded_escape_hatch: "--allow-unguarded-live-env exists for test/emergency only; never benchmark-valid; never used",
    },
    known_invalid_contexts: [
      "legacy fallback with FAIL_TO_PASS in the retrieval query (retrieval-only contamination; fires only on v2 hard-fail)",
      "revision/corrective arms with FAIL_TO_PASS in the prompt (by design; default-off)",
    ],
    no_context_exclusions: NO_CONTEXT_EXCLUSIONS,
    claim_boundaries: [
      "internal confirmation only — a frozen internal 100-case Stage 5 pool, not a public benchmark run",
      "not a public SWE-bench pass@1 claim",
      "not a VEXP parity or superiority claim",
      "not 100-of-100 live-attempted — 97 valid guarded live runs + 3 pre-registered no-context exclusions",
    ],
  };
}

// ---------------------------------------------------------------------------
// Evidence artifact index
// ---------------------------------------------------------------------------

export type ArtifactGroup =
  | "deterministic_core"
  | "live_parity_safety"
  | "live_confirmation"
  | "final_summary"
  | "historical_comparison"
  | "docs";

export interface ArtifactEntry {
  readonly path: string;
  readonly kind: string;
  readonly milestone: string;
  readonly group: ArtifactGroup;
  readonly purpose: string;
  readonly canonical_or_supporting: "canonical" | "supporting";
  readonly notes?: string;
}

const R = "benchmarks/stage5_vexp_swe_bench_smoke/results";

export const EVIDENCE_ARTIFACTS: readonly ArtifactEntry[] = [
  // deterministic core: M94 -> M103
  { path: `${R}/stage5_m94_deterministic_scoreboard.md`, kind: "report_md", milestone: "M94", group: "deterministic_core", purpose: "gold-blind pre-agent baseline scoreboard (comparable-99 basis)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m94_deterministic_scoreboard.json`, kind: "report_json", milestone: "M94", group: "deterministic_core", purpose: "machine-readable M94 baseline metrics", canonical_or_supporting: "canonical", notes: "per-case rows in stage5_m94_deterministic_scoreboard.detail.json" },
  { path: `${R}/stage5_m95_retrieval_improvement.md`, kind: "report_md", milestone: "M95", group: "deterministic_core", purpose: "genericInfra strong-lexical fix", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m96_candidate_pool_recall.md`, kind: "report_md", milestone: "M96", group: "deterministic_core", purpose: "direct-evidence anchoring (issue-text mention lanes)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m97_hidden_coedit_expansion.md`, kind: "report_md", milestone: "M97", group: "deterministic_core", purpose: "bounded hidden co-edit expansion (multi-file recall)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m98_support_precision.md`, kind: "report_md", milestone: "M98", group: "deterministic_core", purpose: "co-edit confidence tiers (subtractive pruning)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m99_import_edge_extraction.md`, kind: "report_md", milestone: "M99", group: "deterministic_core", purpose: "file-level import scan + import_reexport_rescue lane", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m100_candidate_pool_recall.md`, kind: "report_md", milestone: "M100", group: "deterministic_core", purpose: "file-evidence deep-pool rescue", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m101_ranking_pivot.md`, kind: "report_md", milestone: "M101", group: "deterministic_core", purpose: "anchored-target pivot guard", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m102_task_derivation_audit.md`, kind: "report_md", milestone: "M102", group: "deterministic_core", purpose: "task-derivation variant audit (V5 selected)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m103_structured_task_derivation.md`, kind: "report_md", milestone: "M103", group: "deterministic_core", purpose: "structured task derivation shipped as default + provenance leakage policy", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m103_deterministic_scoreboard.md`, kind: "report_md", milestone: "M103", group: "deterministic_core", purpose: "final deterministic scoreboard (new-policy-100 basis)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m103_deterministic_scoreboard.json`, kind: "report_json", milestone: "M103", group: "deterministic_core", purpose: "machine-readable M103 final metrics incl. regression_guard_cases", canonical_or_supporting: "canonical", notes: "per-case rows in stage5_m103_deterministic_scoreboard.detail.json" },
  // live parity / safety basis: M104
  { path: `${R}/stage5_m104_live_path_parity.md`, kind: "report_md", milestone: "M104", group: "live_parity_safety", purpose: "live task builder = shared M103 derivation; 14/14 byte-exact parity + leak-clean no-agent smoke", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m104_live_path_parity.json`, kind: "report_json", milestone: "M104", group: "live_parity_safety", purpose: "machine-readable M104 parity/leakage result", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m104_live_context_smoke.detail.json`, kind: "detail_json", milestone: "M104", group: "live_parity_safety", purpose: "per-case smoke rows (task hashes, leak-scan classifications)", canonical_or_supporting: "supporting" },
  // live confirmation: M105 -> M108
  { path: `${R}/stage5_m105_small_live_confirmation.md`, kind: "report_md", milestone: "M105", group: "live_confirmation", purpose: "14-case live confirmation (6/14 resolved; M73-treatment per-case exact)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m105_small_live_confirmation.json`, kind: "report_json", milestone: "M105", group: "live_confirmation", purpose: "machine-readable M105 aggregate + safety block", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m105_live_runs.detail.json`, kind: "detail_json", milestone: "M105", group: "live_confirmation", purpose: "per-case live rows (M105 set)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m105_live_preflight.detail.json`, kind: "preflight_json", milestone: "M105", group: "live_confirmation", purpose: "per-case spawn-gate evidence (parity hashes, leak scans, guard probes)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m106_24_case_live_confirmation.md`, kind: "report_md", milestone: "M106", group: "live_confirmation", purpose: "24-case live confirmation (9/24; reuse contract established)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m106_24_case_live_confirmation.json`, kind: "report_json", milestone: "M106", group: "live_confirmation", purpose: "machine-readable M106 aggregate + safety block", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m106_live_runs.detail.json`, kind: "detail_json", milestone: "M106", group: "live_confirmation", purpose: "per-case live rows (M106 extension)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m106_live_preflight.detail.json`, kind: "preflight_json", milestone: "M106", group: "live_confirmation", purpose: "per-case spawn-gate evidence (M106 extension)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m106_case_selection.json`, kind: "selection_json", milestone: "M106", group: "live_confirmation", purpose: "pre-registered deterministic extension-case selection", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m107_50_case_live_confirmation.md`, kind: "report_md", milestone: "M107", group: "live_confirmation", purpose: "50-case live confirmation (17/50; sympy-12419 regression resolved live)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m107_50_case_live_confirmation.json`, kind: "report_json", milestone: "M107", group: "live_confirmation", purpose: "machine-readable M107 aggregate + safety block", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m107_live_runs.detail.json`, kind: "detail_json", milestone: "M107", group: "live_confirmation", purpose: "per-case live rows (M107 extension)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m107_live_preflight.detail.json`, kind: "preflight_json", milestone: "M107", group: "live_confirmation", purpose: "per-case spawn-gate evidence (M107 extension)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m107_case_selection.json`, kind: "selection_json", milestone: "M107", group: "live_confirmation", purpose: "pre-registered deterministic extension-case selection", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m108_100_case_live_confirmation.md`, kind: "report_md", milestone: "M108", group: "live_confirmation", purpose: "combined 100-case live confirmation: 97 valid / 55 resolved / 3 no-context exclusions", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m108_100_case_live_confirmation.json`, kind: "report_json", milestone: "M108", group: "live_confirmation", purpose: "machine-readable combined aggregate + safety clean-sweep block", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m108_live_runs.detail.json`, kind: "detail_json", milestone: "M108", group: "live_confirmation", purpose: "per-case live rows (M108 extension)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m108_live_preflight.detail.json`, kind: "preflight_json", milestone: "M108", group: "live_confirmation", purpose: "per-case spawn-gate evidence incl. the 3 expected_no_context holds", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m108_case_selection.json`, kind: "selection_json", milestone: "M108", group: "live_confirmation", purpose: "deterministic complement selection (remaining 50 pool cases)", canonical_or_supporting: "supporting" },
  // final summary: M109
  { path: `${R}/stage5_m109_final_internal_summary.md`, kind: "report_md", milestone: "M109", group: "final_summary", purpose: "canonical final roll-up: deterministic + live + safety + claim-safe wording", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m109_final_internal_summary.json`, kind: "report_json", milestone: "M109", group: "final_summary", purpose: "machine-readable final summary (denominator rule, allowed/prohibited wording)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m109_hard_stratum_analysis.json`, kind: "detail_json", milestone: "M109", group: "final_summary", purpose: "per-case flip analysis vs M73 (strict comparability; loss-reason split)", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m109_final_analysis_notes.md`, kind: "report_md", milestone: "M109", group: "final_summary", purpose: "working derivations behind the summary numbers", canonical_or_supporting: "supporting" },
  // historical comparison: M73 + M92
  { path: `${R}/stage5_m73_final_100_paired_summary.json`, kind: "report_json", milestone: "M73", group: "historical_comparison", purpose: "M73 treatment/baseline expectations over the 100-task set", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m73_final_100_paired.detail.json`, kind: "detail_json", milestone: "M73", group: "historical_comparison", purpose: "per-case M73 rows (treatment_valid comparability source)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m73_stage_c_fresh_baselines_and_final_100.md`, kind: "report_md", milestone: "M73", group: "historical_comparison", purpose: "M73 Stage C report (fresh baselines + final 100 analysis)", canonical_or_supporting: "supporting" },
  { path: `${R}/stage5_m92_core_reduction50_validation.md`, kind: "report_md", milestone: "M92", group: "historical_comparison", purpose: "the ONLY paired same-protocol token/cost claim: -26.7% tokens / -25.0% cost, resolution preserved 20/50", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_m92_core_reduction50_validation.json`, kind: "report_json", milestone: "M92", group: "historical_comparison", purpose: "machine-readable M92 paired result", canonical_or_supporting: "canonical" },
  // docs / claim surfaces
  { path: "README.md", kind: "doc", milestone: "M93B/M109", group: "docs", purpose: "public claim surface (M92 figures scoped; explicit not-a-public-pass@1 disclaimer)", canonical_or_supporting: "canonical" },
  { path: "docs/current_product_state.md", kind: "doc", milestone: "M109", group: "docs", purpose: "single plain-truth product surface incl. benchmark interpretation + freeze note", canonical_or_supporting: "canonical" },
  { path: `${R}/stage5_milestone_ledger.md`, kind: "ledger", milestone: "M99+", group: "docs", purpose: "append-only milestone chain record (what was done, standing findings, next steps)", canonical_or_supporting: "canonical" },
];

export interface ResolvedArtifactEntry extends ArtifactEntry {
  readonly tracked_status: "tracked" | "untracked" | "missing" | "unknown";
  readonly sha256: string | null;
}

export type ArtifactResolver = (path: string) => { tracked: boolean; exists: boolean; sha256: string | null };

export function resolveArtifacts(entries: readonly ArtifactEntry[], resolve: ArtifactResolver): ResolvedArtifactEntry[] {
  return entries.map((entry) => {
    const r = resolve(entry.path);
    return {
      ...entry,
      tracked_status: !r.exists ? "missing" : r.tracked ? "tracked" : "untracked",
      sha256: r.sha256,
    };
  });
}

const FORBIDDEN_INDEX_PATH_PATTERNS: readonly RegExp[] = [
  /\/runs\//,
  /\/raw\//,
  /\/workspaces\//,
  /\/_[^/]*$/, // underscore-prefixed basenames (raw streams, driver ledgers, logs)
  /\/_m\d+_/,
  /\.jsonl$/,
  /\.log$/,
];

/** Paths the artifact index must never contain (raw runs, streams, logs, workspaces). */
export function findForbiddenIndexPaths(entries: readonly ArtifactEntry[]): string[] {
  return entries.map((e) => e.path).filter((p) => FORBIDDEN_INDEX_PATH_PATTERNS.some((re) => re.test(p)));
}

// ---------------------------------------------------------------------------
// Claim matrix
// ---------------------------------------------------------------------------

export interface ClaimEntry {
  readonly id: string;
  readonly claim: string;
  readonly allowed_wording: string;
  readonly supporting_artifacts: readonly string[];
  readonly scope: string;
  readonly denominator: string;
  readonly caveats: readonly string[];
  readonly prohibited_stronger_forms: readonly string[];
}

export const CLAIM_MATRIX: readonly ClaimEntry[] = [
  {
    id: "deterministic_m94_to_m103",
    claim: "The M95-M103 deterministic chain improved the pre-agent scoreboard from M94 to M103.",
    allowed_wording:
      "The M95-M103 deterministic chain improved the pre-agent scoreboard from M94 to M103: recall@5 .637 to .748, all-gold-in-capsule 60.6% to 75.0%, lead-pivot=source-gold 45.5% to 59.0%, hidden-coedit recall .222 to .622, multi-file all-gold 6.7% to 53.3%, miss 30 to 21, wrong_pivot 10 to 7 — at flat median capsule size and p90 -20%. Accepted cost: overpacked capsules 7 to 14.",
    supporting_artifacts: [
      `${R}/stage5_m94_deterministic_scoreboard.json`,
      `${R}/stage5_m103_deterministic_scoreboard.json`,
      `${R}/stage5_m109_final_internal_summary.json`,
    ],
    scope: "gold-blind, pre-agent, deterministic scoreboard over the internal 100-case pool (M94 = comparable-99 basis; M103 = new-policy-100 basis)",
    denominator: "99/100 scored capsules (set bases differ as noted); percentages are over scored cases",
    caveats: [
      "pre-agent scoreboard quality, not live resolution",
      "M94 and M103 sets differ by the leakage-policy change (psf-5414 scoreable only under M103 policy)",
      "overpacked 7 to 14 is a real accepted regression",
    ],
    prohibited_stronger_forms: [
      "VTRACE retrieval is validated on SWE-bench",
      "guaranteed recall improvement on any repository",
    ],
  },
  {
    id: "live_97_valid_55_resolved",
    claim: "97 valid guarded live runs on the frozen internal 100-case pool; 55 resolved.",
    allowed_wording:
      "On the frozen internal 100-case Stage 5 pool, the current default VTRACE path produced 97 valid guarded live runs, with 55 resolved patches (56.7% of valid live runs). Three cases were pre-registered no-context exclusions under the parity contract.",
    supporting_artifacts: [
      `${R}/stage5_m108_100_case_live_confirmation.json`,
      `${R}/stage5_m108_live_runs.detail.json`,
      `${R}/stage5_m109_final_internal_summary.json`,
    ],
    scope: "internal live confirmation, guarded, digest-ON clean-core protocol; frozen pool only",
    denominator: "ALWAYS report all three numbers: 100 frozen pool cases, 97 valid live runs, 3 pre-registered no-context exclusions; the 56.7% rate is over VALID runs only",
    caveats: [
      "not a public SWE-bench pass@1 claim",
      "single live pass per case; live variance is real (M107/M108 evidence)",
      "the three sub-samples (M105/M106/M107 vs M108) are not exchangeable — M106/M107 oversampled failure strata",
    ],
    prohibited_stronger_forms: [
      "VTRACE achieved 56.7% on SWE-bench",
      "VTRACE pass@1 is 56.7%",
      "100/100 live cases were run",
      "VTRACE is validated on SWE-bench Verified",
    ],
  },
  {
    id: "no_context_exclusions",
    claim: "3 pool cases were pre-registered no-context exclusions, never spawned.",
    allowed_wording:
      "Three pool cases (django__django-11740, django__django-15572, sphinx-doc__sphinx-9320) are frozen M103 no-context rows: the default path has nothing to inject, a spawned run would be baseline-shaped and parity-invalid, so the preflight held them back. They were pre-registered in the M108 plan, not dropped after the fact.",
    supporting_artifacts: [
      `${R}/stage5_m108_100_case_live_confirmation_plan.md`,
      `${R}/stage5_m108_live_preflight.detail.json`,
      `${R}/stage5_m110_frozen_default_path_manifest.json`,
    ],
    scope: "frozen 100-case pool under the M104 parity contract",
    denominator: "3 of 100 pool cases",
    caveats: ["these are unattempted, not failures and not resolutions; they cap any pool-denominator rate at 97 attempted"],
    prohibited_stronger_forms: ["100/100 live cases were run", "the exclusions were resolved or would have resolved"],
  },
  {
    id: "safety_leakage_measured_zero",
    claim: "Safety/leakage was measured-zero across all 97 valid live runs.",
    allowed_wording:
      "Across the 97 valid runs, the default path was leak-clean: zero model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, zero fallback-context fires, zero unguarded env/shell runs, and zero host-pip mutation escapes.",
    supporting_artifacts: [
      `${R}/stage5_m105_live_preflight.detail.json`,
      `${R}/stage5_m106_live_preflight.detail.json`,
      `${R}/stage5_m107_live_preflight.detail.json`,
      `${R}/stage5_m108_live_preflight.detail.json`,
      `${R}/stage5_m109_final_internal_summary.json`,
    ],
    scope: "two-sided scans (pre-spawn assembled context + post-run injected snapshot) with base-commit + issue-authored provenance classification",
    denominator: "97/97 valid runs; 0 unexplained hits",
    caveats: [
      "measured-zero on THIS protocol; never present it as an impossibility guarantee",
      "raw string scans false-positive on legitimate base-commit content; classification by provenance is part of the contract (M104 finding)",
    ],
    prohibited_stronger_forms: ["no leakage is possible", "the protocol proves leakage cannot occur"],
  },
  {
    id: "m92_token_cost_reduction",
    claim: "M92 paired 50-task run: tokens -26.7%, cost -25.0%, resolution preserved.",
    allowed_wording:
      "In the one paired same-protocol measurement (M92, 50 tasks, both arms valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% (tool calls -30.2%) with resolution preserved (20/50 both arms).",
    supporting_artifacts: [`${R}/stage5_m92_core_reduction50_validation.json`, `${R}/stage5_m92_core_reduction50_validation.md`],
    scope: "paired baseline-vs-vtrace, same protocol, same day, 50 tasks; the ONLY same-protocol reduction claim",
    denominator: "50 paired tasks, both arms valid",
    caveats: [
      "pre-dates the M95-M103 retrieval chain and the M103 task derivation (M92 used the old composite task)",
      "M105-M108 vs-M73 cost deltas (+14%/-11%/-34%/-10%) are directional only — different model days, unpaired",
      "internal chars/4 budgeter is not tokenizer-accurate",
    ],
    prohibited_stronger_forms: ["token reduction is guaranteed", "VTRACE always reduces tokens by ~25%"],
  },
  {
    id: "historical_m73_m92_comparison",
    claim: "Live results are directionally comparable to frozen M73/M92 history.",
    allowed_wording:
      "Against frozen history (different run days, partly different protocol versions): strict M73-treatment comparability holds on 93 cases — M73 expectation 64, live 54, per-case agreement 77/93 (82.8%). M73-baseline expectation is 61/97 vs live 55/97. On the 49-case M92 overlap: live 16 vs M92 20, agreement 41/49. The deficit concentrates in the deliberately failure-enriched M106/M107 strata and is dominated by agent-side variance on cases whose capsules carried all gold files.",
    supporting_artifacts: [
      `${R}/stage5_m73_final_100_paired_summary.json`,
      `${R}/stage5_m109_hard_stratum_analysis.json`,
      `${R}/stage5_m109_final_internal_summary.json`,
    ],
    scope: "unpaired comparison against frozen historical runs; directional context only",
    denominator: "strict comparable set = 93 (4 pool cases lack a valid M73 treatment row); loose as-reported framing = 81/96 agreement",
    caveats: [
      "not controlled arms; not statistically powered as a public claim at n=100",
      "13 strict live losses: 10 agent-variance, 1 single-file-patch-on-multifile-gold, 2 deterministic context gaps; 10 of 13 had all gold files in the capsule",
    ],
    prohibited_stronger_forms: ["VTRACE regressed/improved X% vs M73 (as a controlled result)", "live variance has been ruled out"],
  },
  {
    id: "boundary_not_public_pass_at_1",
    claim: "BOUNDARY: results are internal, not a public SWE-bench pass@1.",
    allowed_wording: "This is an internal live confirmation, not a public SWE-bench pass@1 claim and not a VEXP parity claim.",
    supporting_artifacts: [`${R}/stage5_m109_final_internal_summary.json`],
    scope: "all M105-M108 live numbers",
    denominator: "n/a (boundary statement)",
    caveats: ["a public claim would need SWE-bench Verified / the official harness under a preregistered protocol"],
    prohibited_stronger_forms: ["VTRACE achieved 56.7% on SWE-bench", "VTRACE pass@1 is 56.7%", "VTRACE is validated on SWE-bench Verified"],
  },
  {
    id: "boundary_not_vexp_parity",
    claim: "BOUNDARY: no VEXP parity or superiority claim exists.",
    allowed_wording:
      "No VEXP arm was run in the M94-M109 arc. Any VTRACE-vs-VEXP comparison requires a separate preregistered protocol with its own paired design and budget.",
    supporting_artifacts: [`${R}/stage5_m109_final_internal_summary.json`, `${R}/stage5_m110_frozen_default_path_manifest.json`],
    scope: "the whole M94-M109 arc",
    denominator: "n/a (boundary statement)",
    caveats: ["the Stage 5 harness wraps the external vexp-swe-bench runner; that is infrastructure reuse, not a comparison"],
    prohibited_stronger_forms: ["VTRACE beats VEXP", "VTRACE matches VEXP"],
  },
  {
    id: "boundary_not_100_of_100_attempted",
    claim: "BOUNDARY: a 100-of-100 live-attempted framing must never be used.",
    allowed_wording:
      "97 of the 100 frozen pool cases were live-attempted (all 97 valid); the remaining 3 are pre-registered no-context exclusions that the default path cannot inject on and therefore never spawned.",
    supporting_artifacts: [`${R}/stage5_m108_100_case_live_confirmation.json`, `${R}/stage5_m108_live_preflight.detail.json`],
    scope: "frozen 100-case pool",
    denominator: "97 attempted / 3 excluded / 100 pool",
    caveats: ["reporting 55/97 without mentioning the 3 exclusions is also non-compliant — the denominator rule requires all three numbers"],
    prohibited_stronger_forms: ["100/100 live cases were run", "55/100 resolved (without the exclusion framing)"],
  },
];

export const REQUIRED_CLAIM_IDS: readonly string[] = [
  "deterministic_m94_to_m103",
  "live_97_valid_55_resolved",
  "no_context_exclusions",
  "safety_leakage_measured_zero",
  "m92_token_cost_reduction",
  "historical_m73_m92_comparison",
  "boundary_not_public_pass_at_1",
  "boundary_not_vexp_parity",
  "boundary_not_100_of_100_attempted",
];

// ---------------------------------------------------------------------------
// Wording guards
// ---------------------------------------------------------------------------

export interface WordingViolation {
  readonly rule: string;
  readonly match: string;
}

const PROHIBITED_PATTERNS: readonly { rule: string; re: RegExp }[] = [
  { rule: "public_pass_at_1", re: /\bpass@1\s+(?:is|=|of)\s*[0-9]/i },
  { rule: "public_pass_at_1", re: /achieved\s+[0-9.]+%\s+on\s+SWE-bench/i },
  { rule: "swe_bench_verified", re: /validated\s+on\s+SWE-bench\s+Verified/i },
  { rule: "hundred_of_hundred", re: /100\s*\/\s*100\s+live/i },
  { rule: "hundred_of_hundred", re: /all\s+100\s+(?:cases|runs)\s+(?:were\s+)?(?:run|attempted)/i },
  { rule: "vexp_parity", re: /\b(?:beats|outperforms|matches|surpasses|superior\s+to)\s+VEXP\b/i },
  { rule: "vexp_parity", re: /VEXP\s+parity\s+(?:achieved|reached|demonstrated|confirmed)/i },
  { rule: "leakage_impossible", re: /no\s+leakage\s+is\s+possible/i },
  { rule: "leakage_impossible", re: /leakage\s+is\s+impossible/i },
  { rule: "guaranteed_reduction", re: /token\s+reduction\s+is\s+guaranteed/i },
  { rule: "guaranteed_reduction", re: /guaranteed\s+token\s+reduction/i },
];

/**
 * Lines that intentionally QUOTE a prohibited form (in a "never say this"
 * listing) are marked with the ✗ prefix by our renderers; strip them before
 * scanning so the guard checks only assertive prose.
 */
export function stripProhibitedListingLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:[-*>|]\s*)*✗/.test(line))
    .join("\n");
}

export function checkProhibitedWording(text: string): WordingViolation[] {
  const scanned = stripProhibitedListingLines(text);
  const violations: WordingViolation[] = [];
  for (const { rule, re } of PROHIBITED_PATTERNS) {
    const m = scanned.match(re);
    if (m) violations.push({ rule, match: m[0] });
  }
  return violations;
}

/**
 * Denominator rule: any text that states the headline live result (55
 * resolved and/or 56.7%) must also carry the 97-valid framing and the
 * no-context exclusions.
 */
export function checkDenominatorWording(text: string): string[] {
  const issues: string[] = [];
  const mentionsHeadline = /55\s+resolved/i.test(text) || /56\.7\s*%/.test(text);
  if (!mentionsHeadline) return issues;
  if (!/97\s+valid/i.test(text)) issues.push("mentions the 55-resolved/56.7% headline without the '97 valid' framing");
  if (!/no[-_\s]?context/i.test(text)) issues.push("mentions the 55-resolved/56.7% headline without the no-context exclusion framing");
  return issues;
}

// ---------------------------------------------------------------------------
// Markdown renderers
// ---------------------------------------------------------------------------

const GROUP_TITLES: Readonly<Record<ArtifactGroup, string>> = {
  deterministic_core: "Deterministic core (M94–M103)",
  live_parity_safety: "Live parity/safety basis (M104)",
  live_confirmation: "Live confirmation (M105–M108)",
  final_summary: "Final summary (M109)",
  historical_comparison: "Historical comparison (M73, M92)",
  docs: "Docs / claim surfaces",
};

export const GROUP_ORDER: readonly ArtifactGroup[] = [
  "deterministic_core",
  "live_parity_safety",
  "live_confirmation",
  "final_summary",
  "historical_comparison",
  "docs",
];

export function renderArtifactIndexMd(entries: readonly ResolvedArtifactEntry[], headCommit: string): string {
  const lines: string[] = [];
  lines.push("# Stage 5 M110 Evidence Artifact Index");
  lines.push("");
  lines.push(
    `_${M110_DATE}. Index of the canonical + supporting evidence for the frozen default VTRACE path (packaging basis commit \`${headCommit}\`). ` +
      "Raw run folders, streams, logs, and workspaces are deliberately NOT indexed or hashed — they are untracked working artifacts, never package contents. " +
      "SHA-256 hashes are over file bytes at the packaging commit._",
  );
  lines.push("");
  for (const group of GROUP_ORDER) {
    const rows = entries.filter((e) => e.group === group);
    if (rows.length === 0) continue;
    lines.push(`## ${GROUP_TITLES[group]}`);
    lines.push("");
    lines.push("| path | kind | milestone | role | tracked | sha256 (12) | purpose |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const e of rows) {
      const sha = e.sha256 ? e.sha256.slice(0, 12) : "—";
      const purpose = e.notes ? `${e.purpose} (${e.notes})` : e.purpose;
      lines.push(`| \`${e.path}\` | ${e.kind} | ${e.milestone} | ${e.canonical_or_supporting} | ${e.tracked_status} | \`${sha}\` | ${purpose} |`);
    }
    lines.push("");
  }
  lines.push("## Explicitly out of scope (never package)");
  lines.push("");
  lines.push("- everything under `results/runs/` and `results/raw/` (cloned workspaces, raw result rows, streams, snapshots)");
  lines.push("- all `results/_agent_*.jsonl`, `results/_m*_logs/`, `results/_m*_driver_ledger.jsonl`, `results/_m*_preflight/`, prompt dumps, guard state dirs");
  lines.push("- the pre-existing dirty `stage5_outcome_ledger.{md,json}` and untracked working docs (`AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`)");
  lines.push("");
  return lines.join("\n");
}

export function renderClaimMatrixMd(claims: readonly ClaimEntry[]): string {
  const lines: string[] = [];
  lines.push("# Stage 5 M110 Claim Matrix");
  lines.push("");
  lines.push(
    `_${M110_DATE}. Every claim the frozen default path supports, with the allowed wording (reuse verbatim or equivalent), ` +
      "its evidence, scope, denominator, caveats, and the stronger forms that are prohibited. " +
      "Lines prefixed with ✗ QUOTE prohibited wording — they are listed so nobody uses them._",
  );
  lines.push("");
  for (const c of claims) {
    lines.push(`## ${c.id}`);
    lines.push("");
    lines.push(`**Claim**: ${c.claim}`);
    lines.push("");
    lines.push(`**Allowed wording**:`);
    lines.push("");
    lines.push(`> ${c.allowed_wording}`);
    lines.push("");
    lines.push(`**Supporting artifacts**:`);
    for (const a of c.supporting_artifacts) lines.push(`- \`${a}\``);
    lines.push("");
    lines.push(`**Scope**: ${c.scope}`);
    lines.push("");
    lines.push(`**Denominator**: ${c.denominator}`);
    lines.push("");
    lines.push(`**Caveats**:`);
    for (const cav of c.caveats) lines.push(`- ${cav}`);
    lines.push("");
    lines.push(`**Prohibited stronger forms** (never say):`);
    for (const p of c.prohibited_stronger_forms) lines.push(`- ✗ "${p}"`);
    lines.push("");
  }
  return lines.join("\n");
}
