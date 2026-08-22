# M171-F — integration decision

## Decision

```text
DEFAULT_ORIENTATION_REDESIGN_NOT_LICENSED
```

M171-F was not run. `src/` carries a zero-line diff and the shipped default
`run_pipeline` response is unchanged.

## Why, in one line

Of the six holdout gates frozen before the holdout ran, five pass on both corpora
with large margins and one — gold-symbol delivery — misses on Broad100-A by three
cases.

## The gate table

| Gate | Broad100-A remainder (88) | Broad100-A full (100) | Broad100-B (100) |
|---|---|---|---|
| Median tokens <= 2,000 | 582 ✓ | 582 ✓ | 582 ✓ |
| p90 tokens <= 2,500 | 827 ✓ | 850 ✓ | 827 ✓ |
| Projected cost <= $0.0262 | $0.0079 ✓ | $0.0079 ✓ | $0.0079 ✓ |
| Pivot identity 100% | 87/87 ✓ | 99/99 ✓ | 98/98 ✓ |
| Gold file within 2pp | 0.00pp ✓ | 0.00pp ✓ | 0.00pp ✓ |
| **Gold symbol within 2pp** | **−3.41pp ✗** | **−3.00pp ✗** | **0.00pp ✓** |
| Soundness violations = 0 | 0 ✓ | 0 ✓ | 0 ✓ |

`stage5_m171_plan.md` froze "gold file and gold symbol delivery within 2
percentage points" before the first holdout case ran. §66 makes integration
conditional on the preservation gates as well as the economic ones. One
preservation gate does not pass, so the contract is not eligible.

## What the miss actually is

Three cases, all on Broad100-A, all the same shape:

| Case | Gold symbol | Position in authoritative order | Locations in packet | Gold FILE delivered |
|---|---|---|---|---|
| `astropy__astropy-14539` | `_diff` | 7 of 8 | 6 | yes |
| `django__django-16263` | `_add_q` | 6 of 7 | 6 | yes |
| `sphinx-doc__sphinx-9320` | `allow_empty`, `ask_user` | 6 and 7 of 8 | 6 | yes |

The packet names one focus plus up to five related locations — six in total. In
each of these three cases the gold symbol sits at authoritative position six or
seven, immediately past the cap.

In all three the packet still delivers the gold **file**. The agent is pointed at
the right file and loses a symbol name inside it. That is a real regression and
it is recorded as one; it is not the "10 to 20 points of evidence delivery"
§61 warns against, and the stronger signal — gold file — is exactly flat at
0.00 percentage points on all three slices.

## Why the cap was not simply raised

R2500, which was measured and is available, has a related cap of seven and would
recover all three cases. Adopting it now would be selecting a contract parameter
after seeing which value fixes the holdout — precisely what §70 forbids and what
the plan committed to not doing. The contract was frozen on development evidence,
where R2000 was the smallest rung with zero file-delivery loss and was identical
to R2500 on every median metric. It stays frozen.

The development set was also, on this specific measure, misleading: its twelve
cases show a 0.00pp gold-symbol delta. The regression is visible only on the
88-case non-development remainder. That is the §32 split doing its job.

## The design fault the miss exposes

The packet is bounded twice, and the wrong bound binds.

```text
token ceiling   2,000     never reached (median 582, max 1,007)
related cap         5     decides every packet
```

The cap exists to implement "enough, then stop" (§17, §46), and on this evidence
"enough" is at least eight locations on roughly 3% of cases. The token ceiling —
the bound the milestone was designed around — is inert. A successor milestone has
to decide what "enough" means when the authoritative state offers eight locations
and the contract shows six, and it has to decide it on development evidence
rather than by raising a number until Broad100-A goes green.

Broad100-A is now partly burned for that decision: the three cases and their
positions are known. Broad100-B, which shows a 0.00pp delta at the current cap,
remains clean and should be held back.

## What is licensed

- A successor milestone that reconsiders the related cap on development evidence,
  reports against Broad100-A knowing it is contaminated for this question, and
  treats Broad100-B as the independent check.

## What is not licensed

- Raising the cap to 7 and re-running the holdout.
- Any live agent spend. There is no shipped treatment to requalify.
- Any retrieval, ranking or selection change. M171 changed none and the
  successor should not either.
