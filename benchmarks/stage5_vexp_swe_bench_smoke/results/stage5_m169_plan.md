# M169 — Pipeline Economic Break-Even and Evidence-Dose Audit

**Status: plan frozen before any economic result was inspected.** Thresholds
(§20), the budget ladder (§24) and the pre-treatment feature families (§46) are
written down here first precisely so that they cannot be chosen to fit twelve
tasks afterwards.

## The question M169 exists to answer

M168 left one open economic fact and no explanation for it:

```text
run_pipeline adoption        12/12
evidence delivered           12/12
native search                reduced
resolved                     8/12 CLEAN vs 7/12 BASELINE
CLEAN cost higher            10/12,  median +$0.134
cache creation higher        11/12
```

VTRACE displaces investigation and does not save money doing it. M169 decides
**why**, between two hypotheses, and licenses at most one next lever.

- **H1 PIPELINE_INTRINSICALLY_OVERFED** — the payload costs more than the
  investigation it replaces on essentially every task. Lever: minimum effective
  evidence dose.
- **H2 PIPELINE_SELECTIVELY_ECONOMIC** — the payload is worth it where
  localization is genuinely hard and wasted where the task already names its
  own answer. Lever: selective invocation.

M169 is an audit. Expected `src/` changes: **0**. No live agents, no paid APIs,
no VEXP, no Docker, no retrieval tuning. Expected live spend: **$0.00**.

## What 8/12 vs 7/12 is allowed to mean

Nothing. One task at n=12 is preserved as an observed outcome and is never
spoken of as a solve-rate gain. M169's subject is economics and mechanism.

## Workstreams

```text
M169-A   reconstruct the paired economic ledger from raw run authority
M169-B   localize where the CLEAN premium is spent, temporally
M169-C   measure the native investigation actually displaced
M169-D   offline evidence-dose ladder and break-even simulation
M169-E   pre-treatment predictor audit (no router is built)
M169-F   economic diagnosis, dose verdict, routing verdict, one next lever
```

## Frozen definitions

### Token and cost authority (§73, §74)

Five figures are kept apart and never summed across boundaries. The authority
order is: the provider's `result` event first; per-request `message.usage`
deduplicated by message id second; anything derived from characters last and
always labelled `OFFLINE_ESTIMATED_TOKENS`.

The billing identity used throughout, for `claude-opus-4-5-20251101`:

```text
input                 $5.00 / Mtok
cache write (1h)     $10.00 / Mtok
cache write (5m)      $6.25 / Mtok
cache read            $0.50 / Mtok
output               $25.00 / Mtok
```

This identity is asserted, not assumed: every uncensored run must reproduce its
own `total_cost_usd` from its own `result.usage` to within $1e-6, or the run is
excluded from dollar analysis and reported as such.

### Attribution mechanism (§9)

Claude Code writes the whole appended suffix into the cache on the following
request, so for consecutive requests `n` and `n+1`:

```text
prompt(n)            = input(n) + cache_creation(n) + cache_read(n)
appended(n -> n+1)   = cache_creation(n+1)
cache identity       cache_read(n+1) == cache_read(n) + cache_creation(n)
```

The identity is CHECKED per run (M166 `checkCacheIdentity`). Where it fails,
attribution for the affected step is reported `NOT_DERIVABLE`, never assumed.

A tool result's attributable traffic therefore has three parts, reported
separately and never collapsed:

```text
initial              the cache-write that first carried it
amplification        that payload re-read on every later request
total attributable   initial + amplification, priced with the identity above
```

`cache_creation(n+1)` covers the tool result AND the assistant text that shared
the same write, so the payload figure is a BOUND pair plus a calibrated point
estimate (M166 `attributeToolResult`), never a single invented number.

### Economic ratio and classes (§19, §20) — frozen before results

```text
ECONOMIC_RATIO = PIPELINE_ATTRIBUTABLE_COST(CLEAN)
               / NATIVE_INVESTIGATION_COST(BASELINE)
```

Both sides in **dollars**, not tokens, because a cache write and a cache read
differ by 20× in price and a token-denominated ratio would silently mis-weight
them.

The denominator is the **displaced** amount, paired, not the whole of the
baseline's investigation (§17: one fewer Grep is not one Grep's cost saved):

```text
INVESTIGATION_COST(run)   attributable cost of every investigation tool result
                          (search / read / shell-inspection) in the run
DISPLACED (primary)       max(0, INVESTIGATION_COST_PRE_EDIT(A)
                                - INVESTIGATION_COST_PRE_EDIT(C))
DISPLACED_GENEROUS        INVESTIGATION_COST(A) over the whole run
```

`ECONOMIC_RATIO` uses `DISPLACED`. `ECONOMIC_RATIO_GENEROUS` uses
`DISPLACED_GENEROUS` and exists as a one-way sensitivity check: it credits VTRACE
with replacing every investigative action the baseline ever took, which it
demonstrably did not, so a loss under the generous denominator is a strong loss.

If `DISPLACED <= 0` while the pipeline cost more than $0, the task is
`PIPELINE_ECONOMIC_LOSS` with ratio reported as `DISPLACED_NOTHING`, not
`NOT_MEASURABLE` — nothing was replaced and something was paid for.
`NOT_MEASURABLE` is reserved for censoring and for a violated cache identity.

```text
PIPELINE_ECONOMIC_WIN     ratio <= 0.80
ROUGH_BREAK_EVEN          0.80 < ratio <= 1.25
PIPELINE_ECONOMIC_LOSS    ratio > 1.25
NOT_MEASURABLE            denominator 0, censored run, or identity violated
```

The band is symmetric in log space (`1/1.25 = 0.80`) and is a tolerance for
accounting noise, not a preference. Grader outcome is **not** an input to this
classification (§21); it is overlaid afterwards (§22).

### Budget ladder (§24) — frozen before results

The product's own knob is `capsule_budget_tokens`, default
`CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS = 8000`. The ladder is the default
and four coarse fractions of it, chosen for roundness, not tuned per task:

```text
8000   current default (100%)
6000   75%
4000   50%
2640   33%
2000   25%
```

Retrieval, ranking, index, task text and component routing are held identical
across every rung (§26). Only the delivery budget moves.

### Evidence-retention classes (§29) — frozen before results

```text
SEMANTICALLY_EQUIVALENT      same delivered files and same primary evidence
PRIMARY_EVIDENCE_PRESERVED   lead pivot + its source retained; support reduced
MATERIAL_SUPPORT_LOSS        >= 1 previously delivered support file gone
MATERIAL_PRIMARY_LOSS        a previously delivered pivot file gone
TRUTHFULNESS_LOSS            readiness / absence / provenance / status dropped
```

`TRUTHFULNESS_LOSS` dominates: a rung that sheds an epistemic-status field is
never scored as an improvement for being smaller (§28).

### Break-even fit classes (§33)

```text
YES_COMFORTABLY   useful payload <= 0.75 x break-even budget
YES_NARROWLY      useful payload <= 1.00 x break-even budget
NO                useful payload  > 1.00 x break-even budget
NOT_MEASURABLE    no break-even budget exists for this task
```

Disclosure on blindness: these two boundaries were written down after the
composition shares and the break-even budgets each existed, but before their
ratio was computed. They are the natural boundaries of the question ("does it
fit, and with room to spare?") and were not selected from a set of candidates.
The stronger claim available to §20's thresholds — chosen before any input
existed — is not claimed here.

`useful payload` has two definitions, both reported, because §28 forbids
counting truthfulness as fat:

```text
EVIDENCE_ONLY        REPOSITORY_EVIDENCE
EVIDENCE_PLUS_CONTROL  REPOSITORY_EVIDENCE + AGENT_USEFUL_CONTROL
```

### Pre-treatment feature families (§46) — frozen before economic classes exist

Two availability tiers are distinguished, because they license different
products:

```text
PRE_INVOCATION   computable with zero retrieval work
PRE_DELIVERY     needs retrieval, but not delivery, and not the outcome
```

```text
TASK_EXPLICITNESS      (PRE_INVOCATION)
  explicit file paths named in the task
  code-like identifiers (dotted / snake / Camel)
  traceback present
  named class or function present
  task character length

REPOSITORY_SCALE       (PRE_INVOCATION)
  indexed files
  indexed symbols

RETRIEVAL_AMBIGUITY    (PRE_DELIVERY)
  score margin between rank 1 and rank 2
  candidates scoring >= 80% of the top score
  distinct files among the top 10 candidates

EXPECTED_IMPACT_BREADTH (PRE_DELIVERY)
  delivered pivot count
  delivered distinct files
```

Forbidden as predictors (§41): grader outcome, gold file or symbol, historical
CLEAN success, observed BASELINE searches or cost, any post-treatment agent
behaviour. Those are labels. Every family tested is reported, including nulls
(§45). No model is fit to n=12 (§43).

## Controls every classifier must pass (§70, §71, §72)

```text
known positive     a case the classifier must flag
known negative     a case it must not flag
identity control   the unchanged case, which must come back unchanged
```

A uniform label across all twelve tasks is treated as suspect until manually
checked. `PARSE_FAILURE` is never rendered as `ABSENT`, `DUPLICATE` or
`NO_EFFECT`.

## Product freeze (§60, §61, §83)

`src/` is byte-identical to `de7bfe48` at tree `f970e24c` and must remain so.
Any instrumentation lives under `benchmarks/`. `run_pipeline`'s default budget
is not changed by M169.

## Exit (§69, §80)

M169 produces exactly one economic diagnosis, one evidence-dose verdict, one
selective-invocation verdict, and one recommended next lever — or a justified
`NO PRODUCT CHANGE LICENSED`. M169 may PASS while concluding that a mandatory
pipeline is economically unjustified.
