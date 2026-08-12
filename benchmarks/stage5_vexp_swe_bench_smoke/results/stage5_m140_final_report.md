# M140 final report — graph correction + bounded upstream orchestration rescue

**M140 overall: MIXED.** Workstream B is implemented, bounded, benchmarked and
provenance-valid, and it recovers the ARC orchestration chain into the candidate
set. One §36 acceptance is not met: the deserialization **entry point**
(`ARCSpecies.from_dict`) is rescued and scored but does not reach delivered
context. §99 defines that outcome as MIXED, and it is reported as such rather
than tuned away.

| area | verdict |
|---|---|
| Workstream A (graph / structural-node correction) | **PASS** (unchanged from M140-A) |
| M140-A paired benchmark | **PASS — authoritative** (unchanged) |
| Workstream B implementation | **PASS** |
| ARC orchestration acceptance | **MIXED** — intermediate delivered, entry point not |
| A6 → final paired benchmark | **PASS — run, provenance-valid, 0 changed cases** |
| Preservation (M131/M136/M137/M138/M139, module nodes, centrality) | **PASS** |
| TCKDB same-checkout acceptance | **PASS** |
| Type safety / tests | **PASS** — 4101 pass, 0 fail |

---

## 1. Authoritative state

| ref | commit |
|---|---|
| M139 functional (declared predecessor of A) | `340fd9c6905125ac3942f622c85a9508ddc8cda4` |
| M140-A6 functional (declared predecessor of B) | `51ea6064f9ad58d26085023f3a2aec7ff64cf092` |
| M140-B functional | `7093e2d6…` — *Add bounded upstream orchestration retrieval* |

Branch `main`, committed locally, **not pushed**. At session start the branch was
10 ahead / 0 behind `origin/main`, and the working tree was dirty only with the
pre-existing `stage5_outcome_ledger.json/.md`, which were left untouched. No
M134–M139 ledger rows were fabricated.

Benchmark workspace: `/home/calvin/bench/vtrace-m140` (root filesystem, 656G
free). Nothing under it is staged.

## 2. Fresh ARC index and the confirmed path

Index built from the requested worktree with the A6 parser, into the bench area;
ARC source and its in-place `.vtrace` were never written (its `.vtrace` mtime
predates this session).

| | value |
|---|---|
| ARC | `arcbench` @ `d5ef3dc5777e6c11c8ce018dada3ce7f91ef666e` |
| ARC tree state | clean of tracked modifications (untracked `.vtrace/`, `feature_docker_ux/` only) |
| index | 324 files, 8,986 symbols, 21,618 edges |
| edges by kind | calls 10,759 · contains 5,960 · imports **2,281** · references 2,618 |
| structural module symbols | 273 |

The A6 import-ownership figure (2,281) reproduced exactly.

**Chain confirmed**, both hops exact `calls` edges:

| symbol | incoming `calls` fan-in | non-structural |
|---|---:|---:|
| `arc/species/perceive.py::perceive_molecule_from_xyz` | **62** | 62 |
| `arc/species/species.py::ARCSpecies.mol_from_xyz` | **3** | 3 |
| `arc/species/species.py::ARCSpecies.from_dict` | **1** | 1 |

The remembered `62 / 3 / 1` profile reproduced. `are_coords_compliant_with_graph`
has **no** direct `calls` edge from either orchestration hop — §35 lists it, but
the graph does not connect it that way; it is reached independently as branch
logic.

## 3. The A6 failure, as measured

Running the exact §35 query at A6:

- `contrastKind = alternative_branches`, `contrastTerms = []` — M139's contrast
  fix intact.
- lead `ARCSpecies`; pivots `ARCSpecies`, `are_coords_compliant_with_graph`.
- `perceive_molecule_from_xyz` retrieved at rank 4 and delivered as support.
- `ARCSpecies.mol_from_xyz` — **absent from the candidate pool**.
- `ARCSpecies.from_dict` — **absent from the candidate pool**.

Both upstream hops were entirely missing, not merely under-ranked: a
candidate-generation gap, exactly as §11 frames it.

**A false positive corrected on the way in.** A `from_dict` does appear at rank
15 — it is `TSGuess.from_dict`, a *different class* in the same file. `species.py`
defines both, so any local-name or name-suffix match reports the absent symbol as
present. Every visibility claim in this milestone resolves by exact fully
qualified name.

## 4. What Workstream B does

Full contract in `stage5_m140b_rescue_policy.md`. In brief:

- **Gate.** Runs only for orchestration-shaped requests, decided once from the
  already-derived intent: a parsed conditional-alternative clause, or a process
  frame (`how does/is…`, `what happens/triggers/orchestrates…`). Suppressed for
  capability lookups and for imperative symbol lookups. `who calls X` is
  deliberately excluded — caller enumeration remains impact's job (§18).
- **Seeds.** Function/method-like, non-structural, non-test, rank ≤ 5, score ≥
  0.75 × top, at most 3.
- **Traversal.** Incoming **exact `calls` edges only** (§13/§51), depth ≤ 2, one
  batched capped edge query plus one batched hydration per level, cycle-safe.
- **Admission.** A caller must independently match the original query on its
  indexed definition: ≥ 2 distinct query terms (absolute floor) and ≥ 0.25 of the
  best BM25 among that node's callers (relative floor). **Zero source reads.**
- **Scoring.** Survivors are re-scored against the query as one pool, then
  `min(0.95, 0.95 × depthFactor × relevance + multiSeedBonus)`.
- **Delivery.** Rescued symbols are ordinary candidates: same scoring, selection,
  budget and rendering. No side channel (§56).

## 5. ARC result — §35–§40

| symbol | role | A6 rank | final rank | A6 delivered | delivered |
|---|---|---:|---:|---|---|
| `are_coords_compliant_with_graph` | branch logic | 2 | 2 | yes (pivot) | **yes (pivot)** |
| `perceive_molecule_from_xyz` | downstream impl | 4 | 4 | yes | **yes** |
| `ARCSpecies.mol_from_xyz` | orchestration hop 1 | **absent** | **6** | no | **yes** |
| `ARCSpecies.from_dict` | orchestration entry | **absent** | 93 / 132 | no | no |

Delivered context moved from

```
ARCSpecies · are_coords_compliant_with_graph · xyz_to_coords_list ·
perceive_molecule_from_xyz · _add_nth_atom_to_coords · change_dihedrals_and_force_field_it
```

to the same set with `change_dihedrals_and_force_field_it` — an unrelated
conformer helper — **replaced by `ARCSpecies.mol_from_xyz`**. The delivered
context now contains `mol_from_xyz → perceive_molecule_from_xyz` plus the
coordinate/graph compatibility branch logic: three of the four symbols §35 asks
to inspect, and both behavioural branches (§39). No downstream evidence was
displaced (§38).

- **§37 met.** The intermediate orchestration is visible and delivered, which is
  the direct proof that rescue traversed the orchestration path.
- **§36 not met.** `from_dict` is rescued and scored (0.975) but sits at rank 93
  of 132. See §9 below.

### High fan-in — §19, §40, §92

| seed | total callers | examined | admitted | cap hit |
|---|---:|---:|---:|---|
| `perceive_molecule_from_xyz` | **62** | 62 | **3** | no |
| `xyz_to_coords_list` | 8 | 8 | 3 | no |
| `are_coords_compliant_with_graph` | 4 | 4 | 1 | no |

The ~62-caller seed contributed **3** candidates, not 62 — §19's hard gate. Of
the 8 rescued candidates, exactly **one** reached delivered context:
`ARCSpecies.mol_from_xyz`. No unrelated caller from the broad tail entered
answer-bearing context (§40's hard gate).

Synthetic 1000-caller fixture: total fan-in 1,002 → 3 admitted, DB queries
constant between the 50- and 1000-caller variants, and no `bulk_consumer_*`
rescued at any fan-in.

## 6. A6 → final paired benchmark — §64, §66, §68

Predecessor `51ea606` (A6), candidate `7093e2d` (B), M134 provenance framework,
isolated per-side indexes over separately prepared copies of the same immutable
corpus.

| suite | cases | provenance valid | changed cases | semantic hashes |
|---|---:|---|---:|---|
| Django expanded | 20 | ✅ | **0** | identical |
| cross_repo_30 | 30 | ✅ | **0** | identical |
| **Frozen 50** | 50 | ✅ | **0** | — |

| Frozen 50 metric | A6 | final |
|---|---:|---:|
| Top-1 gold file | 39 | **39** |
| Top-3 gold file | 44 | **44** |
| gold file anywhere | 47 | **47** |
| gold symbol anywhere | 31 | **31** |
| missing gold | 3 | **3** |
| mean estimated tokens | 1806.44 | **1806.44** |

Zero changed cases, so the changed-case ledger is empty: no improvements, no
regressions, no unexpected movement, nothing unattributed (§66, §93).

That is a consequence of the gate, not of a weak effect. The frozen suites are
SWE bug-report and defect-localisation tasks, which are not orchestration-shaped,
so the lane never activates on them. Measured activation over a mixed ARC query
set: **3/8 (37.5%)** — all three orchestration-shaped, zero on capability
lookups, explicit lookups, and bug reports.

## 7. Three-state table — §65, §94

| suite | metric | M139 retrospective | M140-A6 | M140 final |
|---|---|---:|---:|---:|
| Django expanded (20) | Top-1 | 18 | 18 | 18 |
| | Top-3 | 20 | 20 | 20 |
| cross_repo_30 (30) | Top-1 | 21 | 21 | 21 |
| | Top-3 | 25 | 24 | 24 |
| **Frozen 50** | **Top-1** | **39** | **39** | **39** |
| | **Top-3** | **45** | **44** | **44** |
| | gold anywhere | 47 | 47 | 47 |
| | missing gold | 3 | 3 | 3 |
| | changed cases | — | 24 | **0** |

The two effects stay separated. M139 → A6 carries the graph correction (Top-1
restored to parity; Top-3 one short, from the truthful `sympy-12419` regression
where the old gold had benefited from false import ownership). A6 → final carries
the upstream-rescue effect, which is **zero on these suites**.

## 8. Preservation and performance

| check | result |
|---|---|
| module nodes never delivered (§55) | 0 leaks across 4 queries, incl. rescued candidates |
| structural sources excluded from centrality (§54) | 273 structural symbols, 0 in the metric |
| M136 budget delivery @3000 tokens (§57) | mode `standard`, `get_dihedral` delivered |
| M137 dihedral preference contrast (§58) | lead `get_dihedral`; `calculate_dihedral_angle` penalty 0.28; `contrastKind = preference_exclusion`; rescue **not** activated |
| M139 impact truthfulness (§53) | exact and potential caller evidence in separate fields; coverage truthful |
| M131 flow (§61) | 1 path, 1 edge, `calls` |
| TCKDB same checkout (§63) | `main` @ `b91f69e`, **0/4 cases changed**, read-only |
| tests | 4101 pass / 0 fail / 49 skip |
| typecheck | `bun run typecheck` and `typecheck:benchmarks` clean |

Rescue cost on the activating ARC query: **4.4 ms**, **6 DB queries**, 97 incoming
edges examined, 14 scored, 8 admitted — under 1% of retrieval time. Non-activating
requests do **zero** incoming-edge work and issue **zero** extra queries.

## 9. The §36 limitation, stated plainly

A rescued candidate has almost no base score — being missed by lexical search is
the premise. So the rescue contribution is essentially its whole score. That is
enough to lift a depth-1 caller that tops the rescued pool into delivery
(`mol_from_xyz`: 0 → 1.821, rank 6). It is not enough for `from_dict`, which is a
depth-2 caller scoring 0.553 relative within the rescued pool: it reaches 0.975
against a delivery threshold near 1.78.

Closing that gap would need the rescue component to contribute ≈1.0 — i.e.
rescued two-hop callers routinely outranking exact direct answers, which §70
names as a rescue defect and §69 forbids reaching by tuning. The cap is instead
calibrated against the existing bounded-component family (`directAnswerScore`
caps at 0.95) and left there.

What this means in practice: the reader gets the orchestration hop, the branch
logic and the implementation, and can reach `from_dict` in one step from
`mol_from_xyz`. They do not get the entry point in the delivered context.

## 10. Verdicts

- **Workstream A: PASS** (unchanged).
- **M140-A paired benchmark: PASS, authoritative** (unchanged).
- **Workstream B: PASS** against §98's implementation criteria — path confirmed,
  failure reproduced, bounded exact-call rescue implemented, seeds deterministic
  and intent-aware, every dimension capped, cycles terminate, duplicates merged,
  high fan-in contained, rescued candidates scored against the original query,
  module symbols never answer-bearing, centrality correction intact, M136/M137/
  M139 and flow/worktree behaviour preserved, TCKDB acceptance passed, full
  paired benchmark completed with every changed case attributed (there are none),
  typechecked, tested, committed locally on `main`, nothing pushed.
- **ARC orchestration acceptance: MIXED** — §37 met, §36 not.
- **M140 overall: MIXED**, per §99.

## 11. Remaining limitations and deferred work

- `ARCSpecies.from_dict` is recovered as a candidate but not delivered (§9 above).
- Rescue traverses `calls` only. An orchestration step expressed purely as an
  import or an unresolved dynamic call is not recoverable by this lane.
- When `maxIncomingEdgesPerSeed` bites, the retained prefix is edge-id ordered and
  uncorrelated with relevance. It is set to 2,000 so this is rare, and
  `limitReached` reports it, but a >2,000-caller seed gets best-effort coverage.
- The preservation-smoke result-path hazard (§88) is unchanged: those smokes write
  into the tracked `results/` tree regardless of `--out`. M140-B's own acceptance
  scripts honour `--out`. Deferred to M141.

Deferred to **M141 — Index Readiness and Indexing-Path Hygiene**: the
`index_status` source-fresh vs runtime-ready disagreement, a shared readiness
evaluator, `index_repo` response bloat, `memoryRulesMs` profiling, and the
preservation-smoke result-path hygiene above.
