# M153-C4 — candidate propagation audit

**Question.** Given an already-admitted, subject-aligned behavioural owner, what
exact condition determines whether it becomes an ordinary retrieval candidate —
and why does `Session.get_adapter` satisfy it while `get_filetype` does not?

**Answer.** Nothing about being a candidate differs between them. Both are
constructed, both are scored, both carry `operation_fact` provenance. They differ
only at the **deliverable cap**, which truncated one of them.

Artifacts: `stage5_m153_c4_candidate_propagation_trace.json`,
`stage5_m153_c4_identity_merge_audit.json`.

## Stage-by-stage

Both probes reproduce the capsule's own retrieval call — same shaping, same
weights, same request — so the trace is of the authoritative path, not a
simulation of it.

| Stage | `get_adapter` (requests) | `get_filetype` (sphinx) |
| --- | --- | --- |
| mechanism fact exists | yes — `first_success_return` on `adapters` | yes — `first_success_return` on `source_suffix` |
| operation derived | `selection` | `selection` |
| subject terms | session, connection, adapter, handles, url | build, parser, reads, source, file |
| owner resolved | yes | yes |
| subject aligned | yes — `direct_operand` | yes — `direct_operand` |
| owner admitted by lane | yes (1 of 1) | yes (3 of 3) |
| candidate object constructed | yes | yes |
| `ensureCandidate` reached | yes | yes |
| source assigned | `operation_fact` | `operation_fact` |
| candidate map contains identity | yes | yes |
| candidate score record exists | yes | yes |
| dedupe/merge identity | merged with `lexical` | no merge (sole source) |
| provenance survives merge | yes | yes (n/a) |
| **scored rank** | **1 of 96** | **202 of 273** |
| **survives deliverable cap (60)** | **yes** | **NO** |
| role classification | direct implementer, no promotion | direct implementer, no promotion |
| delivered | yes | no |

**First divergent row: `survives deliverable cap`.** Every row above it is
identical in kind. This is the "candidate inserted then removed" class of §11 —
not "never constructed", not "rejected", not "merged away", and not "present but
ranked low" in the sense that would license score tuning, because the removal is
a truncation, not a comparison.

## Exact divergent function and condition

- **Function:** `admitConceptOwnersBesideCap` in `src/retrieval/hybridRetrieval.ts`
  (now `admitBoundedLanesBesideCap`).
- **Conditional:** `ranked.slice(0, maxResults)` — with the beside-cap carry-over
  applying to the concept-owner lane's admissions **only**.
- **requests input:** `get_adapter` at index 0, `final = 2.443`. Inside the slice,
  so the carry-over never mattered.
- **sphinx input:** `get_filetype` at index 201, `final = 0.6016`. Outside the
  slice, and not a concept-owner admission, so nothing carried it across.

## Root cause

An existing generic contract was applied to one lane instead of to the class of
lanes it describes.

M142-C established the rule and stated it in exactly these terms: *"the cap
bounds what ORDINARY RANKING returns, and a lane that exists because ranking
cannot see its findings does not compete for ranking's slots."* The operation-fact
lane is such a lane by its own definition — its header describes the definition it
admits as one that "no lexical, symbol, path or domain signal reaches" — and it
was nonetheless routed through the cap that ordinary ranking fills. The lane could
therefore only deliver a candidate that ordinary ranking would have delivered
anyway.

That is why the defect survived C1–C3 undetected. `get_adapter` scores `fts = 1`:
a full lexical name match. The one case that exercised the lane in the calibration
corpus was also the one case that did not depend on it, so the lane looked
functional while being, for its actual purpose, inert.

## Questions §9–§15 asked, answered from the trace

- **Are `mechanism fact` and `operation_fact` distinct representations?** Yes, and
  the distinction is real: a *mechanism fact* is an indexed structural row in
  `symbol_mechanism_facts`; `operation_fact` is a `HybridCandidateSource` tag on a
  pooled candidate. The transformation is
  `symbol_mechanism_facts` → `generateOperationFactCandidates` (alignment + bounded
  admission) → `ensureCandidate` → `sources.add(OperationFact)`. It completed
  correctly on both sides.
- **Was lexical/name/path evidence an accidental prerequisite for candidate
  existence (§10)?** **No — and this was tested rather than assumed.** `get_filetype`
  exists as a candidate with `fts = 0`, `symbol = 0`, `path = 0`, `domain = 0`. Its
  only evidence is structural. The §10 hypothesis is therefore refuted for candidate
  *existence*. It is however true in a weaker and still-open form for candidate
  *rank*: with no lexical evidence the candidate's organic `final` is essentially its
  mechanism evidence alone, which is what puts it at rank 202. That is a ranking
  question, and C4 does not touch it.
- **Did candidate identity or dedupe contribute?** No. Pool identities are unique on
  both sides; identity is the symbol id throughout.
- **Did provenance merge contribute?** No. `get_adapter` is found by two lanes and
  carries `["lexical", "operation_fact"]` — the union, with structural provenance
  intact. No erasure was observed.
- **Did role/source classification contribute?** No. Both are classified
  `direct_implementer`. Neither was promoted, because `resolveOperationRoles`
  promotes only across a discovered producer/consumer relation and neither probe has
  a pooled partner. Correct by design, and unrelated to the divergence.

## The fix

`admitConceptOwnersBesideCap` becomes `admitBoundedLanesBesideCap`, taking the
admitted symbol ids of **every** bounded lane rather than of one named lane. The
call site passes the concept-owner and operation-fact admissions.

It is generic because it is not a new rule: it is the M142-C rule applied to the
property that defines the class (a lane exists because ranking cannot see its
findings) rather than to a lane's identity. It contains no repository name, no
symbol name, no vocabulary and no constant. It changes no score — verified by a
control asserting `get_filetype`'s `final` is identical at `maxResults` 3 and 50.
The pool stays bounded: the overflow is at most
`maxConceptOwnerCandidates + OPERATION_FACT_LIMITS.maxAdmitted`.

## Measured effect

| | before | after |
| --- | --- | --- |
| `get_adapter` scored rank | 1 / 96 | 1 / 96 |
| `get_adapter` in pool | yes (rank 1) | yes (rank 1) |
| `get_filetype` scored rank | 202 / 273 | 202 / 273 |
| `get_filetype` in pool | **no** | **yes (rank 65)** |
| sphinx `operation_fact` carriers in pool | 1 of 3 admitted | 3 of 3 admitted |
| `get_filetype` `final` | 0.6016 | 0.6016 |

## What it did not change

Oracle calibration is **unchanged on every case** — 0 substantive per-case
differences across all 35, latency aside. `get_filetype` reaches the pool at rank
65 and the capsule delivers far fewer items than that, so the defect this removed
was real but was not the binding constraint on delivery.

Per §27 that is an honest outcome, not a failed fix: one proven propagation defect
is gone and the dominant bottleneck is now visible one stage later, at delivery
selection. The taxonomy already attributes `sp_parser_selection` to
`ROLE_DELIVERY_FAILURE`, which is the correct stage for "admitted, pooled, not
delivered" — so no taxonomy correction was required.
