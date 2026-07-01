# Stage 5 M93A Product Honesty Cleanup

## Summary

- **What changed:** No production/retrieval/scoring/Capsule behavior changed. This
  milestone is documentation + product-truth reconciliation plus one doc-hygiene
  test. Two new tracked docs were created (`docs/current_product_state.md`,
  `docs/M94_DETERMINISTIC_SCOREBOARD_PLAN.md`) and one test file
  (`src/productDocsHonesty.test.ts`).
- **Key finding:** `VTRACE_TOOLING_AUDIT.md` (2026-06-04) is **substantially
  stale**. The code has moved ~340 commits since. All three audit "release
  blockers" (B1 `check_capsule_staleness`, B2/B-lang call-edge coverage, B3 `vexb`
  leak) and the dead-subsystem findings (session compression / passive
  consolidation) were **already fixed in code and reflected in the existing docs**
  before this milestone. M93A verifies that and consolidates the truth into one
  surface.
- **What was documented:** current product state (surfaces, wired subsystems,
  language matrix, char budget, guards, benchmark interpretation) + the M94
  deterministic-scoreboard plan.
- **What was hidden/wired:** nothing newly hidden or wired — the misleading
  surfaces the audit named were already wired (manifests persisted; compression
  invoked via reindex sweep + `compress-sessions` CLI; `search_logic_flow` already
  traverses `calls` and its description is already honest).
- **What remains deferred:** `@ts-nocheck` removal, tokenizer-accurate budgeting,
  deeper TS/Cython call graphs, and the deterministic scoreboard itself (M94).
- **Recommendation:** **Proceed to M94 deterministic scoreboard.**

## Audit Findings Addressed

| Audit finding | Audit claim (2026-06-04) | Verified current state (2026-07-01) | Action in M93A |
| --- | --- | --- | --- |
| **check_capsule_staleness** | Store production never writes; any real id → "manifest not found". | `run_pipeline` (`runPipelineOrchestrator.ts:368`) and `get_context_capsule` (`tools.ts:8093`) persist manifests via `persistCapsuleManifestBestEffort`; round-trip tests `mcp.test.ts:854,1156,1609,1665`. | Documented as production-enabled; no code change needed. |
| **session lifecycle / consolidation** | Built + tested but no production caller; sessions grow unbounded. | Invoked via bounded reindex sweep (`reindexRepo.ts:131`) **and** `vtrace compress-sessions` CLI (`compressSessionsCommand.ts`). No always-on daemon. | Documented triggers accurately; no code change needed. |
| **search_logic_flow naming/behavior** | Traverses only `contains`+`imports`; name implies call-path tracing. | `SUPPORTED_EDGE_TYPES` includes `Calls` (`searchLogicFlow.ts:137`); MCP description (`tools.ts:8249`) already says "structural evidence only … not runtime execution flow" and reports `callFlowEvidenceAvailable`. | Documented honest description; no code change needed. |
| **vexb brand leak** | `arc_stage1 README:3` + `arc_stage4` harness leak `vexb`. | `git grep vexb` over tracked files → only `docs/rc_release_checklist.md:143`, an **intentional validation check** ("no stale vexb … unless intentionally historical"). arc READMEs already scrubbed. | Confirmed clean; guarded new docs with a test. |
| **language/budget limitations** | TS/Cython emit no call edges; char budget only. | TS + Cython **do** emit `calls` edges now (`typescriptParser.ts:634`, `cythonParser.ts:1482`); budget still `CapsuleBudgetModel.CharacterCount` (`chars/4` estimate). | Documented current language matrix + char-budget limitation. |

## Implementation Details

- **Files created:**
  - `docs/current_product_state.md` — product truth surface.
  - `docs/M94_DETERMINISTIC_SCOREBOARD_PLAN.md` — next-milestone plan.
  - `src/productDocsHonesty.test.ts` — 3 tests guarding the two docs (no stale
    `vexb`, required honesty phrases present, M94 non-goals present).
  - `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m93a_product_honesty_cleanup.{md,json}` — this report.
- **Files unchanged:** all `src/` engine code, `src/mcp/tools.ts`, all parsers,
  retrieval, ranking, and Capsule code. No tool registration, schema, or
  description changes. V4 / C7_D untouched. Env guard / shell guard untouched.
- **Tests added:** 3 (all passing). No existing tests modified.
- **Compatibility notes:** additive only. No behavioral surface changed, so no
  retrieval no-change proof is required (per the milestone's own gate).

## Current Product Truth

- **Core real surfaces:** CLI (24 commands), MCP (12 visible + hidden legacy),
  `run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`
  (with accurate structural caveat), `get_skeleton`, indexing, memory. All
  engine-backed and tested.
- **Known limitations:** JS scanned-not-parsed; Go/Rust dead enums; TS/Cython
  `calls` are conservative; character-based (not tokenizer) budget; `@ts-nocheck`
  debt; handoff no file export; protocol adapters experimental/unexposed.
- **Benchmark interpretation:** M92 is the core token-reduction evidence (−26.7%
  tokens, resolution preserved 20/50). Stage 5 is integrated downstream
  validation, not the deterministic-core scoreboard and not a public SWE-bench
  pass@1 claim. V4/C7_D are default-off diagnostics with no demonstrated
  resolution benefit. Env + shell guards are mandatory Stage 5 live safety.

## M94 Plan

`docs/M94_DETERMINISTIC_SCOREBOARD_PLAN.md` defines an offline, deterministic
scoreboard that scores retrieval/capsule quality **before** the agent acts —
gold-file recall@K, any/all-gold-in-capsule, lead-pivot-is-gold, hidden-coedit
recall, capsule/digest est-tokens, overpacking ratio, and `missing_gold_reason`
attribution — over the frozen Stage 5 100-task pool, with **no live agents, no
Docker, no pass@1 claim**. It comes next because it converts the entangled,
expensive live signal into a fast, byte-stable target function for retrieval/pivot/
capsule work.

## Success Criteria Check

| # | Criterion | Result |
| --- | --- | --- |
| 1 | check_capsule_staleness no longer misleading-by-unreachability | **PASS** — wired in prod; documented. |
| 2 | session compression/consolidation documented or wired honestly | **PASS** — wired (reindex sweep + CLI); documented as bounded, no daemon. |
| 3 | search_logic_flow description no longer implies call-flow tracing | **PASS** — honest description + `callFlowEvidenceAvailable`; documented. |
| 4 | stale vexb leakage scrubbed or explicitly justified | **PASS** — only the intentional checklist item remains; new docs guarded by test. |
| 5 | language coverage + char-budget limitations documented | **PASS** — matrix + budget model in product-state doc. |
| 6 | current product state doc exists | **PASS** — `docs/current_product_state.md`. |
| 7 | M94 deterministic scoreboard plan exists | **PASS** — `docs/M94_DETERMINISTIC_SCOREBOARD_PLAN.md`. |
| 8 | no live agents run | **PASS**. |
| 9 | no Docker eval run | **PASS**. |
| 10 | no Conda environment mutated | **PASS**. |
| 11 | tests/typechecks pass | **PASS** — see verification below. |

## Recommendation

**Proceed to M94 deterministic scoreboard.** The product-truth surfaces are now
honest and consolidated; the audit's blockers were already resolved in code. The
highest-leverage next step is a deterministic, offline target function for the
core, which M94 defines.
