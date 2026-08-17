# M156 — Per-File Parse Failure Containment and Index Availability

Predecessor `d39871de` (M155 close). Branch `main`, local only, no co-author
trailers, pre-existing `stage5_outcome_ledger.*` dirt preserved.

---

## The claim

> VTRACE remains operational when individual source files cannot be parsed or
> indexed: failures are contained to those files, recorded truthfully,
> repository coverage is marked degraded rather than complete, authoritative
> absence is weakened appropriately, and the rest of the repository remains
> queryable.

## The measurement

Same 30 frozen tasks, same manifest (`d143f807…c244ba6`), each repository copied
to an isolated scratch root with any `.vtrace` removed so both sides index fresh
under their own binary.

```
                     M154 predecessor      M156 candidate
usable indexes            27/30                30/30
unavailable                3/30                 0/30
degraded                   0/30                 3/30
```

Preservation on the 27 the predecessor could already index: **27/27 identical**,
zero changed cases — same indexed-file, symbol and edge counts on every one.

---

## 1. The seam

`indexProject` already did the hard part. It parsed every file before opening its
persist transaction, and it already recorded per-file outcomes correctly. Then it
threw:

```ts
const fatalFileFailures = [...summariesByPath.values()].filter(isFatalFileOutcome);
if (fatalFileFailures.length > 0) throw new IndexingFileFailuresError(fatalFileFailures);
```

`isFatalFileOutcome` was `read_failed || parse_failed`. One file, whole
repository.

Because the throw preceded the transaction, the pre-M156 failure left **zero
rows** behind — measured, not assumed: `files`/`symbols`/`edges` all 0, no
`index.meta.json`. So containment is a policy change, not a data-integrity
repair. That single fact is why the diff is small.

## 2. What changed

**Containment.** Recoverable failures (`parse_failed`, `read_failed`) are
recorded against their path and indexing continues. `persistence_failed` and a
refused `validateGraph` stay repository-fatal — a malformed source file is a fact
about the repository and may be served truthfully; a broken database is a fact
about our own state and may not be served at all.

**No authoritative leftovers.** A failed file gets no `files` row — that table is
what M148 reads for path membership and what `symbols.file_id` joins against — and
no symbols, edges, call sites, mechanism facts, document chunks or FTS rows. Every
one of those lanes is counted by name in the tests rather than trusted to cascade,
because the two FTS tables have no foreign key at all. It gets one row in
`file_index_failures`, written inside the same transaction as the successful
evidence.

**Coverage is a second axis.** `ready` is unchanged by a coverage gap;
`coverageComplete` and `failedFiles` answer completeness separately. An index can
be exactly as fresh as its source revision and still be semantically incomplete,
and collapsing those two is how *fresh* quietly starts meaning *complete*.

**Absence weakens only where it must.** A hit is self-supporting — an unparsed
file cannot retract a symbol we found. A miss is a claim about everything we did
not see, so an exact-symbol miss in a repository with an unparsed *symbol-bearing*
file is `unknown / coverage_incomplete` rather than `definitely_absent`, which
downgrades the workspace claim from `authoritative_absence` to `bounded_absence`
through the existing M149 machinery. A failed YAML document does not weaken it —
its parser emits no symbols.

## 3. The second seam, found by testing consumers

Containing the failure in the indexer was not enough. A separate repo-readiness
check, `index_failures_absent`, required zero parse and read failures — and it was
unreachable before M156 only because indexing threw first. With the abort removed,
`run_pipeline` and `get_context_capsule` refused exactly the repositories M156 had
just made indexable. The availability failure had moved one layer up.

It now gates on `persistence_failed` alone and is renamed
`index_persistence_intact`, because a check called *failures absent* that passes
with failures present would be worse than the bug. `get_code_context` was already
fine, which is why testing one tool and generalising would have missed it.

## 4. The three recovered repositories

| instance | eligible | indexed | failed | coverage |
|---|---|---|---|---|
| `psf__requests-1142` | 71 | 70 | 1 | DEGRADED |
| `pytest-dev__pytest-5262` | 205 | 204 | 1 | DEGRADED |
| `pylint-dev__pylint-4551` | 827 | 814 | 13 | DEGRADED |

Fifteen failed files. The deterministic preparer quarantines 16 across the broad
100; the sixteenth belongs to `pytest-dev__pytest-6197`, which is outside this
subset. Two independent counts agree.

**Two corrections to the M155 summary,** both from its own committed artifacts:

- **Two of the three were baseline PASSES, not one.**
  `stage5_m155_paired30_outcomes.json` lists two entries under
  `baselinePassWithTreatmentUnavailable`. The product harm is twice what the prose
  implies.
- **`pylint-4551` fails on 13 files, not one.** A containment mechanism handling
  a single failure per repository would have left it unavailable.

## 5. Why this could not be a parser fix

These files are *supposed* to be unparseable: a py2/py3 documentation example
demonstrating a syntax difference, a linter's regression corpus of deliberately
broken input (`tests/functional/s/syntax_error.py`), and a vendored library with a
corrupt escape. Any repository testing a parser, linter, formatter or migration
tool contains files like these. Teaching the parser three dialects would fix three
repositories and leave the class untouched.

## 6. What the benchmark had been hiding

The deterministic preparer "quarantines and continues" by `rename`-ing offending
files **out of the repository**, indexing, and restoring them afterwards. Its
index was complete *for a repository that does not exist*, and recorded nothing
about the 16 files it dropped. The benchmark's ability to work around a product
failure is what kept the product failure invisible since M134. That mechanism was
deliberately not ported.

Under M156 the same preparer takes its first branch — indexing now exits 0 — so
the M156 corpus contains those files as recorded failures rather than as absences.

## 7. Neutral fixtures

Containment must not be confusable with special-casing three syntax forms. Twelve
valid files plus one that cannot be indexed, across five failure shapes and all
three enumeration positions:

```
18/18 repositories survived the local failure
every valid file still indexed
arithmetic holds on every fixture
outcome independent of where the bad file sorts
clean control NOT degraded
```

Two fixtures were wrong on the first run and the positive control caught both.
`return *[1, 2]` is accepted by CPython, so the fixture meant to reproduce
pylint's starred-expression failure was not failing at all; it now carries the
construct that file actually contains. And **malformed TypeScript does not fail** —
tree-sitter recovers and returns a partial tree — so per-file containment is
exercised by Python and Cython only. Recorded as a declared non-failing fixture
and a named limitation rather than forced, because inventing a TypeScript failure
would test the fixture instead of the product.

## 8. Preservation at scale

Both sides freshly prepared and indexed by their own binary — no era-copied
SQLite, which is the M155-B2 lesson.

**broad100, M154 final → M156 final:**

```
                     M154     M156     delta
gold file Top-1      0.57     0.57      0.00
gold file Top-3      0.73     0.73      0.00
gold file anywhere   0.89     0.89      0.00
gold symbol anywhere 0.64     0.64      0.00
gold delivered       0.78     0.78      0.00
gold discarded       0.11     0.11      0.00
gold missing         0.11     0.11      0.00

changed cases        0 / 100
```

Not merely equal rates — **zero cases changed**, comparing Top-1, Top-3, gold
role, symbol role, and pivot/support/discarded counts per instance.

That includes the four targets M154 could only index by *deleting files from the
tree*, and M156 indexes with those files present and recorded as failures. The
retrieval result is identical because a file that failed to parse contributes no
evidence either way — which is the design working: for retrieval a failed file is
equivalent to an absent one, and the difference is that it is now recorded rather
than silently missing.

**Fast gate (frozen50), on a corpus freshly indexed by the candidate:**

```
derivation-valid   50/50      gateUsable  true
Top-1              0.76       Top-3       0.86
gold delivered     0.90       discarded   0.06      missing 0.04
```

Identical on every metric to M155's re-baselined gate.

**The preparer no longer needs to quarantine anything.** Under M154 it moved 16
files out of 4 repositories to make them indexable; under M156 it takes its first
branch on all 100 targets and quarantines **0**. The workaround is now dead code
against this product.

## 9. The three recovered repositories, retrieved

| instance | product state | coverage | gold role | lead |
|---|---|---|---|---|
| `psf__requests-1142` | VALID_NONEMPTY | DEGRADED (1) | **pivot** | `requests/models.py` — exact gold |
| `pytest-dev__pytest-5262` | VALID_NONEMPTY | DEGRADED (1) | **pivot** | `src/_pytest/capture.py` — exact gold |
| `pylint-dev__pylint-4551` | VALID_NONEMPTY | DEGRADED (13) | missing | `pylint/lint/pylinter.py` |

None is `TREATMENT_UNAVAILABLE_INDEX_FAILURE`. Both cases that were **baseline
PASSES** now retrieve the gold file as their lead.

`pylint-4551` misses gold, and the report says so. Its gold is **not** inside a
failed file — this is an ordinary retrieval miss, not a coverage consequence, and
§53's "available but unanswerable" case did not arise on these three.

Failure classification on real repositories discriminates as intended:
`requests-1142` is `ENCODING_ERROR` (the truncated `\uXXXX` escape) rather than
being lumped in with syntax; `pylint-4551` splits 12 `SYNTAX_ERROR` and 1
`ENCODING_ERROR` (a `U+FEFF` in a Jython fixture).

## 10. Performance

Median index wall clock across the 27 clean repositories moved 39.1s → 33.0s.
This is **not** a speedup claim: one sample per repository, two sides under
different machine load. It is reported only to show there is no material
regression from handling failures per file.

## 11. Storage and derivation

`file_index_failures` is classified `repository_derived`, so it lives in
`index.sqlite` and never in `session.sqlite` — the M152 split holds. Adding it
moves `schema_version`, and `FILE_SNAPSHOT_SCHEMA_VERSION` went 4 → 5 because
`indexOutcome` gained `failed`. Indexes built under all-or-nothing semantics
therefore report `schema_incompatible` and rebuild. **That incompatibility is not
suppressed**: a pre-M156 snapshot cannot express which files were refused, and
reading one as though it could would report a degraded repository as complete —
the exact lie this milestone exists to prevent.

## 12. Limitations

- **Containment is exercised by Python and Cython.** TypeScript's parser is
  error-tolerant and produces no failures to contain; JavaScript is
  `unregistered_language`, a skip rather than a failure.
- **Enumeration remains a repository-fatal seam.** `scanRepo` calls `stat` and
  `hashFile` unguarded, so a file removed between `readdir` and `stat` still
  aborts the scan. Identified in the audit, out of scope here, and distinct from
  the measured defect.
- **Availability is not answerability.** A repository whose gold evidence lives
  inside the failed file is available and still unanswerable. That is truthful,
  and §53 anticipates it.
- **No live agent arms were run.** The three recovered treatments have never
  executed end to end; deterministic availability and retrieval are what is
  claimed here. §54 permits a small live validation and it was not spent: the
  deterministic evidence already answers the availability question, and M155's
  utility verdict stays frozen either way.

---

## Verdicts

```
M156-A  Failure model audit                  PASS
M156-B  Per-file atomic containment          PASS
M156-C  Truthful degraded coverage           PASS
M156-D  Incremental and consumer integration PASS
M156-E  Frozen30 availability + preservation PASS

M156 overall                                 PASS
```

M155 is not rewritten. Its observed availability remains **27/30 (90%) under the
M154 product**, and its utility verdict among valid pairs remains MIXED. M156
reports a new product state on the same frozen repositories: **30/30**.
