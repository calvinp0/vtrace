# Stage 5 M56 Digest Enrichment

Fold already-available **impact**, **memory**, and **rule** summaries into the same
agent-facing Capsule v2 digest block that Stage 5 injects and the MCP/product path
returns. Product/harness work only — no live agents, no Docker, no benchmark sweep,
no retrieval/scoring/ranking change.

## Summary

- **What was enriched.** The Capsule v2 product digest now answers the full VEXP
  question set, not just `●/○`:
  - `→ impact <N> dependents, <M> cross-file[, <C> callers]` plus up to 3
    representative dependent/caller rows, each with the **real** `path::symbol`,
    line range, and a genuine source-window snippet when one is available.
  - `◎ memory <S> session, <D> durable[, <K> stale]` plus up to 3 already-selected
    observations (stale-marked).
  - `◇ rule <R> active` plus up to 3 already-selected active project rules.
- **What remains warning-only.**
  - **Stage 5 live capsule path**: impact/memory/rules stay warning-only (Option C
    below) — the live path consumes the capsule CLI subprocess output and has no
    in-process DB handle to compute those sections. The warnings are now *dynamic*:
    a seam that IS supplied drops its `*_not_threaded_into_digest` warning, so the
    warning is never stale.
  - **`get_context_capsule`**: warning-only by design — it is a lean capsule-only
    tool that does not run the impact/memory/rules sections. Schema accepts the
    fields; the digest simply carries no impact/memory/rule lines for that tool.
- **Does Stage 5 get impact/memory/rules?** Plumbing yes, live data no (Option C):
  `buildInjectedCapsuleV2DigestBlock` now accepts optional seams and folds them when
  supplied; the default live capsule-only path supplies none, so behavior is
  byte-identical to M55W (all three not-threaded warnings, no fabricated lines).
- **Does MCP `run_pipeline` get impact/memory/rules?** **Yes — fully.** `run_pipeline`
  already builds all three sections; they are now derived into bounded seams and
  folded into `capsuleV2.digest` (and the `summary.impactCount/memoryCount/ruleCount`
  counts). Real per-caller snippets are included because the impact graph attaches
  signature-window source excerpts when `repoRoot` is supplied.
- **Does `get_context_capsule` get impact/memory/rules?** No (capsule-only tool;
  sections not computed there). Distinction made explicit here per the honesty rule.

## Implementation

### Files changed

| File | Change |
| --- | --- |
| `src/capsuleV2/productAdapter.ts` | Extended the three digest seams with optional rich fields (representative impact items + cross-file/caller counts; memory items + stale count; rule items). Added bounded block renderers (`renderImpactBlock`/`renderMemoryBlock`/`renderRulesBlock`) replacing the old count-only lines. Pure/deterministic; counts-only callers stay backward-compatible. |
| `src/runPipeline/runPipelineOrchestrator.ts` | Reordered so impact/memory/rules are computed **before** the Capsule v2 build, then derived into seams via new pure exported `deriveImpactDigestSeam`/`deriveMemoryDigestSeam`/`deriveRulesDigestSeam` and threaded into the single `toCapsuleV2ProductResponse` call. |
| `benchmarks/.../run_stage5_vexp_swe_bench_smoke.ts` | `buildInjectedCapsuleV2DigestBlock` accepts optional `InjectedDigestEnrichments`; the `*_not_threaded_into_digest` warnings became dynamic (emitted only for unsupplied seams). Default call site unchanged → identical injected context. |
| `src/capsuleV2/productAdapter.test.ts` | +8 tests for enriched rendering + honesty/determinism. |
| `src/runPipeline/runPipelineOrchestrator.test.ts` | +6 tests (end-to-end enriched digest, omit-when-absent, deriver-null cases). |
| `benchmarks/.../run_stage5_vexp_swe_bench_smoke.test.ts` | +3 tests (seam folds in + drops warning, partial-supply honesty, sentinel-once regression). |

### Adapter option shape

The seams stay optional and additive (every existing call compiles unchanged):

```ts
interface CapsuleV2DigestImpactSeam {
  dependentCount: number;
  crossFileDependentCount?: number;
  callerCount?: number;
  importerCount?: number;
  snippetsAvailable?: boolean;
  available?: boolean;
  representative?: CapsuleV2DigestImpactItem[]; // role/path/symbol/lineStart/lineEnd/snippet/snippetUnavailableReason/why
}
interface CapsuleV2DigestMemorySeam {
  sessionCount: number; durableCount: number; staleCount?: number;
  available?: boolean;
  items?: CapsuleV2DigestMemoryItem[];          // source/age/text/stale/why
}
interface CapsuleV2DigestRulesSeam {
  activeCount: number; available?: boolean;
  items?: CapsuleV2DigestRuleItem[];            // title/text/source/why
}
```

### Rendering behavior

- Counts always render from real section data. Representative rows are capped at 3
  per section; free text is collapsed to one line and truncated at 100 chars.
- An impact row renders `: <snippet>` **only** when a real snippet was supplied;
  otherwise it shows the bare real identity plus `why: likely co-edit / blast-radius
  check` — never an invented body.
- `available === false` renders an explicit `unavailable` line (and the adapter's
  existing `*_unavailable` warning), never a fabricated 0.

### Schema changes

None required. All rich detail lives inside the existing `digest` string; the
`summary.impactCount/memoryCount/ruleCount` integer fields were already present in
`CAPSULE_V2_PRODUCT_RESPONSE_SCHEMA` (M55) and are `additionalProperties:false`-safe.
MCP schema-validation tests pass unchanged.

### Stage 5 injection behavior

- Default (`--inject-capsule-digest` only): byte-identical to M55W — sentinel block
  with `● pivot`/`○ skel`/`budget:` and the three honest `*_not_threaded_into_digest`
  warnings.
- When a caller supplies a seam, that section folds into the digest and its
  not-threaded warning is dropped. The live capsule-only path supplies none.

## Example Digest

Real adapter output (synthetic inputs; django-10880-shaped):

```
<VTRACE_CAPSULE_V2_DIGEST_START>
# django-10880: Count with Case/When and distinct produces invalid SQL
● pivot django/db/models/aggregates.py::Count  [full ~120t]
    why: lexical match on Count + distinct
○ skel django/db/models/aggregates.py::Aggregate  [signature ~24t]
    why: graph neighbour of pivot
→ impact 9 dependents, 4 cross-file, 6 callers
    caller django/db/models/query.py::QuerySet.aggregate L398-L402: for alias, aggregate in aggregates.items():
    caller django/db/models/sql/query.py::Query.get_aggregation L441-L444: existing = self.annotations[alias]
◎ memory 1 session, 2 durable, 1 stale
    durable: 10880 edits aggregates.py (Count+distinct), not json_script/html.py
    session: confirmed the failing path is Count.as_sql with distinct=True
    durable [stale]: older note pointed at compiler.py — superseded
◇ rule 2 active
    co-edit: update the matching tests/aggregation test when changing Aggregate subclasses
    never hand-edit generated migration SQL; regenerate instead
budget: 612/8000t (7.65%)  saved≈5400t vs full-file
warnings: (none)
<VTRACE_CAPSULE_V2_DIGEST_END>
```

A real `run_pipeline` end-to-end digest (test fixture, `what is the impact of base`)
renders, e.g.:

```
→ impact 2 dependents, 2 cross-file
    dependent src/alpha.ts::alpha L2-L4: function alpha(): string { return base(); }
    dependent src/beta.ts::beta L2-L4: function beta(): string { return alpha(); }
```

## Honesty / Fallbacks

- **Never fabricated.** Impact rows carry only real graph identities; snippets are
  emitted only when the impact graph actually loaded a source excerpt. Memory/rule
  rows use only already-selected observations/rules — no new ranking introduced.
- **Unavailable.** `available === false` → explicit `→ impact unavailable` /
  `◎ memory unavailable` / `◇ rules unavailable` lines + `*_unavailable` warnings.
- **Stage 5 (Option C).** Live capsule-only path cannot compute these sections (no
  DB handle) → dynamic `impact_not_threaded_into_digest` / `memory_…` / `rules_…`
  warnings. Stale `impact_not_threaded_into_digest` is **dropped** whenever impact is
  actually threaded.
- **Existing warning names kept.** The codebase uses `impact_unavailable` /
  `memory_unavailable` / `rules_unavailable` (not the milestone's illustrative
  `*_not_available`); kept to avoid churning existing tests/consumers.
- **Future work.** The `run_pipeline` impact graph already attaches *signature-window*
  excerpts, which is what the digest folds. Exact per-edge call-site snippets (the
  precise line where the dependent references the focal symbol) still require edge
  source-span extraction — noted as residual, not implemented here.

## Tests

Added/updated (all pass):

- Adapter: representative impact rows + cross-file/caller counts; summary-only suffix
  when no snippets; memory items + stale marker/count; rule items; warnings honest
  when unavailable; warnings disappear when threaded+available; enriched digest stays
  deterministic.
- Orchestrator: end-to-end enriched `→ impact` digest with real caller rows; no
  impact line when the query doesn't request impact; rules folded when surfaced;
  deriver-null cases for not-included impact / empty memory / no active rules.
- Stage 5: supplied seam folds in and drops its warning; partial-supply keeps honest
  warnings for unthreaded sections; **regression: digest sentinel appears exactly
  once** under `--inject-capsule-digest`.

### Verification results

```
bun run typecheck            → OK
bun run typecheck:benchmarks → OK
bun test                     → 3048 pass, 0 fail (180 files)
git diff --check             → clean
```

No retrieval eval required: retrieval/scoring/ranking/candidate generation untouched
(the orchestrator change is a build-order reorder + digest-only derivation).

## Next Recommended Validation

A small **≤6-live-run A+D confirmation** (3 digest-enriched + 3 baseline) on a few
mixed-difficulty cases, to confirm the now-load-bearing impact/memory/rule lines move
agent behavior (fewer redundant dependency reads / co-edit checks) without token
regression — to be run **after** this commit, not now.
