# M173 — compact automatic orientation, live requalification

**MIXED. 24/24 runs, 12/12 balanced pairs, $17.83 live. The orientation is now
almost free, almost always right, and directly used — and it changes nothing.
Cost was not the thing preventing automatic orientation from being useful.**

```text
A PASS   protocol frozen, accounting discriminates, 12/12 positive control
B PASS   24/24 runs, 12/12 balanced pairs, 119 gates pass / 0 fail / 1 unobservable
C PASS   authoritative grades, M169 diagnostic recomputed, economics complete
D PASS   use and pivot causality classified from frozen rules, wrong pivots not causal
E PASS   verdicts reached and stated

architecture   COMPACT_AUTOMATIC_ORIENTATION_UTILITY_NEUTRAL
economics      ECONOMICALLY_NEUTRAL
utility        UTILITY_NEUTRAL
M169 null      M169_ECONOMIC_NULL_WEAKENED
product        KEEP_COMPACT_ORIENTATION_DEFAULT
pivot work     PIVOT_CORRECTNESS_NOT_LICENSED
extension      ECONOMIC_DIAGNOSIS_REQUIRED
```

## The headline

M169 answered *the old rich automatic pipeline was too expensive to justify
itself*: $0.0985 a task to displace $0.0026, a ratio of 38. M172 answered *the
same authoritative intelligence fits in a twelfth of the tokens*. M173 asked the
question those two set up:

> Was cost the thing preventing automatic orientation from being useful?

**No.**

```text
                                 M169 (rich)      M173 (compact)
orientation attributable cost    $0.0985 / task   $0.0106 / task     9.3x cheaper
investigation displaced          $0.0026 / task   $0.0109 / task     4.2x more
whole-run investigation net      -$0.0070         +$0.1220           direction reversed
aggregate economic ratio         38x              1.0x
economic classes                 0 win / 10 loss  4 win / 7 loss
```

Every economic quantity M169 condemned moved, most of them by an order of
magnitude, and one of them changed sign. The orientation now costs almost
exactly what it displaces.

And the outcome is unchanged:

```text
baseline resolved        7/12
compact VTRACE resolved  7/12
shared success           7
shared failure           5
baseline unique wins     0
VTRACE unique wins       0
```

Not 7 and 7 by coincidence of totals — **the same seven tasks**, task for task.
Twelve paired runs produced twelve identical verdicts.

## The treatment was delivered, and it was the right one

Every §70 and §71 control holds, so the null is a measurement rather than an
apparatus artifact.

```text
disclosure the model received      COMPACT_ORIENTATION 12/12, fallback 0
orientation model-visible tokens   median 629, p90 754, min 476, max 1011
                                   (M172 projected 621)
detail=debug requested by agent    0/12
authoritative payload ever seen    0/12
first repository action            run_pipeline on 11/12; 1 ordinary action on the twelfth
voluntary follow-up VTRACE calls   0/12
baseline vtrace tools / servers    0/12 and 0/12
observed tool inventory            exactly the two frozen tools, all 12
sessions                           24 distinct, no cross-arm contamination
```

The orientation was also *correct*. Its focus file was a gold-patch file on
**11 of 12** tasks, and the agent edited that focus file on **10 of 12**.

```text
orientation use    DIRECTLY_USED 10   IGNORED 2   MISLEADING 0
focus is gold      11 correct / 1 wrong / 0 unobservable
pivot consequence  PIVOT_WAS_CORRECT 11   IGNORED_OR_RECOVERED 1
                   CAUSED_WRONG_EDIT 0   CAUSED_EXTRA_INVESTIGATION 0
```

This is the strongest delivery result any milestone in this arc has produced,
and it makes the null much harder to explain away. The agent was handed the
right file, at the right symbol, for a tenth of the old price, and it was
already going to reach that file.

## Offline projection transferred

```text
M172 projected orientation cost   $0.0084
M173 actual median                $0.0111       ratio 1.33x
M172 projected median tokens      621
M173 actual median tokens         629           ratio 1.01x
```

The token projection is essentially exact. The dollar figure runs 33% high
because M172 priced the packet's own tokens and the live figure also carries
amplification — every later request re-reads the packet as cache. That gap is
explained, not residual.

## The premium that did not go away

The treatment still costs more:

```text
median whole-run cost      A $0.2681   B $0.4081
total whole-run cost       A $5.5876   B $9.2276
median paired delta        +$0.0563
mean paired delta          +$0.2001
p90 paired delta           +$0.7146
worse on                   9 of 11 measurable pairs
```

The mean is four times the median: two tasks carry the tail. §42 requires
reporting that rather than the average alone.

And it is **not** the packet. Splitting each run at its own first and last edit:

```text
                  median Δ$     total Δ$
pre-edit          +0.0647       -0.0460      (treatment cheaper in aggregate)
implementation    +0.0008       +1.4622      (the entire premium, and more)
debug / test      +0.0086       -0.0342
```

The premium lives almost entirely in the implementation phase, whose *median* is
$0.0008 — it is a two-case tail, not a shift.

## What those two cases look like

```text
Spearman(Δ pre-edit requests, Δ whole-run cost)   -0.682
Spearman(Δ pre-edit requests, Δ post-edit requests) -0.627
```

Negative means: **the further ahead the treatment arm's first edit is, the more
the whole run costs.**

```text
treatment edited EARLIER (n=2)
  astropy-14369   Δpre -3 requests   Δpost +19   Δcost +$0.7146
  xarray-6599     Δpre -6 requests   Δpost +13   Δcost +$0.7301
  median Δcost                                   +$0.7224

treatment did not (n=9)
  median Δcost                                   +$0.0292
```

The hypothesis this supports: **the orientation does not remove the work of
understanding; it lets the agent begin editing before that work is done, and the
work reappears afterwards at a higher price.** On the two tasks where the packet
most successfully shortened the approach, the run then ran 19 and 13 requests
longer and cost roughly $0.72 more — and on xarray both arms solved it anyway,
so the extra spend bought nothing.

**This is SUGGESTIVE, NOT ESTABLISHED, and the two cases do not agree with each
other.** On astropy the orientation was correct and `DIRECTLY_USED`; on xarray it
was the one wrong pivot and was `IGNORED`. If early editing were purely an
orientation effect, the ignored case should not show it — so either the packet
shortens the approach even when its focus is rejected, or one of the two is
ordinary agent variance wearing the same shape. The correlation is over 11 pairs
with 2 in the earlier-edit group, which cannot separate those. It is the
mechanism most consistent with the measurements and the shape a larger
qualification should be built to confirm or kill. It is not a finding to spend
retrieval budget on.

## Searching fell everywhere, and it did not matter

```text
searches       total A 38   B 25        B lower on 8/11, higher on 0/11
median         A 1.5        B 1.0
pre-edit investigation cost   total A $1.0581   B $0.8404
```

The mandate reduces searching on every task where it moves at all — M168-E's
finding, reproduced without any coercion. M168's permanent lesson still governs
the reading: fewer searches are not savings, and here the $0.218 of investigation
genuinely displaced is swamped by $1.46 of implementation-phase spend.

Rediscovery, under rules frozen before the runs existed:

```text
TARGETED_CONFIRMATION    39     the packet named it; opening it is consumption
REDUNDANT_REDISCOVERY     4     a search for what had already been delivered
NEW_INFORMATION_SEARCH   53     work the orientation did not do
```

Redundancy is 4 of 96 post-orientation investigation actions. §33's warning was
worth heeding: almost none of the agent's verification is waste, so there is
almost no waste to recover.

## Wrong pivots are not the story

The standing instruction was explicit — if M173 is neutral, prove from the live
traces that wrong pivots caused the losses before touching retrieval again.

They did not. One pivot of twelve was wrong — xarray-6599, where the projector
focused `xarray/core/combine.py` and the gold patch is elsewhere. The agent
ignored it, went its own way, and **solved the task**. Zero pivots caused a wrong
edit and zero caused extra investigation.

```text
PIVOT_CORRECTNESS_WORK_LICENSED   NO
```

All five shared failures — astropy-14369, seaborn-3187, requests-1724,
pylint-4551, sphinx-7462 — failed in **both** arms, and every one of the five
received a **correct gold pivot**; four of the five edited it. The retrieval did
its job on all five and the task was lost anyway. sphinx-7462 failed exactly as
its standing finding predicts, which is a useful check that the grader still
discriminates.

## Verdicts

**`COMPACT_AUTOMATIC_ORIENTATION_UTILITY_NEUTRAL`.** Same solve set, task for
task, with the orientation correct on 11/12 and directly used on 10/12.

**`ECONOMICALLY_NEUTRAL`.** The orientation now pays for itself at the margin it
was designed to serve — ratio 1.0 against M169's 38, whole-run investigation
displaced $0.122 where M169 measured −$0.007 — while whole-run cost stays higher
by a $0.056 median. Cheap and neutral, not cheap and positive.

**`M169_ECONOMIC_NULL_WEAKENED`**, not reversed. M169's specific claim — that the
first call costs 38× what it displaces — is dead. Its conclusion, that the
proactive pipeline does not pay for itself on this population, survives for a
different reason than the one M169 gave.

**`KEEP_COMPACT_ORIENTATION_DEFAULT`.** §78 is directly on point: do not roll
back merely because solves are tied when the economics are substantially better
and no regressions appear. Nothing regressed — no unique baseline win, no
misleading pivot, no debug leak, no fallback — and the default is an order of
magnitude cheaper than what it replaced. Rolling back would restore the payload
M169 condemned in exchange for nothing.

**`ECONOMIC_DIAGNOSIS_REQUIRED`**, not a larger qualification. A 100-task sweep
of a treatment with a two-case cost tail and a zero-case outcome effect would buy
precision about a null. What is worth knowing first is whether the
implementation-phase premium is real and whether early editing causes it.

## What M173 answers, plainly

> **Did reducing the orientation from ~6.9k tokens to ~629 tokens change actual
> end-to-end economics?**

Yes, decisively, at the first call: 9.3× cheaper, displacing 4.2× more, ratio 38
→ 1.0, whole-run investigation displacement reversed in sign. And no, at the
whole run: the treatment still costs a $0.056 median more.

> **Does it displace enough investigation to justify its automatic fixed cost?**

At the pre-edit margin, yes — for the first time in this arc. The orientation
costs $0.0106 and displaces $0.0109. That is the break-even M169 said no payload
size could reach.

> **Does it improve, preserve, or hurt solve outcomes?**

Preserve, exactly. The same seven of twelve.

> **Where it fails, are wrong pivots causal?**

No. 11/12 pivots correct, 0 causal consequences, all five failures shared.

> **Should compact automatic orientation remain the default?**

Yes. It is strictly better than what it replaced and worse than nothing only by
a margin that no longer comes from the packet.

## The one that got away, and it is not retrieval

The remaining question is not what VTRACE delivers — it delivers the gold file,
compactly, and the agent uses it. It is what the agent does with the time the
orientation saves it. On nine tasks: nothing much, $0.029. On the two where the
saving was largest: it started editing sooner and paid $0.72 more finishing.

If that is real, no orientation product fixes it: on astropy the packet was
correct and used, and the run still ran nineteen requests longer. That is a
question about whether an agent that is told where to look still needs to look —
and it is answerable offline against these twenty-four transcripts before any
further live budget is spent.

## Provenance

```text
product            9242d879, src clean throughout, no product change during the sweep
sample             the exact frozen M168/M169 twelve, sha256 ecdba7c4…, nothing dropped
treatment prose    byte-identical to M168's clean arm (sha256 asserted at freeze)
accounting         m169Economics, dedup on message.id; identity holds 35/35 on the
                   reference corpus and 0/35 on the naive path it must fail
live spend         $17.83 of a $45 authorised cap (raised once from $35 by the owner,
                   after the frozen guard stopped the sweep on a one-pair average)
reruns             4 baseline arms, ENOSPC before agent spawn, $0.00 billed, §61 infrastructure
censored           pylint-4551 baseline, no result event — 11 measurable economic pairs of 12
n                  12 paired tasks. Mechanistic qualification and paired-sample evidence.
                   Not population-wide solve-rate proof.
```
