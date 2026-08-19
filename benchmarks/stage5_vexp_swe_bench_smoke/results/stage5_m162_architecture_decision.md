# M162-E — architecture verdict

## Verdict

```text
CALLABLE_NEUTRAL
```

Specifically the low-adoption branch: **the agent never called the tools, so the
architecture's usefulness was never exercised.**

This is not "callable delivery of repository intelligence does not help." It is
"a coding agent given two correct, connected, permitted repository-intelligence
tools and a routing policy did not reach for them once in twelve tasks."

## The result

| | BASELINE | STATIC | CALLABLE |
| --- | --- | --- | --- |
| resolved | 7/12 | 8/12 | 8/12 |
| median cost | $0.473 | $0.557 | $0.514 |
| median processed tokens | 1,015,889 | 1,532,555 | 1,135,372 |
| median turns | 30 | 31.5 | 30.5 |
| median ordinary tool calls | 11 | 11 | 11.5 |
| median searches | 2.5 | 2 | 2.5 |
| median reads | 3 | 3.5 | 3 |
| **median VTRACE calls** | — | — | **0** |
| median first-edit position | 4 | 3 | 3 |
| median wall time | 94 s | 100 s | 118 s |

```text
tasks with ≥1 VTRACE call        0 / 12
tasks with 0 VTRACE calls       12 / 12
get_code_context calls           0
get_impact_graph calls           0
composition events               0
first-call timing                NEVER_USED × 12
```

36/36 arms completed, 0 failures, 0 infra retries, 0 reruns. $23.94.

## Why this is a real finding and not a broken arm

The distinction M162-C was built to preserve decides this milestone, and the
pilot's own first arm proved it was not theoretical — that run was untooled
because of a patcher defect and looked exactly like zero adoption. Every claim
below is therefore evidenced per run, not inferred from the empty call list:

```text
MCP config marker fired                     12 / 12
"config MISSING" marker                      0
vtrace server connected (own init event)    12 / 12
exactly 2 VTRACE tools visible              12 / 12
--allowedTools permitted both               12 / 12
per-task workspace correctly bound          12 / 12
```

And Gate 1 established, on the real runtime, that an agent given these same two
tools **can** discover them, call them, receive a canonical method identity, and
pass it byte-for-byte into the second tool. The capability is present. It was
not used.

One further piece of evidence, and the sharpest one: across all twelve CALLABLE
runs, the agents' visible reasoning contains **zero mentions** of `vtrace`,
`get_code_context`, `get_impact_graph`, or the routing policy. They did not
consider the tools and reject them. The tools appear not to have entered
consideration at all.

## The one discordant task, and what it is not

`sympy__sympy-14976` — baseline failed, STATIC and CALLABLE resolved.

It is labelled `VTRACE_BOTH_WIN`, and that label is misleading here. CALLABLE
made **zero** VTRACE calls on it and received no capsule, so its treatment
content was identical to BASELINE's. A "VTRACE win" on an arm that received no
VTRACE input is agent variance, and it is reported as variance. The same caution
applies to CALLABLE's 8/12 against BASELINE's 7/12: with an identical
information diet, a one-task gap is noise.

The honest reading of the capability comparison is that **CALLABLE and BASELINE
are the same experiment**, and they differed by one task.

## Did callable interaction reduce the static-context tax?

Not answerable from this pilot, and the reason matters.

```text
STATIC   median injected capsule        1,937 tokens, re-read every turn
CALLABLE fixed (schema + policy)        2,065 tokens, re-read every turn
CALLABLE dynamic (tool results)             0 tokens
```

CALLABLE carried a **larger** fixed prefix than STATIC's capsule and fetched
nothing with it. It paid the schema tax and bought no evidence. That is the
worst cell of the economics table, and it is exactly what the pre-registered
accounting was shaped to expose: the 2,065 < 3,062 comparison I was warned not
to make would have been wrong twice over — wrong because 2,065 > 1,937 on this
corpus, and wrong because fixed cost alone was never the question.

CALLABLE's median processed tokens sit between BASELINE and STATIC, consistent
with "baseline behaviour plus an unused tool schema."

STATIC did not reproduce M161's orientation-efficiency effect on this corpus:
turns, searches, and tool calls are flat against BASELINE, and cost is slightly
higher. M161's efficiency finding does not generalize here.

## Answers to the standing questions

**Does VTRACE become more useful when repository intelligence is agent-initiated
rather than statically injected?** Unknown. Agent-initiated retrieval was never
initiated.

**Did callable VTRACE improve capability, efficiency, or both?** Neither. One
task separates it from baseline, on an identical information diet.

**Did callable delivery reduce repeated-context token overhead?** No. It
replaced a 1,937-token capsule with a 2,065-token schema-and-policy prefix and
fetched nothing.

**Did agents naturally understand when to use VTRACE?** No — and more precisely,
they gave no sign of having considered the question. Under a neutral,
non-coercive routing policy, tool adoption was zero.

## What this does and does not license

It does **not** license concluding that repository intelligence fails to help an
agent, because no agent consulted it.

It does **not** license a retrieval milestone. §92's precondition — agents
requesting the right concept and receiving the wrong evidence — did not occur.
There were no requests.

It does license one clear statement: **on a frozen SWE-bench-style task, a
capable coding agent with ordinary tools does not spontaneously reach for an
unfamiliar repository-intelligence MCP server, even when it is connected,
permitted, described, and accompanied by a workflow policy telling it when each
tool applies.**

## Recommended next step

**Tool-policy ablation, as a controlled experiment** — the roadmap item M162
deliberately deferred, which this result now makes the only informative next
move:

```text
arm 1  tools only                        (this pilot: 0 adoption)
arm 2  tools + neutral usage policy      (this pilot's suite policy: 0 adoption)
arm 3  tools + task-level instruction to consider them
```

Gate 1 is the existence proof that arm 3 works mechanically: with an explicit
instruction, the same agent discovered, called, and composed both tools on the
first attempt. What is unknown is whether an agent that is *prompted* to consult
VTRACE then solves more, or solves the same tasks more cheaply — and that is the
question M161 and M162 have both been circling without reaching.

Two subordinate options, both weaker:

- **Hybrid seed.** A tiny turn-0 map naming what VTRACE can answer, plus callable
  tools. Tests whether the failure is salience rather than willingness.
- **Do not pursue callable delivery further** until adoption is demonstrated. On
  this evidence it costs a schema prefix and returns nothing.

What should **not** happen next is a larger callable qualification. Running 100
tasks to observe zero adoption more precisely would buy nothing.
