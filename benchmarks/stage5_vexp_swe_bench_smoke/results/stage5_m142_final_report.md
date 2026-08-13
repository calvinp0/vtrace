# M142 — Final report

**Overall verdict: MIXED.**

Four of five workstreams meet their acceptance criteria. One measured capability
ceiling and one root-caused ranking defect remain, both recorded rather than
closed. That is a truthful closure, not a downgraded PASS.

---

## Verdicts

| Workstream | Verdict |
|---|---|
| **A** — Prose vs identifier signal hygiene | **PASS** (repaired, then frozen) |
| **B** — Relevance-gated centrality | **PASS** (frozen) |
| **C** — Behavioural concept-owner retrieval | **MIXED** |
| &nbsp;&nbsp;· objective hygiene | PASS |
| &nbsp;&nbsp;· owner allocation | PASS |
| &nbsp;&nbsp;· concept evidence | **NOT PASS** — investigated capability ceiling |
| &nbsp;&nbsp;· special support selection | NOT NEEDED AS SPECIFIED |
| **D** — Product response usefulness / boundedness | **PARTIAL** |
| **E** — Fresh-worktree index bootstrap | **PASS** on the same-HEAD path; one defect carried |

---

## Final paired benchmark

`562cff6` (M141) → `41fb0a9` (final M142), frozen 50, **`provenanceValid=true`**.

| Metric | M141 | M142 | Δ |
|---|---|---|---|
| Top-1 gold file | 39 | 38 | −1 |
| Top-3 gold file | 44 | 44 | 0 |
| Gold file anywhere | 47 | **48** | +1 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 3 | **2** | −1 |
| Mean tokens | 1806.44 | 1835.72 | +1.6% |

Per suite: Django 20 cases (Top-1 18→17, everything else flat, missing 0→0);
cross_repo 30 cases (Top-1 21→21, anywhere 27→**28**, missing 3→**2**).

**35 of 50 cases differ in some field. Exactly 2 move a gold-visibility metric,
and both are attributed. Nothing is unexplained.**

- `django-11740` — **REGRESSION**, Top-1 True→False.
- `sphinx-7910` — **IMPROVEMENT**, gold file anywhere False→True.

`sphinx-7462` is absent from the ledger, and that absence is the point: relative
to M141 it is back to parity, which is what a closed regression looks like.

### Staged history behind that number

| Stage | Effect |
|---|---|
| M141 baseline | Top-1 39, symbol 31, missing 3 |
| A — prose vs identifier | fixed `which()` poisoning; cost sphinx-7462's `unparse` |
| A+B rejected form | reverted; pool-relative centrality was wrong |
| A+B+C | concept-owner lane added |
| redesigned B | centrality capped at a candidate's own identifying evidence |
| `admitConceptOwnersBesideCap` | owner recoveries supplement ranking, never evict it |
| objective hygiene + round-robin | quality-neutral on the 50, cheaper, fixes django-11815 |
| **traceback A repair** | symbol 30→**31**, tokens +2.3%→**+1.6%** |

---

## The three cases that mattered

### `sphinx-7462` — repaired

**Root cause.** A query-grammar false negative, not a gold correction. A's rule
that an ordinary word may not claim to *be* a symbol name was applied to a bug
report as though the reporter had chosen every word in it. `unparse` was printed
by CPython inside a traceback frame; it is a plain lowercase word with no
backticks, no call syntax and no declaration phrase, so nothing could admit it
and `sphinx/pycode/ast.py::unparse` stopped being generated at all.

**Fix.** Traceback frames are recognised structurally — `File "…", line N, in
<name>` admits any identifier, a bare `line N, in <name>` tail admits only a
qualified or snake_case name. One frame is admitted, the one where execution
stopped, and only when the traceback is complete and the name is not a
language-protocol dunder.

**Before/after.** `sphinx/pycode/ast.py` goes from absent to delivered at rank 2,
the gold symbol is recovered, and the capsule is **257 tokens cheaper**.

**Isolated paired effect.** Against the M142 checkpoint: gold symbol 30→31, every
gold *file* metric unchanged, 2 cases moved, **0 new gold regressions**.

The rule was narrowed twice by measurement, and both intermediate forms are kept
in the history:

| Form | Result |
|---|---|
| every frame | sphinx-7462 recovered, but xarray-3677 and pylint-8898 regressed |
| last frame only | still regressed both, on a *single* generic name |
| raising frame, identified | target recovered, **no** new gold regression |

Neither regression was a prose false positive — every term admitted was a real
frame function name. The fault was dosage: a deep chain names a dozen functions,
xarray's three all lived in `merge.py` and outvoted the gold file, and pylint's
were CPython's own `sre_parse`.

### `django-11740` — known, root-caused, unresolved

Capping centrality at a candidate's own identifying evidence removed `ForeignKey`
(188 dependents, **zero** identifying evidence) from ordinary ranked retrieval.
The title-symbol lane read that absence as "never retrieved" and re-injected it
with a **synthesized score of ~2.5**, past the correct gold lead.

Two candidate-presence fixes were measured and both were worse:

- skipping ranked-out title reinjection: Top-1 **37 → 35** — three losses to
  recover two;
- re-admitting the organic scorecard: recovered recall, not the lead.

**Candidate presence is not the problem; the synthesized score is.** It is
carried as an unresolved Top-1 ranking defect and is the main reason this
milestone closes MIXED. It is not relabelled neutral.

### `sphinx-7910` — pool visibility only

The concept-owner lane brings the gold file **into the pool**; it is not
delivered. Recorded as recall, never as delivery. `concept_owner_support` was
**not** implemented: §45 required a generic omitted-support defect to justify it,
the surviving candidates were `lexical`-sourced rather than owner-lane sourced,
and one case does not warrant another selection role.

---

## Workstream C — an investigated ceiling

**Objective hygiene (PASS).** Every prose token used to become a candidate
objective, so provenance and section labels — `last`, `modified`, `error`,
`traceback` — gained IDF weight and dominated owner selection. That is not a
one-case phenomenon: label or provenance content appears in **23 of the 50**
frozen tasks. Requests are now segmented into typed spans and a token is an
objective only in a behaviour-bearing role. *IDF weights eligible objectives; it
does not create eligibility.* On django-11815 the elected owners move from
`defaultfilters.py` / `storage.py` / `debug.py` to migrations modules. Frozen 50:
all five quality metrics unchanged, slightly cheaper.

**Allocation (PASS).** Three owners × three definitions against a six-candidate
cap meant the third owner slot was **dead by construction** — `arc/checks/nmd.py`
was elected owner #3 and contributed nothing. Round-robin admission fixes it
under unchanged bounds; nmd.py now contributes 2 definitions. The caps were not
lowered to flatter the numbers.

**Concept evidence (NOT PASS).** Three mechanisms were implemented far enough to
measure, and all three were rejected by measurement:

| Mechanism | Result |
|---|---|
| acronym → path | 0 true positives, 2 false positives — and the acronym was never in the user's wording |
| entity ownership | gated 796→71 nominations, but quality-neutral and it nominates the Gaussian **parser**, not the job adapter |
| identifier/literal body index | **0** objectives recovered on all four ARC cases; only developer prose recovers any, and only two |

**Gaussian acceptance (§89) is NOT MET, stated as two separate facts.** The final
query result is good — `arc/job/adapters/gaussian.py` leads and the committed
corpus scores it top1 — but that is because A removed the `which()` poisoning.
The concept-owner lane never elects the adapter; it elects `arc/job/trsh.py`,
`arc/tckdb/adapter.py` and `arc/output.py`.

**NMD (§90).** The real query is *"How does ARC verify that a saddle point
actually connects the intended reactants and products by looking at how the atoms
move in the imaginary vibration?"* — the phrase "normal mode displacement" is the
specification's wording and **is not in the query**. No acronym evidence is
claimed from words the user never wrote. The owner is elected at rank 3 and
contributes 2 definitions, but is not delivered. The wrong-quantity candidate
`get_expected_num_atoms_with_largest_normal_mode_disp` is neither generated nor
delivered, so it cannot lead on lexical overlap.

What remains is a **vocabulary** gap, not a representation gap: six of the twelve
normal-mode objectives appear nowhere in the owner file at all. No representation
of existing text closes that.

---

## Workstream D — PARTIAL

**The headline figure does not reproduce and is reported as such.** Real external
responses are 20–24 kB at default budgets on both a small and a large repository.
The 63 kB corresponds to the internal `CapsuleV2Result`. The *ratio* complaint
does reproduce: only 34.4% of a default response is answer-bearing, and overhead
is worst where responses are smallest because most non-content fields are fixed
size.

**Defect 1 — the detail contract was inert.** `debug` returned 20 303 bytes where
the default returned 20 302. The boundary was drawn at **array size**, not
audience: a section collapsed only past 12 entries and debug restored a sample of
12, so on a real request nothing crossed the threshold.

**Defect 2 — the selection was serialized five times**, not three: structured
items (6 253 B), the rendered answer (4 828 B), the manifest (2 630 B), the digest
(1 291 B), and the diagnostic file lists (459 B). Proven, not asserted: **6 of 6**
`roleReason` strings are character-identical to entries in
`productContext.items[].selectionReasons`.

**Fixed.** Two copies became references — `roleReason` and the diagnostic file
lists — both restored at `debug`. Debug now differs by **969 bytes** at 8 000
tokens and 224 at the default, instead of 3 and 1. Selection, `modelVisibleContext`
and `digest` are byte-identical at every level and both budgets.

**Not fixed, deliberately.** `modelVisibleContext` and `items` are the answer.
`digest` looked like the obvious third cut until it turned out to be an
*injectable* context payload (`--inject-capsule-digest`). `diagnostics.freshness`
looked like a duplicate until its `autoReindex.state` turned out to be asserted at
default detail by the staleness tests.

**Why PARTIAL.** The default response is only **1.1–2.9%** smaller. §48 asks for
"materially smaller" and this is not that. An attempt to move whole diagnostics
sections behind debug failed nine tests including declared-schema conformance —
those sections are part of the published schema, and §31 rules out a schema bump
for a partial solution. What remains at default is the answer plus fields the
schema declares and callers branch on.

**Reduction metric (§45).** Audited; already truthful; no change made.

---

## Workstream E — PASS on the path that matters

**Profile.** Parsing is **89–90%** of every indexing run measured; persistence
6–7%, linking under 2%.

**A correction worth keeping.** The first profile reported `parseCacheHits=0` even
for a sibling worktree sharing a warm 9 670-entry cache, which looked like M118
failing at its one job. It was not: cross-worktree reuse lives in
`initRepo`/`reindexRepo`, which select a sibling snapshot before calling
`indexProject`. The probe called `indexProject` directly and bypassed the whole
mechanism — profiling the layer beneath the product measured a path the product
never takes.

**Same-HEAD sibling (§54): PASS.** 40 595 ms → **6 737 ms**, and byte-identical to
a clean full index built where no sibling snapshot and no shared cache are
reachable: 325 files, 9 012 symbols, 21 693 edges, all FTS tables equal.
Removing the cache entirely changes the time and nothing else (§65).

**Small delta (§56): DEFECT, root-caused, not fixed.** One edited file out of 325
makes `fullParseCacheContextCompatible` false — it requires
`scannedFiles.every(...)` to match — and per-file reuse is then refused for all
325 even though `canReuseFullParseCache` already performs its own per-file check.
Correctness is unaffected (still byte-identical to a clean full index); the whole
parse cost is simply paid again.

Left unfixed on principle: the flag guards binding, a cached parse carries edge
targets resolved against the symbol set present when it was cached, and the
incremental path only repairs that against an existing symbol table which a fresh
worktree does not have. §60 permits reuse only where the incremental architecture
*already* proves equivalence, and here it does not. M132 previously showed edge
counts moving when resolver ambiguity changed.

---

## Preservation

Ten gates at the final commit; every failure compared against the predecessor
before attribution.

| Gate | Verdict |
|---|---|
| M141 readiness matrix | PASS (incl. wrong-worktree fail-closed) |
| M141 index_repo + memory rules | PASS — *was NOT_RUN previously* |
| M132 worktree isolation | MIXED 19/21, both deltas explained |
| M136 budget delivery | blameless — identical predecessor failure |
| M137 direct answer (dihedral) | PASS on every A control |
| M138 memory provenance | blameless — identical predecessor TypeError |
| M139 impact truthfulness | PASS |
| M140-C orchestration / module node | PASS 28/28 |
| M140-B TCKDB acceptance | PASS, `leadChanged=false` on all four |
| get_skeleton known-file | PASS — *was NOT_RUN previously* |

**M137 is the gate the traceback repair could most plausibly have broken, and it
holds**: `get_dihedral` still leads at rank 1, prose is still not poisoned, the
project-name rule still suppresses a bare `ARC`.

Two printed failures are environmental. The shared ARC fixture index was built at
`2f3fd462` and ARC has moved to `3da32ea0`, so with `auto_refresh=never` the tool
correctly refuses stale context — the readiness gate working. Predecessor and
candidate return identical `resolved=false, items=0, stale/head_mismatch`.

M132's two failing rows are no-change gates against an M131 baseline M142 moves
deliberately. The TCKDB row deserves precision because a lead on a *test file*
looks alarming until checked: that **is** the expected lead, five of six slots
match, and the single movement is the `geometry.py → calculation.py` support slot
already classified neutral. The final tree did not move it further.

---

## Verification

```
bun test                     4216 pass, 49 skip, 0 fail (256 files)
bun run typecheck            clean
bun run typecheck:benchmarks clean
git diff --check             clean
branch                       main, 0 behind / 30 ahead, nothing pushed
```

Working tree carries only the two pre-existing `stage5_outcome_ledger.*`
modifications, untouched and unstaged.

---

## Remaining limitations

1. **`django-11740`** — title-symbol synthesized score outranks the gold lead.
   Root-caused; two fixes measured and rejected; unresolved.
2. **Concept evidence** — the owner lane cannot identify a behaviour owner from
   behavioural phrasing when the vocabulary is absent from the file. Three
   mechanisms measured and rejected.
3. **D's default response** — reduced only 1.1–2.9%; a material reduction needs a
   response-schema change.
4. **E's small-delta path** — one changed file disables parse reuse for the whole
   repository.

## Recommended next milestone

The evidence points at **Option A**. Two of the four limitations are single-repo
retrieval debt with concrete, already-root-caused mechanisms — the title-lane
synthesized score and the binding flag — and both are cheaper to fix now than
after a workspace-identity refactor moves the ground under them.

- **M143 — Title-lane score correction and behavioural concept evidence**
- **M144 — Workspace and repository identity foundation**
