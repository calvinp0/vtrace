# M140 — Import-edge attribution: root cause

## 1. The defect

M139 recorded a minimal reproduction: a file containing `from model import Thing`
and one function yields an `imports` edge; adding a **second, unrelated** function
to the same file drops it to **zero** edges.

Reproduced at product level (real indexer, persisted `edges` table):

| State | `importer.py` | imports edges |
| --- | --- | --- |
| A | `from model import Thing` + `def use()` | 1 — `app.py::use → model.py::Thing` |
| B | A + `def unrelated(): return 1` | **0** |

## 2. Root cause

`src/parsers/pythonParser.ts` (pre-M140, line 2416):

```ts
function getUnambiguousImportSourceSymbol(
  symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
  const topLevelSymbols = symbols.filter((s) => s.parentSymbolId === undefined);
  return topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined;
}
```

`extractImportEdges` calls this once and returns `[]` when it yields `undefined`.

So a file's **entire** import edge set was attributed to its single top-level
symbol, and existed **only** while the file had exactly one. This is not a span,
offset, or dedupe bug — it is an **ownership model with no stable owner**. Edge
existence was a function of how many definitions the file happened to contain,
which any unrelated edit can change.

Two aggravating properties:

- **The owner was already wrong in the passing case.** In state A the edge is
  attributed to the function `use`. A function does not import anything; its
  module does. The edge was an artifact of the file having one symbol.
- **The same rule governed the TARGET side.** `getPythonExportIndex` set
  `moduleSymbol: topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined`,
  so `import model` resolved only when `model.py` had exactly one definition.
  The destination was as unstable as the source.

The Cython parser carried a **byte-identical copy** of the helper
(`cythonParser.ts:1181`) and the same target-side rule, so both languages were
affected.

### Ruled out

The M140 spec lists candidate failure classes. Traced and excluded: source-span
ownership, nearest-symbol attribution, container range swallowing, definition
ordering, offset/span calculation, import-map mutation, symbol-ID collision,
post-processing overwrite, dedupe-key collision, and edge replacement during
persistence. None participate: the edges are never generated at all, because the
single early return fires before any resolution work happens.

## 3. Scale of the defect

Measured on ARC (257 indexed Python files):

| | Value |
| --- | --- |
| Files with exactly one top-level symbol (eligible to own import edges) | 49 / 257 (**19.1%**) |
| Persisted `imports` edges | 283 |
| Repo-internal file→file import relations actually present | 1,200 |
| File→imported-name pairs (upper bound on stable edges) | 2,324 |

**81% of ARC's Python files could not carry an import edge at all.** Any
consumer treating the import graph as complete was reading a graph missing ~8× its
own content. `ModuleConstant` / `ModuleVariable` / `ModuleAlias` are top-level
symbol kinds, so a file with one function *and one constant* already scored zero.

## 4. The fix — a structural module owner

Module-level imports are now owned by a per-file **module scope symbol**
(`SymbolKind.Module`, local name `<module>`), created in
`src/parsers/moduleSymbol.ts` and shared by both parsers.

Two properties are load-bearing:

1. **Fixed zero span.** `computeSymbolId` hashes `startByte`/`endByte`, so a
   body-sized span would change the module symbol's id — and every import edge id
   hanging off it — whenever the file changed length, reintroducing the exact
   instability being fixed. The span is pinned to byte 0 / line 1. It also keeps
   the symbol out of every span-containment lookup, so it can never swallow a
   real definition's range.
2. **Non-identifier name.** `<module>` cannot collide with a Python or Cython
   definition in any name-keyed index, so it is never resolved as a real
   top-level symbol and never becomes a call source.

The target side now resolves `import model` to `model.py`'s module scope, which
always exists.

### No schema change

`symbols.kind` is `TEXT NOT NULL` with **no CHECK constraint**
(`src/db/schema.ts:320`) — unlike `edges.edge_type`, which does have one. The new
kind therefore needs no migration and no schema version bump. **`index_schema_changed`
is neither fixed nor worsened by M140; M141 still owns readiness semantics.**

### Structural symbols are graph-visible, delivery-invisible

`isStructuralSymbolKind` (`src/domain/types.ts`) marks the boundary. Module symbols
are excluded from retrieval candidate generation (`EXCLUDE_STRUCTURAL_SYMBOLS_SQL`
applied to the plain-SQL, FTS, boundary, and path-signal candidate queries) and
from delivered impact nodes and relations. They remain fully visible to graph
consumers: expansion, `rerankGraph`, and any future upstream rescue.

## 5. Measured effect on the graph

ARC, same checkout, full rebuild:

| Edge kind | M139 | M140 |
| --- | --- | --- |
| `imports` | 283 | **2,281** (8.1×) |
| `calls` | 10,759 | 10,759 (unchanged) |
| `contains` | 5,960 | 5,960 (unchanged) |
| `references` | 2,618 | 2,618 (unchanged) |

Symbols after M140: 8,986, of which **273 are module symbols** — one per indexed
Python/Cython file. (The pre-M140 total was not separately captured; only the
module-symbol count is measured.)

That `calls`, `contains`, and `references` are byte-stable at scale is the
evidence for spec §25: the shared-owner fix did not retarget any other edge kind.

## 6. Consequences that are real semantic changes

These are **not** incidental test churn. Each is a behaviour change that follows
from correct attribution, and each is recorded rather than suppressed.

### 6.1 `rerankGraph` import-neighbour calibration (open finding)

`rerankGraph` weights an `importsNeighbor` signal (weight 6, cap 12). Under
correct attribution the **importer-side** contribution now lands on module
symbols, which are excluded from retrieval candidates. A function no longer
inherits its file's imports, so `diffuse_profile` in the mixed Python/Cython
fixture legitimately loses its `ImportsNeighborhood` signal.

The **target** side still gains: imported symbols accumulate import neighbours
from the modules that import them, and now from ~8× as many of them.

This is reported, not tuned. The corrected graph is authoritative. Whether the
existing import-neighbour weight remains well calibrated against a graph with 8×
the coverage and a re-homed importer side is a **ranking-semantics question that
M140 does not answer** — it requires the aggregate paired benchmark that this
milestone did not complete (§8 below). No weight was changed to preserve
historical metrics.

### 6.2 Logic flow no longer traverses function→import

A path from a *function* through its file's import edge no longer exists, because
the function never imported anything. The truthful path starts at module scope:
`caller.py::<module> —imports→ middle —calls→ leaf` is reachable, and asserted.

### 6.3 Impact: structural symbols are not consumers

Module symbols are excluded from impact discovery and from delivered direct
relations. Two effects:

- **Improvement.** The fan-in regression fixture delivered **32 of 40** real
  callers before M140, because each caller burned two slots of the 64-edge
  canonical cap on a redundant import+call pair naming the identical src/dst.
  It now delivers **all 40**.
- **Improvement.** The direct-relations path hydrated one endpoint per query.
  It is now a single batched prefetch: for an 80-caller symbol the impact query
  count fell from **88 to 9**, and it no longer scales with fan-in — the property
  the guarding test is named for, which it did not previously hold.
- **Known limitation.** A file that imports a symbol and never calls it now has
  no symbol-level impact representation, where before it did *if* it happened to
  contain exactly one definition. Import-only dependency is genuinely a
  file-level relation and the impact response is symbol-shaped. Recorded for
  M141 to consider as file-level import evidence; not papered over here.

## 7. Verification

- `bun test` — **3,945 pass, 49 skip, 0 fail**
- `bun run typecheck`, `bun run typecheck:benchmarks` — clean
- `git diff --check` — clean
- `src/parsers/importAttributionStability.test.ts` — 125 new product-level tests
- Guard validation: the same suite run unchanged against M139 (`340fd9c`) gives
  **28 pass / 97 fail**, so it discriminates rather than passing vacuously.

## 8. What this document does NOT establish

The aggregate M139→M140 paired benchmark (frozen 50, Django expanded,
cross_repo_30) was **not run**. The ~8× import-edge expansion therefore has **no
measured aggregate retrieval effect**, and the §6.1 calibration question is open.
No aggregate quality claim is made.
