# M198 — core engine correctness and performance

**M198 — PASS**
`CORE_ENGINE_CORRECTNESS_AND_PERFORMANCE_SUBSTANTIALLY_IMPROVED`
`VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET`

`ENGINE QUALITY != CODING-AGENT UTILITY`

M198 repaired four defects in capabilities VTRACE already claimed, and optimised
two measured bottlenecks. The frozen M197A comparison moved 5/15 → 7/15 as a
consequence; it was not the objective, and no claim was implemented to reach it.

---

## 1. Starting state

```
branch                main
starting SHA          907668b30429d3a08fd5de3f1a6ac40d39f9f678
ahead/behind origin   0 behind, 170 ahead (never pushed)
tracked dirt          benchmarks/.../stage5_outcome_ledger.{json,md}   (pre-existing, preserved)
untracked dirt        204 entries under benchmarks/ and repo root      (pre-existing, preserved)
git diff --check      clean
```

`src/` was byte-identical to 4ab01a72 (M196A), so C-MED was the same corpus
M197A measured.

## 2. Frozen M197A baseline authority

Replayed before any product change: **15/15 authority checks pass**,
`M197A_AUTHORITY_VERIFIED`.

```
preregistration sha256   736e8a9b…6f697d8f0   (unchanged)
G1 ">= 10 of 15 claims MATCH or EXCEED"        present verbatim
G8 "ingestion completeness < 99%"              present verbatim
claim ledger             24 claims @ vexp-cli 2.0.24, 9/9 cited present
C-SMALL   21 files @ d658e3457b      C-MED  492 files @ 907668b304
C-LARGE  276 files @ 826144342e      + 699 .py excluded as nested worktrees
```

The historical verdicts reproduce exactly: A4/A7/A8 EXCEEDS, A6/A9 MATCHES, the
other ten BELOW, **5/15**. The frozen artefacts
(`stage5_m197a_{authority,indexing,engine,claim_ledger}.json`) are restored
byte-identical in the tree; M198's runs are published beside them as
`stage5_m198_*.json`.

**No threshold, corpus, claim, tokeniser or scoring rule was altered.**

---

## 3. TypeScript structural defect

**Root cause — one mechanism, not two.** `node-tree-sitter` reports node offsets
(`startIndex`/`endIndex`) as **UTF-16 code-unit** indices into the string it
parsed. `SymbolRecord.startByte`/`endByte` are **UTF-8 byte** offsets: that is
what `pythonParser` emits from CPython's `ast`, and what every consumer slicing a
file `Buffer` assumes — `sourceExcerpt`, `extractSymbolContent`,
`extractBodyLiterals`, `extractMechanismFacts`.

`typescriptParser` stored the former in the latter. The two agree up to a file's
first non-ASCII character and diverge by a growing constant after it, so slicing
bytes at a UTF-16 index lands **early** by that surplus.

`src/capsule/__fixtures__/stage5DjangoFixture.ts` has four non-ASCII characters
at UTF-16 indices 111, 239, 1682, 12453, each a 3-byte character contributing +2:

| symbol | node startByte | drift | emitted signature |
|---|---|---|---|
| `SymbolSpec` | 1321 | 4 | `";\n\ninterface SymbolS` |
| `seedStage5DjangoFixture` | 5453 | 6 | `xport function seedStage5DjangoFixture(db: Database):` |

Both are the same early window. `xport function …` reads as a *late* start only
because the node is the inner `function_declaration`, so a 6-character-early
window begins inside `export`.

**M197A's stated diagnosis was wrong in its cause and right in its symptom.** It
read the misrendered call lines as `start_byte` including an attached leading
comment. An early span simply reaches back into whatever precedes the
declaration, which is usually its comment.

**Affected population, pre-repair, against source truth** (verbatim occurrence,
identifier-aligned boundaries, closed brackets — the frozen F4 rule):

```
C-MED     4,566 declarations   1,924 valid   42.14%
```

## 4. TypeScript structural repair

`getSignature` now takes a string slice at the offsets tree-sitter actually
means. Spans are translated UTF-16 → UTF-8 once per file by an `OffsetTranslator`
that is the identity for pure-ASCII sources (the overwhelming majority) and a
binary search over recorded surplus positions otherwise; the inverse keeps the
edge pass's node-offset lookups working.

| metric | corpus | M197A | M198 |
|---|---|---|---|
| signature retention | C-SMALL | 51.32% | **100%** |
| signature retention | C-MED | 41.13% | **99.47%** |
| signature retention | C-LARGE | 100% | 100% |
| member retention | C-SMALL / C-MED / C-LARGE | 72.73 / 100 / 94.82% | 72.73 / 100 / 94.82% |
| malformed files (F4) | C-SMALL | 8 | **0** |
| malformed files (F4) | C-MED | 247 | **22** |

Gate (§10): signatures ≥ 95% and members ≥ 90% — **met on every corpus**.
Malformed output is 0 on two of three corpora.

**The residual 22 C-MED files are an instrument artefact, not a product defect,
and the instrument was left alone.** `signatureFaults` validates
`raw.indexOf(signature)` — the *first* occurrence — so `interface Capsule` is
checked against `interface CapsuleBudget` forty lines above it and flagged
`SLICED_MID_IDENTIFIER_END`. All 24 such signatures do occur token-aligned
elsewhere in their own file. Correcting the rule would raise A10 from 99.47% to
100% and could turn MATCHES into EXCEEDS, so **the frozen scoring module was not
touched** and the conservative figure is the one scored (§42).

Member retention did not move: C-SMALL's 72.73% and C-LARGE's 94.82% are
extraction gaps, not representation gaps, and M198 did not target them.

## 5. Call-site serialization defect and repair

**Semantic evidence was never at fault.** M197A established 136/136 declared
call-site spans genuinely contain the callee; M198 reconfirms
`inventedStructuralClaims = 0` on all three corpora. `EdgeCallSite` carries
line/column, not bytes, so the persisted occurrences were always correct.

The serialization was defective for exactly the reason above:
`excerptFromLoadedSymbol` slices `fileBytes` with `symbol.startByte` and labels
the result `symbol.startLine`, and `persistedOccurrence` then indexes into that
text by `site.startLine - excerpt.startLine`. A skewed span breaks the
correspondence, and the rendered "call site" becomes a nearby line.

| metric | corpus | M197A | M198 |
|---|---|---|---|
| excerpt anchoring (of conclusive) | C-SMALL | 88.24% | **100%** |
| excerpt anchoring | C-MED | 53.85% | **100%** |
| excerpt anchoring | C-LARGE | 100% | 100% |
| **strengthened structural claims** | all | **24** | **0** |
| invented structural claims | all | 0 | 0 |
| A15 flow-surface correct rendering | C-MED | 50% | **100%** |

**§14 gate met: strengthened = 0, invented = 0.**

A note on excerpt spans that survives the repair: a symbol span starts at the
*declaration*, so for an exported symbol the first emitted line is a suffix of
its source line (`export ` precedes the node). Every line after it is exact, which
is the property `persistedOccurrence` depends on. M197A's locator counted these
as `not_located` (inconclusive), never as misanchored.

**A15 remains BELOW, deliberately (§15/§40).** It is scored on the impact
surface, which renders 0% as expressions on all three corpora *including*
Python, where the data and its rendering are both correct. The cause is
`compactRelation` in `compactImpactProductResponse` — the final model-facing
gate — which unconditionally projects `evidence` down to
`resolutionMethod / locationKind / callSites`, dropping `sourceText` and
`referenceName` before any budget pressure is considered. That is documented
envelope policy from M177/M178-B, not a malformed rendering. Adding `sourceText`
there would be building a product feature to win one benchmark point, so it was
not done.

---

## 6. Incremental correctness defect and repair

**Root cause.** `rebindCachedEdgeTargets` repoints cached edges at the current
parse's symbol ids, keyed on semantic identity `(path, fqName, localName, kind,
signature, exported)`. It built that index with `new Map(...)`, so where two
symbols share a key the **last one silently won and both old ids rebound to it**.
The mapping was not injective.

Python and TypeScript both permit a class to define the same method twice. **ARC
does it 30 times** (60 symbols). `Class contains method#1` and
`Class contains method#2` then became the same `(src, dst, type)` triple, and the
edge id is a hash of exactly that triple — so two rows collided on the primary
key: **9 collapsing edge pairs**, all `contains`.

The crash was the smaller half. Even where it did not fire, the merge left an
incremental graph a cold build would never produce: `method#1` survived as a
symbol but lost its containment edge.

**Repair.** A semantic key that names two symbols identifies neither, so it now
maps nothing (ambiguous keys are dropped from both sides). Rebinding can still
legitimately land two edges on one identity — a cached result naming an old id
and a freshly parsed one naming the current id describe the same relation — and
because the id is a hash of exactly `(src, dst, type)`, such edges are provably
the same edge and are **merged** (call sites unioned, highest confidence kept)
rather than dropped by `INSERT OR IGNORE`, which §17 forbids and which would
have discarded occurrences the parser really observed.

**Equivalence (§18, §19), ARC at corpus scale — 6/6 semantically equal:**

| mutation | mode | files parsed | graph vs cold index |
|---|---|---|---|
| modify-1 | incremental | 1 | EQUAL |
| modify-3 | full_rebuild (`closure_uncertain`) | 346 | EQUAL |
| add-file | full_rebuild | 347 | EQUAL |
| delete-file | full_rebuild | 345 | EQUAL |
| rename-file | full_rebuild | 346 | EQUAL |
| remove-symbol | incremental | 1 | EQUAL |

Compared over files, symbols, edges, edge call sites, mechanism facts, document
chunks and file failures; run/timing tables excluded. `singleRefreshSequence`
is **OK on all three corpora** (C-LARGE was `CRASH`).

`modify-3` falls back to a full rebuild because the third file by the product's
own enumeration is `arc/__init__.py`, a package surface: adds, deletes, renames
and package-surface edits can change old resolutions with no queryable reverse
dependency, because unresolved descriptors are not persisted. That is deliberate,
documented behaviour — and it is what M197A's k=3 ratio of 1.827 was actually
measuring.

---

## 7. Incremental architecture and performance

**Parsing is bounded; persistence is not.** The closure is computed correctly and
the parse loop respects it exactly:

| corpus | operation | mode | files parsed | closure |
|---|---|---|---|---|
| C-LARGE | no-op | noop | 0 | 0 |
| C-LARGE | k=1 | incremental | **1** | 1 |
| C-MED | k=1 | incremental | **1** | 1 |
| C-MED | k=3 | incremental | **3** | 3 |

P1 (no-op reparses nothing), P2/P3 (k files parsed for k changed), and P4
(unrelated files immune) all hold.

**M197A's "reparsed 346 of 346 for a one-file change" was reading the wrong
counter.** `totalFilesAttemptedForParse` is `readableFiles.length` — files
successfully *read* — and equals the corpus size in every mode. The real count is
`performance.parsedFiles`, which is 1.

**Where the time actually went.** Stage attribution for a C-LARGE k=1 refresh
that parsed one file:

```
discovery      93 ms
parsing       935 ms
invalidation 17978 ms      <-- 68% of the refresh
persistence  5538 ms
linking       850 ms
```

Timing each statement of the invalidation block isolated all of it:

```
DELETE FROM symbol_search_fts             95 ms
DELETE FROM symbol_body_literals_fts      23 ms
DELETE FROM symbol_mechanism_facts         7 ms
DELETE FROM document_search_fts           15 ms
DELETE FROM document_chunks                1 ms
DELETE FROM edges                        278 ms
DELETE FROM symbols                    18451 ms
DELETE FROM files                          1 ms
```

`symbols.parent_symbol_id` references `symbols.id` and had **no index on the
referencing side**. SQLite enforces that by looking for rows still pointing at
the row being deleted; with no index that is a full table scan *per deleted row*,
so 10,309 symbols became ~106 million row visits.

```
DELETE FROM symbols          19,522 ms -> 105 ms   (index builds in 12 ms)
invalidation                 17,978 ms -> 635 ms
insert 20,000 symbols            61 ms ->  62 ms   (not paid for on the way in)
normalizedGraphHash          unchanged
```

**A3 result: still BELOW.** The crash is repaired and the path is genuinely
incremental, but the frozen bar is ratio ≤ 0.25 on C-LARGE and the measured
ratios are k=1 **0.399**, k=3 **1.12**. C-MED now clears the bar (0.169 / 0.185)
and C-SMALL nearly does (0.287 / 0.326), but A3 is scored on C-LARGE.

The residual is persistence: a one-file change still deletes and rewrites the
whole graph. Making persistence respect the closure is the remaining
architectural work; it was **not** attempted, because it would put the
6/6 equivalence proof at risk for a ratio, and §22 forbids trading semantic
equivalence for speed.

**An honest tension worth recording:** A3 is a *ratio*, so the cold-index
optimisation below moved it the wrong way. Before batching, C-LARGE cold was
~50 s and a k=1 refresh ~37 s (ratio ≈ 0.74); after, cold is ~23 s and the ratio
is 0.505 at the same load. Speeding up the denominator is not a regression in the
engine, and the absolute cost of both operations fell.

---

## 8. Cold-index profiling and optimisation

**Profiled before optimising (§24, §25).** Stage attribution of a cold build:

| stage | C-MED | share | C-LARGE | share |
|---|---|---|---|---|
| discovery | 130 ms | 0.6% | 71 ms | 0.1% |
| **parsing** | **18,806 ms** | **86.0%** | **42,322 ms** | **85.0%** |
| persistence | 1,633 ms | 7.5% | 5,747 ms | 11.5% |
| linking | 232 ms | 1.1% | 1,056 ms | 2.1% |
| validation | 25 ms | 0.1% | 37 ms | 0.1% |

Inside parsing, the Python parser spawned `python3 -c <script>` **once per file**
(confirmed by a counting interpreter shim: exactly 40 spawns for 40 files — the
existing export-index cache already prevented duplicate parsing). A bare
interpreter start costs ~36 ms on this machine against ~23 ms of actual work, so
**more than half the budget was process startup**. One interpreter running the
same script over all 276 ARC files takes 6.4 s total.

**Change.** The AST script is now also reachable in bulk: a small driver reads
the script and a list of sources from stdin and runs the script once per file in
one process, giving each the environment it expects. A run spawns singly until it
has taken four — an incremental refresh must not pay to warm a repository — then
warms every known module once, keeping the raw JSON text.

The first design cached a moving 48-file window and was **worse than what it
replaced**: two callers share this cache and want opposite orders — the indexer
walks files sequentially, import resolution reaches for whichever module a file
imports — and the random reader evicted the sequential one on every miss, giving
**440 spawns for 276 files**. That is why the warm is now whole-corpus and
eviction-free.

| C-LARGE, same machine, same corpus | before | after |
|---|---|---|
| python3 spawns | 440 | **79** |
| parsing | 49.4 s | **16.4 s** |
| throughput | 6.08 files/s | **14.33 files/s** |

**Contention control.** The controlled A/B above is same-session, same load
(~33): pre-batch 6.66–6.94 files/s, post-batch 14.33–15.34 files/s on ARC —
**≈2.2× attributable to the change**. The frozen run below was taken at load
14.5 against M197A's 36.3, so part of the headline gain is a quieter machine and
is *not* claimed as engine improvement.

**A2 result: BELOW → MATCHES.**

```
C-MED     27.35 -> 36.21 files/s
C-LARGE    8.81 -> 19.47 files/s      (MATCH >= 15, EXCEED >= 30)
```

**Equivalence:** `normalizedGraphHash` over ARC is identical across the batched
and un-batched implementations and across three repeat builds
(`64c292bf20f7faa76f994a7f0546cbf3d06bfc0e0824856c05361630ff54a53f`), and batch
output was verified byte-identical to per-file spawns across 60 ARC files before
the path shipped. A file that raises is not cached, so it falls back to its own
spawn and reproduces the original error verbatim.

---

## 9. Query latency

`QUERY_PERFORMANCE_ENVIRONMENT_CONTENDED`.

The machine is shared with an unrelated compute job that held ~20 cores for most
of this milestone; it could not be made idle. Load at the frozen engine run was
**14.53** against M197A's **36.29**, so the improvement below is *not*
attributable to M198 and no query-path optimisation was attempted.

| corpus | M197A p90 | M198 p90 |
|---|---|---|
| C-SMALL | 407 ms | 68.78 ms |
| C-MED | 1111 ms | 343.86 ms |
| C-LARGE | 1422 ms | 713.46 ms |

**A5 result: BELOW.** C-LARGE's 713 ms exceeds the 500 ms MATCH bar even on the
quieter machine. Retrieval lanes, candidate recall, provenance and graph evidence
are untouched; determinism is stable and semantic output is unchanged.

---

## 10. Regression protection

| claim | M197A | M198 | evidence |
|---|---|---|---|
| A4 no-op freshness | EXCEEDS | **EXCEEDS** | 0.010 / 0.130 / 0.362 s, 0 files reparsed |
| A6 impact latency | MATCHES | **MATCHES** | p90 424 → 306 ms |
| A7 flow latency | EXCEEDS | **EXCEEDS** | p90 104 → 32 ms |
| A8 ingestion | EXCEEDS | **EXCEEDS** | 100 / 100 / 100%, 0 unexplained (hard invariant, ≥99%) |
| A9 skeleton reduction | MATCHES | **MATCHES** | C-MED 93.21 → 92.67%, C-LARGE 87.21 → 87.21% |

A9 fell 0.54 points on C-MED and 3.62 on C-SMALL. This is expected and correct:
225 previously-malformed C-MED files now render valid skeletons and enter the
population, so the reduction is no longer computed only over files that already
worked, and truncations no longer flatter it by being short. Truth was preferred
to compression, as §33 requires, and no valid structure was truncated to protect
A9.

---

## 11. Frozen A1–A15 before/after

| ID | M197A | M198 | changed | cause | status |
|---|---|---|---|---|---|
| A1 | BELOW | BELOW | | 3 parser-backed families vs 30 | not targeted (§34) |
| A2 | BELOW | **MATCHES** | ✔ | batched CPython AST extraction (`fcd3caec`) | targeted |
| A3 | BELOW | BELOW | | crash repaired, ratio 0.399 > 0.25; persistence unbounded | targeted |
| A4 | EXCEEDS | EXCEEDS | | | protected |
| A5 | BELOW | BELOW | | 713 ms > 500 ms; improvement is machine load | targeted |
| A6 | MATCHES | MATCHES | | | protected |
| A7 | EXCEEDS | EXCEEDS | | | protected |
| A8 | EXCEEDS | EXCEEDS | | | protected |
| A9 | MATCHES | MATCHES | | | protected |
| A10 | BELOW | **MATCHES** | ✔ | UTF-16→UTF-8 span authority (`4b6256b7`) | targeted |
| A11 | BELOW | BELOW | | fixed tier caps bind first | not targeted (§35) |
| A12 | BELOW | BELOW | | 2 representation classes | not targeted (§36) |
| A13 | BELOW | BELOW | | 3 size violations + 5 focus swaps | not targeted (§37) |
| A14 | BELOW | BELOW | | 0 of 985 items carry accounting | not targeted (§38) |
| A15 | BELOW | BELOW | | impact surface compaction is policy, not malformation | bounded (§15) |

Every changed verdict maps to a committed product change. No measurement
correction was applied; the one instrument defect found (§4) was left in place
because correcting it would have helped the score.

## 12. Aggregate parity

```
M197A     MATCH 2   EXCEED 3   BELOW 10      match-or-exceed  5 / 15
M198      MATCH 4   EXCEED 3   BELOW  8      match-or-exceed  7 / 15

threshold  >= 10 / 15  AND  A8 >= 99% on every corpus     (unchanged)
A8         100 / 100 / 100%                                (satisfied)
structural violations 0    determinism stable    F1-F8 all pass

VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET
```

## 13. What actually produced the gain

- **Correctness repairs → A10.** The span fix is the whole of A10 and the whole
  of the strengthened-claims gate. Nothing else contributed.
- **Cold-index optimisation → A2.** ≈2.2× from batching under contention
  control; the rest of the headline number is a quieter machine.
- **Incremental architecture → no verdict change.** The FK index removed 96% of
  invalidation and the crash repair removed the abort, but A3's bar is a ratio
  against cold and persistence is still unbounded.
- **Query optimisation → none attempted.** A5's movement is machine load.
- **Measurement correction → none applied.**

## 14. Remaining VEXP gaps

Unchanged and preserved, per §52:

- limited language breadth (3 parser-backed families)
- whole-output budget under-utilisation (38 / 33 / 16 / 8.5 / 7.2%)
- only two default representation classes
- non-monotone graceful degradation (3 size violations, 5 focus swaps of 20)
- no per-item token accounting (0 of 985 delivered items)
- large model-visible tool surface (14 tools, ~5,521 schema tokens — unchanged)
- Markdown not indexed
- cross-repo graph edges absent
- **context-compiler product utility not established**

New to this list: **incremental persistence is unbounded** — the closure is
computed and parsing respects it, but a one-file change still rewrites the whole
graph.

## 15. Engine interpretation

*Is VTRACE now technically competitive with the frozen deterministic VEXP claim
set?* By the frozen threshold, **no**: 7 of 15 against a bar of 10. It is
materially closer, and the two claims it gained were gained by making existing
capabilities correct and fast rather than by adding anything.

*Does this prove VTRACE materially improves strong coding agents?* **NO.**

`ENGINE QUALITY != CODING-AGENT UTILITY`

## 16. Product boundary

```
CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED
NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION
NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
I6_VALIDATION_SELECTION_REMAINS_CLOSED
```

## 17. Verification

| control | result |
|---|---|
| C1 malformed TS signature | PASS (fails before repair) |
| C2 multiline / generic signature | PASS (fails before repair) |
| C2b method signature below non-ASCII | PASS (fails before repair) |
| C3 call-site coordinate truth | PASS (fails before repair) |
| C4 misleading leading comment | PASS (fails before repair) |
| C5 uncertain edge not rendered as exact | PASS (pre-existing invariant, passes both ways) |
| C6 incremental `edges.id` collision | PASS (fails before repair with the historical error) |
| C7 incremental vs full index | PASS (6/6 ARC, 5 fixture mutations in-suite) |
| C8 deletion / rename | PASS |
| P1 no-op reparses nothing | PASS (0 files, all corpora) |
| P2 one-file change | PASS (1 file parsed) |
| P3 three-file change | PASS (3 files parsed) |
| P4 unrelated-file immunity | PASS (closure = changed files) |
| P5 query result parity | PASS (determinism stable, semantic output unchanged) |
| P6 cold index parity | PASS (`normalizedGraphHash` identical; 60/60 byte-identical AST) |
| P7 repeated determinism | PASS (3 builds, identical hash) |

```
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun test                       5994 pass, 49 skip, 0 fail (6043 tests, 370 files)
git diff --check               clean
A1-A15 frozen rerun            executed, instrument unmodified
live-agent runs                0
live model spend               $0
```

## 18. Repository state

```
branch                  main
starting SHA            907668b30429d3a08fd5de3f1a6ac40d39f9f678
correctness commits     4b6256b7  TypeScript span authority
                        aa417e27  injective symbol rebinding
performance commits     fcd3caec  batched CPython AST extraction
                        4dd626fb  FK index on symbols(parent_symbol_id)
pre-existing dirt       preserved (stage5_outcome_ledger.*, 204 untracked)
pushed                  NO
```

## 19. Strategic conclusion

VTRACE materially improved its existing engine but still trails the frozen VEXP
deterministic claim set in the remaining measured dimensions; those remaining
gaps must not be implemented by default without independent product
justification.

---

I5 remains closed after M190.
I6 validation-target selection remains closed after M195A.
M198 repaired and optimized existing VTRACE engine capabilities only.
No context-compiler product utility experiment was run.
No new intervention family was introduced.
No coding agent was run.
No live model spend was incurred.
The frozen M197A comparison was not weakened or redefined.
Any future product work must be justified independently of the VEXP parity score.
