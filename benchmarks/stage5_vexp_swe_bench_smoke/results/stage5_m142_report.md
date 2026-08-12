# M142 — Behavioral Retrieval Robustness, Concept Ownership, Fresh-Worktree Bootstrap

**Verdict: INCOMPLETE.** Workstreams A, B and C are implemented, tested and
evidenced. Workstream D is measured and root-caused but not implemented.
Workstream E was not started. The paired regression benchmark was prepared and
launched but had not returned when this report was written.

Per §143 this is INCOMPLETE, not MIXED: two mandatory workstreams are not
implemented, and the frozen-50 / Django / cross_repo comparison has not been read.

```text
Workstream A — Prose vs Identifier Signal Hygiene     PASS
Workstream B — Relevance-Gated Centrality             PASS
Workstream C — Behavioral Concept-Owner Retrieval     MIXED
Workstream D — Response Usefulness and Boundedness    NOT IMPLEMENTED (measured)
Workstream E — Fresh-Worktree Index Bootstrap         NOT STARTED
```

---

## Starting state

M141 functional predecessor: `562cff6a5fcf5634e13d768fbc73e4de19b9b578`.
Full SHAs for the six M141 commits:

```text
8d098481a31e9489b63782df4beed78176a873ad
b5a7a9281787e8bf9397be8471e3503b60fbd9b3
86c4cb0bd37edc7b26913afa713e2cc3f1aa10e6
96d64d975fb6cd96a1848653fef5350afa890780
b3d14a3d13bf81a43826185e16239f8e889b93af
562cff6a5fcf5634e13d768fbc73e4de19b9b578
```

**Correction to the brief.** It reported `main` as 21 ahead of origin and not
pushed. The actual state at M142 start was **0 ahead / 0 behind**, and
`git reflog show origin/main` records `562cff6` arriving via `update by push`.
M141 was pushed. M142's own commits are local and unpushed.

Working tree carried the expected pre-existing dirt (`stage5_outcome_ledger.json`
and `.md`); neither was staged.

## Functional commits

```text
321f9a3  Separate prose from identifier intent
69826d3  Gate graph centrality on task relevance
0e4edc7  Retrieve behavioral concept owners
```

## Reproduction

Fresh ARC index at `2f3fd462600d23e671afb6e3ea4623c6b51674bf`, 9,009 symbols,
built in **22.5 s** — which independently confirms the §63 figure of 22–31 s.

Recorded in `stage5_m142_behavioral_failures_m141_before.json`.

One methodological correction happened before any number was recorded. The first
reconstruction of the four behavioural queries reused the implementations' own
vocabulary, and three of four then returned the correct owner on the
**predecessor** — a suite that already passes before the fix (§47). The queries
were rewritten to describe behaviour without naming the implementation, which is
what §29 actually asks for, and the before-state was recorded against those.

| case | predecessor state |
| --- | --- |
| normal-mode displacement | `arc/checks/nmd.py` **not generated** — absent from the pool entirely |
| Gaussian route keywords | `common.py::which` **rank 1, delivered as a pivot** |
| reactant atom index space | `get_reactants_and_products` not generated; `get_bonds` rank 10, not selected |
| TS-guess atom order | `get_single_mapped_product_xyz` not generated; `order_xyz_by_atom_map` rank 6, not selected |

**The `arc/main.py::ARC` project-name failure did not reproduce.** At M141 the
symbol is `not_generated` for the Gaussian query: `projectReferences: ["ARC"]`
already suppresses it, and M132's project-name handling covers that shape. No fix
was written for a defect that is not present; the before/after row records both
states as `not_generated`.

---

## Workstream A — prose vs identifier hygiene (PASS)

### Root cause

Two independent producers, which is why the earlier per-word fixes never held
(§16, the M140-A6 lesson).

1. `searchSymbolsShared.ts` — the broad-term lane awards `broadTermLocalNameExact
   = 28`, its top tier, whenever a query term equals a symbol's `local_name`. The
   only gate was `BROAD_QUERY_STOPWORDS`, which contains `how` and `where` but
   not `which`.
2. `directEvidenceAnchoring.ts` — `resolveFileStemWord` resolved any bare
   lowercase word ≥5 characters to a same-named **top-level definition** and
   synthesized a WEAK final of **1.9**, the strongest score in that pool. This is
   the producer that actually made `which` rank 1; `likelySymbols` and
   `symbolHypotheses` were both empty, so the identifier lane was never involved.

Also confirmed **not** producers, by reading the code: `titleSymbolAnchoring`
(shape-gated: backticks, multi-hump CamelCase, dotted, snake_case,
SCREAMING_SNAKE), `literalAnchoring` (author-marked or ALL-CAPS, project-name
aware), path clues (require a separator), `evaluateDirectAnswer` (token overlap,
capped at 0.28 without a name concept).

### Fix

One request-local decision, `exactSymbolEligibleTerms`, consulted by both
producers. A term may claim name identity when the derived grammar already marked
it an identifier — backticks, call syntax, a symbol-kind noun, a path
qualification, an explicit lookup command, a comparison operand — or when its
shape is unambiguously code (ALL CAPS). Repository/project references are
excluded unless the task explicitly targets the symbol.

It is a rule about **assertion strength**, not suppression: an ineligible term
keeps prefix, substring, path, docstring, coverage, domain and graph scoring. It
simply cannot outrank a pool on a coincidence of spelling.

Deliberately untouched: file-shaped resolutions, which are corroborated by a file
that actually exists (so the M96 stem recoveries are unaffected), and callers
that search by an already-resolved identifier, which pass no grammar and keep the
previous reading.

One grammar gap was closed on the way: `"the function copy"` gave no identifier
signal, because the declaration-phrase patterns required CamelCase or snake_case.
A plain lowercase name now qualifies after a symbol-KIND noun — the cue is the
preceding noun, not the word's shape — with a small clause-hinge set scoped to
that one pattern so `"the helper which parses…"` is not misread.

### Result

| query token | context | predecessor role | M142 role | exact-symbol eligible? |
| --- | --- | --- | --- | --- |
| `which` | grammatical determiner | identifier-like (rank-1 pivot) | ordinary prose | no |
| `which` | `which()` | explicit identifier | explicit identifier | yes |
| `ARC` | project reference | project reference | project reference | no |
| `ARC` | "the ARC class" | explicit identifier | explicit identifier | yes |
| `copy` | "the function copy" | ordinary prose (grammar gap) | explicit identifier | yes |
| `FITS` | ALL-CAPS acronym | explicit | explicit | yes |

`common.py::which`: **pivot at rank 1 → not generated**. Both explicit controls
unchanged: `Where is which() implemented?` still leads on
`arc/job/adapters/common.py::which`; `Where is the ARC class defined?` still leads
on `arc/main.py::ARC`.

Generic fixtures in `src/capsuleV2/proseIdentifierHygiene.test.ts` (10 tests):
common-English collision (`which`/`run`/`copy`/`load`/`check`), a repository
literally named `FOO` containing a class `FOO`, explicit-lookup positive
controls, and a producer-agreement test that reproduces the pre-M142 reading when
no grammar is supplied.

---

## Workstream B — relevance-gated centrality (PASS)

### Root cause

The hub penalty is all-or-nothing: it fires only when a high-in-degree candidate
has **no** local evidence at all, and almost nothing clears a bar that low.
Measured across six ARC queries before the change: `ARCSpecies` (746 dependents)
took the **maximum** centrality contribution on every single one, including
`Where is which() implemented?`, where it carried 21% of the pool's best local
evidence and was still delivered.

Only 9 of 150 pooled candidates had a centrality contribution above 0.05, so the
gate is narrowly targeted rather than a broad rescore.

### Fix

Centrality is scaled by the candidate's share of the strongest local evidence in
the pool:

```text
centralitySupport = weights.centrality * centrality * relevanceShare
```

Not a threshold. A cut-off needs a constant nobody can derive and behaves
discontinuously either side of it; a share is already in the units of the thing
being asked about. Centrality cannot create relevance because it is multiplied by
relevance — and it still reorders plausible candidates.

Scoring now runs in two phases: the share is pool-relative and unknowable until
every candidate's local evidence exists. `recomputeWithWeakenedLexical`
re-derives the gate from the scorecard (`localEvidence / share` recovers the pool
maximum) rather than reusing a stale share.

### Result

| candidate | case | before | after |
| --- | --- | --- | --- |
| `ARCSpecies` | normal-mode | rank 14, f=1.393, **selected** | dropped from pool |
| `ARCSpecies` | Gaussian route | rank 9, f=1.436 | dropped from pool |
| `ARCSpecies` | reactant index | rank 14, f=1.276 | dropped from pool |
| `ARCSpecies` | TS-guess order | rank 10, f=1.371, **selected** | dropped from pool |
| `ARCSpecies` | `which()` lookup | rank 11, f=1.086, **selected** | dropped from pool |
| `ARCSpecies` | ARC-class lookup | rank 2, f=2.193, selected | **rank 2**, f=2.060, selected |
| `ARCReaction` | reactant index | rank 2, f=1.631, selected | **rank 2**, f=1.597, selected |
| `ARCReaction` | ARC-class lookup | rank 3, f=1.858, selected | **rank 3**, f=1.801, selected |

Centrality-only delivery eliminated on five of six queries; both positive controls
— the questions genuinely about those objects — preserved at the same rank.

Fixtures in `src/retrieval/centralityRelevanceGate.test.ts` (6 tests) include the
§26 generic case (`CoreObject` with 200 dependents vs a low-fan-in
`build_gaussian_route`) and the §27 positive control. Recorded in the fixture:
the obvious multi-module spelling yields an in-degree of **zero**, because
cross-file imports are owned by the module scope and M140-A6 excludes structural
sources — so the dependents must share the file for the fixture to test anything.

---

## Workstream C — behavioral concept-owner retrieval (MIXED)

Implemented in `src/retrieval/conceptOwnerRetrieval.ts`: per-file evidence
aggregation over indexed metadata, IDF-weighted by how rare each concept is
across files, with a term in a symbol name or file basename weighted above the
same term in prose. The best definitions of the few best owners are admitted as
ordinary candidates.

**Bounds:** `maxConceptOwnerFiles: 3`, `maxDefinitionsPerConceptOwner: 3`,
`maxConceptOwnerCandidates: 6`, `minObjectives: 3`, `minOwnerScore: 0.35`.
**Source reads: 0**, structurally and as a reported diagnostic.

Two design decisions were forced by measurement rather than chosen:

- Owner selection needs the **deliverable** pool. Judged against the raw
  candidate map, 31 owners counted as already-represented on the ARC normal-mode
  question, including the file it was about.
- File presence is the wrong test even then. The pool *did* contain
  `arc/checks/nmd.py`, via a helper graph expansion reached incidentally, while
  the definitions answering the question were absent. An owner is skipped only
  once the pool carries as many of its definitions as the lane would contribute.
- Recovered definitions enter through the **cap**, not the ranking. A definition
  nothing could name scores ~0.8 against a pool floor of ~1.4; raising the lane's
  contribution until it cleared that floor would be tuning a constant to an
  outcome. A bounded number of tail slots is displaced and every score stays
  truthful — the same ranking/selection separation M140-C established.

### Honest limits

**`arc/job/adapters/gaussian.py` cannot be identified as a concept owner from the
current index.** Its route-keyword logic lives inside `write_input_file`, a
~270-line method body; the file declares 8 methods and its indexed
names/signatures/docstrings cover 2 of 5 query concepts. The index carries
`symbol_search_fts` (name/fqName/signature/docstring/path) and
`symbol_body_literals_fts` (distinctive literals only) — checked directly:
`route` and `emit` do not appear in gaussian.py's body literals. By aggregate
indexed evidence `arc/job/trsh.py` is the better owner, and that is not absurd:
it genuinely handles Gaussian keywords. This case does not need the lane —
Workstream A alone fixed it — but the limitation is real and would need a body
index to overcome, which changes the schema and invalidates every existing index.

**Acceptance outcomes:**

| case | required | outcome |
| --- | --- | --- |
| Gaussian route keywords | `gaussian.py` visible, no `which` lead | **PASS** — via Workstream A, not the lane |
| normal-mode displacement | `arc/checks/nmd.py` visible via contained definitions | **PARTIAL** — the lane selects nmd.py as an owner and admits `get_bond_length_in_reaction` / `get_displaced_xyzs` into the pool, but `analyze_ts_normal_mode_displacement` is not among them and nmd.py does not win a delivery slot |
| reactant atom index space | `get_reactants_and_products`, `get_bonds` | **FAIL** — `reaction.py` is the top-ranked owner but the two named definitions are still not delivered |
| TS-guess atom order | `get_single_mapped_product_xyz`, `order_xyz_by_atom_map` | **FAIL** — the lane's owners (`heuristics.py`, `isomerization.py`) are not where those definitions live; `order_xyz_by_atom_map` is rank 6 and unselected, which is a **selection** failure, not a retrieval one |

The §90 classification matters here: two of the four remaining misses are "ranked
but not selected", not "not generated". Making the owner's definitions win a
delivery slot is selection work the lane does not do.

Controls hold: `find function get_bonds` and `How does ARC work?` both close the
gate (`explicit symbol lookup`, `only 0 behavioural objective(s)`), and a
capability lookup is excluded so M137's dihedral behaviour is untouched by the
lane.

### Structural leak found and fixed

`coeditExpansion.pickInjectedSymbol` chose a file's representative symbol without
excluding module scopes. Since M140 gave those ownership of a file's imports they
out-sort real definitions on edge count, and `arc/mapping/driver.py::<module>`
reached the capsule as delivered support. The generated-artifact-pair branch
alongside it already carried this guard; both now do. This was a latent M140-era
defect that the new pool shape exposed, not one M142 introduced.

---

## Workstream D — response boundedness (measured, NOT implemented)

`stage5_m142_response_boundedness_m142_after.json`.

The measurement changes the framing, so it is stated plainly: **the reported
oversized responses are not a diagnostics-dominance defect on the product path.**

| shape | bytes | content share | diagnostics |
| --- | ---: | ---: | ---: |
| engine `CapsuleV2Result`, normal-mode @6k | 69,906 | 24% | 30.7 kB (`candidate_scores` 25.9 kB) + 21.5 kB `discarded` |
| **product response**, normal-mode @6k | **18,039** | **76%** | 4.3 kB |
| product, Gaussian @3k | 10,501 | 58% | 4.4 kB |
| product, Gaussian @12k | 58,838 | **91%** | 5.3 kB |

The 70 kB structure is the **internal** engine result, which no MCP tool returns.
`toCapsuleV2ProductResponse` already caps the discard tail and reduces
diagnostics to ~4–6 kB, and that figure is **flat** across budgets — the §112
property (response does not grow with the hidden candidate pool) holds as
measured.

A ~63 kB response *is* reachable, at `max_tokens: 12000`, where it is 91% useful
content and ~11,990 estimated tokens against a 12,000 budget. That reconciles the
report: the response was large because it was asked to be. The "~28 kB envelope
for ~3.3k tokens of useful content" shape did not reproduce; the lowest content
share measured anywhere was 58%.

An earlier note in this milestone described the probe's 46–70 kB figures as
reproducing the oversized response. That was measuring the engine result, not the
product response, and is corrected here.

**Not done:** §60/§61 reduction-metric semantics, §111–§113 envelope scale tests
and omission counts. Nothing was changed for Workstream D.

## Workstream E — fresh-worktree bootstrap (NOT STARTED)

The only datum is that a full ARC index takes **22.5 s** (9,009 symbols),
confirming the reported 22–31 s. No profiling, no parse-cache audit, no bootstrap
implementation.

---

## Verification

```text
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun test                       4245 pass / 0 fail / 49 skip, 256 files
git diff --check               clean
```

New tests: 26 across 3 files — prose/identifier hygiene (10), centrality
relevance gate (6), concept-owner retrieval (10).

## Regression benchmarks — NOT READ

The provenance-safe paired protocol was **prepared and launched** but had not
returned. Predecessor worktree at `562cff6` with its own dependency install;
isolated target corpora per side under separate `--out-root`s (which also avoids
the M141 index-lock collision by construction). At the time of writing the
predecessor corpus was at 20/20 Django and 28/30 cross_repo; the candidate corpus
and the comparison had not started.

**No frozen-50, Django-expanded or cross_repo_30 numbers exist for M142, and no
changed-case attribution has been performed.** The three commits are therefore
unvalidated against the regression suites, and the retrieval changes in A, B and
C are all capable of moving those cases.

Also not run: the M131/M132/M136/M137/M138/M139/M140/M141 preservation gates and
the TCKDB acceptance.

## Recommended next step

Read the paired comparison first; it gates everything else. Then, in order:
attribute every changed case, run the preservation gates, finish Workstream D's
metric semantics, and profile Workstream E. M142 cannot be closed as PASS or
MIXED until the regression evidence exists.
