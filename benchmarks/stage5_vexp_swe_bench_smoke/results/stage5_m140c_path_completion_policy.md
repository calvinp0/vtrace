# M140-C path-completion policy

The rule that decides whether one bounded support slot goes to a candidate the
ordinary ranking cannot deliver. Implemented in `src/capsuleV2/pathCompletion.ts`
(pure, deterministic) and applied in `buildCapsuleV2` between support ordering and
support packing.

## The distinction being drawn

```
RANKING   asks: how directly does this candidate match the request?
SELECTION asks: which bounded set of evidence answers the request coherently?
```

`ARCSpecies.from_dict` does not need to pretend to be a stronger direct match than
it is. It needs one truthful support slot because

```
from_dict -> mol_from_xyz -> perceive_molecule_from_xyz
```

is the exact static chain connecting the reader's reconstruction question to the
implementation VTRACE already knows is relevant — and the other two hops are
already being delivered.

## Eligibility

Every condition is required. Nothing here reads repository names, symbol names,
or gold labels.

| # | Condition | Where it comes from |
|---|---|---|
| A | The request's intent is orchestration-shaped | the M140-B lane's own gate, reused verbatim so the two cannot drift |
| B | The candidate was produced by the bounded M140-B rescue | no second traversal, no new DB query, no new source read |
| C | The candidate is non-structural | `isStructuralSymbolKind`; the selection-side half of the A6 backstop |
| D | The path is exact `calls` edges only, depth ≤ 2 | inherited from the lane; re-asserted here |
| E | It is not already selected on ordinary evidence | nothing to complete |
| F | **Every** downstream node of its path is already selected | the coherence rule — see below |
| G | It is a chain head **or** a branch controller | the shape rule — see below |
| H | Relevance ≥ 0.30 and ≥ 2 matched query terms | §38 floor: graph position is never relevance |
| I | The capsule has ≥ 2 support slots | the role never consumes a capsule's only slot |

### F — coherence

Not "a path exists", and not "it shares a seed with something selected": every
node the candidate calls *through*, down to the seed, must already be on screen.
Completing such a path supplies the one missing link of a chain the reader can
otherwise follow. A candidate hanging off an undelivered intermediate would
instead introduce a dangling reference — a worse capsule, not a better one.

### G — shape

Coherence alone is not enough, and this was measured rather than assumed. On the
ARC serialization query, six of the eight rescued candidates satisfy F: every
caller of a delivered function does. Requiring only F spent the slot, on a broad
process question, on an ordinary rank-11 caller whose sole qualification was
calling something already delivered.

Two shapes qualify, each contributing a lifecycle dimension the selected set does
not already carry:

- **`orchestration_entry`** (chain completion, depth ≥ 2) — reaches the seed
  *through* a delivered intermediate. It is the head of a chain, not a sibling of
  one. §34's distinction exactly: `from_dict -> mol_from_xyz -> perceive_...`,
  never `some caller -> perceive_...`.
- **`branch_controller`** (depth 1) — the request parsed as a conditional
  alternative *and* the candidate calls at least two of the **delivered**
  alternatives. It is the code that chooses between the branches on screen.

## Selection

At most **one** item per request. Among eligible candidates:

1. the longest already-delivered chain completed (`downstreamSelected`, desc);
2. how much of the original request the candidate independently answers
   (matched query terms, desc);
3. its truthful ordinary score (desc);
4. fully-qualified name, then symbol id (asc).

Steps 3–4 guarantee the outcome never depends on Map iteration, SQLite row order,
or filesystem order. On ARC this resolves `from_dict` (chain length 2, 3 matched
terms) ahead of `from_yml_file` (chain length 2, 2 matched terms) and ahead of
four depth-1 callers.

## Placement and cost

- Enters the ordinary support ordering, content-mode assignment, token budgeting
  and compaction. There is no side channel and no unbudgeted field.
- **Converts** one support slot rather than growing the capsule. If the winner set
  is full it displaces the weakest unprotected entry; protected means a pivot, an
  author-pointed anchor (line/title/literal/strong direct evidence), a
  body-literal diagnostic, or a node of the path being completed. If nothing is
  displaceable the role simply goes unused.
- Branch evidence needs no explicit flag: support is already ordered strongest
  first, and displacement takes the **last** slot, so evidence the request
  actually asked for is never the thing that goes. On ARC the displaced entry was
  an unrelated zmat coordinate helper, while the branch logic
  (`are_coords_compliant_with_graph`) was a pivot and untouchable by construction.
- Never a pivot and never the lead. `leadPivot` is decided by ordinary
  answer-bearing relevance, untouched.
- The displaced entry is reported as budget-dropped, not silently removed.

## Truthfulness

The delivered item carries both readings side by side:

```
selection_role   orchestration_support
selection_reason completes the exact 2-hop call path from_dict -> mol_from_xyz
                 -> perceive_molecule_from_xyz, whose other 2 node(s) are
                 already delivered; ordinary rank 93 (score 0.9749) is unchanged
ordinary_rank    93
```

The score is not adjusted. `stage5_m140c_arc_before_after.json` records the same
0.9749 at the same rank as M140-B did.

## Policy table

| request shape | example | eligible? | why |
|---|---|---|---|
| behavioural serialization | "How does a species object get its 2D graph when rebuilt from a serialized dictionary…?" | **yes** | orchestration intent; chain head through a delivered intermediate |
| conditional branch | "When do we reuse cached state rather than regenerate it?" | **yes** | branch clause; controller calls two delivered alternatives |
| explicit symbol lookup | "find parse_raw_data", "where is ARCSpecies.copy?" | no | `evaluateOrchestrationIntent` → explicit symbol lookup command |
| capability lookup | "a function that returns a dihedral angle given three vectors, rather than…" | no | `evaluateOrchestrationIntent` → capability lookup |
| caller enumeration | "who calls perceive_molecule_from_xyz?" | no | no orchestration frame; `get_impact_graph` owns this |
| broad process question | "How does ARC handle linear segments and dummy atoms in Z-matrices?" | ordinarily no | intent fires, but no candidate is a chain head or branch controller |
| bug report | "Count with a Case expression and distinct=True emits a missing space" | no | no orchestration frame |

## Bounds

| bound | value |
|---|---|
| items per request | 1 |
| path depth | ≤ 2 (exact `calls` only) |
| new graph traversals | 0 |
| new DB queries | 0 |
| new source reads | 0 |
| minimum support slots | 2 |
| evaluation cost (ARC, measured) | 0.09 ms worst case, 0.01 ms mean |

## What this policy deliberately does not do

- It does not raise any score, add any edge kind, increase depth, broaden seed
  eligibility, or add potential callers.
- It does not key on `rescueScore > k`, which would merely recreate ranking under
  another name (§37).
- It does not name a repository, a symbol, or a gold file.
