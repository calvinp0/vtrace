# M153 — Cross-Repository Behavioural Nomination and Generalisation Proof: plan

Predecessor: M152 final functional `72ce221c7006dc9e477dcbfa2d7e7372c136fa8c`
(evidence `bcdd962e42cfdfccbce89e14885a90f405ba3490`).

## The claim M153 has to earn

> Given a behavioural question and a workspace containing several repositories,
> VTRACE can nominate the repository that actually implements the requested
> behaviour using bounded subject-and-operation evidence, without requiring the
> user to know a path or symbol, and without sacrificing routing truthfulness or
> single-repository retrieval quality.

## The development-policy change

ARC has supplied a disproportionate share of the pressure behind M142–M150. From
M153 onward it is a **holdout**:

> ARC may tell us where VTRACE hurts. It may no longer tell us, by itself, how
> VTRACE should change.

No retrieval, ranking, candidate-generation, behavioural-scoring or routing
change may be justified by ARC alone. TCKDB is a secondary holdout for the same
reason. Calibration happens on repositories that have driven nothing.

## Order of work, and why the order is load-bearing

The corpus is built and committed **before** the algorithm exists (§30). A
benchmark written after the fact, by the same person who wrote the algorithm,
against the vocabulary that algorithm happens to index, measures nothing. Making
the corpus commit precede the implementation commit is what makes it a test
rather than a description.

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **A** | Frozen non-ARC corpus + repository split + M152 oracle/workspace baselines | corpus committed before any routing code |
| **B** | Repository-evidence audit, lane precedence, bounded probe architecture, cost model | no implementation duplicates full retrieval |
| **C** | Bounded behavioural repository nomination | subject *and* operation both matter; probes write nothing; default full retrieval count stays 1 |
| **D** | Non-ARC holdout evaluation | generalisation shown on repositories never opened during calibration |
| **E** | ARC + TCKDB external holdouts, preservation gates, frozen suites | M138–M152 preserved; frozen suites explained |

## Phase A — status: complete

- `behavioralCrossRepoCorpus.ts` — 35 cases, 7 repositories, 12 categories.
- Split frozen by **repository** (§73): calibration `requests`/`flask`/`pytest`/
  `sphinx`; holdout `xarray`/`astropy`/`pylint`.
- 81 referenced symbols mechanically resolved against the pinned trees; all spans
  verified; 14 ground-truth files content-digested.
- 9 false-premise cases, 3 prose/identifier paired controls, 5 project-name reuse
  cases, 2 genuinely ambiguous cases.

Design rationale in `stage5_m153_behavioral_corpus_design.md`; per-case record in
`stage5_m153_behavioral_ground_truth.md` (generated).

## Phase B — the question the audit must answer

Existing nomination tiers (`src/workspace/repositoryRelevance.ts`) are:

```
0. explicit selection    index-free   authority, never overridden
1. path containment      index-free   an absolute path inside a root
2. indexed path          INDEXED      suffix membership
3. exact symbol          INDEXED      bounded name lookup
```

The module's own header states the gap M153 closes: *"There is no behavioural
relevance lane in M146–M149 and this module does not invent one."* A query that
names no path and no identifier currently carries no routing evidence, so the
honest outcome is the configured default or an abstention.

The behavioural lane therefore belongs **below exact symbol** — strong routing
evidence must keep winning (§55, §56) — and **above configured default**, because
evidence should be able to beat a fallback (§54).

One structural decision is not inherited from the existing tiers and has to be
made explicitly: every current tier treats "more than one repository produced
evidence" as `Ambiguous`. Behavioural evidence is graded rather than binary, so
that rule applied unchanged would abstain almost always. How the behavioural tier
discriminates internally — while still abstaining when it genuinely cannot tell —
is the core M153-C design question.

## Hard constraints carried in from earlier milestones

- **M152**: `index.sqlite` is repository-derived evidence and immutable under
  product reads; `session.sqlite` owns mutable state. Routing probes write
  **neither** (§96, §97).
- **M151**: lead-only full retrieval by default; supporters are metadata unless
  composition is opted into; response metadata stays bounded at any workspace
  size.
- **M150**: the behavioural chain and its weights (direct 0.55 / partial 0.20,
  strongest single fact) are frozen unless the **non-ARC** corpus independently
  proves a generic defect.
- **M149**: supporting evidence is never ownership.
- **M147/M148**: exact path and exact symbol routing stay authoritative.

## Failure conditions accepted in advance

M153 is **MIXED**, not PASS, if routing improves on calibration but not on the
non-ARC holdout; if full retrieval count scales with workspace size; if the
behavioural lane forces routes instead of abstaining; or if repository choice
improves while in-repository retrieval regresses.

It is **FAIL** if it introduces ARC-specific heuristics, repository-name-to-symbol
poisoning, full retrieval across every member, wrong-subject nomination, exact
routing regressions, probes that write index or session state, or unbounded route
metadata.

And explicitly: **ARC improvement does not override non-ARC regression.**
