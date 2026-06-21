# Stage 5 M56B Digest Enrichment Bridge

Bridge the enriched M56 digest data (impact / memory / rules) into the **Stage 5 live
injection** path, so a `--inject-capsule-digest` run injects real `→ impact` rows —
not just `*_not_threaded_into_digest` warnings. Harness/product work only: no live
agents, no Docker, no API spend, no benchmark sweep, no retrieval/scoring change.

## Summary

- **Stage 5 can now inject impact:** ✅ **Yes.** The Stage 5 parent opens the
  workspace index (`.vtrace/index.sqlite`) and computes a real impact seam from the
  capsule's top pivot `fq_name`, including representative dependent rows with line
  ranges and signature-window snippets — identical projection to MCP run_pipeline.
- **Stage 5 can now inject memory:** ⚠️ **Plumbing yes, data no.** The bridge calls
  `searchMemory` against the workspace index, but a fresh SWE-bench workspace index
  carries **no observation store** (observations come from prior agent sessions, not
  from indexing source). So memory is honestly `memory_not_threaded_into_digest`. It
  auto-folds the moment an index carries observations — no code change needed.
- **Stage 5 can now inject rules:** ⚠️ **Plumbing yes, data no.** The bridge calls
  `selectRelevantProjectRules`, but a fresh workspace index has **no project-rule
  store** (rules are promoted from prior agent observations). Honestly
  `rules_not_threaded_into_digest`; auto-folds when rules exist.
- **Is the ≤6-live-run A+D confirmation unblocked?** ✅ **Yes, for impact** — the
  load-bearing lever for the hidden-pivot weakness (M55Z: hidden/non-traceback pivot
  edited only 2/13). Impact is now real in live Stage 5 injection. Memory/rules remain
  honestly unavailable in the SWE-bench setting and are **not** what the confirmation
  needs to test. Recommendation: **run the ≤6 A+D to test impact's effect**, with the
  explicit caveat that memory/rules are out of scope for SWE-bench workspaces.

## Data Boundary Findings

1. **Where Capsule v2 is built for Stage 5.** Via the external `vtrace query
   --capsule-engine v2` CLI, spawned as a **subprocess** from
   `prepareIndexedContext` → `runEngineQuery` (`runProc(spec.command, spec.args)`).
   The parent parses the subprocess stdout JSON into a `CapsuleV2Result`.
2. **Subprocess vs CLI.** Subprocess (separate `vtrace` CLI process). The capsule
   itself never runs in the Stage 5 process.
3. **Data serialized back.** Only the capsule `--json` payload (pivots, support,
   diagnostics, `actual_mode`, optional `pivot_neighborhood`). **No** impact graph,
   project rules, or memory — the capsule CLI does not compute them.
4. **repoRoot / DB / index available at the injection point?** **Yes.** The parent
   owns `workspace` (the cloned repo root) and the index it just built/reused at
   `path.join(workspace, ".vtrace", "index.sqlite")` (checked at line ~6242). This is
   the key enabler M56 did not exploit.
5. **Impact graph helpers callable there?** **Yes.** `openIndexerDatabase(dbPath)` +
   `getImpactGraph(db, { symbolFqn }, { repoRoot })` run in-process against that index.
   The capsule pivot `fq_name` equals the indexed `symbols.fq_name` (it flows from
   `candidate.fqName`), so `listSymbolsByFqName` resolves it.
6. **Rules/memory callable there?** **Yes** (`selectRelevantProjectRules`,
   `searchMemory`) — but they read the rule/observation stores, which a fresh
   SWE-bench workspace index does not populate (those come from agent sessions).
7. **Why M56 enriched MCP run_pipeline but not Stage 5.** `run_pipeline` is a single
   in-process orchestrator that already builds impact/memory/rules next to the
   capsule, so M56 folded them in directly. Stage 5's capsule arrives from a
   subprocess that returns *only* the capsule — M56 added the digest *plumbing* but
   never wired the parent's own DB access to compute the seams. M56B closes exactly
   that gap.

## Implementation

- **Strategy used: A** — build enrichments in the Stage 5 parent process from the
  already-built index, then thread them into the existing digest builder. The
  injected pivots/support stay byte-identical (same `CapsuleV2Result`); only the
  impact/memory/rule sections are *added*.

### Files changed

| File | Change |
| --- | --- |
| `src/impact/impactDigestSeam.ts` *(new)* | Shared pure `impactGraphToDigestSeam(graph)` — single impact→digest projection used by both MCP run_pipeline and Stage 5 (dedups M56's inline mapping). |
| `src/runPipeline/runPipelineOrchestrator.ts` | `deriveImpactDigestSeam` now calls the shared mapper (behavior-identical; M56 tests unchanged). |
| `benchmarks/.../run_stage5_vexp_swe_bench_smoke.ts` | New `buildStage5DigestEnrichments` (DB-backed impact/rules/memory seams) + `buildStage5DigestEnrichmentsBestEffort` (open/compute/close, never throws). `ClassifyCapsuleOptions.digestEnrichmentProvider` callback threaded into the digest build; `runEngineQuery` supplies a DB-backed provider when `--inject-capsule-digest` + v2. |
| `src/impact/impactDigestSeam.test.ts` *(new)* | +4 pure mapper tests. |
| `benchmarks/.../stage5_digest_enrichment.test.ts` *(new)* | +3 DB-backed tests (real impact from a fixture index; folds + drops warning; best-effort degrade). |
| `benchmarks/.../run_stage5_vexp_swe_bench_smoke.test.ts` | +2 provider-flow tests. |

### Enrichment shape

`buildStage5DigestEnrichments({ db, repoRoot, query, result, intent })` →
`InjectedDigestEnrichments { impact?, memory?, rules? }`:

- **impact**: top ≤3 pivots → first whose `fq_name` resolves to a dependent-bearing
  symbol → `impactGraphToDigestSeam` (≤3 representative rows, real snippets when the
  graph loaded them). Doc-heading pseudo-fqns (`path#heading`) skipped. Null if none
  resolve.
- **rules**: `selectRelevantProjectRules` active rules → ≤3 items. Null if none.
- **memory**: `searchMemory` durable matches → ≤3 stale-marked items, `sessionCount:0`
  (no Stage 5 vtrace session). Null if none.

### Digest rendering behavior

Unchanged from M56 — the seams flow through the same `toCapsuleV2ProductResponse` →
`buildInjectedCapsuleV2DigestBlock`. A supplied+available seam renders its section
and **drops** its `*_not_threaded_into_digest` warning; a null seam keeps the honest
warning. The sentinel block still appears exactly once.

### Warning behavior

Dynamic and honest: `impact_not_threaded_into_digest` disappears when impact is
actually threaded; `memory_*` / `rules_*` remain on a fresh SWE-bench index. No stale
warnings; no fabricated counts/snippets. The IO is isolated in the best-effort
provider — any failure degrades to `{}` (the pre-M56B warning-only digest), never
failing the run.

## Example Injected Digest

Real offline output — `buildCapsuleV2` + `buildStage5DigestEnrichments` +
`buildInjectedCapsuleV2DigestBlock` against an indexed `base ← alpha ← beta` fixture
(impact is genuine; memory/rules honestly warning-only):

```
<VTRACE_CAPSULE_V2_DIGEST_START>
# refactor the base function in src/base.ts
● pivot src/base.ts::base  [full ~67t]
    why: actionable function — in a likely edit file; lexical match; issue-domain relevance
● pivot src/alpha.ts::alpha  [full ~85t]
    why: actionable function — in a likely edit file; lexical match; issue-domain relevance; graph/import neighbour
○ skel src/beta.ts::beta  [signature ~17t]
    why: strong target but beyond the pivot budget — pivot: actionable function …
→ impact 2 dependents, 2 cross-file
    dependent src/alpha.ts::alpha L2-L4: function alpha(): string { return base(); }
    dependent src/beta.ts::beta L2-L4: function beta(): string { return alpha(); }
budget: 169/8000t (2.11%)
warnings: memory_not_threaded_into_digest, rules_not_threaded_into_digest
<VTRACE_CAPSULE_V2_DIGEST_END>
```

## Remaining Gaps

- **Per-edge call-site snippets.** The folded snippets are signature-window excerpts
  the impact graph attaches (real, useful), not the exact line where the dependent
  references the focal symbol. Pinpoint edge-site spans still need edge source-span
  extraction — unchanged from M56, out of scope here.
- **Memory in Stage 5.** Unavailable because a fresh SWE-bench workspace index has no
  observation store. Not faked, not invented. Would require seeding observations into
  the workspace index (a different milestone) — deliberately **not** done.
- **Rules in Stage 5.** Same: no project-rule store on a fresh index. Plumbing is
  live; data is absent honestly.
- **No larger architecture change needed for impact** — it works today via the
  parent's existing index handle.

## Validation Recommendation

**Ready for the ≤6-live-run A+D confirmation — to test impact specifically.**

Impact is now genuinely injected into Stage 5 live runs, which is the lever for the
M55Z hidden-pivot weakness. Memory and rules are honestly unavailable in the SWE-bench
workspace setting and are not what this confirmation should measure. Run the A+D with
impact as the treatment variable; do not expect (or require) memory/rules sections.
