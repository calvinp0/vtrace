# M173 — compact automatic orientation, live requalification

**Frozen before execution. Two arms, twelve tasks, twenty-four runs, a $35
authorised hard cap, and one manipulated variable: what `run_pipeline` hands the
model.**

M169 measured the proactive pipeline and found it cost $0.0985 a task to displace
$0.0026 of investigation — thirty-eight times its worth — and closed on
`NO_FURTHER_PROACTIVE_PIPELINE_WORK`. M172 then changed the thing that verdict
was about. The default disclosure became a bounded orientation projection: a
median 621 model-visible tokens against 6,884 on a clean hundred-task holdout,
with gold file and gold symbol delivery unchanged to the percentage point and
all 66 previously withheld related entries delivered.

So the verdict is not inherited. It is rerun.

> **Does the shipped M172 compact automatic orientation produce measurable
> end-to-end coding-agent benefit now that its attributable first-call cost has
> fallen by roughly an order of magnitude?**

## What is held fixed, and how

| Held fixed | Mechanism |
| --- | --- |
| the twelve-task sample | `stage5_m168_sample_manifest.json`, re-hashed at freeze; reselection fails closed |
| the mandate prose | imported from `m168Treatment.M168_MANDATE_TEXT`, not copied; byte-identity asserted |
| the tool inventory | `run_pipeline`, `get_impact_graph` — M168's frozen two |
| the economic definitions | imported from `m169Economics`; investigation is SEARCH/READ/SHELL_INSPECTION |
| the economic thresholds | M169's, frozen before any M173 number existed |
| the product | commit `9242d879`, `src` clean, projector and tool module hashed |

Arm B's prose hashes to M168's clean arm exactly. That identity is what makes
M173 a requalification rather than a new experiment: the difference between
M169's economics and M173's cannot be a difference in what the agent was told.

## The arms

```text
A  BASELINE         task prompt, ordinary tools, no VTRACE anything
B  VTRACE_COMPACT   the same mandate, against the M172 compact default
```

Absent from B on purpose: the VEXP prohibition text, the Grep/Glob denial hook,
the harness's anti-loop discipline, the tool-use discipline, and any `detail`
argument. M168-E measured the coercion going 0-for-5 where it bound; none of it
returns. The treatment is compact automatic orientation and nothing else.

`detail` is an argument the agent can reach, and its output schema says
`detail=debug` returns the authoritative result. Blocking it would be a product
change M173 is forbidden to make, so whether an agent reaches for it is a
**measured product behaviour**, classified per run.

## What M173-A found before spending anything

**The accounting discriminates.** The corrected path — deduplicating on
`message.id` — reproduces the provider's own `total_cost_usd` on 35 of 35
uncensored M168 runs to 1e-9. The naive per-block summation M169 caught
reproduces it on 0 of 35. The canonical result row's cache-read field is
inflated 2.64×. A control that passed on both paths would have certified
nothing.

**The workspaces are the ones the agent will query.** All twelve arm-B
workspaces were cloned and indexed at the live label paths with the runner's own
command shapes, so the live `--index-policy auto` reuses the artifact this
preflight validated rather than rebuilding it. M169 found the Broad100-A
workspaces answered `repo_not_ready` on 93 of 100 to the current build; M164
found `REPO_NOT_READY` on 12 of 12 in an arm that had already been paid for.
A differently prepared positive control would have caught neither.

**The compact default has an escape hatch, and it was found before the spend.**
Asked the raw problem statement, matplotlib-22719 returned the FULL
AUTHORITATIVE RESULT at 26,075 characters with no `detail` argument, on a
healthy index of 927 files and 15,700 symbols. That is the shipped fallback:
`projectRunPipelineOrientation` declines on an empty delivery and
`orientation ?? authoritativeResult` hands over the whole thing — the payload
M169 priced at $0.0985.

Asked the query M168's own agent authored, the same workspace returns a
1,703-character compact orientation focused on the gold file. Twelve of twelve
are compact under an agent-shaped query; the median is 1,994 characters,
about 500 tokens, consistent with M172's 621-token projection.

So the workspace was sound and the preflight's query was the limitation — but
the fallback is real, it is a property of the shipped product, and every live
run is classified for whether it opened.

## Controls at freeze

```text
10 pass    offline smoke: wiring, leakage, inventory, policy, disclosure, grader
 5 awaiting the first live pair — NOT_RUN is not a pass
 4 pass    accounting controls, including one required to FAIL on the broken path
12/12      valid non-empty compact orientation under an agent-shaped query
 0         fallback risk declared for the live sweep
```

## Spend

`$35`, authorised, enforced **at task entry** rather than per spawn. The
granularity is the point: a guard that stops between a task's two arms censors
the pair, and a censored pair is what the paired comparison cannot use. Two
conditions, both required — the running average projected over every remaining
arm must fit the cap, and the headroom must cover one whole pair at the worst
pair cost this harness has recorded ($3.20). No code path raises the cap. On a
stop the driver writes `stage5_m173_cap_pressure.json`, which decomposes spend
by arm and asks whether the pressure is arm-skewed: if the cap bites because the
treatment is expensive, a truncated sweep would report the cheap half of the
treatment distribution as the treatment.

Estimate basis, from this harness's own M168 telemetry over the identical
twelve: the direct A+C analogue was $16.58, the p90-weighted 24-run projection
is $26.34. The expectation is roughly flat total cost, not an eleven-fold
saving — M169 established that the first call is not the tax and run length is.
A materially lower total would itself be a finding.

## Stop conditions

Apparatus defects stop the sweep: baseline leakage, wrong tool inventory, wrong
commit, a debug payload in the model transcript, an index or worktree mismatch,
an accounting failure, session contamination, a grader fault, a wiring fault.

Experimental outcomes do not: VTRACE losing a task, costing more, being ignored,
picking a wrong pivot, or the agent re-searching everything. Those are results.
The rerun policy admits infrastructure failures only.

## Verdicts M173 must reach

```text
utility        UTILITY_POSITIVE | NEUTRAL | NEGATIVE | INCONCLUSIVE
economics      ECONOMICALLY_POSITIVE | NEUTRAL | NEGATIVE | INCONCLUSIVE
architecture   COMPACT_AUTOMATIC_ORIENTATION_VALIDATED | UTILITY_NEUTRAL
               | ECONOMICALLY_NEGATIVE | INCONCLUSIVE
M169 null      REVERSED | WEAKENED | PERSISTS | NOT_COMPARABLE
pivot work     PIVOT_CORRECTNESS_WORK_LICENSED | NOT_LICENSED
product        KEEP_COMPACT_ORIENTATION_DEFAULT | ROLL_BACK | INCONCLUSIVE
```

n = 12 paired tasks. This is a mechanistic qualification and paired-sample
evidence; it is not population-wide solve-rate proof and will not be described
as one.

And the standing instruction that governs the ending: if M173 is neutral, do not
blame pivot correctness. Prove from the live traces that wrong pivots caused the
remaining losses before touching retrieval again.

## Amendment during M173-B: the cap, raised once, by a human

The task-entry guard stopped the sweep before task 2 of 12. Its projection was
$44.48 against a $35 cap, and it was right to stop on its own arithmetic — but
that arithmetic was a running average whose only sample was astropy-14369,
complexity 99 in a 14–234 sample and the second-priciest pair in M168.

The cap was raised to $45 by the repository owner. Nothing else moved: not the
projection logic, not the task order, not the sample, the arms, the prompts, the
treatment, the rerun policy or the accounting. The M168-based estimates that
informed the authorisation were deliberately NOT injected into the guard, which
continues to project from its own recorded spend.

The next task settled the question. django-13658's pair cost $0.45, the running
average fell from $1.8532 to $1.0397, and the projection fell from $44.48 to
$24.95 — inside the original $35. The stop was a first-task-ordering artifact of
a two-sample average, and the record keeps both the stop and its cause rather
than only the outcome.
