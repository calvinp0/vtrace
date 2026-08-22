# M172 — the bound that was never wired

```text
M172 overall:            PASS

A:                       PASS   the bundle taken apart; the defect found
B:                       PASS   policy frozen on the defect, before any holdout
C:                       PASS   five controls, measured not asserted
D:                       PASS   every gate, on both corpora
E:                       PASS   shipped

orientation verdict:     MINIMUM_SUFFICIENT_ORIENTATION_CONFIRMED
                         (against the frozen offline gates; NOT a solve-rate claim)
economics verdict:       PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED
product verdict:         DEFAULT_ORIENTATION_REDESIGN_SHIPPED

product changed:         YES  — run_pipeline's DEFAULT disclosure
retrieval changed:       NO   — no ranking, scoring, candidate or selection change
authoritative state:     UNCHANGED — detail=debug returns what it always returned

current default median model-visible tokens:   6,766 dev / 6,884 B
selected orientation median:                     603 A / 621 B / 544 dev
selected orientation p90:                        850 A / 865 B
projected attributable cost:                  $0.0081 A / $0.0084 B
M169 baseline localization reference:         $0.0524 median, gate $0.0262
pivot identity:                               99/99 A, 98/98 B, 12/12 dev
action-support preservation:                  7/7, inherited by construction
                                              (209/209 packets are supersets of
                                               M171's, with identical focus)
Broad100-A:                                   every gate; gold symbol 0.00pp
Broad100-B:                                   every gate; gold symbol 0.00pp
unsupported claims:                           0 over 234 audited packets
false absence:                                0
debug preservation:                           ~80 consumer tests assert the full
                                              authoritative result at detail=debug
live spend:                                   $0.00
live requalification:                         LICENSED, NOT REQUESTED, NOT RUN
```

---

## What M172 asked

M171 built a projector that cut the response elevenfold and then declined to ship
it, because gold-symbol delivery on Broad100-A fell 3.00 percentage points
against a 2-point gate frozen before the holdout ran. Three cases. In each, the
gold symbol sat at authoritative position six or seven in a packet that named
six, inside files the packet still delivered. R2500 — a rung with a cap of seven
— would have recovered all three, and adopting it after seeing that would have
been choosing a parameter because it fixed the holdout.

M171's own recommendation was to settle what the bound should be on development
evidence, and only then look at a holdout again. That is M172.

## A — the bundle, taken apart

M171's dose was four rungs, each a bundle of three parameters that moved
together:

```text
R1000   ceiling 1000   focusChars  700   relatedCap 2
R1500   ceiling 1500   focusChars 1200   relatedCap 3
R2000   ceiling 2000   focusChars 1800   relatedCap 5     <- frozen by M171
R2500   ceiling 2500   focusChars 2400   relatedCap 7
```

A bundle cannot tell you which of its parameters caused an effect. Separating
them on the same twelve development captures produced two findings.

**The ceiling was never a bound.** `Rung.ceilingTokens` is declared on the
interface, set on all four rungs, and read by nothing: `projectOrientation`
consults `focusCodeCharacters` and `relatedCap` and nothing else. M171's standing
finding that "the ceiling is inert" understated what had happened — the ceiling
was not inert, it was absent. Measured post hoc it would not have bound anyway:
at R1000, the smallest rung, every development packet leaves at least 459 tokens
of headroom.

**The count cap bought nothing.** Delivering the *full* authoritative related
supply costs a median of 544 and a maximum of 947 model-visible tokens —
identical at median, p90 and max to capping at five — while withholding 5
authoritative entries across 4 of the 12 cases. The cap was standing proxy for a
cost constraint that had more than a thousand tokens spare.

So the packet was bounded once, by an undeclared parameter, while the declared
one was documentation.

A third finding closed off the obvious alternative. Entries rendered as *"in the
same file as the focus symbol; no indexed relationship to it"* — proximity, not
relation — appear 6 times across 3 development cases, always inside the first
five slots. It looks like filler occupying slots a real relationship could use.
It is not: **no proximity-only entry ever precedes a real relationship**, on any
case. They pad the tail to exactly the cap. Excluding them would displace nothing
and rescue nothing.

## B — freezing on the defect, not on the outcome

Development cannot choose between the candidates. `P_M171_R2000`, `P_SUPPLY` (no
count cap) and `P_RELATION` (no cap, no proximity entries) score **identically**
on every outcome metric over the twelve cases: gold file 83.3%, gold symbol
33.3%, 38 files delivered, pivot identity 100%. A policy chosen on those numbers
would have been chosen on noise — which is exactly how M171's development slice
showed 0.00pp where the 88-case remainder showed −3.41pp.

So the policy was frozen on the architectural defect instead, which is visible
without reference to any delivery metric:

```text
P_SUPPLY
  ceilingTokens              2000    enforced
  focusCodeCharacters        1800
  relatedCap                 null    removed
  excludeUnrelatedNeighbors  false
```

The count cap goes; the declared ceiling becomes real, checked against the
assembled packet rather than an estimate of one. The focus and the
interpretation-critical notes are never subject to it — a claim that cannot be
rendered truthfully is omitted rather than weakened, and a packet whose qualifier
was evicted for budget is precisely the overstrong rendering that rule exists to
prevent.

`stage5_m172_frozen_policy.json` was written before any holdout capture was
opened, and discloses what it would be fair to hold against it: on development,
where supply never exceeds 7, P_SUPPLY delivers exactly what a cap of 7 would
deliver — and 7 is R2500's cap, the value M171 declined to adopt. P_SUPPLY is
nevertheless not a cap of seven. It is the absence of a cap.

`P_RELATION` was rejected, not deferred: excluding proximity entries displaces
nothing (proven above) and would have bundled a second semantic change into the
holdout for about 48 development tokens, weakening attribution of whatever the
holdout then showed.

## C — making a promoted bound earn the promotion

Four of the five controls would have passed vacuously against M171's projector,
because a bound that is never applied cannot be observed misbehaving. They are
written against a synthetic supply large enough to reach the ceiling.

```text
1  the ceiling constrains          admission stops at supply 46, delivering 45
2  below it, nothing is capped     all supply delivered whenever it fits
3  deterministic and truthful      234 packets, 0 violations, no mutation
4  raising it removes nothing      evidence sets nested across 7 ceilings
5  unused capacity attracts none   byte-identical at 2000, 2500, 5000, 20000, MAX
```

Control 5 is the direct answer to M166, where removing diagnostics caused the
packer to refill the freed envelope. This projector cannot: it has no notion of
remaining space, so there is nothing for freed space to attract. What ends a
packet is the authoritative supply running out, not a budget being reached.

The real corpus never approaches the bound — median 572 tokens, minimum headroom
1,053 — so the ceiling is genuine but idle. **The packet is supply-bound.**

## D — the holdout, once

One policy, evaluated once, frozen beforehand.

| gate | **Broad100-B** | Broad100-A full | A-remainder (88) |
|---|---|---|---|
| median tokens ≤ 2000 | **621** | 603 | 606 |
| p90 ≤ 2500 | **865** | 850 | 840 |
| projected cost ≤ $0.026219 | **$0.0084** | $0.0081 | $0.0082 |
| pivot identity 100% | **98/98** | 99/99 | 87/87 |
| gold file ≤ 2pp regression | **0.00pp** | 0.00pp | 0.00pp |
| gold symbol ≤ 2pp regression | **0.00pp** | 0.00pp | 0.00pp |
| soundness violations 0 | **0** | 0 | 0 |

Broad100-A recovers exactly what M171 lost: gold symbol goes from −3.00pp to
0.00pp full, and −3.41pp to 0.00pp on the remainder. But **A is not the
evidence.** It was contaminated twice over — it contains all twelve development
cases, and M171 published which three of its cases failed and at what positions.
Its licensing value was spent before M172 began.

**Broad100-B is the evidence**, and what it shows is quieter and better. M171's
cap withheld **66 authoritative related entries** there. M172 delivers all 66,
and gold file and gold symbol delivery do not move at all — 62.24% and 36.73% on
every arm — while the median packet costs 621 tokens. The 66 entries bought no
measurable gold. That is the point: removing the cap is safe rather than clever.
It costs nothing and it withholds nothing.

The pre-registered risk did not materialise. Holdout supply maxes at 9 on A and 8
on B, against a ceiling that does not engage until 46, so the packet remained
supply-bound on both corpora and never became envelope-bound.

## E — what shipped

```text
BEFORE
  authoritative result -> serialized almost whole -> agent
  22 keys, ~6,800 model-visible tokens, 895 characters of code inside 21,318

AFTER
  authoritative result -> stays server-side, complete, unchanged
        |
        v
  orientation projection -> focus, related, boundary, notes
        |
        v
  agent: ~610 model-visible tokens
```

`src/runPipeline/orientationProjection.ts` is the projector. One line in
`src/mcp/tools.ts` decides disclosure, after the authoritative result exists:

```ts
const orientation = detailRequested === McpResponseDetail.Debug
  ? null
  : projectRunPipelineOrientation(authoritativeResult);
return { ok: true, output: orientation ?? authoritativeResult };
```

There is no second pipeline and no new tool. `content[0].text` is
`JSON.stringify(output)` and `structuredContent` wraps the same value, so
compacting `output` compacts both transport channels at once — the packet cannot
be short in one channel and complete in the other.

**Failure states are never projected.** The projector returns null on anything it
is not defined over — unready repository, stale index, empty retrieval, delivery
failure — so those envelopes keep their reason, their readiness and their
`nextTool` at full fidelity. A compact success output does not license a vague
failure output. `get_code_context` needed the same rule: it post-processes the
delegated `productContext`, and now returns the projection untouched rather than
writing machine-facing freshness and timing records back into a packet made to
hold them back.

Two identity proofs stand behind the claim that the qualification transfers:

- **the shipped projector is the qualified projector** — 210 captures across all
  three corpora, 209 identical projections, 1 both-declined, **0 mismatches**
- **the shipped packets dominate M171's** — 209/209 are supersets with an
  identical focus, which is why M171's 7/7 first-action support is inherited by
  construction rather than re-argued

The declared `outputSchema` now documents both shapes and requires only
`schemaVersion`, the one property common to them, with the version string itself
saying which arrived. A tool that advertised only the debug shape while returning
the orientation would be lying to its clients.

## Verification

```text
bun run typecheck               clean
bun run typecheck:benchmarks    clean
bun test                        5425 pass, 49 skip, 0 fail (349 files)
                                baseline before M172: 5405 pass, 0 fail
git diff --check                clean
```

The 20 additional tests are the default-disclosure contract. Roughly 80
pre-existing consumer assertions moved to `detail=debug`: they test what the
pipeline resolved, not what it discloses, and their passing is the debug-
preservation proof.

## What this does and does not claim

It claims the default disclosure is eleven times cheaper while delivering the
same pivot, the same gold files and the same gold symbols, asserting nothing the
authoritative state does not support, on two disjoint hundred-task corpora.

It does not claim VTRACE solves more tasks. Every dollar here is a PROJECTED
ATTRIBUTABLE COST computed offline; no agent ran and no provider reported a
token. M169's live null was measured against a treatment costing $0.0985 a task.
The treatment now costs a projected $0.0084 — a twelfth — which is a materially
different treatment, so M169's result no longer settles it. That licenses a
requalification. It does not predict one.

Nothing here should be read as VEXP parity. M168 established the published VEXP
artifact could not attribute its own result; the comparison available is one of
product shape, not of solve rate.

## Next

A live requalification is now economically plausible: baseline against automatic
compact orientation, no search prohibition, no anti-loop policy, no VTRACE-
specific reasoning instructions. It is **licensed and not requested** — it costs
real money and needs explicit authorization.

The cheaper next step is offline. The orientation is right or wrong per case and
never partly right: across the twelve live transcripts, early-phase support was
0% or 100% with nothing between. A bigger packet does not rescue a wrong pivot.
Now that packet size has stopped being the variable worth tuning, the question
that remains is pivot correctness — which is a retrieval question, and M172
deliberately changed no retrieval.
