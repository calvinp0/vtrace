# M150 — Behavioral Decision-Point and Execution-Mechanism Retrieval

> **Superseded in part.** This report describes the `ab8e4f0` CHECKPOINT. The
> milestone continued past it; see `stage5_m150_final_report_continuation.md` for
> the closing state, and `stage5_m150_subject_alignment_design.md` for the
> discriminator that closed the Gaussian regression recorded below as open.

**Checkpoint verdict: MIXED.**

A → PASS, B → PASS, C → PASS, D → MIXED, E → MIXED.

M150 set out to make retrievable the behaviour that lives in a statement rather
than a name. It succeeds on the failure that motivated it and on the generic
mechanism vocabulary, and it does not succeed on distributed ordering evidence.
One M142 preservation case regressed. Both are recorded below rather than
smoothed away (§88, §112).

- M149 predecessor (functional): `2aaac750b326478bb3f29576aa1454365d0f734d`
- M150 final functional: `ab8e4f0`
- Branch `main`, nothing pushed, no co-author trailers.

---

## 1. What was wrong (M150-A — PASS)

Reproduced against the M149 predecessor on a fresh ARC index, not reasoned about.

Query: `How does ARC decide which reaction family wins?`

| symbol | rank | final | delivered |
| --- | --- | --- | --- |
| `family.py::get_reaction_family` — memoisation helper | **1** | 1.9000 | **lead pivot** |
| `reaction.py::ARCReaction.family` — accessor | 2 | 1.9000 | pivot |
| `family.py::get_reaction_family_products` | 3 | 1.7406 | support |
| `reaction.py::ARCReaction.determine_family` — **decides** | **16** | 1.5750 | **no** |
| `family.py::get_all_families` — establishes ordering | — | — | **never generated** |
| `product_dicts[0]` — the deciding statement | — | — | **not visible** |

**Root cause, and it is not the M142 defect.** `symbolHypotheses` is empty and
`ARC` is correctly classified as a project reference, so no prose word became an
identifier. The failure is that `reaction` and `family` drive four independent
signals — lexical, symbol, domain, path — and **nothing in the scorecard
represents the requested operation**. A helper that names the subject perfectly
and chooses nothing had no way to be recognised as choosing nothing.

The persisted index made this unfixable by ranking alone: it stored names,
signatures, docstrings, paths, edges and body *literals*. No statement-level
representation existed, so `product_dicts[0]` was not merely unranked — it was
absent from the index entirely.

The `intent confidence: low / fallbackApplied: true` the agent reported comes
from the intent classifier, which is a separate layer. The operator cues in the
sentence are unambiguous regardless, which is why the new derivation reads the
grammar and never consults classifier confidence (§67–§69).

## 2. Separating subject from operation (M150-B — PASS)

`src/retrieval/behavioralObjective.ts` derives a typed operation from the
already-parsed `DerivedQueryIntent` — the same seam `evaluateOrchestrationIntent`
uses, not a parallel parser. Operations: `selection`, `ordering`, `fallback`,
`caching`, `storage`. Each earns its place only because a mechanism fact
implements it, so a recognised operation always has something to retrieve.
`validate`, `convert`, `retry` and the rest of §9 are deliberately absent.

Cue **strength** is modelled, not presence, because the discriminating cases
share their nouns. Measured on the four-query contrast set:

| query | operation | cue |
| --- | --- | --- |
| How does ARC decide which reaction family **wins**? | `selection` | `decide` |
| How is reaction-family lookup **cached**? | `caching` | `how is … cached` |
| **Where is** the *selected* reaction family **stored on** ARCReaction? | `storage` | `where is … stored` |
| What determines the **precedence/order** …? | `ordering` | `precedence` |

The third is the load-bearing one: it contains a selection word and is not a
selection question. Operations are behavioural objectives and never identifier
hypotheses; `\b` does not match across `_`, so `choose_candidate` cannot fire a
cue, and an explicit lookup frame suppresses the derivation outright (§10, §44).

## 3. Indexing what a definition does (M150-C — PASS)

`src/indexer/extractMechanismFacts.ts` derives twelve bounded fact kinds from
definition bodies at index time, sliced by the same byte ranges the body-literal
lane uses, with strings and comments blanked first — ARC has a docstring quoting
`product_dicts[0]`, and prose about code is not code.

Stored in `symbol_mechanism_facts`, additive exactly like `edge_call_sites`. A
pre-M150 index probes `sqlite_master` once, finds no table, and degrades to
precisely its pre-M150 behaviour; readiness reports
`behavioral_mechanism_evidence` as a **missing capability**, never as an
incompatible schema (§51).

Three truthfulness commitments:

- A fact states only what the statement shows. Taking element zero is
  `first_item_selection`, never `winner_by_priority` — there is no such kind to
  promote it to. The ordering that made element zero the winner lives elsewhere
  (§62).
- Ordering and selection are different kinds, so sorting for display is not a
  choice (§38) and a precedence question is not answered by whatever calls `[0]`.
- Each fact records whether it produces the definition's **result**. This is the
  property that separates the three ARC functions that all take element zero:

| definition | statement | result-bearing |
| --- | --- | --- |
| `determine_family` | `family, … = product_dicts[0]['family']` then `return family` | **yes** |
| `get_reactant_num` | `group = self.groups[self.reactants[0][0]]`, returns a *count* | no |
| `get_reactive_bonds_from_family` | `bond = tuple(sorted(...))`, appended to a list | no |

**Scale on ARC** (`stage5_m150_mechanism_scale.json`): 7154 callables, 1624 carry
facts, 2549 facts total, of which only **619 are result-bearing**. The largest
kind, `first_item_selection`, has 968 facts and 59 result-bearing — the
selectivity is in the property, not in a threshold. Index time 21.3s → 22.4s
(+5.1%). Query-time source reads: **0**; facts load via one indexed `SELECT` over
the already-bounded candidate pool, never a repository body scan (§56, §94).

Only callables carry facts. A class's byte range covers its methods, and
extracting from it re-attributed eight facts from six properties and two methods
onto `ARCReaction` itself, which then rode all of them at once. Module symbols
are excluded, so no `<module>` node can become answer-bearing (§28).

## 4. Scoring and delivery (M150-D — MIXED)

`src/retrieval/mechanismEvidence.ts` compares the requested operation against the
indexed facts. The contribution enters `final` alongside the other bounded,
attributable adjustments, gated three ways:

1. **No declared operation → zero.** An ordinary lookup or a bug report pays
   nothing and cannot move.
2. **No compatible fact → zero.** A cache helper earns nothing on a selection
   question — not penalised, simply not evidence for that question. On a cache
   question the same fact is the strongest evidence in the pool. That reversal is
   the argument that this is relevance rather than a bonus (§12, §39).
3. **Below the subject-relevance floor → zero**, measured on *identifying*
   evidence excluding domain affinity.

The contribution is the **strongest single fact, never a sum**. Summing rewarded
the wrong thing: `get_reactive_bonds_from_family` carried four weakly-compatible
mechanisms and out-earned the function that actually decides, because containing
more control flow read as being more decisive.

`W_mech` was **not** chosen to clear 1.9. Direct = 0.55, partial = 0.20, ceiling
= direct. The magnitudes were fixed against the generic mechanism cases and the
negative controls before ARC was re-measured, and the ARC result is reported as
an outcome of that calibration.

**Delivered.** `determine_family` becomes the lead pivot rendered `full`, so the
deciding statement `product_dicts[0]['family']` is in the model-visible context
(§25). No new content mode was required.

**Not delivered.** The bounded `mechanism_support` role and statement-slice
content mode were designed but **not implemented**. Consequently `get_all_families`
is still never generated, and the ordering → first-item relationship is not made
visible. This is the main reason D is MIXED rather than PASS.

## 5. Acceptance and preservation (M150-E — MIXED)

### ARC contrast set (`stage5_m150_arc_family_{before,after}.json`)

| query | before → lead | after → lead |
| --- | --- | --- |
| selection | `get_reaction_family` (cache) | **`determine_family`** |
| cache control | `get_reaction_family` | `get_reaction_family` (held) |
| accessor control | `ARCReaction` (class) | `ARCReaction.family_own_reverse` |
| identifier control | `determine_family` | `determine_family` (unchanged) |
| ordering | `_dihedral_angle` | `_dihedral_angle` (**unchanged — still wrong**) |

Watchlist on the selection query, after:

| symbol | rank | final | mechanism | delivered |
| --- | --- | --- | --- | --- |
| `determine_family` | **1** | 2.1256 | 0.55 | **lead pivot** |
| `get_reaction_family` | 3 | **1.9000** | 0 | support |
| `ARCReaction.family` | 4 | **1.9000** | 0 | — |
| `get_all_families` | — | — | — | **not generated** |

The cache helper and the accessor are at **exactly their predecessor scores**.
Nothing was penalised; `determine_family` gained evidence for answering a part of
the question they do not answer.

§108 scorecard: 1 ✔ cache helper no longer the lead · 2 ✔ selection function is
primary answer-bearing evidence · 3 ✘ ordering helper not visible · 4 ✔
`product_dicts[0]` visible · 5 ✘ ordering → selection relationship not shown · 6
✔ cache query still favours the cache helper · 7 ✔ storage query favours the
accessor · 8 ✔ direct identifier lookup unchanged.

### Generic mechanism cases (§31–§40)

All nine pass at the extraction and scoring layers, with both negative controls
clean: `first_character(name) → name[0]` yields **no fact at all** (the operand is
singular, refused before query gating ever runs), and sorting for display yields
ordering evidence that never reaches the direct tier on a selection question.
46 focused tests across the three new modules.

They are **unit and scoring level**, not a repository-scale corpus. The dedicated
deterministic M150 corpus of §46 was **not built**, so the §72 corpus metrics
(mechanism lead rate, Top-1/Top-3 over a discriminating corpus) are **not
reported**. E is MIXED for this reason as well.

### Paired preservation (`stage5_m150_paired_comparison.json`)

M149 `2aaac75` → M150 `9a81a1c`, dual-root, shared immutable corpora,
`provenanceValid=true`, `srcDirty=false`:

| suite | changed | semantic hashes |
| --- | --- | --- |
| django (20) | **0/20** | byte-identical |
| cross_repo_30 (30) | **0/30** | byte-identical |
| **Frozen50** | **0/50** | Top-1 38, Top-3 44, gold anywhere 48, gold symbol 31, missing 2, mean tokens 1832.4 — all equal to the M149 baseline |

**Stated honestly:** those corpora were indexed before M150 and carry no
mechanism facts, so this proves M150 has **no side effect** on them — it does not
prove the operation gate holds when facts are present. That was measured
separately on the ARC index (2549 facts) by running the M142 behavioural probe
from both roots against the same index.

### M142 preservation — one regression

| case | predecessor | candidate |
| --- | --- | --- |
| normal-mode displacement | owner top1 false | unchanged |
| **Gaussian route keywords** | owner **top1 true** | owner **top1 false** (top3 still true) |
| reactant atom index space | owner top1 true | **unchanged** |
| TS-guess atom order | owner top1 false | unchanged |
| explicit `which()` lookup | `common.py::which` | **unchanged** |
| explicit `ARC` class lookup | `arc/main.py::ARC` | **unchanged** |
| broad vague control | no lead | unchanged |

`How does ARC decide which Gaussian route keywords to emit?` contains `decide`,
so it derives `selection`. A dozen Gaussian-named parsers each carry a genuine
result-bearing first-item selection and each clears the relevance floor on
lexical score, so the component is near-uniform across that pool and small
lexical differences reorder the lead. Selecting *something* is not evidence about
selecting *the thing asked about*.

Two fixes were measured and rejected during the milestone rather than shipped: a
subject-match strength modifier (broke the cache and ordering contrast controls
without repairing the case) and raising the relevance floor (arbitrary). §76 is
otherwise intact — `which()` is still not generated from grammatical *which*, and
explicit lookup is unchanged.

### Other preservation

M140 module invariant: zero `<module>` nodes delivered (facts are restricted to
callables). M141 readiness: `behavioral_mechanism_evidence` participates in
`capabilityCompatible` / `missingCapabilities`. M139/M147/M148/M149: untouched by
this change and covered by the full suite.

## 6. Gates

`bun run typecheck` ✔ · `bun run typecheck:benchmarks` ✔ · `bun test` **4517 pass,
0 fail, 49 skip, 279 files** ✔ · `git diff --check` clean ✔.

Derivation fingerprint **intentionally changes**: `src/indexer/` gained a module,
so `indexer_fingerprint` moves and existing indexes are correctly reported
`derivation_incompatible` and rebuilt. No index is silently invalidated (§100).

Real ARC and TCKDB indexes were never opened for writing; all measurement used
isolated copies under `/home/calvin/bench/vtrace-m150/`.

## 7. Not done

- `mechanism_support` role and statement-slice content mode (§21–§27, §59–§61).
- The dedicated M150 mechanism corpus and its §72 metrics (§46–§48).
- TCKDB same-checkout acceptance (§84).
- Full/incremental/no-op equivalence for the new table (§53, §54). `normalizeGraph`
  now includes mechanism facts so the gate *can* run; it was not run.
- Changed-case ledger (§87) — vacuous at 0/50, but the M142 regression is
  attributed above under cause `decision_point_ranking`.

## 8. Recommended next scope

Not M151. The reachable retrieval core is not yet trustworthy enough to build
workspace routing on top of, which was the whole argument for doing M150 first.

Finish M150 before proceeding: implement the bounded `mechanism_support` role and
statement slice, build the discriminating corpus, and use it to resolve the
Gaussian regression on evidence rather than intuition. The open question that
corpus must answer is how mechanism evidence should discriminate *within* a
topically relevant pool where many definitions genuinely perform the requested
operation — the ARC selection query has one such definition and the Gaussian query
has a dozen, and only a corpus can say which of the rejected discriminators is
right.
