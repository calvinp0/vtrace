# M140 — Graph Attribution Stability and Bounded Upstream Rescue

**Overall verdict: INCOMPLETE (Workstream A PASS, Workstream B not implemented).**

Workstream A — import-edge attribution stability — is root-caused, fixed, and
gated with 125 new product-level tests. Its acceptance checkpoint (§26) is met in
full.

Workstream B — bounded upstream/orchestration rescue — was **not implemented**,
and the mandatory aggregate paired benchmark (§61) was **not run**. M140's PASS
criteria (§112) require both, so M140 is not a PASS. Nothing in this report
claims otherwise.

This is a scope outcome, not a blocker: §113's stop condition (Workstream A
cannot be made trustworthy) does **not** apply. A is trustworthy, and the
groundwork proving B is feasible is recorded below.

- Starting commit: `4cf4946911c2123ced4368e33c21377a39318843` (M139 evidence)
- M139 functional predecessor: `340fd9c6905125ac3942f622c85a9508ddc8cda4`
- Branch: `main`. **M140 is not pushed.**
- Branch state confirmed at start: **2 ahead / 0 behind** `origin/main` — matching
  the prompt, and consistent with M139's correction that origin already contained
  M138.

**M139 remains MIXED.** Nothing here rewrites that record; M140 does not close
M139's orchestration-visibility gap, because that gap belongs to Workstream B.

---

## 1. Workstream A — verdict PASS

Full detail: `stage5_m140_graph_attribution_root_cause.md`.

### 1.1 Root cause

A file's **entire** import edge set was attributed to its single top-level symbol
and emitted only while the file had exactly one:

```ts
// pythonParser.ts:2416 (pre-M140), duplicated verbatim at cythonParser.ts:1181
return topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined;
```

Not a span, offset, or dedupe bug — an **ownership model with no stable owner**.
Edge existence depended on how many definitions a file happened to contain. The
same rule governed the target side, so `import model` resolved only when
`model.py` had exactly one definition.

Even the "working" case was wrong: the edge was owned by a *function*, which
imports nothing.

### 1.2 Scale

On ARC, only **49 / 257 (19.1%)** of Python files could own an import edge, giving
283 edges against 2,324 real file→imported-name pairs. **81% of files carried no
import edge at all.**

### 1.3 Fix

A per-file structural module symbol (`SymbolKind.Module`, `<module>`) owns
module-level imports, shared by both parsers via `src/parsers/moduleSymbol.ts`.
Its span is pinned to byte 0 so its id — and every edge id hanging off it — cannot
drift when the file changes length. Its name cannot collide with a real
definition.

Structural symbols are **graph-visible, delivery-invisible**: excluded from
retrieval candidates, lexical ranking, and delivered impact nodes/relations;
fully visible to graph expansion, `rerankGraph`, and impact traversal.

**No schema change.** `symbols.kind` has no CHECK constraint, so no migration and
no version bump. The known `index_status` / `index_schema_changed` contradiction
is **untouched** — M141 still owns readiness.

### 1.4 §26 checkpoint

| Gate | Result |
| --- | --- |
| Minimal defect reproduced | PASS — 1 edge → 0 edges, product level |
| Root cause identified | PASS — single early return, both parsers |
| Unrelated edit no longer changes the edge | PASS — identical endpoints |
| Semantic import changes still alter the edge | PASS — retarget/remove/add controls |
| Full vs incremental equivalence | PASS — incl. retargeting edit and no-op |
| Existing Python import-resolution tests | PASS — full suite green |
| M139 caller truthfulness preserved | PASS — all `src/impact` tests green |

### 1.5 Import attribution table (§101)

| Fixture mutation | M139 edge | M140 edge | Expected | Result |
| --- | --- | --- | --- | --- |
| baseline `from model import Thing` | `use → Thing` | `<module> → Thing` | stable owner | PASS |
| + unrelated function | **none** | `<module> → Thing` | unchanged | PASS |
| + unrelated class | **none** | `<module> → Thing` | unchanged | PASS |
| + unrelated constant | **none** | `<module> → Thing` | unchanged | PASS |
| definition reordered | varies | `<module> → Thing` | unchanged | PASS |
| import target changed `a`→`b` | varies | `<module> → b.py::Thing` | **changes** | PASS |
| local shadow / module rebind | varies | `<module> → Thing` | import unchanged; no call edge to the shadowed name | PASS |

Covered across all six import forms (from-import, module-import, both alias
forms, relative, `__init__` re-export) × nine unrelated additions × two insertion
positions = 108 combinations, plus controls. Full matrix:
`stage5_m140_import_metamorphic_matrix.json`.

### 1.6 Guard validation

The new suite run **unchanged** against M139 (`340fd9c`) gives **28 pass / 97
fail**. It discriminates; it is not vacuously green.

---

## 2. Measured graph effect

ARC, same checkout, full rebuild:

| Edge kind | M139 | M140 |
| --- | --- | --- |
| `imports` | 283 | **2,281** (8.1×) |
| `calls` | 10,759 | 10,759 |
| `contains` | 5,960 | 5,960 |
| `references` | 2,618 | 2,618 |

`calls` / `contains` / `references` being byte-stable at scale is the §25 evidence
that the shared-owner fix retargeted no other edge kind.

---

## 3. Deliberate behaviour changes (not incidental churn)

### 3.1 `rerankGraph` import-neighbour calibration — OPEN FINDING

The corrected edges are authoritative and flow to `rerankGraph` unchanged; no
weighting was altered to preserve historical metrics.

Consequence: the **importer-side** import signal now lands on module symbols,
which are excluded from retrieval candidates, so a function no longer inherits
its file's imports. The **target** side still accrues import neighbours, now from
~8× as many importers.

Whether the existing weight (6, cap 12) is still well calibrated against a graph
with 8× coverage and a re-homed importer side is a **ranking-semantics question
M140 does not answer.** It needs the aggregate paired benchmark, which was not
run. Reported honestly; deliberately not tuned.

### 3.2 Impact — two improvements and one limitation

- **Fan-in delivery improved.** 32 → **40 of 40** real callers delivered under the
  same 64-edge cap: each caller previously burned two slots on a redundant
  import+call pair naming the identical src/dst.
- **Impact query count no longer scales with fan-in.** Batched the direct-relations
  prefetch: an 80-caller symbol went from **88 queries to 9**. The guarding test
  is named for this property and did not previously hold it.
- **Limitation.** A file that imports a symbol and never calls it now has no
  symbol-level impact representation (before, it did *if* it contained exactly one
  definition). Import-only dependency is a file-level relation; the impact
  response is symbol-shaped. Recorded for M141.

### 3.3 Logic flow

A path from a *function* through its file's import no longer exists — the function
never imported anything. The truthful module-scope path is asserted instead.

---

## 4. Workstream B — NOT IMPLEMENTED

No upstream rescue lane, seed rules, budgets, diagnostics, fixtures, or ARC
serialization acceptance exist. The ARC orchestration-visibility gap M139 left
open **remains open**.

What M140 does contribute is the decisive feasibility evidence
(`stage5_m140_arc_upstream_path.json`), gathered from a fresh ARC index:

```
ARCSpecies.from_dict  --calls-->  ARCSpecies.mol_from_xyz  --calls-->  perceive_molecule_from_xyz
```

Both edges are **present**. §114's failure mode ("the graph genuinely lacks the
path") does **not** apply — this is a candidate-generation problem, exactly as
M139 concluded.

Calls-only incoming degree, which directly sizes the §37/§44 bounds:

| Symbol | calls fan-in |
| --- | --- |
| `perceive_molecule_from_xyz` (the retrieved seed) | **62** |
| `ARCSpecies.mol_from_xyz` | 3 |
| `ARCSpecies.from_dict` | 1 |

So the downstream tail is precisely the high-fan-in seed §44 requires be
suppressed or strictly top-bounded, while the two upstream hops are cheap. A
depth-2 walk with a per-seed cap recovers `from_dict` without flooding.

Not established: `mol_from_xyz → are_coords_compliant_with_graph` and
`from_dict → are_coords_compliant_with_graph` have **no** direct calls edge in the
current index, so §46's list should not be assumed whole.

---

## 5. Not run, and therefore not claimed

- **The aggregate M139→M140 paired benchmark** (frozen 50, Django expanded,
  cross_repo_30) — §61's mandatory gate. Setup was attempted: an M139 worktree at
  `340fd9c` was created and `run_stage5_m134_prepare_targets.ts` was invoked, but
  the scratch filesystem (32G tmpfs) hit its quota copying Django checkouts. It is
  runnable on the root filesystem (675G free), but indexing ~40 Django checkouts
  per side is a multi-hour job that could not be completed and interpreted here.
  **No aggregate quality claim, no changed-case ledger, no retrospective M139
  metrics, no latency comparison.**
- ARC serialization query before/after; M135/M137 dihedral preservation; M136
  3000-token delivery; M138 memory freshness; M131 flow and M132 worktree
  acceptance as standalone runs; TCKDB same-checkout acceptance. M131/M132 and the
  M138 observation paths are covered only insofar as the full unit suite exercises
  them, which it passes.

Safety: no live agents, no Docker, no VEXP, no paid APIs, no network. ARC was read
only, indexed into a temporary database.

---

## 6. Verification

```
bun test                       3,945 pass · 49 skip · 0 fail
bun run typecheck              clean
bun run typecheck:benchmarks   clean
git diff --check               clean
```

New: `src/parsers/importAttributionStability.test.ts` (125 product-level tests).
Load average was 4–16 on a 20-core machine during the passing runs; no
resource-starvation failures were observed or reclassified.

---

## 7. Files changed

`src/domain/types.ts` (`SymbolKind.Module`, `isStructuralSymbolKind`),
`src/parsers/moduleSymbol.ts` (new), `src/parsers/pythonParser.ts`,
`src/parsers/cythonParser.ts`, `src/parsers/cythonExports.ts`,
`src/impact/getImpactGraph.ts`, `src/retrieval/searchSymbols{,Fts,Shared}.ts`,
plus expectation updates in eight test files and
`src/testing/mixedPyCythonFixture.ts`.

Artifacts: `stage5_m140_import_edge_repro_before_after.json`,
`stage5_m140_import_metamorphic_matrix.json`,
`stage5_m140_import_full_incremental_equivalence.json`,
`stage5_m140_graph_attribution_root_cause.md`,
`stage5_m140_arc_upstream_path.json`.

---

## 8. Recommendation

Continue M140 rather than opening M141. In order:

1. **Run the paired benchmark first**, on the root filesystem, before any further
   behaviour work. It is the only thing that can answer whether the 8× import
   expansion helps, is neutral, or regresses aggregate retrieval — and whether the
   §3.1 import-neighbour weight is still calibrated. Attribute every changed case
   as `import_attribution_fix`.
2. **Then implement bounded upstream rescue** against the confirmed ARC chain,
   using the measured fan-in profile (62 / 3 / 1) to set the seed-eligibility rule
   and per-seed cap.

M141 (index readiness, `index_repo` bloat, `memoryRulesMs`) remains untouched and
correctly deferred.
