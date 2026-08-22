# M169 — Pipeline Economic Break-Even and Evidence-Dose Audit

**Verdict: PASS. No product change is licensed for the mandatory pipeline.**

```text
economic diagnosis     PIPELINE_ECONOMICS_MULTI_FACTOR
evidence dose          LOWER_EVIDENCE_DOSE_PLAUSIBLE
selective invocation   SELECTIVE_INVOCATION_NOT_SUPPORTED
next lever             NO_FURTHER_PROACTIVE_PIPELINE_WORK
live spend             $0.00
src/ changes           0   (tree f970e24c, identical to M167 de7bfe48)
```

M168 left one open fact: VTRACE displaces search and costs more anyway. M169 was
asked why — too big, or invoked on the wrong tasks. The answer is neither of the
two hypotheses as posed, and it is arithmetically simple:

> The pipeline costs **$0.0985 per task** and displaces **$0.0026 per task** of
> repository investigation. Over a whole run it displaces **less than nothing**:
> the treatment arm did $0.0070 *more* investigation than the baseline. The
> ratio is not a tuning problem. It is 38×.

---

## 1. What M168's numbers actually were

Before any economics, two of M168's inputs had to be repaired.

**The canonical result row's token counts are arithmetic artifacts.** Claude Code
streams one `assistant` event per *content block*, each repeating the whole
request's usage. The external harness sums them without deduplicating on
`message.id`, so the input side is multiplied by blocks-per-response and
`outputTokens` counts streaming placeholders — 43, for a run that emitted 17,724.
Deduplicating on message id reproduces the provider's own `result` event exactly.

```text
astropy-14369 vtrace_clean      row          provider        factor
cache read                  2,171,645         819,267         2.65x
cache creation                116,737          40,105         2.91x
output                             43          17,724         0.002x
turns                              43              16
```

`costUsd` is unaffected for the eleven completed runs — the runner takes it from
`total_cost_usd`. It is affected for the twelfth, which is the censored one, and
that matters (§5 below).

**The billing identity holds, so counterfactuals can be priced rather than
guessed.** For `claude-opus-4-5-20251101` at input \$5 / 1h-cache-write \$10 /
cache-read \$0.50 / output \$25 per Mtok, every one of the 35 uncensored runs
reproduces its own `total_cost_usd` to within 1e-16. The external harness prices
cache writes at the 5m rate (\$6.25), which is the second reason its arithmetic
disagrees with the provider's.

**The cache identity holds on 36/36 runs**, so attribution is measurement, not
modelling: `cache_read(n+1) == cache_read(n) + cache_creation(n)`, and the tokens
appended between two requests are the difference of two provider-reported prompt
sizes.

A least-squares fit over 416 real steps converts serialized characters to billed
tokens at **3.26 chars/token (R² = 0.977)**. The product budgets in `chars/4`,
so it under-measures its own responses by about 23%.

---

## 2. The paired economic ledger

Eleven uncensored pairs. `pipe$` is the whole life of the `run_pipeline` payload
— written into cache once, then re-read by every later request. `displ$` is the
measured paired reduction in pre-edit investigation traffic, floored at zero.

| Task | A cost | C cost | Δ | Pipeline attributable | Investigation displaced | Ratio | Economic class |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| astropy-14369 | $0.9408 | $1.2544 | +$0.3136 | $0.1311 | $0.0112 | 11.7× | LOSS |
| django-13658 | $0.1915 | $0.3315 | +$0.1400 | $0.0884 | $0.0545 | 1.6× | LOSS |
| matplotlib-22719 | $0.4138 | $0.4002 | −$0.0135 | $0.0824 | $0.0145 | 5.7× | LOSS |
| seaborn-3187 | $0.8100 | $1.2350 | +$0.4250 | $0.1341 | $0.0308 | 4.4× | LOSS |
| flask-5014 | $0.2109 | $0.2483 | +$0.0374 | $0.0637 | $0.0741 | 0.86× | ROUGH_BREAK_EVEN |
| requests-1724 | $0.1979 | $0.4504 | +$0.2525 | $0.0970 | $0.0000 | DISPLACED_NOTHING | LOSS |
| xarray-6599 | $0.9577 | $1.6374 | +$0.6797 | $0.1436 | $0.0000 | DISPLACED_NOTHING | LOSS |
| pylint-4551 | *censored* | $1.3991 | — | $0.1342 | — | — | NOT_MEASURABLE |
| pytest-7432 | $0.2730 | $0.5309 | +$0.2578 | $0.0874 | $0.0000 | DISPLACED_NOTHING | LOSS |
| scikit-learn-10844 | $0.3000 | $0.3773 | +$0.0772 | $0.0911 | $0.0000 | DISPLACED_NOTHING | LOSS |
| sphinx-7462 | $0.3067 | $0.4355 | +$0.1287 | $0.0800 | $0.0007 | 118.7× | LOSS |
| sympy-13480 | $0.2734 | $0.3641 | +$0.0907 | $0.0851 | $0.0014 | 59.4× | LOSS |

```text
10 PIPELINE_ECONOMIC_LOSS    1 ROUGH_BREAK_EVEN    0 WIN    1 NOT_MEASURABLE
```

Under the deliberately generous denominator — crediting VTRACE with replacing
*everything* the baseline ever inspected — it is still 8 losses, 2 break-even,
1 win. That denominator is reported and then discarded in §4, because it turns
out to be counterfactually false.

Economic class was assigned without reference to the grader. Overlaid
afterwards, it carries no outcome signal: the ten LOSS tasks resolved 7/10 in
both arms, with two unique wins each way.

---

## 3. Where the premium is spent

Median paired premium **+$0.1400** (mean $0.2172). Two decompositions.

**Temporally**, two thirds of it lands before the first edit — where the payload
lands — and a third afterwards:

```text
median Δ pre-edit    +$0.0914
median Δ post-edit   +$0.0444
median Δ requests    +1
```

**By what the payload is made of**, through M166's frozen rule table, averaged
over the twelve clean runs:

```text
TRANSPORT_STRUCTURE    8,542 ch   2,641 tok   $0.0411   40.4%
REPOSITORY_EVIDENCE    4,006 ch   1,238 tok   $0.0190   18.9%
DUPLICATE              3,677 ch   1,137 tok   $0.0176   17.4%
AGENT_USEFUL_CONTROL   2,155 ch     666 tok   $0.0104   10.2%
MACHINE_DIAGNOSTIC     1,668 ch     516 tok   $0.0081    7.9%
PROVENANCE             1,107 ch     342 tok   $0.0053    5.2%
```

**Under a fifth of the payload is repository evidence.** Two fifths is JSON
syntax. The product's own envelope accounting agrees and says so out loud, on all
twelve deliveries:

```text
median estimated_model_visible_tokens      642
median estimated_metadata_tokens         4,565      7.1x the context
total_response_token_ceiling             9,200      on every run
within_envelope                           true      on every run
```

The ceiling is derived from a *context* budget of 8,000 and is then spent almost
entirely on things that are not context — and the product reports that as being
within budget, because by its own definition it is.

The first-call cost is not the whole tax. Amplification — the payload re-read as
cache on every later request — is 9% of the payload's cost on the shortest run
and **56% on the longest**. A payload's price is set as much by how long the run
turns out to be as by its own size.

---

## 4. What was actually displaced

M168 reported that VTRACE reduced native search, and it did — in tool counts.
In traffic dollars it did not.

```text
                              baseline    clean     net
pre-edit investigation        $0.4219   $0.3934   +$0.0285
whole-run investigation       $0.6151   $0.6221   −$0.0070
```

Per task, over eleven pairs: **$0.0026 displaced, $0.0985 spent.** On six of the
eleven the treatment arm's pre-edit investigation was *higher* than the
baseline's — xarray by $0.106, requests by $0.039 — because the agent stopped
searching and read files instead. M168 established that a blocked search is not
a saved search. M169 adds the harder half: a *skipped* search is not a saved
search either.

This is why the generous denominator has to be discarded rather than merely
reported. It credits VTRACE with replacing investigation that measurably still
happened.

---

## 5. Censoring

Twelve grader pairs; **eleven uncensored economic pairs**. `pylint-4551`
baseline was killed by the cost guard at a recorded $3.0384 and has no `result`
event.

That recorded figure is not a provider endpoint and is not on the same basis as
the other eleven. It is the harness's own `calculateCost` over the
non-deduplicated stream at the 5m cache-write rate — the two defects of §1
compounded. The provider's cost at kill time is at least the reconstructible
input side, **$1.2867**, plus an output term that cannot be recovered because
the run never reported one. The task is excluded from every dollar statistic and
its clean arm is reported alone.

---

## 6. The dose ladder

The plan named `capsule_budget_tokens` as the knob. An identity control rejected
it on contact: at 8,000 it also raises the v1 capsule's *character* budget from
its own default of 2,000 to 32,000, and the reference rung delivered 36,342
characters where the live agent received 25,119. **The product ships two
different default budgets for one response and no argument sets both to their
defaults.** The ladder was re-cut on `max_tokens` — the argument the schema
documents as the caller's model-visible context budget — with the reference rung
being the call the live agent actually made: no budget argument at all.

Controls: the default rung reproduces itself against itself on every corpus, and
the default call repeated *after* every rung returns the same delivery, so the
ladder leaves no residue.

That second control was wrong when first written, and the way it was wrong is the
same way three M168 classifiers were wrong. It compared two responses field by
field and certified them identical — including when both were the same
`repo_not_ready` error, which is how it reported a clean 100/100 on a corpus
where 93 of 100 cases returned no delivery at all. Non-delivery is now
`NOT_COMPARABLE`. The rule keeps earning its place: **a control that cannot
discriminate the case it exists to check is not a control**, and two identical
errors are not an identical delivery.

```text
                    M168-12 (12)      Broad100-A (100)     Broad100-B (98)
rung           median ch  primary   median ch  primary   median ch  primary
DEFAULT           21,854    100%       20,617    100%       21,771    100%
8,000             35,755   83.3%       35,490   86.0%       35,941   81.6%
6,000             27,863   66.7%       27,605   83.0%       27,610   73.5%
4,000             19,626   58.3%       19,632   71.0%       19,626   60.2%
2,640             14,051   16.7%       14,173   29.0%       14,109   17.3%
2,000             11,365    0.0%       11,194    7.0%       11,564    4.1%

truthfulness preserved at 2,000 tokens:   0.0%      7.0%      6.1%
```

Two things this shows, neither of them the thing it was built to show.

**§26 could not be satisfied.** No shipped argument varies the model-visible
evidence dose while holding retrieval fixed. `max_tokens` also multiplies the
assembly budget, so the delivered *item set* moves with it — and not monotonically:
django-13658 delivers zero pivots at 4,000 and one pivot at 2,640. A budget knob
under which less can mean more is not a dose control.

**Every reduced rung sheds truthfulness.** `claimBoundary` disappears under
compaction at nearly every non-default rung. §28 forbids scoring that as an
improvement for being cheaper, so the ladder cannot recommend any rung on it.

What generalizes cleanly is the composition. Repository evidence is 19.4% of the
default payload on the M168 twelve, 17.6% on Broad100-A and 18.2% on
Broad100-B — the same response shape on 210 tasks across 12 repositories, two of
those corpora frozen before any of this was measured and never used to tune
anything.

---

## 7. Break-even

The largest payload each task could have afforded, inverting the write-plus-re-read
arithmetic against what it displaced:

```text
median delivered payload            6,383 tokens
median useful core (evidence+control) 1,903 tokens
median break-even budget                106 tokens   (measured displacement)
median break-even budget              4,033 tokens   (generous denominator)
```

Against the generous denominator the shipped payload does not fit on **10 of 11**
tasks, while its useful core fits comfortably on **7 of 11**. That is the shape
that would have supported a dose-reduction lever.

Against what was actually displaced, it collapses. On **9 of 11 tasks the minimum
useful payload — evidence plus every truthfulness field, nothing else — still
costs more than the entire investigation it replaced.** Only django-13658 and
flask-5014 could ever break even.

```text
                       minimum useful payload    displaced
astropy-14369                    $0.0391          $0.0112
django-13658                     $0.0264          $0.0545   fits
matplotlib-22719                 $0.0246          $0.0145
seaborn-3187                     $0.0400          $0.0308
flask-5014                       $0.0190          $0.0741   fits
requests-1724                    $0.0289          $0.0000
xarray-6599                      $0.0428          $0.0000
pytest-7432                      $0.0261          $0.0000
scikit-learn-10844               $0.0272          $0.0000
sphinx-7462                      $0.0238          $0.0007
sympy-13480                      $0.0254          $0.0014
```

---

## 8. Selective invocation

Fifteen candidate features across the four frozen families, split by whether the
task displaced anything at all. **Fourteen are NULL.**

```text
feature                    tier              displaced   not      stat   verdict
taskCharacters             PRE_INVOCATION      1438      1784    0.53    NULL
explicitFilePaths          PRE_INVOCATION         1         2    0.38    NULL
distinctExplicitFilePaths  PRE_INVOCATION         1         2    0.37    NULL
codeIdentifiers            PRE_INVOCATION        20      16.5    0.53    NULL
tracebackPresent           PRE_INVOCATION         0         0    0.52    NULL
namedDefinitionPresent     PRE_INVOCATION         0         0    0.53    NULL
codeFencePresent           PRE_INVOCATION         1         1    0.38    NULL
indexedFiles               PRE_INVOCATION       927     344.5    0.60    NULL
indexedSymbols             PRE_INVOCATION     15700      7345    0.60    NULL
rankingCandidates          PRE_DELIVERY           2         2    0.62    NULL
scoreMargin                PRE_DELIVERY       0.278     0.192    0.57    NULL
nearTopCandidates          PRE_DELIVERY           2         2    0.53    NULL
distinctFilesInTopTen      PRE_DELIVERY           2         1    0.87    WEAK
deliveredPivots            PRE_DELIVERY           1         1    0.50    NULL
deliveredDistinctFiles     PRE_DELIVERY           4         3    0.62    NULL
```

The one signal that is not null is PRE_DELIVERY: it needs retrieval to have run,
which is most of the work a router would exist to avoid. Nothing available
before invocation separates the two groups at all — and the cross-corpus
distribution shows the twelve are not a peculiar sample:

```text
corpus       n     task chars p50   no explicit path   traceback
M168-12     12          1,237            16.7%           16.7%
Broad100-A 100          1,141            53.0%           11.0%
Broad100-B 100          1,575            50.0%           12.0%
```

No router is proposed. `SELECTIVE_INVOCATION_NOT_SUPPORTED` means not supported
by this evidence at n=11, not proven impossible.

---

## 9. Diagnosis and next lever

Both factors are real, so the diagnosis is `PIPELINE_ECONOMICS_MULTI_FACTOR`:
the response is overwhelmingly not evidence, **and** six of eleven tasks had
nothing worth replacing. But §54's instruction to take the larger lever first
does not apply, because §55's prior question answers both at once.

```text
if the pipeline payload were free           CLEAN still costs +$0.148/task
if the payload were cut to its useful core  it still costs 11x what it displaced
tasks where no dose can break even          9 of 11
pre-treatment signal to route on            none
```

A dose reduction recovers $0.069 of a $0.217 per-task premium. It is worth doing
— 70% of the payload is transport, restatement and bookkeeping, and that is
indefensible on its own terms — but it is not an economics fix, and this report
declines to sell it as one.

**Recommended: `NO_FURTHER_PROACTIVE_PIPELINE_WORK`.**

The mandatory-first-action pipeline is economically inappropriate for this task
population. That is not a claim that VTRACE is useless; it is a claim about
*proactive* invocation on tasks where a coding agent localizes for two cents.
The natural reading of §56 — repository intelligence on demand, for ambiguous
tasks, impact questions, multi-repo work and large unfamiliar repositories —
survives every measurement in this report untouched, because none of them tested
it.

Two pieces of work are licensed by M169 and neither is an economics bet:

1. **The response diet is a correctness-of-product issue, not a savings play.**
   40% transport, 17% restatement, 8% machine diagnostics. Whenever the tool is
   called at all — proactively or not — the model pays for that. Fixing it needs
   no economic justification and should not be given a false one.
2. **The two default budgets should be reconciled**, and the non-monotonicity of
   `max_tokens` treated as the defect it is. A budget under which less can mean
   more will mislead anyone who tunes against it, including us.

---

## 10. What would change this conclusion

Stated so the conclusion is falsifiable rather than merely argued:

- **A population where baseline localization is expensive.** Every task here was
  localized by the baseline for a median of $0.048. On a large unfamiliar
  repository, or a genuine cross-file impact question, the denominator could be
  an order of magnitude larger and the same payload would break even.
  M169 measured one population and says nothing about others.
- **An on-demand arm.** Nothing in M162–M169 has ever measured VTRACE being
  called *when the agent wanted it*. Every arm mandated it.
- **n=11.** One task at this sample size is not a rate. The economics are
  lopsided enough (38×) that sampling noise is not a plausible explanation for
  the direction, but the magnitude is not precise.

---

## 11. Provenance and preservation

```text
M167                de7bfe48b5bbadd50ff7ab7c85621f15f1dd3a37
M168 authority      aaa334d90ad7498f213cd6ba5486d4c4908716e1
M168 protocol       55e1f0bba2a7a62fd0a79dfcfb631bcd313e316e
M168 live evidence  413093e032dd9d31b37d4c16f5f80452df8d083c
origin/main         bcdd962e42cfdfccbce89e14885a90f405ba3490

src/ tree  M167  f970e24c46d5aa7a6d190389911722e12e8787b9
src/ tree  HEAD  f970e24c46d5aa7a6d190389911722e12e8787b9   identical
```

Product behaviour, retrieval, ranking, the `run_pipeline` default budget and the
search policy are all unchanged. M169 spent **$0.00** live: no agent, no Docker,
no paid API, no VEXP. The offline work re-materialised 100 Broad100-B and 100
Broad100-A workspaces at the current index generation and ran roughly 2,200
`run_pipeline` calls through the shipped server, all of it local CPU.

Rebuilding Broad100-A also incidentally re-validated the readiness path M164
repaired: 100 of 100 freshly indexed workspaces answer, against 7 of 100 on the
stale originals.

One incidental finding worth recording outside this report's argument: the
Broad100-A workspaces under `workspaces/cross_repo/` are `index_corrupt /
index_unreadable` to the current build — 93 of 100 answer `repo_not_ready`. Any
evidence that depends on re-running against them is not currently reproducible
without a rebuild. M169 rebuilt them under a new root and left the originals
alone.
