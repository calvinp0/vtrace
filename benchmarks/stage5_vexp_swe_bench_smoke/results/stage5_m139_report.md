# M139 — Impact Consumer Truthfulness and Behavioral Contrast Correctness

**Overall verdict: MIXED.** Workstream A (impact consumer truthfulness) meets its
gates. Workstream B fixes the contrast defect and its hard gate, but does **not**
achieve the ARC serialization orchestration-visibility acceptance; that failure is
root-caused precisely below and left unfixed rather than papered over with weights.

- Starting HEAD: `40fcd4bc4aaf0d87b287aac378517430ac9adeac` (M138 evidence)
- M138 functional predecessor: `3c4be01ed73d78d73572602810cfdfbbfa943275`
- Branch: `main`. Nothing pushed by M139.

**Branch-state correction.** The prompt expected `14 ahead / 0 behind / nothing
pushed`. The actual repository state at M139 start was **0 ahead / 0 behind**:
`refs/remotes/origin/main` is at `40fcd4b` and its reflog records `update by push`.
The M129–M138 work was already pushed by someone before this session. M139 itself
pushes nothing.

---

## 1. Workstream A — `ARCSpecies.copy` consumer under-reporting

### 1.1 Root cause

Three independent defects compounded into one deceptive answer.

**(a) `contains` traversed backwards makes the owning class a "dependent."**
`discoverImpactSymbols` walks incoming edges of any type. For a method that means
`ARCSpecies.copy ←contains— ARCSpecies` at distance 1, and then — through the class
— *every constructor caller of the class* at distance 2. Measured on ARC at
`depth:3, max_edges:80`, `dependentSymbolCount` was **80**, of which **zero** call
`copy`. The list was dominated by tests doing `ARCSpecies(...)`.

**(b) Unresolved receivers are structurally invisible.** `edge_call_sites` is keyed
to `edges.id`, so a call site is persisted only when an edge already exists. When
the receiver type cannot be proven (`spc.copy()`), the parser candidate is dropped,
no edge is written, and no call site survives. The engine's own diagnostics already
admitted this ("Unresolved parser candidates are skipped by the current persisted
graph") but the summary counts did not reflect it.

**(c) Direct relations contained no callers at all.** The three `directRelations`
were: `ARCSpecies contains ARCSpecies.copy` (incoming), `copy calls as_dict`
(outgoing), `copy calls ARCSpecies` (outgoing). `richSummary.directIncoming: 1`
counted the containment edge. **Exact callers: 0.**

Net effect: an agent reading `dependentSymbolCount: 2, dependentFileCount: 1` with
no warning could only conclude `ARCSpecies.copy` has essentially no consumers. It
has at least seven production call sites.

### 1.2 The 3-vs-609 contradiction explained

The apparently impossible pairing of `max_edges: 80`, `retainedEdges: 3` and
`canonicalEdgesOmitted: 609` is **three different accounting domains reported side
by side under one vocabulary**:

| Number | Produced by | Actually counts |
| --- | --- | --- |
| `canonicalEdgesRetained: 80` | graph discovery | dependent **nodes** kept |
| `canonicalEdgesOmitted: 686` (this checkout) | graph discovery | dependent **nodes** never hydrated |
| `responseBudget.retainedEdges: 3` | M133 envelope compaction | delivered edges, selected from `directRelations` — of which only 3 exist |

Crucially the budget named `max_edges` is applied to `symbolsById.size`, i.e. it
bounds **nodes**, not edges. So `canonicalEdgesOmitted` was neither edges nor caused
by an edge budget. `max_edges` was never the limiting factor on delivered edges;
having only three direct relations was.

M139 keeps the legacy field for compatibility and adds
`canonicalDependentsOmitted` / `canonicalEdgeSlotsOmitted` /
`canonicalOmissionCause` (`node_budget` here, measured `686 / 0 / node_budget`).

### 1.3 What M139 changed

- **`src/impact/callerCoverage.ts`** (new). Bounded, deterministic discovery of
  unresolved call sites. Candidates are narrowed using **indexed relations to the
  owning class** (75 files on ARC, not the whole repository), then only those files
  are read and validated against the indexed content hash before being trusted.
  No schema bump, no rebuild, no repository-wide scan, no `rg` at query time.
- **`summary.consumers`** — direction-separated counts: `exactCallerCount`,
  `exactReferenceCount`, `potentialCallerCount`, `structuralContainerCount`,
  `outgoingDependencyCount`, `reverseReachableSymbolCount`. `dependentSymbolCount`
  is retained and documented as deprecated rather than silently repurposed.
- **`callerCoverage`** — machine-readable `status` (`complete｜incomplete｜unknown`)
  plus reason codes. Zero exact callers with unresolved evidence can no longer
  render as "no callers".
- **`potentialCallers`** — a **separate collection**. Nothing here is ever emitted
  as an edge or persisted; the index stays conservative.
- **`richSummary.fieldDomains`** — every count now names its population
  (`full_graph`, `canonical_retained`, `delivered`), so `transitiveIncoming: 73`
  beside three delivered edges reads as two domains rather than a contradiction.

### 1.4 Precision: the rules that matter

Confidence is assigned only from **local, bounded** evidence, never inference:

| Tier | Evidence | Rule |
| --- | --- | --- |
| high | annotated parameter, annotated local, sole-constructor assignment, `self` in the owning class | receiver must be a **bare identifier** |
| medium | loop variable where the scope declares `list[Owner]` | container type must be declared with brackets |
| unresolved | scope merely names the owner; name match only | always surfaced, never promoted |

Two false positives found during development and fixed, both of which had been
scored `high`:

- `mol = ARCSpecies(label=...).mol` — the RHS is a `Molecule`. Constructor evidence
  now requires the constructor to be the **entire** right-hand side.
- `other: ARCSpecies` … `other = other.mol` … `other.copy()` — the annotation was
  stale. Binding analysis is now **last-write-wins**.

Also excluded: `self.r_1.mol.copy()` and `self.rxn1.copy()` (attribute suffixes
discard the root's type evidence), and `shutil.copy(...)` (an imported module name
is not an instance receiver).

### 1.5 Result

At `max_tokens: 3000`, `depth: 3`, `max_edges: 80`:

| Metric | M138 | M139 |
| --- | --- | --- |
| exact caller count | not reported | `0` (explicit) |
| potential caller count | not reported | `83` discovered, `10` delivered, `73` omitted |
| caller coverage state | absent | `incomplete` + 5 reason codes |
| `dependentSymbolCount` | `2` | `2` (unchanged, now deprecated) |
| `summary.consumers` | absent | present, direction-separated |
| `transitiveIncoming` / `affectedFiles` | `73` / `33` | `73` / `33` (now domain-labelled) |
| `canonicalEdgesOmitted` | `686`, cause unstated | `686` = `686` nodes + `0` edge slots, cause `node_budget` |
| delivered edges | `3` | `3` |
| response chars / withinEnvelope | `6739` / true | `13092` / true |

Delivered sites include the real production consumers `arc/mapping/engine.py:463`
(`spc_1`, `spc_2`, high) and `arc/reaction/reaction.py:849` (`r_spc`, medium).
`arc/scheduler.py:4547` is discovered at `unresolved`. `arc/checks/ts.py:206` is
correctly **excluded** — it calls `ARCReaction.copy`. See
`stage5_m139_arc_copy_rg_ground_truth.md`.

At `max_tokens: 1200` the sites do not fit; compaction retains the machine-readable
warning and the counts (`status: incomplete`, `omitted: 83`) rather than degrading
into apparent completeness. Priority order is enforced: proven relations, then
high-confidence sites, then lower-confidence sites; the target's own **outgoing**
dependencies yield before caller evidence on a consumer question.

### 1.6 Known limitation (accepted)

`arc/mapping/driver.py:202,225` are real consumers that M139 does **not** discover.
That file never imports `ARCSpecies` — not even under `TYPE_CHECKING` — so no
indexed relation exists to narrow on. Reaching it needs cross-module attribute type
inference, excluded from M139 by design. Coverage correctly reports `incomplete`.

---

## 2. Workstream B — behavioral vs preference contrast

### 2.1 Root cause

`parseContrastClauses` treated `rather than` / `instead of` as unconditional
preference-exclusion cues. For the ARC query the right-hand span "taken from the
stored adjacency list" was removed from the positive text and its terms became
negative contrast terms. `evaluateCandidateContrast` charges
`matchedContrastTerms.length * 0.14`, which is exactly the reported **-0.28** for
`adjacency` + `list`.

Confirmed live on the M138 baseline: `downranked: high-confidence contrast matched
list (-0.14)`.

### 2.2 The fix

A `ContrastKind` dimension (`preference_exclusion` | `alternative_branches`) is
derived from the **clause frame**, not the cue word. A conservative grammar of
behavioural frames (`under what conditions`, `when is/are/does/…`, `what
determines`, `why does`, `depending on`, `whether`) is matched against the text
preceding the cue within the same sentence. Every rule demands clause structure —
`when` must be followed by an auxiliary verb — so "the helper used **when parsing**,
rather than the one for serializing" remains a preference.

Branch clauses never remove text, never contribute contrast terms, and never
suppress an identifier. Both sides become positive `branchTerms`, and a candidate
matching **both** sides earns an extra orchestration bonus.

### 2.3 Verified behaviour

| Query | contrastKind | negative penalty |
| --- | --- | --- |
| ARC serialization / adjacency list | `alternative_branches` | **none** ✅ |
| M135 dihedral "vectors rather than coordinates" | `preference_exclusion` | `-0.28` retained ✅ |
| "use vectors rather than coordinates" | `preference_exclusion` | yes |
| "when are vectors used rather than coordinates?" | `alternative_branches` | none |
| "I need a bytes parser instead of a file parser" | `preference_exclusion` | yes |
| "When does the program choose the bytes parser instead of the file parser?" | `alternative_branches` | none |
| "helper used when parsing, rather than the one for serializing" | `preference_exclusion` | yes |
| `compare A with B` / `why doesn't A call B?` | `none` | none |

**Hard gate (§43) met:** `adjacency` and `list` no longer appear as negative
contrast terms for the ARC query — `contrastTerms` is empty and the live
`downranked` evidence line is gone. **M135 preserved (§44):** `get_dihedral`
remains lead and `calculate_dihedral_angle` retains its `-0.28`.

### 2.4 The ARC serialization acceptance — NOT met

The real code path, read from source at `d5ef3dc`:

> `ARCSpecies.from_dict` (`species.py:886`) is the reconstruction entry point.
> The stored-adjacency branch is `species.py:960-970` and `974-977`
> (`Molecule().from_adjacency_list(...)`). The Cartesian re-derivation branch is
> `species.py:989-990`, guarded by
> `if self.final_xyz or self.initial_xyz or self.most_stable_conformer or
> self.conformers or self.ts_guesses: self.mol_from_xyz(get_cheap=False)`.
> The in-source comment states it **overrides** the mol built from adjlist or
> smiles so xyz and mol share atom order.

Removing the penalty changed the lead from `are_coords_compliant_with_graph` to
`ARCSpecies`, but `from_dict`, `mol_from_xyz`, `as_dict` and `copy` are **still not
visible**. Root cause, established rather than assumed:

1. **It is a vocabulary gap, not the contrast bug and not a missing symbol.** The
   indexed text of these methods barely overlaps the query. `from_dict`'s docstring
   is "A helper function for loading this object from a dictionary in a YAML file
   for restarting ARC" — no "serialized", "graph", "adjacency", "connectivity" or
   "Cartesian". `mol_from_xyz`'s is "Make sure atom order in self.mol corresponds
   to xyz". Meanwhile `are_coords_compliant_with_graph` matches *coords* + *graph*
   directly, which is why it ranked.
2. **The structural chain that would rescue them exists in the index.** Verified:
   `ARCSpecies.from_dict` has 18 outgoing edges including
   `→ ARCSpecies.mol_from_xyz`, and `mol_from_xyz → perceive.py::perceive_molecule_from_xyz`.
   `perceive_molecule_from_xyz` **is** retrieved (support #2). So a bounded upstream
   graph expansion from retrieved symbols would surface `mol_from_xyz` at one hop
   and `from_dict` at two.

Per the milestone's own instruction not to solve a candidate-availability defect by
raising score weights, and not to retune ranking broadly, this expansion is **not**
implemented here: it changes candidate generation and would require the full paired
frozen-benchmark proof to land safely. It is recorded as the precise, scoped next
step.

---

## 3. Verification

```
bun run typecheck              PASS
bun run typecheck:benchmarks   PASS
bun test                       3945 pass / 0 fail / 49 skip (244 files)
git diff --check               clean
```

New tests: `src/impact/callerCoverage.test.ts` (13) — typed/constructed/annotated
receivers, ambiguous method name, rebinding, attribute suffixes, container typing,
module receivers, boundedness, "no site is ever promoted to a proven edge", and the
only-way-to-reach-`complete` rule. `src/retrieval/contrastKind.test.ts` (12) —
both ARC/M135 queries, `rather than`/`instead of` ambiguity in both directions,
comparison and causal controls, frame-word hygiene, and the §58 check that
behavioural framing does not become `capability_lookup`.

M131–M138 preservation is carried by the existing suite, which passes in full.

**Not run, and therefore not claimed:** the aggregate frozen-50 / Django-expanded /
cross_repo_30 paired benchmark, the TCKDB same-checkout acceptance, and the
standalone M136/M137/M138 ARC smoke scripts. The M138→M139 paired comparison was
performed on ARC only (`stage5_m139_arc_copy_impact_before_after.json`,
`stage5_m139_behavioral_contrast_before_after.json`), with both sides generated
from freshly built indexes over the same immutable checkout. No aggregate-quality
claim is made.

Safety: no live agents, no Docker, no VEXP, no paid APIs, no network. ARC and its
index copies were read-only/isolated.

---

## 4. Findings for the ledger

- **A budget named for edges bounded nodes.** `max_edges` caps `symbolsById.size`
  in `discoverImpactSymbols`, and the resulting omission count was reported as
  `canonicalEdgesOmitted`. Any past reading of that field as "edges dropped because
  max_edges was reached" was wrong.
- **`contains` is not consumption.** Reverse-reachability through a containment
  edge turns every consumer of a *class* into a "dependent" of each of its
  *methods*. Direction-blind reachability cannot answer "who calls this?".
- **Import-edge attribution is fragile (new defect, unrelated to M139, deferred).**
  Minimal reproduction: a file with `from model import Thing` and one function
  yields an `imports` edge; adding a **second, unrelated** function to the same
  file drops it to **zero** edges. This silently shrinks any import-derived
  narrowing — including M139's candidate set — and deserves its own milestone.
- **The committed ARC index was stale**, recording `ARCSpecies.copy` at line 653
  against a working tree that has it at 691. The M139 caller scan's freshness gate
  correctly refused to trust 43 of 70 candidate files against it; all acceptance
  was therefore run on freshly generated indexes. Re-check index freshness before
  trusting any ARC measurement.
- **Prompted ground truth needs re-validation.** Of the four call sites supplied
  for this milestone, all four line numbers were stale and one
  (`checks/ts.py`) was a different class's method.

## 5. Deferred to M140 (unchanged, not addressed here)

- `index_status` reports `fresh` while the next `get_code_context` returns
  `index_schema_changed / rebuild_index`. M139 introduced **no** schema change, so
  it neither fixes nor worsens this.
- `index_repo` returns a ~290-entry `fileOutcomes` array for a normal index.
- `memoryRulesMs` ~2167 ms of ~5445 ms total. M139 adds no memory work; the caller
  scan costs ~110 ms and runs only when consumers are requested and none were
  proven.
