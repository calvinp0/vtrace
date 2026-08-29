# M183 — VEXP positioning

## The required answer (§146)

**Does M183 support saying VTRACE has a VEXP-class value proposition — comparable
quality with lower resource usage?**

**Not yet.** `VEXP_CLASS_VALUE_PROPOSITION_NOT_YET_SUPPORTED`.

The quality half holds: 19/30 against 19/30, exact parity. The economics half
does not. Aggregate cost was $19.19 for VTRACE against $19.14 for baseline — a
0.21% *increase*, not a reduction. Whole-run tokens moved 5.26% in VTRACE's
favour on the pooled view, but the paired bootstrap interval spans
[-166,320, +242,363] tokens and straddles zero comfortably.

A VEXP-class claim requires comparable quality **plus** lower resource usage.
M183 measured the first and did not find the second.

## What M183 may not be compared to

M183 is **not** a VEXP benchmark. The published VEXP headline was 73/100 resolved
at ~$0.67/task against Live-SWE-Agent's 72/100 at ~$0.86 — a different harness, a
different model, a different task count, and a different protocol. M183 ran 30
paired tasks on `claude-opus-4-5-20251101` through this repository's own harness.

Nothing here licenses "VTRACE beats VEXP" or "VTRACE matches VEXP". M183 was not
designed to provide matched evidence and does not provide it.

The one structural connection is the sample: M183's tasks are drawn from
Broad100-A, the mechanically reconstructed VEXP-compatible hundred, whose
selection provenance (12 repositories, proportional allocation, complexity
quintiles, seed 42, ceiling ≤250) is preserved from M160. Drawing from a
compatible pool is not reproducing a benchmark.

## The required marketing-honesty answer (§145)

**If we advertised a token reduction from this experiment, what denominator would
it use?**

There are three candidates and they are not interchangeable.

| Reduction concept | Baseline denominator | Reduction |
|---|---|---|
| Repository context / orientation | **NOT MEASURABLE** | **NOT MEASURABLE** |
| Complete agent tokens | 33.4M pooled | 5.26% pooled, not statistically resolved |
| Complete agent cost | $19.14 pooled | −0.21% (an increase) |

The first row is the one a marketing claim would reach for, and M183 refuses to
fill it. The baseline arm has no repository-context artifact to measure: it
investigates with Read and Grep, which is not a payload with a token count.
Inventing a "full repository" or "naive full-file" denominator would manufacture
a large percentage out of a quantity the baseline never spent. The product's own
`estimatedNaiveFullFileTokens` is a compression claim about *selected files* and
is not a claim about what the baseline agent actually used.

**So the only honest headline available from M183 is the whole-agent-run one, and
it is 5.26% pooled with an interval that includes zero.** That is not a
publishable reduction claim.

## What could be said truthfully

- "Current VTRACE orientation costs a median of 580 model-facing tokens and did
  not change SWE-bench solve rate on 30 paired tasks (19/30 vs 19/30)."
- "It reduced pre-edit investigation: median 4 tool calls before the first edit
  against 6, and 1 search against 2.5."
- "Those savings did not reach the whole-run bill."

Each of those is measured. None of them is a VEXP-class claim.
