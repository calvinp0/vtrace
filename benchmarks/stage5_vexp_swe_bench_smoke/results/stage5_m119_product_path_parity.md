# Stage 5 M119 Unified Product Context Response

Date: 2026-07-22

## Summary

- Previous product divergence: `run_pipeline(capsule_engine=v2)` was the richest
  path, `get_code_context` inherited it only through delegation, and
  `get_context_capsule` had a separate weaker envelope. There was no single
  authoritative model-visible render or cross-tool accounting contract.
- Unified response: all three single-repository paths now add the same
  `productContext` response-version-2 contract assembled by
  `src/productContext/assembleProductContext.ts`.
- Accounting: the used estimate measures the final deduplicated render; the naive
  baseline is the full content of each unique selected source file.
- Timing: freshness, capsule build, bounded impact, memory/rules, rendering,
  optional index refresh, and total monotonic wall time are visible.
- Skeleton/impact/memory behavior: supports use parser-backed structural data with
  explicit fallbacks; impact is capped static graph evidence; only relevant fresh
  memory and active rules are attached.
- Verdict: **PASS**.
- Recommendation: **promote unified response**.

## Pre-change Audit

The complete 44-question pre-change audit is in
`stage5_m119_product_path_parity_plan.md`. MCP definitions and handlers are in
`src/mcp/tools.ts`; the Capsule v2 builder is
`src/capsuleV2/buildCapsuleV2.ts`; the former wrapper accounting is
`src/metrics/contextAccounting.ts`; worktree freshness is implemented by
`src/indexer/worktreeIndexFreshness.ts`; structural data comes from
`src/db/repositories/symbolsRepository.ts` and `src/services/getSkeleton.ts`.

Before M119, `run_pipeline(capsule_engine=v2)` was strongest because it combined
v1 orchestration, Capsule v2, impact, memory, rules, neighborhoods, diagnostics,
and wrapper accounting. `get_context_capsule` independently built a smaller
capsule envelope. Task aliases, freshness, no-context behavior, and accounting
were inconsistent. Existing outer fields, manifests, `digest`, legacy
`accounting`, and default v1 semantics are compatibility constraints and remain
available.

## Shared Response Architecture

`ProductContextResponse` is defined in `src/productContext/types.ts` and emitted
under the additive `productContext` field. The shared assembler owns Capsule v2
selection projection, role normalization, stable IDs, parser-backed compression,
body deduplication, bounded evidence, knowledge attachment, rendering,
accounting, timing, and diagnostics. The outer tools may still differ, but they no
longer maintain separate normalized product responses.

Items carry deterministic display and stable IDs, repository-relative path,
symbol/section identity, one or more roles, content mode, selection reasons, line
span where indexed, approximate tokens, and bounded metadata. Roles are `pivot`,
`required`, `support`, `skeleton`, `impact`, `memory`, `rule`, and
`documentation`. M112/M113 actionability survives in required-item metadata;
optional supports are not promoted. Existing fields are preserved rather than
renamed or reinterpreted.

## Token Accounting

`renderedCharacters` measures exactly `modelVisibleContext.length` and
`usedTokensEstimate` is `ceil(renderedCharacters / 4)`. Provenance is
`character_ratio`; `estimateExact` is `false`. The budget and remaining estimate
use the same approximation without claiming tokenizer or provider precision.

The canonical naive baseline reads the full source of every unique selected file
before pivot/support compression. It excludes duplicate inclusion and generated
metadata. It is neither the entire repository nor provider-billed input. If any
selected source cannot be safely read, or context is unresolved, the baseline and
savings are null. Saved tokens equal naive minus used and may be negative for tiny
fixtures; no zero clamp or artificial 100% saving is applied.

Role merging and exact-content deduplication render each body once. The Python
impact/docs smoke suppressed approximately 23 duplicate tokens. The main mixed
fixture removed no duplicate body because its multi-role records were already
merged before rendering.

## Structural Context

Pivots retain focused/full implementation source, indexed line span, primary
symbol, selection evidence, and token estimate. Required records distinguish lead
pivots and actionability sources such as hidden/anchored targets, high-confidence
co-edits, import/re-export rescue, and file-evidence rescue.

Supports prefer an indexed structural skeleton containing kind, signature,
return type when recoverable from the signature, docstring summary, line span,
and public/exported state. Fallback order is structural skeleton, signature,
bounded indexed excerpt, then metadata only; fallback mode is explicit. Python
functions/classes and TypeScript functions are exercised by focused tests and the
smoke. Markdown sections are separate documentation items and bounded independently.

## Impact and Project Knowledge

Impact uses existing indexed graph edges only. It is capped at two impacted
pivots, six edges per pivot, ten total items, and 2,400 rendered characters. Items
report edge type, source symbol/path/span, depth, and evidence availability, and
are labelled static structural evidence rather than execution flow. The Python
smoke emitted three impact items.

Memory selection reuses observation relevance plus staleness checks and excludes
self-echo auto-captures; rules reuse active project-rule selection. Both are capped
at three items and are honestly empty when nothing relevant exists. The mixed
fixture included one fresh memory and one active rule. Stale and irrelevant items
remain excluded.

## Worktree and Index Integration

Repository root, repository ID, worktree ID, HEAD, branch/detached state, index
run ID, index mode, and M114 freshness status/reason/action are present. Default
`auto_refresh` remains `never`. A stale response is unresolved with zero rendered
tokens and null naive/savings fields.

When `get_code_context(auto_refresh="if_stale")` refreshed the mixed fixture,
the response preserved M118 diagnostics and reported `indexMode=incremental` plus
`indexRefreshMs=22.7`. The linked-worktree case produced a distinct worktree ID
and did not mutate the source worktree index. The current VTRACE checkout was
inspected read-only and failed closed on its pre-existing `manifest_invalid`
state; it was not refreshed.

## Cross-Tool Parity

The same fresh mixed repository, task, `modify` intent, and 8,000-token budget was
sent to `get_code_context`, `get_context_capsule`, and `run_pipeline`. All three
matched on task hash, intent, `standard` capsule mode, lead pivot, selected-file
hash, stable item identities and roles, character-ratio estimator, repository ID,
worktree ID, HEAD, and freshness.

Each path selected two pivots, three required items, five supports, and four
skeletons. Each rendered 2,882 characters (~721 tokens) against a ~1,671-token
unique-full-file baseline: ~950 tokens saved, or 56.85% estimated compression.
Outer wrappers and elapsed timings differed as allowed. Parity result: **PASS**.

## No-Agent Product Smoke

`run_stage5_m119_product_path_smoke.ts` ran ten offline cases: a Python-heavy
multi-file impact/docs fixture, high-confidence co-edit fixture, no-context
fixture, all three tool paths on a mixed TypeScript/Python/Markdown repository,
stale index, incremental auto-refresh, linked worktree, and read-only VTRACE
preflight. It created no agent, called no model/API, ran no Docker, and ran no
VEXP arm.

The mixed tool cases estimated 56.85% compression; the linked worktree estimated
61.28%; incremental refresh estimated 61.30%. Tiny synthetic Python/co-edit
fixtures were intentionally honest negative reductions because their structured
metadata exceeded their very small full files. No-context and stale cases used
null baselines/savings. All component durations were nonnegative and total time
was at least every major measured component. Smoke result: **PASS (10 cases,
cross-tool parity true)**.

## Invariants

Focused integration assertions preserve task hash, Capsule v2 actual mode, lead
pivot, selected-file identities/order, and required/support assignments across
the three paths. M112 action metadata, M113 guidance, M114 identity/freshness, and
M118 refresh diagnostics remain additive. No candidate generator, scorer, pivot
selector, co-edit selector, task derivation algorithm, E1-v2 code, or graph
mutation strategy changed. Because these selection identities remained equal,
the broad retrieval evaluations were not run.

Leakage tests reject `FAIL_TO_PASS`, `PASS_TO_PASS`, gold-file, and benchmark
scoring metadata in model-visible context.

## Deferred Work

- richer static impact/flow presentation in M120;
- cross-repository workspace product assembly;
- tokenizer-exact or provider-reported accounting;
- an internal retrieval timing seam (the current builder is synchronous, so its
  undivided time is attributed to capsule build and retrieval is honestly zero);
- public benchmark work.

## Success Criteria Check

All 18 PASS criteria are satisfied: one shared assembler; cross-tool task,
selection, role, and worktree parity; explicit pivot/required/support roles;
parser-backed skeletons; final-render accounting; unique-file baseline;
consistent arithmetic and estimator provenance; measured body suppression;
monotonic total/stage latency; bounded real graph evidence; relevant fresh or
empty project knowledge; preserved M114/M118 behavior; unchanged selection;
leakage rejection; no live spend; and passing requested verification.

## Verdict

**PASS**

## Recommendation

**promote unified response**
