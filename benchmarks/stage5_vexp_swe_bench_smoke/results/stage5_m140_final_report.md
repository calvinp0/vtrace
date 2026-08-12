# M140 final report — graph correctness, bounded rescue, path-coherent delivery

**M140 overall: PASS.**

Workstream A corrected the graph. Workstream B recovered the orchestration chain
into the candidate set. Workstream C delivers it. The ARC acceptance criterion
that left M140 at MIXED — `ARCSpecies.from_dict` discovered but not delivered — is
met, and it is met without inflating a single score.

| workstream | verdict |
|---|---|
| A — module-symbol import ownership | **PASS** (unchanged from M140-A) |
| A6 paired benchmark | **PASS — authoritative** (unchanged) |
| B — bounded upstream orchestration rescue | **PASS** |
| B ARC acceptance | **MIXED** — entry point discovered, not delivered |
| C — path-coherent orchestration delivery | **PASS** — 28/28 acceptance, B→C 0/50 changed, provenance-valid |

Commits, all local on `main`, **nothing pushed**:

| stage | functional | evidence |
|---|---|---|
| M139 (declared predecessor of A) | `340fd9c` | — |
| A6 | `6a6e922` | `51ea606` |
| B | `7093e2d` | `2902b65` |
| C | `4172a26` + `c267816` | this commit |

The working tree was dirty only with the pre-existing
`stage5_outcome_ledger.json/.md`, which were left untouched. No M134–M139 ledger
rows were fabricated. Benchmark workspace `/home/calvin/bench/vtrace-m140` (root
filesystem, not `/tmp`); nothing under it is staged.

This report supersedes the M140-B final report. The numbers that report carried
are retained in the four-state table in §11 rather than restated as current.

---

## 1. What M140-C set out to fix

M140-B ended one criterion short, and the shortfall was precise:

```
ARCSpecies.from_dict is DISCOVERED  (rescued, scored 0.9749)
ARCSpecies.from_dict is NOT DELIVERED (rank 93 of 132)
```

That was not a defect in the rescue lane. A rescued candidate has essentially no
base score — being missed by lexical search is the *premise* of a rescue — so the
bounded rescue component is its entire score. Reaching the ~1.78 delivery
threshold from 0.975 needs roughly another point from one component, which is the
same as declaring that two-hop callers outrank exact direct answers. M140-B
declined to do that and reported MIXED rather than tuning it away.

M140-C therefore changes no score at all. It separates two questions the pipeline
had been answering with a single number:

```
RANKING   asks: how directly does this candidate match the request?
SELECTION asks: which bounded set of evidence answers the request coherently?
```

`ARCSpecies.from_dict` does not need to pretend to be a strong direct match. It
needs one truthful support slot, because it is the last missing link of a chain
whose other two hops are already on screen.

## 2. The ARC chain, reconfirmed

ARC `arcbench @ d5ef3dc` is unchanged since M140-B (the recorded `clean=false`
reflects only two untracked directories; no tracked file differs). A freshly built
isolated index reproduced M140-B exactly:

```
324 files · 8,986 symbols · 21,618 edges · 2,281 imports
```

Chain verified as exact `calls` edges; fan-ins re-measured rather than inherited:

| node | incoming `calls` | non-structural |
|---|---:|---:|
| `perceive_molecule_from_xyz` | 62 | 62 |
| `ARCSpecies.mol_from_xyz` | 3 | 3 |
| `ARCSpecies.from_dict` | 1 | 1 |

`are_coords_compliant_with_graph` still has **no** direct `calls` edge from either
orchestration hop; it is branch logic reached independently, and is treated as
such.

### What the code actually does

The query asks when connectivity is re-derived from coordinates rather than taken
from the stored adjacency list. That decision is made in `from_dict` itself:

1. `ARCSpecies.from_dict` rebuilds state from the serialized dict. If the dict
   carries `adjlist` / `mol` / `inchi` / `smiles`, `self.mol` is built from the
   **stored adjacency** — the first branch.
2. Then, at `arc/species/species.py:990-991`:
   ```python
   # Perceive molecule from xyz coordinates. This also populates the .mol attribute.
   # It overrides self.mol generated from adjlist or smiles so xyz and mol will have the same atom order.
   if self.final_xyz or self.initial_xyz or self.most_stable_conformer or self.conformers or self.ts_guesses:
       self.mol_from_xyz(get_cheap=False)
   ```
   When the serialized dict carries Cartesian coordinates, the coordinate route
   **overrides** the adjacency-derived graph — the second branch. This condition
   is the "under what conditions" the question asks about.
3. `ARCSpecies.mol_from_xyz` calls `perceive_molecule_from_xyz(xyz, …)`, assigns
   `self.mol = perceived_mol`, and validates it with `check_xyz_isomorphism`
   (TS species are accepted without enforcing 2D isomorphism).
4. `perceive_molecule_from_xyz` performs the coordinate → connectivity perception.

The deciding condition lives in `from_dict`. Under M140-B the reader received
steps 3 and 4 and never saw step 2.

## 3. What M140-C does

One support slot per request may go to the single already-discovered candidate
that completes an exact short call path whose **every other node is already
selected**. The full rule is in `stage5_m140c_path_completion_policy.md`; its
shape:

- **eligibility** — orchestration-shaped intent (the M140-B lane's own gate,
  reused so the two cannot drift), discovered by that lane, non-structural, exact
  `calls` only, depth ≤ 2, every downstream path node already selected, relevance
  ≥ 0.30 with ≥ 2 matched query terms, and ≥ 2 support slots in the capsule;
- **shape** — the candidate must be a **chain head** (reaches the seed *through* a
  delivered intermediate) or a **branch controller** (the request asked which of
  two alternatives runs, and it calls ≥ 2 of the delivered alternatives);
- **selection** — at most one, ordered by chain length completed, then matched
  query terms, then ordinary score, then name;
- **placement** — converts one existing support slot under ordinary budgeting;
  never a pivot, never the lead; may displace only the weakest unprotected winner.

### The correction measurement forced

The first implementation required only coherence — that the path's downstream
nodes be delivered. On ARC that is correct, but *every caller of a selected
function* satisfies it, and on a broad process question ("How does ARC handle
linear segments and dummy atoms in Z-matrices?") it spent the slot on an ordinary
rank-11 caller whose only qualification was calling something already on screen.
That is precisely the failure the contract warns about.

The shape rule was added in response. It is a stricter eligibility gate — the kind
the milestone permits — not a repo-specific exception, a symbol bonus, or a
gold-tuned threshold. After it, the same broad query selects nothing.

## 4. ARC acceptance — **28 / 28 PASS**

`stage5_m140c_acceptance.json`.

| symbol | M140-B | M140-C |
|---|---|---|
| `perceive_molecule_from_xyz` | delivered (rank 5) | delivered, unchanged |
| `ARCSpecies.mol_from_xyz` | delivered (rank 6, rescued) | delivered, unchanged |
| `are_coords_compliant_with_graph` | delivered (pivot) | delivered, unchanged |
| **`ARCSpecies.from_dict`** | **rescued, rank 93/132, NOT delivered** | **DELIVERED as `orchestration_support`** |

The selected set changes by exactly one in, one out:

```
added    arc/species/species.py::ARCSpecies.from_dict     (24 tokens, signature mode)
removed  arc/species/zmat.py::_add_nth_atom_to_coords     (an unrelated zmat coordinate helper)
lead     arc/species/species.py::ARCSpecies               (unchanged)
items    6 -> 6        tokens 829 / 6000        within envelope
```

The rank is **not** inflated. `from_dict` still scores 0.9749, exactly as M140-B
recorded, and the delivered item says so:

```
selection_role   orchestration_support
selection_reason completes the exact 2-hop call path from_dict -> mol_from_xyz
                 -> perceive_molecule_from_xyz, whose other 2 node(s) are already
                 delivered; ordinary rank 97 (score 0.9749) is unchanged
ordinary_rank    97
```

> The two ranks (93 and 97) are the same symbol measured in two pools: 93 in the
> acceptance probe's uncapped 132-candidate ranking (`lexicalPoolSize` pinned to
> the product's 100), 97 in the capsule's own diagnostics pool. Both are reported
> as measured; neither is a delivery threshold.

Contrast semantics unchanged: `contrastKind = alternative_branches`, no negative
adjacency/list penalty, both branches remain positive evidence.

Per-symbol selection trace: `stage5_m140c_arc_selection_trace.json`.

## 5. Generic, repository-independent behaviour

| fixture | query | result |
|---|---|---|
| one-chain | "How is an object rebuilt from a serialized payload before raw data parsing?" | `deserialize` selected as `orchestration_entry`, depth 2 |
| conditional branch | "When do we reuse cached state rather than regenerate it?" | `load_state` selected as `branch_controller`, depth 1, two delivered alternatives |
| one-chain, incoherent | same query, intermediate **not** delivered | nothing selected — "1/2 downstream path nodes selected" |

## 6. Negative controls — all clean

`stage5_m140c_negative_controls.json`.

| shape | example | selected | why |
|---|---|---:|---|
| explicit lookup | "find get_dihedral" | 0 | no orchestration intent |
| explicit lookup | "where is ARCSpecies.copy?" | 0 | no orchestration intent |
| capability lookup | the M137 dihedral query | 0 | capability lookup suppresses the gate |
| caller enumeration | "who calls perceive_molecule_from_xyz?" | 0 | no orchestration frame; `get_impact_graph` owns this |
| broad process | "How does ARC handle linear segments…?" | 0 | no chain head or branch controller |
| broad process | "How is a species rebuilt and its conformers generated?" | 0 | no candidate discovered |
| bug report | the Django `Count`/`distinct` issue | 0 | no orchestration frame |
| high fan-in | 1,000 callers of one helper | 0 | 2 rescued, both direct callers, neither a chain head |

## 7. Bounds, budget and cost

| property | measured |
|---|---|
| items per request | ≤ 1 (property test) |
| selection rate | 1 / 11 mixed ARC requests (9.1%) |
| requests where the role was *considered* | 2 / 11 |
| new DB queries | 0 |
| new graph traversals | 0 |
| new source reads | 0 |
| evaluation cost | 0.07 ms worst case, 0.01 ms mean |
| rescue lane cost (unchanged) | 5.6 ms, 6 DB queries, 97 incoming edges examined |

Budget ladder — monotonic, never empty, always within envelope:

| max_tokens | mode | delivered items | chain symbols | entry delivered | path completion |
|---:|---|---:|---:|---|---|
| 500 | micro | 2 | 0 | no | refused: 1 support slot |
| 1,000 | micro | 2 | 0 | no | refused: 1 support slot |
| 3,000 | standard | 6 | 4 | **yes** | 1 selected |
| 6,000 | standard | 6 | 4 | **yes** | 1 selected |
| 12,000 | full | 15 | 4 | **yes** | 1 selected |

More budget never delivers less of the chain, and a capsule too tight to afford
the role simply does not use it.

## 8. Product-surface parity

`run_pipeline`, `get_code_context` and `get_context_capsule` read one seam —
`buildAuthoritativeProductRetrieval → buildCapsuleV2` — so the item cannot exist
in one surface and not another. Verified directly: the entry point is present in
the capsule result, in the authoritative retrieval result, and in the projected
historical capsule, and the `orchestration_support` role survives the projection.

## 9. Preservation

| milestone | check | result |
|---|---|---|
| M140-A | module symbols never delivered (5 queries, all surfaces) | **0 leaks** |
| M140-A6 | structural sources excluded from dependent-symbol centrality | 273 structural symbols, **0** in the metric |
| M139 | `ARCSpecies.copy` impact: exact vs potential callers separate | identical to M140-B |
| M137 | dihedral capability query: `get_dihedral` lead, `calculate_dihedral_angle` −0.28 penalty, no path-completion item | preserved |
| M136 | 3,000-token delivery: resolved, `get_dihedral` visible, within envelope | preserved |
| M131 | `reorder_p_label_map → map_two_species` flow | 1 path, 1 `calls` edge — identical |
| M132 | worktree routing / isolation / cleanup smoke | 20/21 rows pass — see below |
| M138 | memory provenance smoke | FAIL, **pre-existing** — see below |

**M132.** Every routing, isolation and cleanup row passes. The one failing row,
`impact_hydration_batched`, asserts a strict query *reduction* against its
baseline; its baseline here is M140-B, which already contains the M132 batching,
so `34 → 34 queries for 40 dependents` is the correct unchanged result and the
gate is structurally unsatisfiable in a B→C comparison
(`queryReduction: 0`, `semanticEquivalence: identical_dependent_set_size`).

**M138.** The standalone smoke reports FAIL. It reports the *same* FAIL at
`7093e2d` and at `4172a26`: the verdict artifact is byte-identical across the two
commits, and the only differing bytes anywhere are the recorded observing-commit
metadata and timing jitter. Classified pre-existing, not caused by M140-C.

**Filesystem hazard.** Three of the four standalone preservation runners accept no
`--out` and write into the tracked results tree regardless. `git status` was
captured before and after every run, every overwritten evidence file was archived
to the bench workspace and restored with `git checkout`, and no overwritten
historical evidence is committed. The restore step initially also reverted an
M140-C artifact written into the same directory; it was recovered from the archive
and the filter narrowed. Deferred to M141 as *preservation-smoke output-path
safety*. Details in `stage5_m140c_preservation_smokes.json`.

## 10. B→C paired benchmark

Provenance-safe M134 protocol: predecessor `7093e2d` and candidate `c267816`, each
loading its declared implementation from its own worktree against its own
independently prepared index over the same immutable target corpus.

```
provenanceValid = true      frozen 50: 0 / 50 changed
```

| suite | cases | provenance | same fixture | same corpus | isolated indexes | semantic hashes | changed |
|---|---:|---|---|---|---|---|---:|
| django_expanded | 20 | valid | ✅ | ✅ | ✅ | byte-identical | **0** |
| cross_repo_30 | 30 | valid | ✅ | ✅ | ✅ | byte-identical | **0** |

| metric | M140-B | M140-C |
|---|---:|---:|
| Top-1 gold file | 39 | 39 |
| Top-3 gold file | 44 | 44 |
| gold file anywhere | 47 | 47 |
| gold symbol anywhere | 31 | 31 |
| missing gold | 3 | 3 |
| mean pivots / support | 2.10 / 3.88 | 2.10 / 3.88 |
| mean estimated tokens | 1806.44 | 1806.44 |

Lead changes: 0. Selected-set changes: 0. Improvements 0, neutral 0, regressions
0, unexplained 0 — the changed-case ledger
(`stage5_m140c_changed_case_ledger.json`) is empty.

**An empty ledger here is a measurement, not a gap.** `evaluateOrchestrationIntent`
is active on **0 of the 50** frozen-50 tasks — measured directly on the fixture
text, not inferred from the benchmark — so the rescue lane never activates on
these suites and path completion is never offered a candidate. The frozen suites
prove **regression safety**; capability is proven by the ARC acceptance (§4), the
generic fixtures (§5), and the activation summary (§7), which must be read
together with this table.

Target preparation note: four of the twenty Django targets carry
`resumed_isolated_state` rather than `historical_run_success` — they were indexed
by the same candidate worktree in a run that was killed by a wall-clock limit and
resumed, not re-indexed. Three cross-repo targets report
`historical_run_success_with_unsupported_files`, the ordinary status for files the
parser does not handle. The indexer is untouched by M140-C, so neither affects
attribution.

## 11. Four-state quality

Each arrow carries exactly one effect, and they are not collapsed:

```
M139 -> A6   graph correctness / structural-node correction
A6   -> B    bounded upstream rescue DISCOVERY
B    -> C    path-coherent orchestration SELECTION
```

Frozen 50:

| metric | M139 *(retrospective replay)* | M140-A6 | M140-B | M140-C |
|---|---:|---:|---:|---:|
| Top-1 | 39 | 39 | 39 | **39** |
| Top-3 | 45 | 44 | 44 | **44** |
| gold anywhere | 47 | 47 | 47 | **47** |
| gold symbol anywhere | 31 | 31 | 31 | **31** |
| missing gold | 3 | 3 | 3 | **3** |
| mean tokens | — | 1806.44 | 1806.44 | **1806.44** |
| changed cases into this state | — | 24 | 0 | **0** |

Per suite:

| suite | M140-A6 | M140-B | M140-C | changed B→C |
|---|---|---|---|---:|
| django_expanded (20) | 18 / 20 | 18 / 20 | 18 / 20 | 0 |
| cross_repo_30 (30) | 21 / 24 | 21 / 24 | 21 / 24 | 0 |

*(Top-1 / Top-3 gold file.)*

The **M139 column is a retrospective replay** measured during M140-A, not a fresh
run of this milestone's harness; the Top-3 45 → 44 step into A6 is the truthful
`sympy-12419` regression M140-A attributed and accepted, not an M140-C effect.

The whole of M140's measurable quality movement on these suites therefore belongs
to Workstream A. B and C are both exactly zero on them — B because the gate never
fires on bug-report tasks, C because it is never even offered a candidate. That is
the intent gating working as designed, and it is the reason the ARC acceptance
carries the capability claim.

## 12. TCKDB same-checkout acceptance

TCKDB has advanced since M140-B (`main @ b91f69e` → `main @ 1896a85`). Both sides
ran against the **same current checkout**, opened read-only, so any difference is
attributable to the code:

```
main @ 1896a85 — 0 / 4 changed, pass = true
```

Shapes covered: one ordinary modify task, two process questions, one explicit
lookup. TCKDB source was never modified.

## 13. Verification run

```
bun run typecheck            clean
bun run typecheck:benchmarks clean
bun test                     4120 pass · 49 skip · 0 fail   (4101 at M140-B; +19 new)
git diff --check             clean
```

Named suites run explicitly: the M140-A structural suite
(`importAttributionStability.test.ts`) **130 pass / 0 fail**; the new
`pathCompletion.test.ts` **19 pass / 0 fail**. The ARC capsule for the
serialization query is byte-identical across six consecutive builds, including
the path-completion role and its recorded ordinary rank.

Everything above is offline and deterministic: no live agents, no Docker, no
VEXP, no paid APIs, no network. ARC and TCKDB are read-only.

## 14. Limitations and deferred work

- Path completion is restricted to two structural shapes. A depth-1 orchestration
  bridge on a non-branch process question is **not** eligible; the fully general
  "completes an exact short selected/relevant path" reading is deliberately not
  shipped, because the only measurement available for it showed it firing on an
  ordinary caller. Generalising it needs evidence this milestone does not have.
- The frozen suites cannot exercise the role at all — 0 of the 50 tasks are
  orchestration-shaped — so they prove regression safety, not capability. The ARC
  acceptance and the generic fixtures carry the capability claim.
- Rescue still traverses `calls` only (inherited from M140-B). An orchestration
  step expressed purely as an import or an unresolved dynamic call remains
  unreachable, and path completion cannot recover what was never discovered.
- The M138 smoke failure and the M132 baseline-gate mismatch are both pre-existing
  harness issues, recorded rather than fixed.

Deferred to **M141 — index readiness and indexing-path hygiene**: `index_status`
readiness disagreement, a shared `sourceFresh`/`schemaCompatible`/`ready`
evaluator, the `index_repo` ~290-entry `fileOutcomes` bloat, `memoryRulesMs`
~2.17 s profiling, preservation-smoke result-path hygiene, and file/module product
presentation. Workspace/multi-repository work stays behind M141.
