# M161 extension decision

**Decision: `DO_NOT_EXTEND`.**
**Strategic gate: `UTILITY_POSITIVE` — but scoped to orientation efficiency, not to solving more tasks.**

---

## What the 30 pairs settled

| | baseline | VTRACE |
| --- | ---: | ---: |
| resolved | 19 / 30 | 19 / 30 |

Discordant pairs: **2** (1 win, 1 loss), exact two-sided p = **1.0**. Both were
inspected and **neither is a context effect**:

- the win (`sympy-13615`) is the baseline stashing its own correct fix as its final
  tool call, on a task where VTRACE delivered **no gold file at all**;
- the loss (`sphinx-10673`) is a worse patch written on the **identical two files**
  the baseline edited, with identical search counts.

## Why more of the same measurement is not worth buying

Extending to the pre-frozen 100 costs roughly **$140 and ~20 hours** of wall time
for 70 more pairs. The question it would sharpen is the solve-rate difference, and
that difference is currently **zero with two discordant pairs**. Scaling the observed
discordance rate forward predicts about **7 discordant pairs at n=100** — still far
short of the 6-0 split that would be needed to clear p<0.05, and nowhere near enough
to resolve a small effect. A larger sample would buy a tighter interval around zero.

The finding that *is* interesting — a reliable reduction in agent work — is already
consistent at n=30 across every work metric, and 70 more pairs of the same protocol
would not change what it means. It would only re-measure it.

## What is worth buying instead

The sharpest result here is the **§107 answer**: VTRACE's Top-1 correctness
correlates with **efficiency** but not with **solve rate**. Conditional on a correct
lead the agent spent a median **164k fewer tokens** and **4.5 fewer turns** than it
did on the same task without VTRACE; conditional on a wrong lead it spent ~71k more.
Yet `LEAD_GOLD` cases resolved **9/14 in both arms** — exactly the same.

Two follow-ups are better value than 70 more paired runs:

1. **A policy ablation.** M161 deliberately stripped five benchmark-authored agent
   policy blocks so the treatment was evidence only. Whether those blocks help,
   hurt, or do nothing is now an open and cheap question, and it is the one the
   historical Stage 5 numbers were silently answering.
2. **A callable-tools experiment.** §149 is explicit that injection being neutral
   does not imply callable tools would help — that requires its own experiment. This
   milestone can say nothing about it, and marked every such metric UNAVAILABLE.

## What must NOT be concluded

- **Do not read the identical 19/30 as "VTRACE does not work."** At two discordant
  pairs the solve-rate comparison is uninformative about direction, not evidence of
  no effect.
- **Do not read the work reduction as a cost saving.** Turns fall reliably (18 pairs
  lower, 8 higher) but tokens and dollars do not: 14 pairs cheaper in tokens against
  16 dearer, median cost delta **+$0.017**. The aggregate token saving comes from a
  couple of large outliers, not from a per-task effect.
- **Do not start a lead-selection milestone on this evidence.** §146 requires a
  repeated pattern of wrong-lead anchoring causing losses the baseline avoids.
  Agents **ignored** the wrong lead in 13 of 15 cases, and the 2 that acted on it
  were shared failures. Zero unique harm.

## If extension is authorized anyway

It must use the **same frozen product** and run the **next cases in the frozen
order** from `stage5_m161_extension_manifest.json` (§106, §13). No re-selection, no
product change between the 30 and the remainder, and the pooled result reported over
the full denominator.
