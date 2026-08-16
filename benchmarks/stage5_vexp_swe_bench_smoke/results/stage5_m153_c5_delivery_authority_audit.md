# M153-C5 — delivery authority audit

**Question.** What authority must a structurally proven behavioural implementer
possess to become answer-bearing, and why does `get_filetype` not reach the
capsule?

**Answer, in two parts.** One generic defect: the discard gate read the answer-role
*grant* where it should read the *evidence*, so proven implementers that lost a
one-per-query grant were erased under a reason that is false about them. One
honest ceiling: `operation_fact` does not prove what it would need to prove to
make `get_filetype` the answer.

Artifacts: `stage5_m153_c5_delivery_trace.json`,
`stage5_m153_c5_answer_role_comparison.json`,
`stage5_m153_c5_behavioral_unique_recoveries.json`.

## Three-way trace

Control C is the existing M150 delivery fixture, unmodified.

| Stage | C — `pipeline.py::beta` | A — `get_adapter` | B — `get_filetype` |
| --- | --- | --- | --- |
| direct behavioural fact | yes | yes | yes |
| pool present | yes (rank 1) | yes (rank 1) | yes (rank 65) |
| lexical | **0** | 0.9766 | 0.0516 |
| localEvidence / domain / graph | 0 / 0 / 0 | 1.98 / 1 / 0 | **0 / 0 / 0** |
| mechanismEvidence | 0.55 | 0.55 | 0.55 |
| answer-role evidence | yes | yes | **yes** |
| candidates eligible for the grant | **1** | **1** | **3** |
| holds the grant | yes | yes | **no** — `get_rst_suffix` (rank 24) |
| role before C5 | pivot | pivot | **discard** |
| role after C5 | pivot | pivot | **support** |
| survives delivery selection | yes | yes | **no** — support #14 of 17, 4 delivered |
| capsule item | lead | lead | none |

**The obvious explanation is refuted.** Control C has *less* lexical evidence than
`get_filetype` — zero against 0.0516 — and identical `localEvidence`, `domain` and
`graph`. Weak naming is therefore not what separates them. The separator is that C
is the **only** eligible candidate in its fixture, so its grant is unopposed.

## First divergent stage

`assignCandidateRoles` → `classify`, in `src/capsule/assignCandidateRoles.ts`.

```ts
if (s.localEvidence <= 0 && !anyProximity && !answerRole) → Discard
```

`answerRole` is the **grant**, awarded once per query to the highest ordinary-ranked
eligible candidate. `get_filetype` fails every disjunct — `localEvidence 0`,
`domain 0`, `graph 0`, grant held by another — and is discarded with the reason
*"no lexical/symbol/path/test/graph relevance to the task"*.

That reason is false. Retrieval had already proven this definition performs the
requested operation on the requested operand, and recorded it on the candidate as
`mechanismEvidence = 0.55`. The gate simply did not read the field.

**Is this the M150 architectural class (§17)?** Yes — the same shape, one layer
deeper. M150 found downstream gates re-asking for lexical proof of a candidate
retrieval had already established; the grant was the fix. C5 finds that the fix was
wired to the grant rather than to the evidence, so it covered the first such
candidate and no other. It is repaired by reusing the existing authoritative
concept (`hasAnswerRoleEvidence`), not by adding a parallel one.

## The fix

The discard gate now also spares a candidate carrying direct-tier mechanism
evidence. Nothing else moves: `directEvidence`, the pivot bar and the grant are
untouched, so the number of candidates that can become an edit target through
behavioural evidence is still exactly **one**. The rest become support, which is
what proven-but-not-selected evidence is (§21, §30).

No score, threshold or constant changed. Bounded by construction: only the direct
tier qualifies, so a partial fact (a consumer, a prerequisite) cannot reach it —
measured at 3 candidates on the sphinx probe, 2 in the neutral fixture.

## Second divergence, recorded and not bypassed (§27, §59)

With the role corrected, `get_filetype` is support #14 of 17 and the capsule
delivers 4 support items. It now loses to the **bounded delivery envelope**, not to
a role gate.

This was left alone. Support ordering is by organic final score, and promoting a
proven implementer within support would be a third seam in one pass (§55) — and,
more importantly, the section below shows it would be promoting a candidate the
evidence cannot actually distinguish.

## What `operation_fact` actually proves (§20)

The three sphinx candidates that competed for the grant carry facts that are
**identical in every indexed field**:

| Definition | kind | subject | provenance | result-bearing | evidence |
| --- | --- | --- | --- | --- | --- |
| `get_filetype` | `first_success_return` | `source_suffix` | — | yes | `return filetype or 'restructuredtext'` |
| `Project.path2doc` | `first_success_return` | `source_suffix` | — | yes | `return filename[:-len(suffix)]` |
| `get_rst_suffix` | `first_success_return` | `source_suffix` | — | yes | `return suffix` |

All three genuinely iterate `source_suffix` and return on first match. They differ
only in **what they return** — a filetype, a stripped filename, a suffix — and the
fact does not record the kind of the returned value.

So the honest classification of `get_filetype`'s authority is:

```
DIRECT_IMPLEMENTER of a first-success selection over `source_suffix`   — proven
the definition the request asked for                                   — NOT proven
```

The request asks which *parser* reads a *source file*. Only `get_filetype`'s result
feeds that. Nothing in the index says so. Three definitions satisfy the structural
predicate equally, and the lane orders them by alignment class, exactness and then
`symbol_id` — a tie it cannot break on evidence.

**This is §19's legitimate outcome, not a defect.** Delivering `get_filetype` ahead
of its two siblings would not be retrieval succeeding; it would be the corpus label
leaking into the ranking. §33 is explicit that a forced candidate is not a recovery.

## Behavioural unique recoveries (§31, §62)

Measured from provenance, without adding a product flag to run a benchmark arm.

| Category | Count |
| --- | ---: |
| ordinary retrieval already sufficient | 6 |
| **behavioural unique recovery** | **0** |
| behavioural adds useful support only | 0 |
| behavioural no effect | 14 (not delivered) |
| behavioural harmful addition | 0 |

20 primary implementations scored across the 4 calibration repositories. The lane
has still never delivered a definition ordinary retrieval could not reach, and it
has never delivered a wrong one either — it is inert on this corpus, not harmful.

## Effect on measurements

Oracle calibration: **unchanged**, 0 substantive per-case differences across all 35
cases (impl@1 5.3% calibration / 3.3% overall). Taxonomy: **unchanged**
(REPRESENTATION 7 · ACTIVATION 6 · NONE 3 · SUBJECT 2 · CANDIDATE 2 ·
ROLE_DELIVERY 1).

The C5 fix is correct and currently invisible in aggregate, because the candidate
it rescues from deletion then loses an envelope it cannot honestly win.
