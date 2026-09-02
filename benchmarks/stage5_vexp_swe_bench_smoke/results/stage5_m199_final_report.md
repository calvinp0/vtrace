# M199 — bounded incremental persistence

**M199 — PASS**
`A3_PARITY_NOT_CLOSED`
`INCREMENTAL_PERSISTENCE_BOUNDED_BY_THE_CHANGED_CLOSURE`
`VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET`

`ENGINE QUALITY != CODING-AGENT UTILITY`

M199's objective was to make incremental persistence scale with the changed
closure rather than with the repository. It does: a one-file refresh on ARC wrote
116,478 semantic rows against 13 affected, and now writes 26 — one delete and
one insert per affected row, with no third write anywhere. Incremental/full
equivalence is 18/18 across three corpora and 3/3 on the adversarial sequence.

A3 nonetheless remains **BELOW**, and not because persistence is still
unbounded. The frozen A3 rule scores C-LARGE at both k=1 and k=3. k=1 moved
**0.399 → 0.052**, inside the EXCEEDS band. k=3 is not an incremental refresh at
all: the third file of ARC by the product's own enumeration is `arc/__init__.py`,
and a package-surface edit routes to a full rebuild, so k=3 measures a rebuild
against a rebuild and sits at 1.04. No amount of persistence work moves it.

---

## 1. Starting state

```
branch                main
starting SHA          f1caae38b2fb9ea3809689511721b255754d5002
ahead/behind origin   0 behind, 175 ahead (never pushed)
tracked dirt          benchmarks/.../stage5_outcome_ledger.{json,md}   (pre-existing, preserved)
untracked dirt        204 entries under benchmarks/ and the repo root  (pre-existing, preserved)
git diff --check      clean
```

## 2. Frozen authority

`run_stage5_m197a_authority.ts` replayed unmodified, twice — once before any
product change and once before the final scoring run. **15/15 checks pass**,
`M197A_AUTHORITY_VERIFIED`.

```
preregistration sha256   736e8a9b5beba4a26d29ca068bafa2f4aede973ec50dab53bba6673f6697d8f0  (unchanged)
G1 ">= 10 of 15 claims MATCH or EXCEED"        present verbatim
G8 "ingestion completeness < 99%"              present verbatim
claim ledger             24 claims @ vexp-cli 2.0.24, 9/9 cited present
C-SMALL   21 files @ d658e3457b      C-MED  492 files @ 11382073cf
C-LARGE  276 files @ 826144342e      + 699 .py excluded as nested worktrees
```

The four historical M197A JSONs are restored byte-identical; M199's runs are
published beside them as `stage5_m199_*.json`. No threshold, corpus, claim,
tokeniser or scoring rule was altered.

**The corpus check earned its keep.** C-MED is this repository's own `src/`, and
its frozen identity is a file count. A new test file made it 493 and the
authority run returned `M197A_AUTHORITY_MISMATCH` on the spot. The tests moved
into `indexProject.test.ts`; the count is 492 again. Worth recording as a
property of the instrument: the frozen comparison is measured partly on the tree
that measures it, so any milestone adding a source file moves the substrate under
A2, A5, A8 and A10 without touching any of them.

### A3, verbatim from the committed definition

```
claim         "incremental refresh is materially cheaper than a cold build"
source        frozen M196 protocol
metric        ratioToColdMedian = elapsed(refresh) / median(3 cold builds)
numerator     one indexProject call after appending a comment line to k files
denominator   median of REPEATS=3 cold builds of the same corpus copy
corpora       C-LARGE only (/home/calvin/code/ARC, Python, frozen eligible 276)
k             1 and 3; band() requires EVERY measured value to clear the bar
warm state    the refresh follows 3 no-op refreshes on the same db handle
match         ratio <= 0.25
exceed        ratio <= 0.05
crash         any k1/k3 failure, or a CRASH singleRefreshSequence, is BELOW
pre-change    M198: k=1 0.399, k=3 1.12  ->  BELOW
```

---

## 3. Pre-change reproduction

`run_stage5_m199_persistence.ts` at f1caae38, repeats 3, load average 15.5.

| corpus | cold median | no-op | k=1 ratio | k=3 ratio | k=3 mode |
|---|---|---|---|---|---|
| C-SMALL | 198 ms | 11 ms | 0.289 | 0.285 | incremental |
| C-MED | 13,617 ms | 93 ms | 0.100 | 0.129 | incremental |
| C-LARGE | 22,936 ms | 339 ms | **0.310** | **0.955** | full_rebuild |

A3 reproduced as BELOW on the frozen corpus before any product change.

**C-LARGE k=1 stage attribution, pre-change:**

```
discovery        21.6 ms
parsing         316.7 ms       one file parsed; the rest read from the parse cache
invalidation    484.6 ms
linking         768.1 ms
persistence   5,084.0 ms       71.6% of the refresh
validation       36.6 ms
unattributed    387.9 ms
                ---------
total         7,099.8 ms
```

---

## 4. Root cause

`indexProject`'s graph transaction ignored the plan. Whatever mode was selected —
`incremental` or `full_rebuild` — it ran eight unqualified statements

```sql
DELETE FROM symbol_search_fts; DELETE FROM symbol_body_literals_fts;
DELETE FROM symbol_mechanism_facts; DELETE FROM document_search_fts;
DELETE FROM document_chunks; DELETE FROM edges;
DELETE FROM symbols; DELETE FROM files;
```

and then looped over **every** `successfulResults` entry calling
`persistParseResult`. In incremental mode `successfulResults` is the whole
repository: the changed files freshly parsed, every other file rehydrated from
the parse cache. So the transaction deleted and reinserted the entire graph for a
one-line comment.

Measured by trigger on ARC, for a change affecting 13 rows:

| table | deleted | inserted | affected |
|---|---|---|---|
| files | 346 | 346 | 1 |
| symbols | 10,309 | 10,309 | 3 |
| edges | 24,887 | 24,887 | 5 |
| edge_call_sites | 19,330 | 19,330 | 3 |
| symbol_mechanism_facts | 2,817 | 2,817 | 1 |
| document_chunks | 550 | 550 | 0 |
| **semantic total** | **58,239** | **58,239** | **13** |

**Write amplification 8,960x**, and exactly 200% of the live graph — the
signature of delete-everything-then-reinsert-everything. C-MED: 2,451x.
C-SMALL: 33.7x.

The per-file machinery to avoid this already existed and was unused:
`persistParseResult` replaces one file's rows, `deleteEdgesTouchingFileSymbols`
removes the edges at one file's symbols, and the FTS and mechanism-fact
repositories delete by `file_path_raw`. Ownership was never the problem; the
caller was.

---

## 5. Repair

One authoritative path, evolved in place — no `V2`, no parallel refresh
implementation. `resolvePersistenceScope` decides, once, which files the run
rewrites:

```
plan.mode !== "incremental"                  -> whole_repository
plan.fullRebuildReason !== undefined         -> whole_repository
otherwise                                    -> affected_files(plan.affectedClosureFiles)
```

**Why the affected files are sufficient.** An incremental plan has already proved
two things a full rebuild has not. No file was added, deleted or renamed — the
planner routes all three to `closure_uncertain`, because unresolved import
descriptors are not persisted and the reverse closure is not queryable. And the
repository's `semanticContextHash` is unchanged: every symbol's path, fully
qualified name, local name, kind, signature and export status, plus every package
surface's content, is identical to the previous run. What can still differ is
therefore confined to the changed files' own rows and to the edges touching their
symbols. Everything else in the graph is already correct and is left alone.

**The seam is the inbound edge.** `computeSymbolId` hashes the symbol's byte
range, so a definition that merely moves within its file gets a new id. An edge
whose *target* is in the changed file is owned by the file at its *other* end,
which a bounded refresh does not re-persist — its persisted row would be left
pointing at an id that no longer exists. So `invalidatePersistedFile` deletes
edges in **both** directions, and `persistResolvableInterFileEdges` is given the
same symbol set that invalidation deleted against:

```
rewrittenSymbolIds = symbols of the files this run rewrites

an inter-file edge is written iff  both endpoints are persisted
                              AND  (src or dst is in rewrittenSymbolIds)
```

which restores exactly what was removed and touches nothing that survived. No
`INSERT OR IGNORE` anywhere: an edge that would collide is one that was never
deleted, and the filter is what makes that impossible, not the insert.

**M184's recovery still writes everything.** The materialization check keeps an
incremental *parse* plan while the graph itself is missing, so it invalidated
nothing and a scope taken from the change set would have written nothing. Any
incremental plan carrying a `fullRebuildReason` is treated as whole-repository,
which fails towards writing more. There is a permanent regression for it.

**Scope is driven by the invalidated paths, not by the results about to be
written.** Those agree today only because a file that stops parsing also changes
the semantic surface and forces a full rebuild — a coincidence of another guard,
not a property of this one. Invalidating what the plan invalidated is what makes
the scope correct on its own terms.

---

## 6. Write-amplification evidence

Interleaved same-session A/B, C-LARGE, pre-repair worktree at `9c60c120` and
HEAD, running the **identical** instrument, alternating pre/post/pre/post.

| | pre r1 | post r1 | pre r2 | post r2 |
|---|---|---|---|---|
| load average | 14.50 | 15.04 | 16.11 | 15.89 |
| cold median | 17,445 ms | 17,915 ms | 17,415 ms | 18,921 ms |
| **k=1 median ratio** | **0.274** | **0.052** | **0.385** | **0.049** |
| k=3 median ratio | 1.005 | 1.085 | 1.162 | 1.011 |
| k=1 semantic rows written | 116,478 | **26** | 116,478 | **26** |
| k=1 affected rows | 13 | 13 | 13 | 13 |
| **k=1 amplification** | **8,960x** | **2.0x** | **8,960x** | **2.0x** |

The cold denominators agree within 8% across all four runs, so the ratio moved
because the numerator did.

**k=1 stage attribution, same A/B:**

| stage | pre r1 | pre r2 | post r1 | post r2 |
|---|---|---|---|---|
| parsing | 383.5 | 390.0 | 376.9 | 389.9 |
| invalidation | 326.1 | 395.5 | **7.4** | **10.6** |
| linking | 454.3 | 783.8 | **8.6** | **9.7** |
| persistence | 3,393.7 | 4,492.1 | **8.9** | **8.6** |
| validation | 31.8 | 48.9 | 24.5 | 33.1 |
| total | 5,102.3 | 6,665.9 | **881.8** | **939.9** |

Parsing is unchanged to within noise, which is the control: the same corpus doing
the same parse work. The entire delta is in the three stages the repair touches.

**Full corpus set, after (repeats 3, load 18.6):**

| corpus | k | mode | affected rows | rows written | amplification | median ratio |
|---|---|---|---|---|---|---|
| C-SMALL | 1 | incremental | 6 | 12 | 2.0 | 0.112 |
| C-SMALL | 3 | incremental | 15 | 30 | 2.0 | 0.177 |
| C-MED | 1 | incremental | 18 | 36 | 2.0 | 0.034 |
| C-MED | 3 | incremental | 59 | 118 | 2.0 | 0.034 |
| C-LARGE | 1 | incremental | 13 | 26 | 2.0 | 0.052 |
| C-LARGE | 3 | full_rebuild | 193 | 116,478 | 603.5 | 1.026 |

C-LARGE k=3 is the package-surface rebuild. It is reported at its true
amplification rather than excused: a full rebuild writes the whole graph because
that is what a full rebuild is.

---

## 7. What is left in an incremental refresh

C-LARGE k=1, after, 1,159.9 ms total:

```
parsing         501.8 ms   43%   ONE file parsed; the rest is 345 parse-cache reads
parseCacheWrite 165.3 ms   14%   345 cache entries rewritten
bookkeeping     156.0 ms   13%   10,656 run-state rows
discovery        39.9 ms
validation       33.2 ms          whole-graph dangling-row invariants
persistence      11.4 ms    1%
linking           8.3 ms
invalidation      7.4 ms
read             11.8 ms
commit            1.9 ms
unattributed    222.4 ms   19%   parser-registry construction and the two
                                 whole-repository context hashes
```

Persistence is now 1% of the refresh. Three whole-repository terms remain, and
each is reported rather than absorbed.

**Run-state bookkeeping is repository-scale by contract.** `computeSymbolDiff`
compares one run's full snapshot against the previous run's, so a snapshot
holding only the changed files would report every file it omitted as removed.
10,656 rows on every refresh, including a no-op. It is also the reason the index
file grows about 7 MB per refresh on C-LARGE whatever changed — the per-run
snapshots accumulate and nothing prunes them. Pre-existing, unaffected by M199,
and the clearest remaining candidate.

**The parse cache is rekeyed globally.** Its key carries a binding-context hash
derived from every symbol in the repository, so one symbol moving rekeys every
file's entry and an entry that was just *read* has to be written back under the
new key. This is the same global-binding-context design that forces k=3 to a full
rebuild.

---

## 8. SQL and index evidence

Query plans taken against a real C-LARGE index (346 files, 10,309 symbols, 24,887
edges, 19,330 call sites), each statement also timed in isolation inside a
rolled-back transaction so every one sees the same graph.

| statement | plan | isolated |
|---|---|---|
| lookup file id by path | indexed | 0.06 ms |
| delete call sites touching file | MULTI-INDEX OR over both edge indexes | 0.30 ms |
| delete edges touching file | MULTI-INDEX OR over both edge indexes | 0.19 ms |
| delete document chunks for file | indexed | 0.07 ms |
| delete mechanism facts for file | indexed | 0.20 ms |
| delete symbols for file | indexed | 0.35 ms |
| delete file by path | indexed | 0.27 ms |
| delete document_search_fts for file | **full scan** | 0.58 ms |
| delete symbol_body_literals_fts for file | **full scan** | 1.92 ms |
| delete symbol_search_fts for file | **full scan** | 4.51 ms |
| validate: dangling edges | **full scan** | 21.30 ms |
| validate: dangling search rows | **full scan** | 10.47 ms |

**No index was added.** Two findings, both left alone deliberately:

- the three FTS deletes scan because `file_path_raw` is an FTS5 `UNINDEXED`
  column, which cannot carry an index. Bounded persistence turned three
  unqualified `DELETE`s into three per-file scans — 7 ms per changed file on
  C-LARGE, against a refresh of 1,160 ms. Real, measured, and not worth a shadow
  table at this size;
- the two validation scans are whole-graph invariants, and they are precisely
  what proves a bounded write left nothing dangling. Removing them to save 32 ms
  would remove the check that makes the repair safe.

M198's `idx_symbols_parent_symbol_id` continues to carry `DELETE FROM symbols`;
per-file deletion is 0.35 ms.

**Storage (§35).** No index added, so no insert penalty. Same A/B, C-LARGE:

| state | pre-repair | post-repair |
|---|---|---|
| cold build | 47,218,688 | 47,218,688 |
| after one no-op refresh | 54,259,712 | 54,259,712 |
| after k=1 | 63,238,144 | **61,329,408** |
| after k=3 (full rebuild both sides) | 73,023,488 | **70,311,936** |

The bounded refresh leaves a file 1.9 MB *smaller*. The ~7 MB the no-op adds is
identical on both sides and is the run-state accumulation above.

**Memory (§36).** The repair introduces one `Set` of the changed files' paths and
one of their symbol ids — 13 rows' worth on the C-LARGE k=1 case — plus a shallow
array copy of existing references. It removes work rather than moving it into
RAM; nothing is loaded into memory that was not already there.

---

## 9. Incremental correctness

Six mutation classes, each applied identically to an incrementally refreshed copy
and to a copy indexed cold from the same final filesystem, compared over the full
projection: files, symbols, edges, symbol search, body literals, mechanism facts,
edge call sites, document chunks, document search, per-file failures, and
`normalizedGraphHash`.

| mutation | C-SMALL | C-MED | C-LARGE |
|---|---|---|---|
| E1 modify 1 | EQUAL (incremental, 1 parsed) | EQUAL (incremental, 1) | EQUAL (incremental, 1) |
| E2 modify 3 | EQUAL (incremental, 3) | EQUAL (incremental, 3) | EQUAL (full_rebuild, 346) |
| E3 add file | EQUAL (full_rebuild, 22) | EQUAL (full_rebuild, 494) | EQUAL (full_rebuild, 347) |
| E4 delete file | EQUAL (full_rebuild, 20) | EQUAL (full_rebuild, 492) | EQUAL (full_rebuild, 345) |
| E5 rename file | EQUAL (full_rebuild, 21) | EQUAL (full_rebuild, 493) | EQUAL (full_rebuild, 346) |
| E6 remove symbol | EQUAL (full_rebuild, 21) | EQUAL (**incremental, 1**) | EQUAL (full_rebuild, 346) |

**18/18 equal**, `normalizedGraphHash` identical in every case. The mode each
mutation took is recorded because a mutation that quietly stopped being
incremental would otherwise pass equivalence and hide the regression. C-MED E6
is a symbol removed and the graph repaired incrementally by rewriting one file.

**M198's ambiguity repair is intact.** ARC defines the same method twice in 30
classes, and E1 on C-LARGE is an incremental refresh of that corpus comparing
equal. The in-suite duplicate-definition regression — two `Holder.dup`
definitions, both keeping their own containment edge — still passes, and the five
`normalizedGraphHash` mutation tests M198 added pass unchanged.

---

## 10. Sequence correctness

```
modify A -> refresh (incremental)
modify B -> refresh (incremental)
delete A -> refresh (full_rebuild)
add C    -> refresh (full_rebuild)
modify C -> refresh (incremental)
```

then compared against a cold build of the sequence's **final** filesystem, copied
after every step rather than replayed, so a replay bug cannot make the two agree.

**EQUAL on all three corpora**, `normalizedGraphHash` identical. This is the case
one-shot equivalence cannot reach: state left behind by refresh N surviving into
refresh N+3.

---

## 11. No-op boundedness

```
changed files            0
parsed files             0
semantic rows written    0     (C-SMALL, C-MED, C-LARGE; 3 repeats each)
bookkeeping rows         120 / 5,110 / 10,656
```

A no-op writes nothing semantic and never has. The bookkeeping is quantified
rather than excused: it is the run-history snapshot of §7, and on C-LARGE it is
10,656 rows and about 7 MB of file growth for a refresh that changed nothing.

---

## 12. Determinism

Three repeats per corpus, each from a fresh cold index, each applying the same
one-file mutation:

| corpus | normalized graph hashes | rows written | amplification |
|---|---|---|---|
| C-SMALL | identical (a32a2604c6e42133…) | 12, 12, 12 | 2.0, 2.0, 2.0 |
| C-MED | identical (4598b30256ded1d3…) | 36, 36, 36 | 2.0, 2.0, 2.0 |
| C-LARGE | identical (dc2c8fdb15c1c03e…) | 26, 26, 26 | 2.0, 2.0, 2.0 |

Semantics and write counts are both stable; only timing varies.

---

## 13. A3 under the frozen scorer

`run_stage5_m197a_indexing.ts`, unmodified, repeats 3, load average 16.31:

| corpus | cold median | no-op | reparsed on no-op | k=1 | k=3 | singleRefreshSequence |
|---|---|---|---|---|---|---|
| C-SMALL | 174.7 ms | 14.0 ms | 0 | 0.147 | 0.203 | OK |
| C-MED | 14,781 ms | 149.2 ms | 0 | 0.029 | 0.032 | OK |
| **C-LARGE** | 18,928 ms | 333.5 ms | 0 | **0.052** | **1.04** | OK |

```
M198   C-LARGE k=1 0.399   k=3 1.12   -> BELOW
M199   C-LARGE k=1 0.052   k=3 1.04   -> BELOW
```

`band()` requires every measured value to clear the bar. k=1 clears both the 0.25
match and the 0.05 exceed threshold; k=3 does not clear either. **A3 = BELOW.**

**Why k=3 cannot move.** A3's k=3 targets are the first three `.py` files of ARC
by the product's own enumeration: `ARC.py`, `ARC_test.py`, `arc/__init__.py`. The
third is a package surface. `planIncrementalRefresh` routes any modification of
one to `closure_uncertain`, and `computeSemanticContextHash` independently hashes
a package file's raw content, so even without the planner guard the post-parse
check would force the same rebuild. Both guards exist because Python re-export
resolution is a genuine cross-file binding: `fromReExportsByName` lets
`from arc import X` resolve through `__init__.py` into the defining module, and
unresolved import descriptors are not persisted, so no query can name the files
whose resolutions would change. k=3 therefore reparses all 346 files and rewrites
the whole graph — correctly — and its ratio is a rebuild measured against a
rebuild.

Making it incremental means giving package-surface identity a semantic derivation
and persisting enough of the import descriptor set to compute a reverse closure.
That is binding-context architecture, not persistence, and §16 is explicit: an
edge may only be excluded from rebinding where no changed identity can alter its
resolved target, and correctness beats A3. It was not attempted.

Two frozen-instrument artefacts, restated rather than fixed (§30 forbids touching
the instrument): A3's rendered sentence still reads "reparsed 346 of the 346
files … for a ONE-file change", which M198 identified as reading
`totalFilesAttemptedForParse` (files successfully *read*) instead of
`performance.parsedFiles`, which is 1. And A3's `comparabilityCaveat` still says
"incremental refresh has no incremental path (M196A §14)", which has not been
true since M198.

---

## 14. Protected frozen claims

| claim | M198 | M199 | measurement |
|---|---|---|---|
| A2 cold throughput | MATCHES | **MATCHES** | C-MED 33.29, C-LARGE 18.28 files/s (M198: 36.21 / 19.47, at load 14.53 vs 15.31) |
| A4 no-change check | EXCEEDS | **EXCEEDS** | 0.014 / 0.149 / 0.334 s, 0 files reparsed |
| A6 impact graph | MATCHES | **MATCHES** | p90 294.4 ms on C-LARGE |
| A7 logic flow | EXCEEDS | **EXCEEDS** | p90 32.8 ms on C-LARGE |
| A8 ingestion (veto) | EXCEEDS | **EXCEEDS** | 100% / 100% / 100%, 0 unexplained missing |
| A9 rendered reduction | MATCHES | **MATCHES** | C-MED 92.67%, C-LARGE 87.21% |
| A10 structural truth | MATCHES | **MATCHES** | signature retention C-MED 99.47%, C-LARGE 100% |

No protected claim regressed. A2's small decline tracks a machine 5% busier and
is within the run-to-run spread of the cold builds in §6; the A2 threshold is 15
files/s and the measurement is 18.28.

M198's structural gates hold: 0 invented structural claims, 0 strengthened
claims, determinism stable, falsification controls F1–F8 all pass in the frozen
report. A15's rendering subchecks are unchanged (flow 100%, impact 0% on all
three corpora — the documented M177/M178-B envelope policy, not malformation).

---

## 15. Full A1–A15 matrix

| ID | M198 | M199 | cause / status |
|---|---|---|---|
| A1 | BELOW | BELOW | 3 parser-backed families against a claim of 30; product scope |
| A2 | MATCHES | MATCHES | 18.28 files/s C-LARGE |
| A3 | BELOW | BELOW | k=1 0.399 -> **0.052**; k=3 1.04, a package-surface full rebuild |
| A4 | EXCEEDS | EXCEEDS | |
| A5 | BELOW | BELOW | p90 668.95 ms C-LARGE against a 500 ms bar |
| A6 | MATCHES | MATCHES | |
| A7 | EXCEEDS | EXCEEDS | |
| A8 | EXCEEDS | EXCEEDS | 100% on all three corpora |
| A9 | MATCHES | MATCHES | |
| A10 | MATCHES | MATCHES | |
| A11 | BELOW | BELOW | budget utilisation; product scope |
| A12 | BELOW | BELOW | 2 representation classes; product scope |
| A13 | BELOW | BELOW | focus loss under budget growth; product scope |
| A14 | BELOW | BELOW | 0 of 985 items carry token accounting; product scope |
| A15 | BELOW | BELOW | impact surface renders 0% of call sites; deliberate policy |

```
M198   7 / 15
M199   7 / 15      (MATCH 4, EXCEED 3, BELOW 8, structural violations 0)
target 15 / 15
A8 minimum coverage 100% (need 99)
VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET
```

Generated by `run_stage5_m197a_report.ts`, unmodified.

---

## 16. What produced the change

**Architecture.** All of it. The interleaved A/B in §6 holds the machine, the
corpus, the instrument and the cold denominator fixed and changes only `src/`:
k=1 ratio 0.274/0.385 to 0.052/0.049, amplification 8,960x to 2.0x, persistence
3,394/4,492 ms to 8.9/8.6 ms, with parsing unchanged as the control.

**SQL and indexing.** Nothing. No index was added and none was needed; every
statement the bounded path runs is already an indexed lookup or a scan of a table
that cannot be indexed. M198's `idx_symbols_parent_symbol_id` continues to do the
work it was added for.

**Measurement correction.** Nothing was corrected in A3's favour. Four timing
categories were added — `read`, `bookkeeping`, `parseCacheWrite`, `commit` —
which reduced the unattributed residual from 36% to 19% of an incremental
refresh, and every one of them counts work *against* the refresh.

**Environment.** Against M199. The final after-run sat at load average 18.6
against the before-run's 15.5, and the frozen scoring run at 15.31 against
M198's 14.53. The reported gain is measured across a machine that got busier,
and the A/B removes the question entirely.

---

## 17. Remaining parity gaps

`A1  A3  A5  A11  A12  A13  A14  A15`

Not implemented, not started, not authorized by this milestone.

---

## 18. Product boundary

```
ENGINE QUALITY != CODING-AGENT UTILITY

NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
I6_VALIDATION_SELECTION_REMAINS_CLOSED
```

A faster incremental refresh is a property of the engine. It says nothing about
whether a coding agent is helped by anything the engine produces, and M185's
`NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` still governs.

---

## 19. Falsification controls

| control | result |
|---|---|
| F1 full-rewrite detector | PASS — bound is amplification <= 3.0 against the affected closure, derived as 2 (delete + insert) plus one row of headroom; measured 2.0 on all three corpora |
| F2 ambiguous rebinding | PASS — M198's duplicate-definition regression and the five mutation-hash tests unchanged; ARC's 30 duplicate methods refresh incrementally and compare equal |
| F3 stale deletion | PASS — delete and remove-symbol mutations leave no stale symbol, edge or call-site row; a newly unparseable file leaves no rows and no dangling edges |
| F4 add | PASS — add mutations equal a cold build on all three corpora |
| F5 no-op | PASS — 0 semantic rows written, 3 repeats, 3 corpora |
| F6 sequence | PASS — 5-step sequence equals a cold build of the final state on all three corpora |
| F7 deterministic graph | PASS — 3 identical normalized graph hashes and 3 identical write counts per corpus |
| F8 gate can fail | PASS — forcing `resolvePersistenceScope` back to `whole_repository` fails the boundedness regression; the same forced build is the pre-repair worktree measured at 8,960x in §6 |

Plus the frozen report's own F1–F8, which pass unmodified.

---

## 20. Standing findings

- **A one-file change wrote the whole graph, and the machinery not to had been
  there the whole time.** `persistParseResult` already replaced a single file's
  rows; `deleteEdgesTouchingFileSymbols` already removed one file's edges from
  both directions; the FTS and fact repositories already deleted by path.
  Ownership was never missing. The transaction simply never asked which files the
  plan had invalidated, and 8,960 rows were written per row affected.

- **Symbol identity is a byte range, so a definition that moves breaks every edge
  pointing at it.** That is what makes bounded persistence non-trivial: the rows
  a refresh must repair are not only the changed file's, they are every edge
  whose *target* is in it — rows owned by files the refresh does not touch. Any
  future bounded write has to answer the same question.

- **A3's k=3 was never an incremental refresh.** The third file of ARC by path is
  `arc/__init__.py`, and a package-surface edit is a full rebuild by two
  independent guards. A3 is a single claim scoring two operations of different
  kinds, and the incremental half now sits at 0.052 while the rebuild half sits
  at 1.04. No persistence work can close it; closing it means giving package
  identity a semantic derivation and persisting import descriptors.

- **The frozen benchmark measures the tree that measures it.** C-MED is this
  repository's `src/`, identified by file count. Adding one test file broke the
  corpus check for every claim scored on C-MED. The check worked; the property is
  worth knowing before the next milestone adds a file.

- **Run history is now the largest unbounded term, in time and on disk.** Every
  refresh, no-op included, writes 10,656 rows on C-LARGE and grows the index
  about 7 MB, because `computeSymbolDiff` compares full per-run snapshots and
  nothing prunes old runs. It is repository-scale by contract rather than by
  accident, which is why M199 did not touch it — but it is the clearest remaining
  candidate, and unlike persistence it is a retention question as much as a
  scaling one.

- **`pruneRemovedFiles` is dead code.** Defined in `indexProject.ts`, called from
  nowhere. It is harmless today only because deletions always force a full
  rebuild, which wipes the tables it would have pruned. If the deletion closure
  is ever bounded, it becomes load-bearing and has never been exercised.

- **Next-step recommendation.** None issued. M199 was scoped to A3 and stops at
  the frozen rerun. The A3 gap that remains is a binding-context change, not a
  persistence one, and its value is a benchmark ratio rather than a measured
  workload need. `CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` still
  governs.

---

## 21. Verification

```
bun run typecheck               pass
bun run typecheck:benchmarks    pass
bun test                        5,999 pass / 49 skip / 0 fail (6,048 tests across 370 files)
git diff --check                clean

live-agent runs: 0
live model spend: $0
```

No coding agent was run, no provider call was made, no Docker evaluation was
executed, and no network request left the machine.

## 22. Evidence

```
stage5_m199_before.json        pre-change reproduction, all corpora, stage attribution
stage5_m199_after.json         post-change, all corpora, 3 repeats, storage
stage5_m199_ab_{pre,post}_{1,2}.json   interleaved same-session A/B on C-LARGE
stage5_m199_query_plans.json   EXPLAIN QUERY PLAN + isolated cost per statement
stage5_m199_equivalence.json   18/18 mutations, 3/3 sequences, determinism, F1/F3-F7
stage5_m199_authority.json     frozen authority replay, 15/15
stage5_m199_indexing.json      frozen A2/A3/A4/A8
stage5_m199_engine.json        frozen A1/A5-A7/A9-A15
stage5_m199_claim_ledger.json  frozen A1-A15 matrix, 7/15
```
