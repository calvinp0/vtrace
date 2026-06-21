# Stage 5 M61 Atomic Digest/Contract Truncation

## Summary

- **What caused the M60B invalid run.** The Stage 5 injected context is reduced to a
  12,000-char budget by `truncateContextByPriority` (M45 section-priority truncation).
  That reducer parses the rendered text into `## `/`●` sections but is **blind to the
  sentinel-delimited digest and decision-contract blocks**. When the essential-tier
  content exceeds the budget it falls into a section-blind head-preserving slice
  (`legacy_slice_fallback`: `rebuilt.slice(0, cut)`), which can cut **through** a
  sentinel block and evict the `…CONTRACT_END` sentinel — leaving a dangling
  `…CONTRACT_START` with no END. The strict four-sentinel validator (`parseDigestDecisionContract`,
  both sentinels required) then reports the contract absent ⇒ the treatment run is invalid.
- **Strategy used.** A hybrid of Strategy A (atomic section model) + Strategy C
  (compact-before-slice): `truncateContextByPriority` gained an opt-in `atomicBlocks`
  option. When the digest/contract sentinels are present, those spans are **reserved
  whole**, and only the surrounding *free* content is reduced (via the existing,
  unchanged M45 reducer). The invariant — a sentinel block is **either fully present or
  fully absent with an explicit omission marker** — holds by construction, never by
  post-hoc repair. The strict four-sentinel validity check is **unchanged** (not weakened).
- **Does pylint-8898 pre-flight now pass?** Partially, and the honest answer is
  instructive (see Regression). The injected context for pylint-8898 is
  `digest = 9,937 chars` + `contract = 2,866 chars` = **12,803 chars**, which **alone
  exceeds the 12,000-char budget** (the free render adds a further ~11,853). No amount of
  lower-priority eviction can make both blocks fit at 12k. The fix therefore **fails
  closed**: it preserves the digest whole and emits an explicit
  `VTRACE_STRUCTURED_CONTRACT_OMITTED_DUE_TO_BUDGET (digest_decision_contract)` marker
  for the contract — **no partial sentinel**, telemetry records the omission. This is the
  spec's prescribed failure behavior. The old path silently corrupted the block; the new
  path makes the over-budget condition explicit and detectable.
- **Did default behavior change?** No. Without `atomicBlocks` (or when no sentinels are
  present in the text) `truncateContextByPriority` runs the original code path byte-for-byte.
  A budget sweep test asserts byte-identical output with and without the option on
  non-digest text. Full suite: 3112 pass / 0 fail.
- **Is future breadth validation unblocked?** For the **common case** — where the digest
  + contract fit within budget and the bloat is the lower-priority duplicate render /
  neighborhood — **yes**: both blocks are now preserved atomically by evicting that free
  content first. **pylint-8898 specifically** remains over-budget on the two atomic blocks
  alone; it needs a separate digest-compaction follow-up (or treatment-specific headroom)
  before it can be a *valid* treatment run, but it can no longer silently corrupt the run.

## Truncation Path Findings

- **Assembly point.** `run_stage5_vexp_swe_bench_smoke.ts:4836` (`classifyCapsuleV2Output`):
  `context = [digestBlock, decisionContractBlock, inspectFirstPart, rendered, neighborhoodText]
  .join("\n\n")`. The digest is first, the contract second, then the lower-priority
  duplicate human render + neighborhood. This per-instance `rawContext` is what gets truncated.
- **Truncation point.** `buildVtraceContextMarkdown` (`run_stage5_vexp_swe_bench_smoke.ts:~6172`)
  calls `truncateContextByPriority(section.rawContext, limits.maxChars)` for preformatted
  (Capsule v2) sections. `limits.maxChars` defaults to **12,000**
  (`DEFAULT_CONFIG.vtraceContextMaxChars`). The PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY
  safety blocks are appended **after** this truncation, so they are never at risk from it.
- **Section priority behavior.** `src/capsuleV2/sectionBudgetAccounting.ts`:
  `inventorySections` re-parses the rendered text into `{name, kind, priority, startChar,
  chars}` sections; `classifyHeading` assigns `essential|important|optional|diagnostic`;
  `●/○` item bodies are forced `essential`. `truncateContextByPriority` drops whole
  non-essential sections (diagnostic → optional → important, largest-first), and only if
  the essentials alone still exceed the budget does it head-slice (`legacy_slice_fallback`).
- **`essentialSectionsEvicted` explanation.** Set in the `legacy_slice_fallback` branch
  (`sectionBudgetAccounting.ts:~389`): `true` when the head-slice cut into a section
  classified `essential` (real code evidence lost). Surfaced in the `vtraceContextBudget`
  telemetry on `_run.meta.json`. M60B observed it `true` for pylint-8898 — the symptom of
  the section-blind tail clip.
- **Why the END sentinel was lost.** The contract block is **not** a `## `/`●` section,
  so the reducer never modeled it as a unit. With the digest (~9.9k) ahead of it, the
  contract END sentinel sat past the 12k cut; the head-preserving slice kept the contract
  START but dropped its END.
- **Atomic vs concatenated.** Before M61 the digest/contract were **raw concatenated
  text** with no section identity — invisible to the priority model. M61 represents them
  as **atomic locked spans** (located by sentinel pair) that are reserved before any
  section processing.
- **Lower-priority sections evicted first.** The duplicate `renderCapsuleV2Human` source
  render, pivot-neighborhood excerpts, optional advisories, and long focused source bodies
  — all of which live in the *free* region after the two atomic blocks — are reduced by
  the standard M45 reducer before the atomic blocks are ever touched.

## Implementation

- **Files changed.**
  - `src/capsuleV2/sectionBudgetAccounting.ts` — added `AtomicSentinelBlockSpec`,
    `TruncateByPriorityOptions`, `STRUCTURED_CONTRACT_OMITTED_MARKER`; extended
    `VtraceContextBudget` with new `truncationMode` values (`atomic_section_priority`,
    `atomic_legacy_slice`, `atomic_omitted`) and optional `atomicBlocksPreserved` /
    `atomicBlocksOmitted`; added an `options` param to `truncateContextByPriority` that
    branches to `truncatePreservingAtomicBlocks` when sentinel blocks are present; the
    original reducer body is preserved unchanged as the internal `truncateContextByPriorityCore`.
  - `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts` — defined
    `STAGE5_ATOMIC_SENTINEL_BLOCKS` (the digest + decision-contract sentinel specs);
    pass it to `truncateContextByPriority` at the preformatted-section call site; extended
    `aggregateContextBudgets` to surface the atomic modes + telemetry.
  - `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m60_preflight.ts` — additively
    applies the 12k truncation and re-validates the four sentinels on the **truncated**
    context (so the pre-flight checks what the agent actually receives).
- **Atomic section behavior.** Sentinel blocks are located by `START…END` pair, reserved
  as whole spans, and emitted verbatim. The free content between/around them is reduced
  with the existing M45 reducer. Concatenating the segments reproduces the text exactly.
- **Priority policy.** Atomic blocks (digest, contract) outrank everything; the free
  duplicate render / neighborhood / advisories are shed first (diagnostic → optional →
  important → essential-source, then a head-clip of the free remainder if still over).
  Whitespace-only separators between blocks are kept verbatim.
- **Failure behavior if a block cannot fit.** If the atomic blocks alone exceed the
  budget, the reducer keeps blocks greedily in order until the budget is exhausted and
  replaces each block that cannot fit with `VTRACE_STRUCTURED_CONTRACT_OMITTED_DUE_TO_BUDGET
  (<label>)` — **never** a partial sentinel pair — recording the label in
  `budget.atomicBlocksOmitted`. `truncationMode = "atomic_omitted"`.

## Regression

- **pylint-8898 offline result (real persisted index, no agent / no Docker).** Ran the
  enhanced `run_stage5_m60_preflight.ts` against
  `results/workspaces/m60_structured_bounded_pylint_8898/pylint-dev__pylint-8898` (the
  local `vtrace query` capsule CLI + in-process classify + the 12k truncation):
  - Untruncated build: digest sentinel ✓, contract sentinel ✓, structured grammar ✓,
    bounded three-way ✓, 4 required targets, compact applied ✓.
  - **Block sizes:** digest = **9,937** chars, contract = **2,866** chars,
    `digest+contract = 12,803` chars > 12,000 budget; free render = 11,853 chars; total
    24,656 chars.
  - Post-truncation: `truncationMode = atomic_omitted`,
    `atomicBlocksPreserved = ["capsule_v2_digest"]`,
    `atomicBlocksOmitted = ["digest_decision_contract"]`. Digest START/END present exactly
    once; **no dangling contract sentinel** (START and END both absent — the block is
    cleanly omitted with the explicit marker, not split). `post_truncation_contract_present
    = false`.
  - **Interpretation.** The atomic fix removes the silent-corruption failure mode for
    pylint (no more partial sentinel). But pylint's two atomic blocks alone exceed 12k, so
    they cannot both be preserved at the default budget — the run fails closed and is
    correctly, *explicitly* invalid. This contradicts the task's assumption that
    lower-priority eviction would suffice for pylint; it is a genuine content-budget
    overflow, not a truncation-ordering bug.
- **Synthetic tight-budget result.** Added a synthetic reproduction (`M61-1`) where a
  large digest pushes the contract END past the cut: the legacy core path produces a
  dangling contract START (the bug), while the atomic path fails closed with the explicit
  marker and **no partial sentinel**. A preservation test (`M61-2`) proves the common case
  — digest + contract fit, the large free render is evicted, both blocks survive whole and
  the strict parser confirms the contract present. An invariant sweep (`M61-4`) asserts
  **no budget** ever yields a partial sentinel pair.
- **Sentinel validity before/after.**
  - Before (legacy core, mid-contract budget): `CONTRACT_START` present, `CONTRACT_END`
    evicted → partial pair → `parseDigestDecisionContract.present = false` (silent corruption).
  - After (atomic path, blocks fit): both pairs present exactly once → `present = true`.
  - After (atomic path, blocks don't fit — pylint): contract cleanly omitted + explicit
    marker → `present = false`, but **detectable** via `atomicBlocksOmitted` and never a
    dangling sentinel.

## Tests

- **Added** (`src/capsuleV2/sectionBudgetAccounting.test.ts`, M61 suite, 7 tests):
  - `M61-1` legacy core clips the contract END; atomic path never leaves a partial sentinel.
  - `M61-2` structured bounded treatment preserves BOTH blocks under a tight budget.
  - `M61-3` lower-priority free render is evicted before the digest/contract blocks.
  - `M61-4` no budget ever produces a partial digest or contract sentinel pair (sweep).
  - `M61-5` a registered safety block is preserved atomically alongside digest/contract.
  - `M61-6` without `atomicBlocks` (or with none present) truncation is byte-identical
    (incl. a glyph-only text that must NOT activate the atomic path).
  - `M61-7` when everything fits, atomic blocks are reported preserved, text unchanged.
- **Added** (`benchmarks/.../digest_decision_contract_injection.test.ts`, 2 tests):
  - the REAL structured-bounded `classifyCapsuleOutput` context keeps both sentinel blocks
    under a tight truncation budget (strict four-sentinel validity on the truncated text);
  - a budget below the atomic floor fails CLOSED — no partial sentinel pair, omission reported.
- **Updated** (`run_stage5_m60_preflight.ts`): applies the 12k truncation and re-validates
  the four sentinels on the truncated context (reuses the existing pre-flight helper rather
  than adding a parallel harness).
- **Verification results.** `bun run typecheck` ✓, `bun run typecheck:benchmarks` ✓,
  `bun test` → **3112 pass / 0 fail** (184 files), `git diff --check` clean. The existing
  23 `sectionBudgetAccounting` tests (incl. the `legacy_slice_fallback` assertion) and the
  7 prior digest-contract injection tests still pass unchanged.

## Next Recommendation

**proceed to a small no-live pre-flight replay over all M60 selected cases.**

Rationale: the atomic-truncation fix is correct and universal — it eliminates the silent
partial-sentinel failure mode for every case, and for any case whose digest + contract fit
within the 12k budget it now preserves both by evicting lower-priority context first
(unblocking breadth validation for the common case). A no-live replay of the 15 M60
selected cases through the enhanced `run_stage5_m60_preflight.ts` (post-truncation
validation) is the cheap way to confirm: (a) how many cases actually truncate, (b) that
none regress to a partial sentinel, and (c) that pylint-8898 is the sole over-budget
outlier. pylint-8898 itself is **not yet a valid treatment run at 12k** (digest + contract
= 12,803 > 12,000); that requires a separate, scoped follow-up — compacting the digest's
lowest-priority internal content, or granting the bounded, deterministic digest + contract
a small atomic headroom — and is explicitly out of scope here (non-goals: no global budget
bump as the primary fix, no single-case tuning). It should not block the broader M60C
confirmation for the cases that fit.
