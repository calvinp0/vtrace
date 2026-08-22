# M171 — agent-facing orientation contract redesign

**Offline design and qualification milestone. No live agents, no Docker, no paid
API. $0.00 expected live spend.**

## The question

M169 closed the proactive pipeline as an economic proposition: a mandatory
first-call context pack costing $0.0985/task displaced $0.0026/task of
investigation, a 38x ratio, with 10 economic losses and no wins. M170 closed the
opposite architecture: transparent mediation under an operation the agent already
chose has a 4.81% whole-run oracle ceiling on this population and no safe rung.

Neither result condemns the product category. Both condemn a *price*. M171 asks
whether the price is a property of the category or of the disclosure:

> Can VTRACE keep its full authoritative internal evidence model while sending
> the agent only the minimum sufficient decision-oriented orientation?

The architecture under test:

```text
repository + task
  -> full authoritative VTRACE computation      (unchanged)
  -> internal PipelineResult                    (unchanged)
  -> MINIMUM SUFFICIENT PROJECTION              (new)
  -> small orientation packet                   (what the model sees)
```

This is a **projection redesign, not a retrieval change**. Ranking, candidate
generation, FTS, graph construction, centrality, behaviour routing, query
interpretation, support scoring and impact semantics are out of scope and must be
provably untouched.

## Gates, frozen before any result

Every threshold below is taken verbatim from the milestone prompt and was fixed
before the first measurement. None may be relaxed after seeing a number.

| Gate | Requirement | Source |
|---|---|---|
| Size, median | <= 2,000 model-visible tokens | §12 |
| Size, p90 | <= 2,500 model-visible tokens | §12 |
| Economics | projected attributable cost <= 50% of the M169 median baseline localization cost (~$0.026 on the historical basis) | §13, §66 |
| Pivot identity | 100% preserved | §36, §58 |
| Truthfulness | 0 unsupported claims, 0 authority strengthening, 0 false absence | §49, §59 |
| Action support | >= 90% preservation of first meaningful repository action support, reported honestly if unreachable | §60 |
| Holdout delivery | gold pivot no regression; gold file and gold symbol delivery within 2 percentage points | §61 |
| Refill | a projection complete below its ceiling must NOT be padded | §17, §46 |
| Monotonicity | a fact present at a smaller rung must be present at a larger one | §45 |

Two rules constrain how the gates may be met:

- **Soundness, not completeness (§6).** The packet may omit supported facts. It
  may never assert one the authoritative state does not support.
- **No false absence (§7).** Omitted is not absent; not observed is not absent;
  bounded absence is not authoritative absence; support is not ownership; a
  potential caller is not an exact caller.

## Method constraints inherited from earlier milestones

- **The measured channel is `structuredContent`** (§21, M167). The pretty
  renderer and the wire bytes are not the model-token surface. A compact
  `content[0].text` with the full object still in `structuredContent` is
  cosmetic and fails (§22).
- **Token accounting uses M166's measured calibration** — 0.3174 tokens per
  result character, regressed on provider-reported cache creation across 363
  samples. The product's own `chars/4` understates a dense JSON payload by 1.27x
  and is never used for a claim (§64).
- **Dollars are PROJECTED ATTRIBUTABLE COST** (§65). M171 is offline; no provider
  telemetry exists for these calls. Per-case cache amplification is read from the
  M169 ledger so an M171 dollar is comparable to an M169 dollar.
- **Duplicate accounting is not semantic duplication** (M166/M167 permanent).
  The fact graph dedupes through named extractors, never through string equality.
- **A comparative classifier must classify an unchanged input correctly before
  its treatment verdicts count** (§51, M167 permanent).
- **Parse failure is not semantic absence** (§52, M167 permanent).
- **The existing budget knobs are not the lever** (§15). `capsule_budget_tokens`
  and `max_tokens` are non-monotone and shed `claimBoundary` at low rungs. M171
  may not be implemented by choosing a smaller value for either.
- **One pipeline** (§19). No `run_pipeline_v2`, no parallel product path.

## Populations

| Set | Cases | Role |
|---|---|---|
| Development | the 12 M168/M169 tasks | design and dose selection (§30); already contaminated for benchmark inference |
| Broad100-A remainder | 88 | primary holdout; A is the exact public VEXP 100-task manifest (M168) |
| Broad100-A full | 100 | reported alongside, with the 12 development members named (§32) |
| Broad100-B | 100 | independent holdout, disjoint from A; never a development set (§71) |

All three read fresh, derivation-valid indexes. `workspaces/cross_repo` is not
current-build authority and is not touched; A is read at the root M169
re-materialised (§33).

## Workstreams

```text
M171-A  decompose the actual model-facing contract
M171-B  derive the minimum-sufficient orientation contract
M171-C  build the projector; dose curve; no-refill and monotonicity proofs
M171-D  truthfulness and information-preservation qualification
M171-E  holdout economics and regression qualification
M171-F  default product integration, ONLY if A-E license it
        then STOP for live authorization
```

## Verdicts to be issued

One orientation verdict (§93), one economics verdict (§94), one product verdict
(§95) and one future-live verdict (§96). If 2,000 tokens cannot be reached
truthfully, the answer is `VEXP_CLASS_ORIENTATION_NOT_YET_ECONOMIC` and a
statement of what consumes the irreducible bytes — not a weaker gate (§67).
