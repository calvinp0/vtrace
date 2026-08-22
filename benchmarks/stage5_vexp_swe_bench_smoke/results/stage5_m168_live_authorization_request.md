# M168-E live authorization request

**Nothing has been spent. Nothing live has been run. This is the ask.**

## What the experiment now is

> Does the VEXP-published coercive investigation policy change the utility or
> economics of VTRACE's already-qualified `run_pipeline` treatment?

This tests the **policy mechanism** the public VEXP benchmark code implements,
with VTRACE as the intelligence engine. It does **not** reproduce, and makes no
claim to reproduce, the historical VEXP 73%.

M168-A/B conclusions are preserved unchanged and are not re-litigated here:

```text
historical VEXP grading result              REAL
historical intended-treatment compliance    NOT SUPPORTED BY COMMITTED TELEMETRY
paired historical no-VEXP baseline          ABSENT
accounting                                  ACCOUNTING_DEFINITION_GAP_CONFIRMED
Broad100-A                                  EXACT VEXP 100-TASK MANIFEST
```

## The three arms

| | A BASELINE | B VTRACE_STRICT | C VTRACE_CLEAN |
|---|---|---|---|
| VTRACE MCP server | — | yes | yes |
| visible tools | none | `run_pipeline`, `get_impact_graph` | identical to B |
| pipeline-first mandate | — | yes | yes, byte-identical to B |
| VEXP prohibition text | — | **yes** | — |
| `Grep\|Glob` denial hook | — | **yes** | — |
| normal tools | Edit Write Bash Read Glob Grep TodoWrite | same | same |

**B and C differ by 191 characters and one hook. Nothing else.** The isolation
invariant is checked in code, not asserted: identical MCP config hash, identical
tool inventory, identical allowed-tools list, and `strict − prohibition == clean`
byte-for-byte. The protocol freeze refuses to write itself if any of that fails.

```text
primary     B vs C   does coercion change work, economics or outcome?
secondary   C vs A   clean pipeline utility
            B vs A   full VEXP-shaped scaffold utility
```

## The sample — selected and frozen before the arms were materialised

Twelve tasks drawn from the frozen public VEXP manifest (sha256 verified against
M168-A before drawing), one per repository, spread across the complexity range,
seed 42. Selection read only `repo`, FAIL_TO_PASS count and gold patch size —
all published with the task, none of them an outcome of any treatment.

```text
astropy__astropy-14369             astropy/astropy              cx  99   1-4 hours
django__django-13658               django/django                cx  19   15 min - 1 hour
matplotlib__matplotlib-22719       matplotlib/matplotlib        cx  16   <15 min fix
mwaskom__seaborn-3187              mwaskom/seaborn              cx  36   15 min - 1 hour
pallets__flask-5014                pallets/flask                cx  15   <15 min fix
psf__requests-1724                 psf/requests                 cx  67   <15 min fix
pydata__xarray-6599                pydata/xarray                cx  18   15 min - 1 hour
pylint-dev__pylint-4551            pylint-dev/pylint            cx 234   1-4 hours
pytest-dev__pytest-7432            pytest-dev/pytest            cx  15   <15 min fix
scikit-learn__scikit-learn-10844   scikit-learn/scikit-learn    cx  17   15 min - 1 hour
sphinx-doc__sphinx-7462            sphinx-doc/sphinx            cx  44   <15 min fix
sympy__sympy-13480                 sympy/sympy                  cx  14   <15 min fix
```

id-list sha256 `ecdba7c4a32a3abd…` · the other **88 tasks are untouched holdout**,
never read by this experiment.

One task is worth flagging in advance rather than after the fact: `sphinx-7462`
is a known Stage 5 hard case whose gold spans a file a python.py-only patch can
never reach. It stays in. Selection was treatment-independent and removing a task
because we expect it to fail would be exactly the contamination §25 forbids.

## Smoke controls — 9 pass, 0 fail, 5 need a live agent

Run against `astropy__astropy-13977`, which is in Broad100-B and therefore in
neither the twelve nor the eighty-eight.

```text
PASS   baseline carries zero VTRACE env, config, policy, hook or tool
PASS   only the strict arm registers a PreToolUse hook
PASS   B and C get the identical MCP config and tool inventory
PASS   the policy files differ by exactly the 191-char prohibition
PASS   the hook matcher is exactly "Grep|Glob" — not Bash, not Read
PASS   the guard denies with exit 2 when .vtrace/index.sqlite exists
PASS   the guard allows when it does not, as VEXP's does, and logs both
PASS   the server serves exactly run_pipeline + get_impact_graph
PASS   the mandated first call returns 19,387 chars of real evidence
```

Still outstanding, and honestly named rather than skipped:

```text
NOT_RUN  does the agent actually call the mandated tool first?
NOT_RUN  does the hook deny a Grep the agent actually attempted?
NOT_RUN  does the baseline transcript contain zero VTRACE schemas?
NOT_RUN  does the model see WHY a search was denied?
NOT_RUN  what does one run of each arm actually cost?
```

That fourth one matters more than it looks. VEXP's hook prints its reason to
**stdout** and exits 2; whether Claude Code surfaces stdout to the model on a
PreToolUse denial is UNKNOWN. If it does not, arm B's agent learns only that
something was blocked, and may retry blindly — which would change the very
economics the experiment measures. The published behaviour is reproduced exactly
rather than "fixed", and the first live runs will tell us which world we are in.

## Cost

Estimated from M164's 24 runs on this harness — same model, same runner, same
sequential protocol:

```text
M164 observed        mean $0.7992/run · median $0.6470 · p90 $1.5531 · max $2.0200
M168 estimate        36 runs x $0.80  =  $28.77
p90-weighted         36 runs x $1.55  =  $55.91
theoretical maximum  36 runs x $3.00  = $108.00   (per-run cost limit)
```

The sample is harder than M164's on average (pylint-4551 at complexity 234,
astropy-14369 at 99), and arm B may cost *more* rather than less if denied
searches convert into extra turns — that is a measurement, not an overrun.

```text
requested hard cap   $50.00
```

Enforced before every spawn by the driver's cost guard, against actual recorded
`costUsd` plus a running-average projection for the arms not yet run. If the
projection would breach the cap the sweep stops and reports; it never raises it.
A sweep stopped by the cap reports which pairs are incomplete rather than
imputing them.

Docker grading is a separate step afterwards, costs no model tokens, and uses the
same official evaluator for all three arms.

## Standing controls carried in

```text
mandatory env guard + drift check (M89)      fails closed before spawn
mandatory agent shell guard / pip firewall (M90A)
sequential execution                          the shared agent stream forbids parallelism
frozen VTRACE commit for the whole window     no retrieval, ranking, composition,
                                              budget, schema or rendering change
rerun policy frozen                           stage5_m168_rerun_policy.md
arm order rotated by task position            no arm systematically leads
```

## What I need

Approval to spend up to **$50.00** on **36 live runs** (12 tasks × 3 arms), plus
the subsequent Docker grading pass.

I will stop and report if the cost guard binds, if any arm's smoke control fails
in anger, or if the apparatus turns out to be defective — preserving the original
artifacts rather than silently fixing and continuing.
