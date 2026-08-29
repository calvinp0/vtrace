# M183 — cost accounting contract

Frozen before any M183 live run existed.

## Authority

`costUsd` on the external harness's result row, per arm, per instance. It is
provider-derived and is the same field M168, M169, M173 and M174 used, which is
what makes M183's figures comparable to theirs. M183 does **not** reconstruct
cost from a pricing table, so §38's reconstruction clause does not engage.

One historical caution, recorded rather than corrected: M169 found one M168
`costUsd` computed at the wrong cache-write rate (pylint-4551, $3.04). If an
M183 row lands outside its arm's enforced $3 ceiling, it is a harness-arithmetic
defect and is flagged, not pooled.

## Definitions, made once

    RUN_COST      := costUsd of one completed arm
    PAIR_DELTA    := treatmentCost - baselineCost           (positive = treatment dearer)
    AGGREGATE     := sum over valid pairs, per arm
    COST_PER_SOLVED := aggregate arm spend / that arm's resolved count

`COST_PER_SOLVED` and `median run cost among solved` are different quantities and
are never used interchangeably (§96).

## What is included

The COMPLETE billed run, through the terminal model response or the declared
limit. Unsuccessful tails are included. §95: omitting the tails of failed
treatment runs is the specific way this measurement gets faked, and it is
forbidden here.

## Cost is not tokens

Reported separately, always. A lower dollar figure can come entirely from cache
reads being cheaper than cache writes, with no token reduction at all (§71).
M183 reports the four token components alongside cost so the reader can see which
happened.

## Outcome-conditioned reporting

Aggregate economics are also broken down by outcome class — both solved, both
failed, treatment-only win, baseline-only win — because M174 found 95.7% of a
paired cost premium concentrated in two runs, and a pooled headline had hidden
it (§100).
