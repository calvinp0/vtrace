# M142 — Behavioral Retrieval Robustness, Concept Ownership, Fresh-Worktree Bootstrap

**Verdict: INCOMPLETE.** Workstreams A, B and C are implemented, tested and
evidenced, and the checkpoint paired benchmark has now been read, bisected and
attributed — it found a real regression in B, which has been redesigned and
re-measured. Workstream D is measured and root-caused but not implemented.
Workstream E was not started.

Per §98 this is INCOMPLETE, not MIXED: two mandatory workstreams are not
implemented.

```text
Workstream A — Prose vs Identifier Signal Hygiene     PASS
Workstream B — Relevance-Gated Centrality             PASS (redesigned after the benchmark)
Workstream C — Behavioral Concept-Owner Retrieval     MIXED
Workstream D — Response Usefulness and Boundedness    NOT IMPLEMENTED (measured)
Workstream E — Fresh-Worktree Index Bootstrap         NOT STARTED

Checkpoint paired benchmark    READ, BISECTED, ATTRIBUTED (0 unexplained)
Final paired benchmark         NOT RUN (candidate tree not final)
Preservation suite             RUN — 8 gates PASS, M131 MIXED, 3 accounted failures
TCKDB acceptance               PASS (M140-B 0/4 changed); §77 parity attributed
```

Frozen-50, M141 predecessor → current revised checkpoint:

```text
                     M141    A     A+B   A+B+C   revised
top-1 gold file        39    39     36     36       37
top-3 gold file        44    44     43     42       42
gold file anywhere     47    47     46     48       48
gold symbol anywhere   31    30     30     28       28
missing gold            3     3      4      2        2
mean tokens          1806  1810   1885   1859     1839
```

Two Top-1 losses remain against M141, both attributed and neither unexplained;
file-level recall is better than M141 (`anywhere` 47→48, `missingGold` 3→2).

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
321f9a37ffad85b24162e469f7735daba81a0884  Separate prose from identifier intent
69826d356790533109cbc401f89dd3dd25dc7b52  Gate graph centrality on task relevance
0e4edc7804a280c2ab924ec05764914066c53a28  Retrieve behavioral concept owners
dce0b15                                   Cap centrality at a candidate's own identifying evidence
bb4d4e1                                   Keep the title-symbol lane's pool-cap injection rule
```

`0e4edc7` is the checkpoint the first paired benchmark measured; `df1da70` is its
evidence commit and touches no source. `dce0b15` and `bb4d4e1` are the response to
what that benchmark found.

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

### First fix, and why the benchmark rejected it

The first cut scaled centrality by the candidate's share of the strongest local
evidence **in the pool**. It achieved the ARC objective, and the paired benchmark
then charged the entire frozen-50 Top-1 loss (39 → 36) to it. Two mechanisms:

- **`django-11740`** — `ForeignKey` (188 dependents, `symbol=0.00`,
  `lexical=0.22`) was correctly demoted out of the capped pool. The title-symbol
  lane read that absence as "retrieval never found it" and injected a synthesized
  candidate at `TITLE_SYMBOL_FINAL` 2.5, past the gold lead at 1.90. The
  correction was inverted into a promotion by an adjacent lane.
- **`flask-5014`** — `Blueprint`, the gold lead with an exact `symbol=1.00`,
  carried 75% of the pool's best local evidence and so lost a quarter of its
  centrality. That cost 0.089 of ordering value, and it lost the lead by
  **0.004**. A pool-relative share makes every candidate's score depend on
  unrelated candidates, so near-ties flip on movements involving neither.

### Fix as shipped

What actually separates the two populations is not how much evidence a candidate
has but **what kind**. `ARCSpecies` carries `symbol=0, path=0, testToImpl=0,
bodyLiteral=0` on every behavioural query and rides lexical 0.59–0.64 plus domain
0–0.33. `Blueprint` and `MigrationAutodetector`, both gold leads, carry an exact
`symbol=1.00`. The share does not separate them (0.49–0.51 against 0.74–0.75);
the evidence *kind* does — and it is the same question the hub penalty already
asks, just as a cliff at zero.

```text
centralitySupport = weights.centrality * min(centrality, identifyingEvidence)
```

`identifyingEvidence` is local evidence minus issue-domain affinity — the one
component every symbol in a topically relevant package earns, and therefore the
loophole. No new constant (`HUB_WEAK_LEXICAL_MAX` is the existing bar, and the
cap compares two already-normalised quantities), no pool coupling, and the
all-or-nothing hub penalty becomes the zero-evidence end of a continuous rule.
The two-phase scoring the pool-relative share required is gone.

### Result

| candidate | case | M141 | shipped gate |
| --- | --- | --- | --- |
| `ARCSpecies` | normal-mode | rank 14, f=1.393, **selected** | dropped from pool |
| `ARCSpecies` | Gaussian route | rank 9, f=1.436 | dropped from pool |
| `ARCSpecies` | reactant index | rank 14, f=1.276 | dropped from pool |
| `ARCSpecies` | `which()` lookup | rank 11, f=1.086, **selected** | rank 24, f=0.879, not selected |
| `ARCSpecies` | TS-guess order | rank 10, f=1.371, **selected** | rank 10, f=1.321, still selected |
| `ARCSpecies` | ARC-class lookup | rank 2, f=2.193, selected | **rank 2, f=2.193**, selected |
| `ARCReaction` | reactant index | rank 2, f=1.631, selected | **rank 2**, f=1.626, selected |
| `ARCReaction` | ARC-class lookup | rank 3, f=1.857, selected | **rank 3, f=1.857**, selected |

Centrality-only delivery is eliminated on four of six queries and demoted out of
delivery on a fifth. **TS-guess is the honest exception**: `ARCSpecies` is still
delivered there at rank 10. Both positive controls are now *byte-identical* to
M141 — the pool-relative version had moved them (2.193 → 2.060, 1.857 → 1.801).

Both benchmark regressions this workstream caused are gone: `flask-5014` and
`sympy-16766` are back to their M141 leads.

Fixtures in `src/retrieval/centralityRelevanceGate.test.ts` (8 tests) include the
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
- Recovered definitions enter **beside** the ranking, not through it. A
  definition nothing could name scores ~0.8 against a pool floor of ~1.4; raising
  the lane's contribution until it cleared that floor would be tuning a constant
  to an outcome. The first cut took a bounded number of tail slots on the M140-C
  precedent; the benchmark rejected that, and the corrected rule admits without
  evicting. See the django-11815 section below.

### The eviction defect, and the fix (§8-§16)

`django-11815` was carried out of the previous checkpoint as the one case that
could not be root-caused to a line, with a recorded hypothesis pointing at the
coedit structural filter. That hypothesis was **wrong in both halves**: the lane
admits six candidates on that case, not zero, and the coedit filter is inert
there. Feature isolation, reverting each of `0e4edc7`'s two changes in turn
against one held-constant index:

```text
state                                     subsystem elected        lead              gold?
A+B baseline (69826d3)                    db/migrations            EnumSerializer    yes
+ coedit structural filter ONLY           db/migrations            EnumSerializer    yes
+ concept-owner lane ONLY                 contrib/auth/migrations  Migration         no
full 0e4edc7                              contrib/auth/migrations  Migration         no
```

The chain, end to end. The lane's objectives are every prose token of the
request, which for this task includes `last`/`modified`/`oasl` from the Trac
byline and `error`/`traceback` from the M103 evidence **labels** — all rare, so
all high-IDF, so all decisive. It elects `defaultfilters.py`, `storage.py` and
`views/debug.py` as the owners of a migrations bug, and admits four of their
definitions (finals 0.41-0.49) into a pool already at its cap of 25, **evicting
four ranked candidates** — two from `db/migrations`, one of them a delivered
pivot. `resolveLocalSubsystem` tallies anchored candidates per directory, and
`pathSegmentOverlap` ties at 1 for both contenders, so the count decides:

```text
                          A+B    0e4edc7
  db/migrations             8   ->   6
  contrib/auth/migrations   7   ->   6
```

At 6-6 the tiebreak at `debugRoles.ts:695` (`dir < best`) elects
`contrib/auth/migrations`. `EnumSerializer` is then out-of-subsystem with
`symbol=0, path=0, testToImpl=0`, and the strong-lexical exemption that would
have saved it is restricted to function/method kinds — it is a class. So
`isGenericInfrastructure` returns true, `debugRoles.ts:279` demotes it to
support, and the support budget discards it. **Its own scorecard never moves**
(rank 5, final 1.6352 on both sides): a selection regression invisible to any
score-level comparison.

Fixed in `9f08e33` by `admitConceptOwnersBesideCap`. The cap bounds what ordinary
ranking returns, and a lane that exists because ranking cannot see its findings
does not compete for ranking's slots — least of all by paying out of the evidence
base later inferences read. Two generic fixtures guard it; the first fails on the
old code with the exact eviction message.

Two alternative fixes were measured and **not** shipped: excluding cap-admitted
rescues from the subsystem election (0 of 50 cases changed), and gating the lane
off when the request carries direct localization evidence (inert — this task has
no failing tests, likely files or likely symbols at all).

**What the fix does not fix.** The objective contamination is real and untouched:
the lane still reads evidence labels and tracker bylines as behavioural concepts.
It no longer *costs* anything measurable, because its output can no longer evict
better-evidenced candidates, but it is wasted work and a live precision risk.
Measured over the frozen 50, the lane puts 235 candidates into the pool, of which
16 are delivered and 21 sit in a gold file. That is C1/C2 work (§23, §29-§39),
recorded here so it is not mistaken for something this fix resolved.

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
| reactant atom index space | `get_reactants_and_products`, `get_bonds` | **PARTIAL** — `reaction.py` is now the **top-1 owner file** under the revised gate (it was not before), but the two named definitions are still not the ones delivered |
| TS-guess atom order | `get_single_mapped_product_xyz`, `order_xyz_by_atom_map` | **FAIL** — the lane's owners (`heuristics.py`, `isomerization.py`) are not where those definitions live; `order_xyz_by_atom_map` is rank 6 and unselected, which is a **selection** failure, not a retrieval one |

The §90 classification matters here: two of the four remaining misses are "ranked
but not selected", not "not generated". Making the owner's definitions win a
delivery slot is selection work the lane does not do.

Owner-file top-1 across the four behavioural cases moved **1/4 → 2/4** when the
centrality gate was redesigned; the reactant-index case gained it. That is a
Workstream B effect landing on a Workstream C acceptance, and the acceptance
artifacts were regenerated against the shipped implementation so the recorded
numbers describe what is actually committed.

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
bun test                       4198 pass / 0 fail / 49 skip, 256 files
git diff --check               clean
```

New tests: 28 across 3 files — prose/identifier hygiene (10), centrality
relevance gate (8), concept-owner retrieval (10).

`src/logicFlow/flowScalability.test.ts` ("explored work stays flat as the
surrounding graph grows 50x") is **flaky on a 5 s wall-clock timeout**, failing
3 of 4 sampled runs on the **M141 predecessor** and 1 of 3 on the current tree.
Pre-existing harness precondition, not attributable to M142 (§71 pattern).

## Checkpoint paired benchmark — read, bisected, attributed

Provenance-safe M134 protocol, `provenanceValid=true` on every run. Predecessor
worktree at `562cff6` with its own dependency install; isolated target corpora per
side under separate `--out-root`s, which also avoids the M141 index-lock collision
by construction.

The first comparison charged the checkpoint with frozen-50 Top-1 39 → 36. Rather
than reason about which of three commits did it, each was measured separately
against the same predecessor over the same corpora:

```text
                     M141    A     A+B   A+B+C   revised
top-1 gold file        39    39     36     36       37
top-3 gold file        44    44     43     42       42
gold file anywhere     47    47     46     48       48
gold symbol anywhere   31    30     30     28       28
missing gold            3     3      4      2        2
mean tokens          1806  1810   1885   1859     1839
changed cases           -    19     46     47       38
```

**A is neutral** (39 → 39). **B owned the entire Top-1 loss.** **C is net-positive
on file recall** (`missingGold` 4 → 2, `anywhere` 46 → 48) at the cost of one
Top-3 and two symbol-level hits. B was redesigned in response; see that section.

Per-suite at the revised checkpoint: Django Top-1 17/20, cross_repo Top-1 20/30.

Eight cases move a gold-visibility metric anywhere across the five stages, and
**none is unexplained** — `stage5_m142_checkpoint_changed_case_ledger.json`
carries the per-case attribution. Two Top-1 regressions remain against M141:

- **`django-11740` (REGRESSION, `centrality_gate_x_title_injection`)** — the gate
  correctly demotes an irrelevant 188-dependent hub out of the capped pool, and
  the title-symbol lane re-injects it at a constant 2.5 because it cannot tell
  "never retrieved" from "retrieved and ranked out". Two fixes were implemented
  and measured; **both cost more than they save** (Top-1 37 → 35), so neither
  shipped. The distinction itself (`evaluatedById`) is kept on the retrieval
  result because the C1 concept-support work needs exactly that separation.
- **`django-11815` (REGRESSION, `concept_owner_commit_secondary_selection`)** —
  gold `EnumSerializer` falls from lead to candidate rank 3 and loses the single
  pivot slot to a migration file. The bisect places the flip at `0e4edc7`, which
  carried both the concept-owner lane and the `coeditExpansion` structural-symbol
  filter; the concept-owner lane reports no admissions on this case, so the coedit
  representative change is the likelier producer. **Not root-caused to a line.**

Not run: the final paired benchmark (§80) — the candidate tree is not final while
D and E are unimplemented.

## Preservation gates

Run against the shipped implementation (`stage5_m142_preservation.json`).

```text
M136  budget delivery @3000            PASS   ARC 3000=resolved
M137  direct answer (dihedral)         PASS   lead=get_dihedral, 3000=true
M139  impact truthfulness              PASS   via M140-C assertion
M140-C orchestration + module-node     PASS   28/28 assertions
M140-B TCKDB acceptance                PASS   main@567ba7f, 0/4 changed
M141  readiness matrix                 PASS   10/10 states
M141  cross-tool readiness parity      PASS   0 disagreements
M132  worktree isolation               PASS   every worktree assertion holds
M131  flow/scalability                 MIXED  19/22 vs 21/22 on M141
```

M137 is the gate that matters most for Workstream A, and it holds exactly: no
prose-token poisoning, no project-name poisoning, `get_dihedral` still the lead.
M132's worktree assertions all hold — nested exclusion (616 → 325 files), the
routing matrix (15 cases, 0 missing) and refresh isolation.

Three gate failures, all accounted for and none of them silent:

- **`response_within_m130_envelope`** — "captured incident payload not provided",
  failing **identically on the M141 predecessor**. Harness precondition.
- **`frozen_50_semantics_unchanged`** (M131 and M132) — 50/50 cases, 200 semantic
  differences. This is a **no-change** gate, and M142 changes retrieval
  deliberately; the same movement is bisected and attributed case-by-case above.
  Recorded as an expected change, not as a pass.
- **`tckdb_same_checkout_preserved`** — the lead is **preserved** and **every**
  §77 evidence category is satisfied on both sides (`missingCategories: []`), with
  5 of 6 selected files identical. One support slot swaps `builders/geometry.py` →
  `builders/calculation.py`, which trips the exact-hash parity layer. Bisected to
  the centrality gate: M141 and A both deliver `geometry.py`, the **rejected**
  pool-relative gate delivered neither, and the shipped gate delivers
  `calculation.py`.

**M138** fails with the identical signature on both sides (`ARC current=4/4,
suppressed=0`) and `stage5_m138_no_agent_smoke.detail.json` is byte-identical
between them — the pre-existing precondition the M141 ledger already recorded.

Not run: M141 `index_repo` boundedness and `memoryRules` performance (no index
representation changed), and the `get_skeleton` known-file check.

## Recommended next step

The checkpoint gate is cleared and the preservation suite is run, so functional
work may continue. In order: root-cause `django-11815` to a line, split C into C1
(selection) and C2 (representation) per §10, then D and E, then the final paired
benchmark. M142 cannot be closed as PASS or MIXED until D and E exist.

The `django-11740` root cause is worth carrying forward as a design note rather
than a fix attempt: **an anchor lane must not treat pool-cap absence as evidence
of absence.** Two corrections were measured here and both lose more than they win,
which says the title lane's synthesized score — not merely its presence — is doing
the work. That is a ranking question, not an injection question.
