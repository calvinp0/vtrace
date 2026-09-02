# M200 — incremental package-surface binding closure

```
verdict           M200 — PASS
parity            A3_PARITY_CLOSED
spend             0 live-agent runs, $0, 0 network requests, 0 VEXP processes
frozen matrix     MATCH 5  EXCEED 3  BELOW 7   match-or-exceed 8/15 (M199: 7/15)
moved             A3 only, BELOW -> MATCHES
```

---

## 1. What was wrong

A modification to a package `__init__.py` was `closure_uncertain`. Two guards
said so, for the same reason, and both were right at the time:

```
planIncrementalRefresh          pre-parse    modified.some(isPackageSurfacePath)
computeSemanticContextHash      post-parse   package\0<path>\0<contentHash>
```

The second one names the defect exactly. The semantic context hash carried the
package file's **raw content**, so these two edits were the same event:

```python
# old
from .foo import Foo

# P1 — a comment is added        # P4 — the target is redirected
# a comment                      from .bar import Foo
from .foo import Foo
```

They are not the same event. Measured on a fixture, the consumer's edges after
each:

```
P1   consumer.py -> pkg/foo.py    unchanged, byte for byte
P4   consumer.py -> pkg/bar.py    every consumer resolution moved
```

`__init__.py` emits no symbols for its imports, so the raw content hash was the
only signal either guard had, and it cannot tell those apart. The conservative
answer — invalidate everything — was therefore the only available one.

`run_stage5_m200_reproduction.ts` establishes which guard actually fired, since
both report the same `fullRebuildReason`. It asks the planner in isolation for
the same change set:

```
C-LARGE k=1   ratio 0.063   guard1=incremental    guard2Consulted=true    parsed 1
C-LARGE k=3   ratio 1.067   guard1=full_rebuild   guard2Consulted=false   parsed 346
                            fullRebuildReason=closure_uncertain
```

The planner decided it. Repairing the hash alone would have changed nothing.

## 2. What replaced it

What a consumer resolves through is a set of **bindings**, and those are
derivable from the resolver the edges are already built with. Two new facts are
published per file by the Python parser and persisted:

```
ModuleBindingSurface   what this module makes importable, and where each name resolves
ImportDescriptor       one row per import statement, as the resolver saw it
```

Neither is re-derived by a second implementation: both come out of
`buildImportMaps`, which is what resolves the edges. A second answer to "which
name does this import bind" would be a second answer, and a closure bounded
against a resolution the graph does not use is a false negative.

The graph could not answer the reverse question on its own. An `imports` edge is
written only when both ends resolve to a symbol, and a consumer whose resolution
is about to move is exactly the case where one does not.

### The surface, on the cases that decide it

```
                                       surface digest
from .foo import Foo                    143544f1…  (base)
# comment; from .foo import Foo         143544f1…  equal      -> no invalidation
from .bar import Foo                    differs               -> consumers invalidated
from .foo import Foo as PublicFoo       differs               -> published name is carried
from .foo import *                      differs, unbounded    -> refused, rebuild
```

### The closure

```
changed surface
   -> importers of that module            (persisted descriptors, covering index)
   -> of those, the ones that REPUBLISH through it
   -> their importers, transitively, cycle-guarded
```

Transitive because a re-export chain's first hop is not its last: a consumer of
`pkg` may resolve through `pkg/__init__.py` into `pkg/a.py` and on into
`pkg/b.py`, and only the first hop is a direct importer. Cycle-**guarded**, not
cycle-refused: a cyclic re-export is a real Python shape, and refusing it would
rebuild the repository for an ordinary edit.

### What still rebuilds

Every refusal returns a rebuild, never a smaller closure.

```
wildcard_surface                  a changed module publishes through `import *`
wildcard_consumer                 a consumer reaches it through `import *`
surface_not_derivable             a package surface no parser models (TypeScript index.ts)
descriptors_unavailable           an index that predates the authority
semantic_change_outside_bindings  symbols moved too, not just bindings
closure_too_large                 past MAX_BINDING_CLOSURE_FRACTION
```

The confinement test is worth naming. Rather than keeping a second per-file
surface ledger that could disagree with the hash it is meant to explain, it
re-asks the same hash function one question: *would the semantic hash have
matched if the changed binding surfaces had stayed where they were?* If yes,
bindings are all that moved.

`MAX_BINDING_CLOSURE_FRACTION` is 0.20 and is a **cost** boundary, not a
correctness one — both sides of it produce the same graph. It is set equal to the
existing `MEASURED_LIGHTWEIGHT_PARSER_CHANGE_RATIO` rather than being a second
tuned number, it is not yet an evidence-derived crossover, and
`IndexPerformanceDiagnostics.bindingClosure` publishes closure size, the work it
implied, and what the rebuild it displaced would have cost, so a later milestone
can replace it with a measured one. It was not chosen to make A3 pass: the frozen
fixture changes no surface, so no closure is derived and the cap is never
consulted.

## 3. Falsification fixtures — P1..P14

Each asserts the plan **and** equality with a clean rebuild of the same final
tree. Padded to 30 unrelated modules, because on a five-file fixture the cap is
one file and every case would exercise the fallback instead of the closure.

```
      case                          plan          closure   equal
P1    non-semantic package edit     incremental   none      yes
P2    added re-export               incremental   1         yes
P3    removed re-export             incremental   1         yes
P4    redirected re-export          incremental   1         yes
P5    aliased re-export             incremental   1         yes
P6    aliased consumer              incremental   1         yes
P7    module import consumer        incremental   1         yes
P8    aliased module import         incremental   1         yes
P9    transitive re-export          incremental   2         yes
P10   cyclic re-export              incremental   4         yes
P11   ambiguous binding             incremental   1         yes
P12   unrelated package export      incremental   1         yes
P13   wildcard consumer             full_rebuild  refused   yes
P14   relative parent import        incremental   1         yes

14 fixtures, 0 behaviour failures, 0 equivalence failures
```

P3 and P4 assert edge **absence**: no stale `consumer.py -> pkg/foo.py` survives.
P12 asserts the independence control — a consumer of another package must not
enter the closure. P13 is the production negative control, and it is not
synthetic: a TypeScript `index.ts` reaches the same refusal through
`surface_not_derivable`, because nothing models what it publishes.

F12 is covered by a unit test that runs the implementation §8 warns about — a
surface keyed by published name alone — and shows it calling P4's redirect
unchanged while the shipped derivation does not.

## 4. The frozen C-LARGE k=3 case

```
changed files            ARC.py, ARC_test.py, arc/__init__.py
package surface before   143544f1352a82d52e7639842e34c335bd2cca4cf05bd3a660980a170c71a9ca
package surface after    143544f1352a82d52e7639842e34c335bd2cca4cf05bd3a660980a170c71a9ca
surface changed          no
changed bindings         0        reverse consumers   not queried
plan mode                incremental                  (M199: full_rebuild)
parsed files             3                            (M199: 346)
equal to clean rebuild   yes
```

Nothing was tailored to this fixture. The same derivation that lets it through
catches P2-P12, and the cap it never reaches is what stops P13.

## 5. Where the remaining time went, and what was done about it

With the planner fixed, k=3 was incremental at **0.520** — still above the 0.25
bar. Profiling put 8,717 ms of 9,441 ms in parsing, for three files:

```
ARC_test.py         524 ms   (15,804 bytes)
ARC.py              240 ms   ( 3,444 bytes)
arc/__init__.py   8,278 ms   (   383 bytes)
```

It is not the file. It is whichever parse crosses
`PYTHON_AST_BATCH_WARM_THRESHOLD`: at four spawns the run warms the AST cache
for every module in the repository, and every parse after it is free. Measured
directly — six leaf modules parsed in one registry:

```
parse #1   327 ms      parse #4   0 ms
parse #2    49 ms      parse #5   0 ms
parse #3 7,740 ms      parse #6   0 ms
```

The threshold was a proxy for "this is a bulk run", chosen so the parser would
not have to be told which kind of run it was in. It was a good proxy while every
multi-file change was a full rebuild. M200 made a three-file incremental refresh
possible, and a package root resolving twenty imports crosses four spawns before
finishing its first file — so the proxy now misfires on exactly the case M200
created.

The parser is now told, when the caller knows: the indexer sets the count once
the parse plan exists, and the parser reads it lazily, because the registry is
built before the plan that decides it. A run that will not parse even one
batch's worth of files pays per file; a caller that says nothing behaves exactly
as before, and cold builds still plan hundreds of parses and still warm.

```
arc/__init__.py    8,138 ms -> 1,349 ms
k=3 parsing        8,717 ms -> 2,033 ms
k=3 ratio            0.520  ->   0.136
```

This is a parser change, so the argument that a cache cannot change its output
was not accepted as evidence. `run_stage5_m200_warm_nochange.ts` builds both
sides from source in separate copies of the same corpus, with the predecessor's
parser checked out **by commit** rather than compared against a stored golden:

```
C-MED     IDENTICAL   full projection + normalizedGraphHash
C-LARGE   IDENTICAL   full projection + normalizedGraphHash
M200_WARM_CHANGE_IS_SEMANTICALLY_INERT
```

## 6. Correctness retained

```
existing mutation matrix     18/18 EQUAL   (M199: 18/18)
sequence equivalence          3/3 EQUAL    modify A, modify B, delete A, add C, modify C
package-binding sequence      EQUAL        add / redirect / add consumer / remove / restore
determinism                   3/3 identical closure, descriptor rows, graph hash, mode
write amplification           2.0x on C-SMALL, C-MED and C-LARGE (M199: 2.0x)
no-op refresh                 0 rows written, including the three new tables
controls                      F1, F3-F7 all pass
```

Exactly one mode moved against M199, and it is the target case:

```
C-LARGE E2-modify-3   full_rebuild/closure_uncertain -> incremental   still EQUAL
```

The package-binding sequence on the real corpus:

```
add re-export        incremental   parsed 16    closure 16 consumers
redirect re-export   incremental   parsed 16    closure 16 consumers
add consumer         full_rebuild  parsed 347   an ADDED file; M200 does not own adds
remove export        incremental   parsed 17    closure 17 consumers
restore export       incremental   parsed 17    closure 17 consumers
final state equals a clean rebuild of the final filesystem
```

The three new tables are in the equivalence projection. A derived table the
harness does not read is a table that can diverge unobserved, and this one
decides whether future refreshes are bounded at all, so a divergence would
compound rather than stay local.

## 7. SQL, indexes and storage

```
                                        plan          C-LARGE cost
reverse_importers_of_target             indexed          0.043 ms
reverse_wildcard_importers_of_target    indexed          0.006 ms
re_exports_through                      indexed          0.030 ms
read_persisted_surfaces                 full_scan        0.056 ms
delete_descriptors_for_file             indexed          0.062 ms
delete_bindings_for_file                indexed          0.033 ms
delete_surface_for_file                 indexed          0.022 ms
```

One index was added, `idx_import_descriptors_target`, and it is the reverse
lookup the closure walks by. It first read as `mixed` — a covering-index SEARCH
followed by `USE TEMP B-TREE FOR DISTINCT` — so the `DISTINCT` was removed,
because the closure adds these to a set anyway. `read_persisted_surfaces` stays a
deliberate scan of a per-file table: 276 rows, the same scale as the file table
it is derived from.

```
                 rows                                    binding bytes   share
C-MED            0 / 0 / 0                                           0    0.00%
C-LARGE          276 surfaces / 5,440 bindings / 3,790 descriptors
                                                             1,994,752    4.24%
```

Both sides are VACUUMed. They were not at first, so the reclamation was being
billed to the binding tables — visibly wrong on C-MED, which holds no binding
rows at all and was reporting 4.34%. C-MED's zero is now the control that the
measurement measures what it says.

## 8. Frozen A1-A15, unmodified scorer

```
ID    M199       M200       note
A1    BELOW      BELOW
A2    MATCHES    MATCHES    C-MED 30.45 files/s, C-LARGE 15.93 files/s
A3    BELOW      MATCHES    <== the only movement
A4    EXCEEDS    EXCEEDS    no-op 0.011 / 0.206 / 0.334 s, 0 files reparsed
A5    BELOW      BELOW      outside M200
A6    MATCHES    MATCHES
A7    EXCEEDS    EXCEEDS
A8    EXCEEDS    EXCEEDS    100% / 100% / 100%, 0 unexplained
A9    MATCHES    MATCHES
A10   MATCHES    MATCHES    signature retention 99.47% / 100%
A11   BELOW      BELOW      outside M200
A12   BELOW      BELOW      outside M200
A13   BELOW      BELOW      outside M200
A14   BELOW      BELOW      outside M200
A15   BELOW      BELOW      outside M200

M199   7/15        M200   8/15        long-term target 15/15
```

A3, as the frozen instrument reports it:

```
cold median            21,717.6 ms
no-op median              334.3 ms
k=1 ratio                   0.062
k=3 ratio                   0.141
singleRefreshSequence       OK, 1 changed file, target ARC.py
band([0.062, 0.141], match 0.25, exceed 0.05, atMost)  ->  MATCHES
```

`band()` requires every measured value to clear, and both do.

```
A3_PARITY_CLOSED
```

## 9. What produced the gain

```
semantic binding architecture   the package term became derived, not raw bytes.
                                This is what makes k=3 incremental at all, and
                                the whole of P1-P14.
planner / closure               the pre-parse package guard moved to a post-parse
                                resolver with a reverse authority to answer with.
                                Worth 1.067 -> 0.520.
SQL / indexing                  one covering index; no measured contribution to
                                the ratio, 4.24% of the C-LARGE index in bytes.
parser cost model               the AST batch warm no longer fires on small runs.
                                Worth 0.520 -> 0.136 and none of the correctness.
measurement                     none. No threshold, corpus, scorer or fixture
                                was modified.
environment                     the machine carried an unrelated compute job
                                throughout (load ~15 of 20 cpus), which the
                                frozen protocol already records as a caveat. A3
                                is a ratio of two timings taken under the same
                                load; k=1 read 0.047-0.062 across reruns and k=3
                                0.111-0.141, both far from the 0.25 bar.
```

## 10. Standing findings

- **The benchmark forbids adding a source file.** C-MED is this repository's own
  `src/`, and its frozen identity is a file count. Three new modules made it 495
  and `run_stage5_m197a_authority.ts` returned `M197A_AUTHORITY_MISMATCH` before
  any claim could be scored — the exact failure M199's ledger predicted for "the
  next milestone [that] adds a source file". The closure derivation therefore
  lives in `incrementalIndex.ts` beside `planIncrementalRefresh` and the hash it
  compares, and the persistence in `persistParseResult.ts`. Both are better homes
  than the standalone modules they replaced, but the constraint chose them, and
  the next milestone that needs a new file under `src/` faces the same wall.

- **A cache heuristic can be a correctness-shaped cost.** The AST batch warm
  turned a 383-byte file into 8.1 seconds, and it did so because its proxy for
  "bulk run" was a spawn counter. Nothing was wrong with the proxy until an
  incremental refresh could parse three files that resolve imports. Every guard
  whose premise is "multi-file means full rebuild" is now worth re-reading; this
  was the one that cost 74% of the A3 gap.

- **`import pkg` consumers cannot be narrowed by name.** A module-form descriptor
  names no member, so it can reach anything the target publishes and must enter
  the closure on any surface change. This is why the closure is module-granular
  and not name-granular, and it is a property of Python rather than a decision.

- **The persisted binding authority is most of an export index.** Resolution
  still rebuilds `PythonExportIndex` by re-parsing each imported module, which is
  what made `arc/__init__.py` expensive before the warm fix and what the warm was
  papering over. `module_bindings` already holds the re-export half of that
  structure. Serving export indexes from persistence instead of re-parsing is the
  obvious follow-on — and it would change symbol resolution, so it needs the
  deterministic retrieval no-change proof, which puts it outside M200.

- **Adds, deletes and renames remain `closure_uncertain`.** M200 did not make
  them derivable and does not claim to. A new file can claim a module name an
  existing import already resolved elsewhere, and a deleted one can strand
  resolutions the graph never recorded as edges. The package-surface case moved
  because a modification leaves the file set intact, so the persisted descriptors
  describe the same repository the new parse does.

- **`pruneRemovedFiles` is still dead code**, and now has one more table to
  prune. M199 recorded it; nothing changed.

- **Next-step recommendation.** None issued. M200 was scoped to A3 and stops at
  the frozen rerun. `CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` still
  governs: no remaining BELOW claim is authorised by this milestone.

## 11. Verification

```
bun run typecheck               pass
bun run typecheck:benchmarks    pass
bun test                        6,007 pass / 49 skip / 0 fail (6,056 tests, 370 files)
git diff --check                clean

live-agent runs: 0
live model spend: $0
```

No coding agent was run, no provider call was made, no Docker evaluation was
executed, and no network request left the machine.

## 12. Evidence

```
stage5_m200_reproduction.json         pre-change guard attribution, C-LARGE k=1/k=3
stage5_m200_package_equivalence.json  P1-P14 behaviour and full-build equality
stage5_m200_closure_evidence.json     frozen k=3 closure, package sequence, determinism
stage5_m200_profile.json              stage attribution before the warm fix
stage5_m200_profile_after.json        stage attribution after it
stage5_m200_warm_nochange.json        paired predecessor/candidate graph identity
stage5_m200_equivalence.json          18/18 mutations, 3/3 sequences, F1/F3-F7
stage5_m200_query_plans.json          EXPLAIN QUERY PLAN, per-statement cost, storage
stage5_m200_authority.json            frozen authority replay, 15/15
stage5_m200_indexing.json             frozen A2/A3/A4/A8
stage5_m200_engine.json               frozen A1/A5-A7/A9-A15
stage5_m200_claim_ledger.json         frozen A1-A15 matrix, 8/15
```

```
ENGINE QUALITY != CODING-AGENT UTILITY
```
