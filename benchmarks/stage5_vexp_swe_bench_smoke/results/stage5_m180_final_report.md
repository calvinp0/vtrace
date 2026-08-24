# M180 — `productContext.items` evidence/metadata ownership

## The one-line finding

> `productContext.items` is the model-facing metadata the response envelope
> shrinks to fit a ceiling AND the index the orientation projector reads to decide
> what the agent is told. The envelope shrank it by deleting rows and left the
> rendering alone — so on **722 of 1,380** delivering budgets the response paid to
> ship evidence the projector could no longer reach, and a larger budget could
> deliver a smaller answer.

The repair gives the projector an authoritative supply published by the component
that owns the evidence budget. **722 → 0**, at zero serialized bytes.

## Reproduction (§20)

```text
historical M179 violations      83
reproduced under M180           83     (35 Broad100-A, 48 Broad100-B — exact)
identity control                169/169 pass
```

Attributed: **63** to `compactMandatoryProductMetadata`, **9** to the envelope
ladder's `productContext.items` rung, **11** to the evidence layer.

## The known positive (§22, §64)

`django__django-11133`, one frozen authoritative object, budget varied alone.

| max_tokens | rendered sections | items in response | related, before | related, after |
| ---: | ---: | ---: | ---: | ---: |
| 800 | 7 | 1 | 0 | **6** |
| 1,600 | 10 | 1 | 0 | **9** |
| 3,200 | 13 | 3 | 2 | **12** |
| 6,400 | 21 | 1 | 0 | **18** |
| 8,000 | 21 | 5 | 4 | **18** |

Same authoritative object, same ranking, same rendering, same `items` — only what
the projector reads changed. Before the repair the packet delivered *fewer*
related entries at 6,400 than at 3,200 while the response carried *more* evidence
at both. The counterfactual §64 asks for: the packet delivered at 3,200 is
derivable at 6,400 and 8,000 after the repair, and was not before, because
metadata compaction had removed the index rows it needed.

## The synthetic control (§25)

Sixteen items, no retrieval, no ranking, no upstream state:

| max_tokens | evidence layer | projector input | related |
| ---: | ---: | ---: | ---: |
| 800 | 7 | 3 | 2 |
| 1,600 | 16 | 4 | 3 |
| 3,200 | 16 | **3** | **2** |
| 8,000 | 16 | 16 | 15 |

`SEMANTIC_SUPPLY_MUTATED_BY_METADATA_LAYER`, with nothing else in the object.

## The ownership metric (§60)

```text
delivering budgets, both corpora                              1,380
budgets where the metadata layer changed the semantic
evidence source the projector CONSUMED
                                            before             722
                                            after                0
```

`productContext.items` is still cut on the same 722 budgets, and that is correct:
it is model-facing metadata and this module exists to shrink it. What changed is
that shrinking it no longer decides what the agent is told.

## The 83-case table (§82)

Two scorings, because M179's identity function and M180's preservation semantics
answer different questions. M180's were fixed in `m180Ownership.ts` before any
candidate existed, and fail in both directions.

| Violation class (M180 preservation semantics) | Before | After |
| --- | ---: | ---: |
| focus changed | 0 | 0 |
| related item lost | 54 | **8** |
| related item replaced / role changed | 0 | 106 |
| claim downgraded | 0 | **0** |
| orientation → decline | **0** | **0** |
| priority inversion | 0 | 0 |
| representation downgrade | 0 | 0 |
| qualifier evicted | 0 | 0 |
| **total** | **54** | **113** |
| *benign: claim upgraded* | 8 | 757 |
| *benign: focus resolved to the declared lead pivot* | 21 | 21 |

`54 + 29 benign = 83`, the reproduced count, accounted for pair by pair.

Under M179's raw `symbol|claim-wording` identity the after-count is **876**. That
is the identity function, not the product: the repaired arm delivers **10,203**
related entries across the same 1,380 packets where the pre-repair arm delivered
**2,016**, so five times as many claims are available to disagree about wording.
Every one of the 876 is a symbol that is present with a different authoritative
claim, or one of the 8 real losses.

## What the residual 113 are, verified rather than assumed

- **106** — `compactReasons` picks a *preferred* reason while the uncompacted path
  leaves `selectionReasons[0]` first, so which authoritative claim is reused
  depends on whether the evidence layer compacted. Of 10,203 delivered claims,
  **10,185 verbatim authoritative**, **18** an authoritative reason under the
  160-character ellipsis, **0 unsupported**, **0** about a symbol outside the
  supply. Nothing invented, nothing lost.
- **8** — `ORIENTATION_POLICY.ceilingTokens` is a flat 2,000 and the packet now
  reaches it, so a longer candidate list yields a shorter admitted prefix. M179's
  outstanding defect §2.

Neither is an ownership defect. §53 forbids forcing zero by widening scope.

## Gates

| Gate | Result |
| --- | --- |
| M179's `orientation → decline` correction (§55, §89) | **PRESERVED.** 0 before, 0 after, both corpora |
| totality (§56) | **PRESERVED.** 0 throws, 0 responses outside the envelope, 2,760 deliveries |
| truthfulness (§79) | **PRESERVED.** 0 orientations without a focus; 0 unsupported claims in 10,203 |
| default-budget response identity (§49) | **169/169 byte-identical** serialized |
| metadata still compacts (§62, §63, §88) | median 1,243 / 1,232 tokens → **1,243 / 1,232**, unchanged to the token; the same 722 budgets still eject item rows |
| retrieval / ranking / candidate order (§58) | **UNCHANGED**, hashed per case |
| fit contract (§57) | **UNCHANGED**; M178's names untouched |
| identity control (§24) | **169/169** |
| known negative (§23) | 2 of 169 cases are never cut, and both have **0** violations |
| focus displaced from the declared lead pivot | 3 → 3, unchanged; all three are evidence-layer, not ownership |
| `<module>` stays delivery-invisible (§45) | **PRESERVED.** 0 of 11,583 delivered entries name a module node; 0 authoritative items do either |

## Economics (§61, §80)

| | Broad100-A | Broad100-B |
| --- | ---: | ---: |
| packet tokens, median | 462 → **1,208** | 583 → **1,291** |
| packet tokens, p90 | 1,522 → 1,611 | 1,533 → 1,645 |
| packet tokens, max | 1,744 → 2,000 | 9,790 → 9,790 |
| metadata tokens, median | 1,243 → **1,243** | 1,232 → **1,232** |

Per budget, medians pooled over both corpora:

```text
max_tokens    100   200   400   600   800  1000  1200  1600  2000  3200  6400  8000
before       1331  1345  1526   293   258   254   248   248   256   367   719   769
after        1331  1345  1526   293   267   267   283   681  1002  1313  1488  1560
```

Unchanged to the token below 800; growth begins at 1,600, which is where the
collapse used to begin. Flagged under §61 and reported rather than smoothed: this
is a **+103% median at the default budget**, and it is the packet the orientation
contract always specified. `ENOUGH, THEN STOP` still holds — what ends a packet is
the authoritative supply running out, and the supply was being cut before it got
there — but the honest reading is that part of M172's measured 600-token median
was this defect. The packet remains bounded by the 2,000-token orientation ceiling
and four to five times cheaper than the 6,766–6,884 full response M171 measured.

## The repair

Three files, and the seam is a publication rather than a rewrite.

```text
src/productContext/semanticItemSupply.ts   NEW. A frozen, never-serialized record of
                                           what the evidence budget delivered, keyed
                                           on the productContext record's identity.
src/productContext/budgetDelivery.ts       +1 call: publish what `finish` delivered.
src/runPipeline/orientationProjection.ts   +1 line: read the published supply,
                                           falling back to productContext.items.
```

`compactMandatoryProductMetadata` and the envelope ladder are **untouched**. No
`productContextV2`, no `itemsV2`, no `run_pipeline_v2`. No response field added, no
schema change, no ceiling raised, no budget introduced. `git diff` over `src/`
against M179's close is three files.

Rejected: `C_PRESERVE_MINIMAL_INDEX`, which stops the rungs deleting rows and
reduces each row to the projector-relevant fields. It fixes the serialized
response too, and it costs **26 new `orientation → decline` pairs** — the class
M179 drove from 1,088 to 0 — because per-item rows measure 178 characters even
stripped and fourteen of them do not fit a 1,000-token allowance. See
`stage5_m180_candidate_decision.md`.

## The answers M180 was asked for

- **What is `productContext.items` supposed to represent?** Both an authoritative
  semantic supply and a model-facing metadata representation:
  `MIXED_RESPONSIBILITY`, with no type distinguishing their owners or lifetimes.
- **Was `compactMandatoryProductMetadata` authorized to change the semantic supply?**
  **No.** It owns serialized response metadata and nothing else.
- **Was the projector consuming an authoritative surface or a mutable one?** A
  mutable serialization surface — the output of `compactProductResponse`, which on
  the default path is then **discarded**, since `tools.ts` returns
  `orientation ?? decline ?? authoritativeResult`.
- **Where did the larger-budget path first lose evidence?** At
  `compactMandatoryProductMetadata` (`responseEnvelope.ts:744`), replacing the
  array with `[items[0]]`; and at the `enforceTotalEnvelope` rung
  `productContext.items` (`responseEnvelope.ts:2209`), `items.slice(0, kept)`.
  Both run after `applyProgressiveContextBudget`, which is monotone and whose
  `items` and rendering agree row for row.
- **Does a larger budget now preserve focus and related evidence?** For the
  ownership mechanism, yes: related-item loss 54 → 8, and the residual 8 are the
  projector's own flat ceiling. Focus: 0 changed, 21 resolved *toward* the declared
  lead pivot.
- **Can metadata still be compacted without changing evidence ownership?** Yes —
  identical metadata medians, same 722 budgets compacted, zero effect on the supply.
- **Did the repair disable compaction or cause refill?** No. Compaction is
  untouched. The packet grows only where the supply was being cut.
- **Does M179's 1,088 → 0 hold?** Yes, 0 on both corpora.
- **Does VTRACE keep repository evidence stable across delivery budgets?** For
  response bookkeeping, yes: no serialization operation can now alter what the
  agent is told. Two non-ownership mechanisms remain and are named. No live utility
  claim is made.

## Benchmark harness hygiene (§91)

```text
pre-existing benchmark typecheck defect
  run_stage5_m178_identity.ts:37 statically imported
  /home/calvin/bench/vtrace-m178/pre-split/src/impact/impactResponseEnvelope,
  a temporary detached worktree that no longer exists. Module resolution precedes
  every statement, so the existsSync guard already in main() could not protect it.
  Red since the worktree was removed; pre-existing at a4eee924.

repair
  loaded through a computed specifier inside main(), after the existing guard —
  the pattern M179's cross-checkout loader already uses.

product behaviour affected      NO   (no file under src/ in that commit)
historical M178 artifacts amended  NO
separate commit                 291c9c8dd439cce12114e89d50988434295578b9
```

## Verification

```text
bun run typecheck              0 errors
bun run typecheck:benchmarks   0 errors   (was 1, pre-existing; repaired above)
bun test                       5,518 pass / 49 skip / 0 fail   (5,567 across 352 files, 352s)
git diff --check               clean
```

M179 closed at 5,515 pass / 49 skip / 0 fail; the three added tests are M180's.

**Environmental, recorded rather than hidden (§93).** The full-suite run above was
taken at a load average of 20-22 under unrelated local work, against M179's 267s
baseline. It came back green, so no conclusion here rests on a saturated run
having *failed*; the subsets the repair can reach were also run in isolation —
`src/mcp`, `src/runPipeline`, `src/productContext` 338 pass / 30 skip / 0 fail.

The two M180 tests that pin the repair were verified to FAIL on the pre-M180
checkout and pass here:

```text
M180: response metadata compaction never decides what the projector sees
M180: more delivery budget never withdraws a related entry
```

A third, `M180: metadata compaction still shrinks the response`, passes on both
arms by design — it is the guard against fixing preservation by disabling
compaction.

## Method notes

- **Both arms in one process, on the same bytes.** `compactProductResponse` and
  `projectRunPipelineOrientation` are pure functions of a frozen authoritative
  object, so the pre-M180 checkout is imported by absolute path and called on the
  same in-memory object. M178 measured what any other method costs: 20 false
  differences in 1,016 cases, every one a specimen tipped by the decimal width of a
  timing float.
- **The candidate was never tuned.** `C_AUTHORITATIVE_SUPPLY_CHANNEL` was
  implemented once and not adjusted after any measurement; no parameter was fitted
  to either corpus. The gate that rejected the alternative — 26 new
  `orientation → decline` pairs — is decidable on Broad100-A alone (19 of the 26).
- **Preservation semantics were fixed before scoring** and are symmetric: a claim
  decaying to the roles fallback and a focus abandoning the declared lead pivot are
  violations, exactly as their reverses are benign. Measured: 0 claim downgrades.
- **Gold was not used to select anything** (§26, §37).

## Verdicts

```text
root cause        PROJECTOR_READS_MUTABLE_SERIALIZATION_SURFACE
ownership         SEMANTIC_AND_METADATA_OWNERSHIP_SEPARATED
preservation      BUDGET_MONOTONE_SEMANTIC_PRESERVATION_PARTIAL
repair            ITEM_OWNERSHIP_REPAIR_VALIDATED
product           KEEP_COMPACT_ORIENTATION_WITH_ITEM_OWNERSHIP_FIX
totality          RESPONSE_TOTALITY_PRESERVED
truthfulness      ORIENTATION_TRUTHFULNESS_PRESERVED
economics         COMPACT_ECONOMICS_MATERIALLY_CHANGED
next work         SEMANTIC_PRESERVATION_FOLLOWUP_REQUIRED
```

`PARTIAL` rather than `VALIDATED`, for the same reason M179 chose it: the
mechanism this milestone is named for is gone — the metadata layer no longer
reaches the projector's evidence on any of 1,380 budgets — and 114 ordered pairs
still fail the invariant through two mechanisms that belong to other components.
Claiming a validated invariant while they do would be the overstatement this
ledger exists to prevent.

`COMPACT_ECONOMICS_MATERIALLY_CHANGED` is deliberate too. The packet roughly
doubles at the default budget. That is the contract being honoured rather than
economics regressing, but it is a material change and calling it "preserved"
would be false.

## Scope note

Measured on the `run_pipeline` delivery path with `detail=standard`.
`get_impact_graph` has its own envelope and its own item handling and was not
swept here. No live agents, no Docker, no SWE-bench utility claim. Live spend
$0.00.

## Commits

```text
291c9c8dd439cce12114e89d50988434295578b9   benchmark harness hygiene (NON_PRODUCT)
e62cbe6eb4798ce4ba4be55ed337ce014fbd07ee   product
cb522c9c1636c34532f104d4915d2d4db8590553   evidence + ledger
47058f04ee189c82f49bb3fb64c4079817265957   M179 close, the state this began from
```

Product diff over `src/` against M179's close: three files plus one test file.
Not pushed.
