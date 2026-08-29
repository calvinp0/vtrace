# M183 — architecture decision

## The decision

**Keep the current compact orientation unchanged. Do not tune it against these
results. Do not launch a 100-task confirmation.**

`CURRENT_PRODUCT_UTILITY_NEUTRAL` — §110 D, and per §125 that is a meaningful
negative result rather than a measurement failure.

## What the experiment established

Resolution is **exactly** at parity: 19/30 both arms, 17 both-solved, 2 unique
wins each way, 9 neither. Exact McNemar on the 4 discordant pairs gives p = 1.000.
Whole-run tokens and cost are neutral, with intervals straddling zero and the
aggregate cost delta ($0.05 on $19) so small that the ten tail pairs account for
19× it.

The apparatus was clean: 60/60 arms, 30/30 valid pairs, orientation delivered on
30/30 treatment arms and absent on 30/30 baseline arms, arm difference proved to
be one environment variable.

## Why this is not "the orientation is too small"

The obvious reflex — the packet is a median 580 tokens, make it bigger — is
specifically forbidden by §123/§124, and the evidence says it would be aimed at
the wrong thing.

**Localization was not the bottleneck.** The orientation named a gold file on
21/30 tasks and its focus *was* a gold file on 19/30. The treatment arm edited the
focus on 17/30 and reached orientation evidence on 22/30. Those are healthy
numbers, and they did not convert:

- **6** tasks where the focus was the gold file and the treatment arm still failed
- **6** tasks where the focus was *not* the gold file and the treatment arm solved anyway

Those two counts are the whole finding. Knowing where to look was not what
separated a solve from a failure on this sample.

**The baseline found the same files anyway.** Baseline reached the same
orientation-named files on 21/30 against the treatment's 22/30 — a difference of
one task. The orientation arrived sooner (median 0 tool calls to first contact
against 1) but it was not arriving with information the baseline could not get.

That is the same shape M164 reported: strong localization, delivered evidence,
and no unique wins, because a capable coding agent recovers equivalent evidence
cheaply on its own.

## Why the displacement did not pay

Investigation *was* displaced, and measurably:

| | baseline | VTRACE | paired median delta |
|---|---|---|---|
| tool calls before first edit | 6 | 4 | −1 |
| searches before first edit | 2.5 | 1 | −1 |
| reads before first edit | 2 | 2 | 0 |

So the packet did what it was designed to do. It removed roughly one search and
two tool calls of early investigation — and that is worth far less than it
sounds, because M169 already priced pre-edit investigation at fractions of a cent
against run totals in the hundreds of thousands of tokens. The saving is real and
it is immaterial to the bill.

## The causal reading of the four discordant pairs

None supports a causal claim in either direction.

| task | winner | focus gold? | orientation used? | classification |
|---|---|---|---|---|
| astropy-14369 | VTRACE | no | no | NOT_DETERMINABLE |
| django-12325 | VTRACE | no | no | NOT_DETERMINABLE |
| requests-5414 | baseline | yes | yes | REPAIR_STRATEGY_DIFFERENCE |
| pytest-6197 | baseline | no | no | NOT_DETERMINABLE |

Both VTRACE wins came on tasks where the focus was **not** a gold file and the
agent did **not** edit it — so the orientation cannot be credited. The one
baseline win where orientation was correct and used (requests-5414) failed at the
repair, not the localization, so VTRACE cannot be blamed either. `NO_CLEAR_
VTRACE_CAUSAL_UTILITY_EVIDENCE` in both directions, which is the honest reading
of 2-and-2 with no traceable mechanism.

## What is licensed next

`PRODUCT_FOLLOWUP_REQUIRED_BEFORE_SCALE`.

A larger confirmatory benchmark would buy precision on an effect that measured
zero, at roughly $1.28 a pair. That is the wrong purchase. §125 is explicit: high-
quality localization plus a compact stable orientation does not automatically
translate into agent utility, and the answer is not to micro-tune without a
measured bottleneck.

The measured bottleneck, insofar as M183 found one, is **repair and validation,
not localization** — 6 tasks with a correct focus that still failed, and 9 tasks
neither arm solved. That is where a future milestone should look, and it is a
different kind of work from retrieval.

## What must NOT happen next

- No retrieval or ranking change motivated by a task on this list (§18/§120).
- No enlargement of the orientation packet to chase the 6 correct-focus failures
  (§124 — inspect the mechanism first; the evidence says they are repair
  failures, not context failures).
- No 100-task run (§163).
- No external claim (§163).
