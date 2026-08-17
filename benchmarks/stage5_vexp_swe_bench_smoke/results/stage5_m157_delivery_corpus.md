# M157-B — the no-pivot delivery corpus, and why it cannot be 20–30 cases

M157 §25 asks for a frozen corpus of roughly 20–30 no-pivot cases across 4+
unrelated repositories, split into calibration and holdout before any functional
change. §33 adds the countervailing instruction: if the corpus does not
demonstrate a generic distinction, stop — do not manufacture one.

This document reports that the corpus cannot be built from the available data,
and what was frozen instead.

## The population, measured

Sweeping the delivery decision over every instance in the M156 broad100
(`stage5_m157_delivery_population.json`):

| | |
| - | - |
| instances evaluated | 100 |
| **no-pivot (`no_context`) cases** | **2** |
| repositories containing one | 2 (django/django, sphinx-doc/sphinx) |
| no-pivot cases with zero candidates | 0 |

The no-pivot rate is **2%**. The complete instance pool available offline is
`vexp-swe-bench/data/swe-bench-100.jsonl` — 100 instances, the same 100. The
other in-repo fixtures (`retrieval_eval.cross_repo*.json`,
`retrieval_eval.django*.json`) are subsets of the same instances, and the
M155-era per-era corpora were deleted by M156 §3.

Reaching 20–30 no-pivot cases at a 2% rate would require roughly 1000–1500
SWE-bench instances. They do not exist in this checkout, and no amount of
re-splitting the 100 produces more than 2.

**Therefore M157-B does not pass as specified.** The alternative — varying
budgets or intents until more capsules come back empty — would be manufacturing
the population §33 forbids, and would measure the allocator rather than the
delivery rule.

## What the two real cases are

| instance | repo | candidates | support authority | gold-file candidates | character |
| -------- | ---- | ---------: | ----------------: | -------------------: | --------- |
| `sphinx-doc__sphinx-9320` | sphinx-doc/sphinx | 25 | 25 | 18 (3 gold symbols) | §22 class **B** — credible evidence, empty delivery |
| `django__django-11740` | django/django | 33 | 33 | 2 | §22 class **C** — noise-dominated, correctly empty |

Both were inspected diagnostically in M157-A. Per §27 and §28, **neither can
serve as a sealed holdout**: Django is calibration by instruction, and Sphinx was
consumed to identify the mechanism. That is the second reason a
calibration/holdout split over this population is not available — there is
nothing left to seal.

## Ground truth, source-verified (§30, §32)

Verified against the pinned corpus rather than assumed from the gold patch:

- `sphinx-doc__sphinx-9320` — gold file `sphinx/cmd/quickstart.py` exists in the
  target tree; the three gold symbols (`ask_user`, `allow_empty`, `is_path`)
  exist as indexed functions; 15 further definitions from that file are in the
  candidate pool. The candidates are genuinely task-relevant: the task is about
  the quickstart prompt loop failing to exit, and `ask_user` / `do_prompt` /
  `valid_dir` are that loop.
- `django__django-11740` — gold file `django/db/migrations/autodetector.py`
  exists; the two pool candidates from it (`add_operation`, `arrange_for_graph`)
  are real methods, but the fixture's gold SYMBOL is `generate_altered_fields`,
  which is **not** in the pool. So even a perfect delivery of the retrieved
  candidates would not deliver the patched definition. The 25 top-ranked
  `default_error_messages` candidates were checked to be genuine module-level
  assignments across `db/models/fields`, `forms/fields`, and
  `contrib/postgres/fields` — a real lexical explosion on the task's
  `Errors: ValueError` line, not an indexing artifact.

One ground-truth correction was made before freezing: the initial gold matcher
compared fixture paths (`django/db/...`) against candidate paths (`db/...`) and
reported 0 gold candidates for both cases. The corpora are indexed at the package
root, so the scorer's own boundary-aware `fileMatches` is required. Using it
recovers 2 and 18 gold candidates respectively. Had this not been caught, M157-A
would have concluded that neither no-pivot case retrieved any gold at all — the
exact opposite of the truth.

## What was frozen instead

Since the specified corpus is unavailable, the functional work is controlled by
constructed fixtures covering the §26/§55 categories that the population cannot
supply, plus the full broad100 and frozen50 as preservation evidence:

| control | where | expectation |
| ------- | ----- | ----------- |
| no pivot + doc-tree candidate holding the slot | `pivotSlotReclaim.test.ts` | real source reclaims the slot |
| no pivot + task legitimately about docs | `pivotSlotReclaim.test.ts` | nothing reclaimed (rule reacts to a vacated slot, not to doc paths) |
| no pivot + only a disqualified candidate | `pivotSlotReclaim.test.ts` | stays empty — no self-filling vacancy |
| no pivot + nothing relevant retrieved | `noPivotDeliveryAuthority.test.ts`, `pivotAuthorityConsumers.test.ts` | stays empty, no absence overclaim |
| pivot + support, ordinary | broad100 (98 cases) | unchanged |
| tier budget respected | `pivotSlotReclaim.test.ts` | never exceeds the tier's pivot cap |

## Consequence for the milestone

The support-only delivery lane the milestone hypothesises (§34) is not
implementable on this evidence and was not implemented. §52's precondition —
*multiple unrelated calibration cases* demonstrating that useful support can be
identified independently of pivot authority — is met by **one** case, and that
case turned out not to need the lane. See `stage5_m157_delivery_authority_audit.md`.
