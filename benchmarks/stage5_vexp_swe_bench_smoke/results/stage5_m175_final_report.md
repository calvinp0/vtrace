# M175 — Orientation Envelope Input-Echo Elimination and Evidence-Budget Correctness

```text
M175 overall:  PASS

A: PASS   request/query authority and consumer audit
B: PASS   echo attribution and pathology reproduction
C: PASS   minimal request-identity projection, frozen before any holdout
D: PASS   product repair
E: PASS   Broad100-A / Broad100-B evidence-budget qualification
F: PASS   closure

defect verdict:           REQUEST_ECHO_EVICTION_CONFIRMED
repair verdict:           MINIMAL_REQUEST_DISCLOSURE_REPAIR_VALIDATED
evidence-budget verdict:  EVIDENCE_BUDGET_REALLOCATED_TO_REPOSITORY_EVIDENCE
product verdict:          KEEP_COMPACT_ORIENTATION_WITH_REQUEST_ECHO_FIX

product changed:    YES — model-facing request disclosure only
retrieval changed:  NO
live spend:         $0.00
live work:          NOT RUN
```

## What was wrong

`compactProductResponse` reduces or drops every large field in a response except
one. That one was `request`, exempt by an explicit rule
(`responseEnvelope.ts:1288`): *"`request` echoes the caller's own input verbatim and
is a correctness surface, so it is never rewritten."*

The exemption is sound for a field somebody reads. M175-A went looking for the
readers.

- `request.task` is assigned `orchestration.request.query` at
  `formatRunPipelineOutput.ts:211` — the same string under a second key, **identical
  in 199 of 199 captured responses**.
- **Zero** product consumers read the shipped block. The only readers anywhere in the
  repository are two assertions in `mcp.test.ts`, both at `detail="debug"`, and a
  benchmark analyzer that counts it *as* duplication.
- Every consumer of the request *text* reads the pipeline's **input** record
  server-side — retrieval, routing, capsule and memory hashing, intent derivation.
  None reads the response.

So the one field the ladder could not touch was the question the agent had just
asked, carried twice, and when the ceiling bound, the only thing left to evict was
the repository evidence.

## Required answers

**§79 — what must be retained internally, and what must be sent back?**

Internally, everything: raw task, normalized task, retrieval query, task and query
hashes, intent derivation, retrieval provenance. Fourteen call sites consume the
input record and all of them still do.

Model-facing, in the default response: **none of the prose.** There is no derived
query to disclose — in this path the retrieval query *is* the task string, so §21's
"search focus" line would restate rather than inform. `detail=debug` returns the
request whole.

**§80 — was the empty delivery caused by evidence losing a budget competition to
redundant restatement?**

Yes. From the envelope's own accounting on M174's default-path capture:

```text
evidence the packer had ready         3,731 tokens
metadata after every legal reduction  6,435 tokens
                                     ──────────────
                                     10,166 vs a 9,200 ceiling
deficit the ladder could not close      966 tokens

removing the duplicate copy alone     2,544 tokens   ← 2.6x the deficit
removing all verbatim request prose   5,087 tokens   ← 5.3x the deficit
```

The echo was 78.5% of that response. The ladder had nothing else to give up, so it
deleted ten retrieved items and advised the caller to raise `max_tokens`.

**§81 — does the same envelope now carry materially more repository intelligence?**

Yes, and the request block's cost is now **constant** rather than a function of the
question: a median of 617.5 → 65 tokens on Broad100-A and 848.5 → 65 on Broad100-B,
with the maximum falling from 12,430 → 65.

**§82 — does this move VTRACE toward a VEXP-class first-orientation packet?**

Directionally yes, and the honest version is narrower than it sounds. M172 had
already removed the request block from the model-facing packet entirely, so the
packet was already ~100% repository evidence. What M175 fixes is that the
restatement still decided *whether the packet got any evidence at all*. No benchmark
parity is claimed.

## The known-positive, closed

| Metric | Before | After |
|---|---:|---:|
| retrieval items | 10 | 10 |
| selected evidence items | 10 | 10 |
| delivered evidence items | **0** | **4** (focus + 3 related) |
| pivot available | yes | yes |
| pivot delivered | **no** | **yes** |
| request/task chars | 20,346 | 85 |
| request/task tokens | 5,087 | 21 |
| repository evidence tokens | 0 delivered | 451 |
| total packet tokens | 143 | 451 |
| delivery failure | **yes** | no |
| fallback | decline projector | none |
| gold file delivered | no | **yes** |
| gold symbol delivered | no | **yes** |

The focus after the repair is `lib/matplotlib/axis.py::Axis.convert_units` — the
identical lead pivot M174 recorded as correct and undelivered.

## Corpus results

| Metric | A before | A after | B before | B after |
|---|---:|---:|---:|---:|
| valid cases | 100 | 100 | 98 | 98 |
| median orientation tokens | 587.5 | 607 | 599.5 | 627.5 |
| request-restatement, median tokens | 617.5 | **65** | 848.5 | **65** |
| request-restatement, max tokens | 5,133 | **65** | 12,430 | **65** |
| request share of ceiling >25% | 4 | 0 | 9 | 0 |
| evidence density of packet | 100% | 100% | 100% | 100% |
| packets delivered | 99 | **100** | 94 | **96** |
| related items delivered | 464 | **514** | 396 | **476** |
| gold file delivered | 66 | **67** | 53 | **55** |
| gold symbol delivered | 43 | **45** | 33 | **36** |
| delivery failures | 1 | **0** | 4 | **2** |
| all-evidence evictions | 1 | 0 | 2 | 0 |
| focus changed | — | **0** | — | **0** |
| evidence reduced on any case | — | **0** | — | **0** |

Two workspaces in Broad100-B have empty indexes and refuse identically in both arms;
they are excluded from every denominator.

## The harsher failure mode, found on the corpus

Broad100-B's two longest questions (24,770 and 22,778 characters) did not merely lose
their evidence. The request block alone exceeded the ceiling, so the response could
not be assembled even with the evidence deleted: `compactProductResponse` threw
`product_response_envelope_unreachable` and `run_pipeline` returned `handler_failed`
with no response at all. Both return working orientation packets after the repair.

This is why the repair had to make the cost **constant** rather than merely smaller.
Anything unbounded in the caller's input eventually exceeds any fixed ceiling, and a
budget-triggered rung cannot help once the field alone is over the bound.

## Standing findings

- **The exemption protected nothing, and cost the product its evidence.** A field
  declared a correctness surface had two readers, both tests, both at
  `detail=debug`. Before calling a field a correctness surface, find the code that
  reads it — that audit is the transferable part of this milestone.

- **`request.task` was never a second concept.** One assignment, one string,
  identical in 199 of 199 captures. The response paid twice for it, and the envelope
  already deduplicated three *smaller* copies into `@request.task` while exempting
  the two largest.

- **The obvious instrument does not work here, and the reason is worth keeping.**
  Replaying compaction over one snapshot would isolate policies perfectly. It cannot
  be done: compaction runs before any response is observable, so a capture at the
  product's budget is already the wreck — `productContext.items` arrives empty.
  Capturing above the ceiling keeps the evidence but `max_tokens` feeds
  `budgetTokens` (`tools.ts:9189`) as well as `requestedContextTokens`
  (`tools.ts:9255`), so a wider capture **selects differently** — 24 items at
  120,000 against 10 at 8,000. Measured, rejected, and replaced by two checkouts
  answering against one corpus and one index.

- **Evidence yields to the budget; the echo did not.** The control that mattered most
  is the one that found nothing: 144,000 characters of evidence beside a 90-character
  request delivers fine, because the progressive packer shrinks evidence to fit. A
  large evidence supply never evicts itself. The echo was the only metadata that
  could not be made smaller — which is what made a narrow claim provable rather than
  a plausible story about big responses.

- **The prevalence is a tail, and the report should not oversell it.** The request
  block exceeded 25% of the ceiling on 4 of 100 Broad100-A cases and 9 of 98
  Broad100-B cases. Three responses in 198 went from unusable to usable; 48 more
  gained evidence; the remaining 147 are unchanged. This is correctness work, not a
  treatment difference.

- **Nothing regressed, on any measure available.** Focus unchanged on all 193
  delivered packets; every after-packet a superset of its before-packet; zero cases
  lost evidence; zero cases lost delivery. Retrieval unreachable from the change
  across a 153-module import closure, index fingerprints unmoved.

- **Next-step recommendation: no live work, and one lead worth taking.** §83's test is
  whether the fix changes normal packets or only rare pathological ones, and the
  answer is the latter — 147 of 198 responses are byte-identical. Requalifying an
  agent against that would buy precision about a null, and M174 already showed the
  packet is causally inert on outcomes. The lead is what this uncovered rather than
  fixed: **`product_response_envelope_unreachable` is a reachable crash on ordinary
  input.** M175 removed the largest field that reached it; the throw remains, and any
  sufficiently large irreducible field still finds it. A response that cannot be made
  to fit should degrade to a truthful non-answer, not fail the call.

## Verification

```text
bun run typecheck              exit 0
bun run typecheck:benchmarks   exit 0
bun test                       5488 pass, 49 skip, 0 fail (5537 tests, 352 files)
git diff --check               clean
```

Six new tests in `src/mcp/responseEnvelope.test.ts`; four fail with the repair
disabled, verified by disabling it and re-running.
