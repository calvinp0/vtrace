# M140-B plan — bounded upstream orchestration rescue

Continuation of M140 from the corrected Workstream-A6 checkpoint (`51ea606`).
Workstream A is not reopened; the graph architecture, import semantics, the
`computeInDegreeCentrality` correction, and the A6 benchmark conclusion are all
frozen inputs.

## Sequence executed

1. **Fresh ARC index (§8).** Build an isolated index over the requested ARC
   worktree with the M140-A6 parser, record its identity, and re-measure the
   fan-in profile rather than trusting the remembered `62 / 3 / 1`.
2. **Confirm the path (§9).** Prove the exact `calls` chain exists in that index,
   with FQNs, edge kinds and per-node incoming fan-in.
3. **Reproduce the failure (§10).** Run the exact §35 query at A6 and record
   derived intent, contrast kind, candidate ranks, lead, pivots and delivery —
   then adapt the acceptance to the gap that actually remains.
4. **Implement (§11–§32).** A separate bounded rescue lane: intent gate,
   deterministic seed rule, incoming exact-call expansion to depth ≤ 2, caps at
   every dimension, cycle protection, dedupe, relevance scoring against the
   original query, truthful attribution, telemetry.
5. **Fixtures and negative controls (§41–§50).**
6. **ARC acceptance and preservation (§35–§40, §53–§62).**
7. **Freeze, then benchmark (§86, §64).** Commit the functional change, then run
   the provenance-safe A6 → final paired comparison over Frozen 50, Django
   expanded and cross_repo_30 against a moving-tree-free candidate.
8. **Report (§65–§68, §90–§94, §100).**

## What was measured before designing

Every design number came from the fresh index, not from notes:

| symbol | incoming `calls` | non-structural |
|---|---:|---:|
| `perceive_molecule_from_xyz` | 62 | 62 |
| `ARCSpecies.mol_from_xyz` | 3 | 3 |
| `ARCSpecies.from_dict` | 1 | 1 |

The remembered profile reproduced exactly. Import edges also reproduced at
**2,281**, matching the A6 evidence.

`are_coords_compliant_with_graph` has **no** direct `calls` edge from either
orchestration hop — §35 lists it, but the graph does not connect it that way, so
it is treated as branch logic reached independently rather than as a chain link.

## The gap that actually remained

Two corrections to the assumed starting point, both found by measurement:

- The A6 failure is **not** "downstream retrieved, upstream ranked low". Both
  upstream hops were **entirely absent from the candidate pool** — a pure
  candidate-generation gap, as §11 anticipated.
- `from_dict` appears at candidate rank 15 only if matched by local name. That
  is `TSGuess.from_dict`, a **different class**. `arc/species/species.py` defines
  both, so any name-suffix check reports an absent symbol as present. All
  visibility in this milestone is resolved by exact fully-qualified name.

## Non-goals

Explicitly not attempted: reopening the import-ownership architecture, retuning
`rerankGraph`, touching the structural-module centrality correction, broad score
changes, symbol-specific bonuses, repo-specific exceptions, M141 readiness work,
or workspace/multi-repository work.
