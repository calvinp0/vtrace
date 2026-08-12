# M141 — Index readiness and indexing-path hygiene: final report

**Overall verdict: PASS**

M140 established that VTRACE can reason truthfully about code. M141's job was
to make it reason truthfully about *whether the data behind that answer is
usable*, and to stop the evaluation infrastructure from corrupting the evidence
it validates. Both hold. No M140 retrieval semantics moved.

| Workstream | Verdict |
| --- | --- |
| A — readiness truthfulness | **PASS** |
| B — `index_repo` response boundedness | **PASS** |
| C — `memoryRulesMs` | **PASS** |
| D — benchmark path hygiene | **PASS** |
| E — preservation provenance | **PASS** |

## Commits

Local, on `main`, nothing pushed, no co-author trailers.

```text
8d09848  Unify index readiness evaluation and bound indexing responses
b5a7a92  Make memory-rule evaluation bounded per request
86c4cb0  Make benchmark output paths safe and preservation claims provenance-aware
96d64d9  Extend the safe output contract to every tracked-by-default runner
b3d14a3  Record M141 validation evidence and close M141 as PASS
```

Starting point, resolved rather than assumed:

```text
M140-C functional  4172a26378b41734dc7f3176997f527619a93d60
                   c267816999ce73664ccceba5bcc71892681c05dc
M140 close         249f61feabf26ee183d500a8ffb761e2c3ac09e6
```

`249f61f` is the functional predecessor used for every paired measurement: it
is `c267816` plus evidence-only files, and it is the earliest commit carrying
the M140-C acceptance runner needed to measure both sides with one harness.

---

## A — Readiness truthfulness

### The defect, reproduced on both sides

```text
scenario: source unchanged; VTRACE's indexer/parser build moved

predecessor 249f61f
  index_status        state=fresh  isStale=false  "No re-index is recommended right now."
  get_code_context    resolved=false  reason=index_schema_changed
  contradiction       TRUE

candidate 96d64d9
  index_status        state=possibly_stale  isStale=true
                      "Rebuild this repo's index (`index_repo` with mode `full`)…"
                      reasons=[index_schema_incompatible]
                      indexReadiness={ready:false, state:schema_incompatible,
                                      reason:schema_changed, action:full_rebuild,
                                      sourceFresh:true, schemaCompatible:false}
  get_code_context    resolved=false  reason=index_schema_changed
  contradiction       FALSE
```

Two independent models answered one question. `index_status` compared the
target repository's source snapshot; the product tools additionally compared
VTRACE's own indexer, parser, schema, and config fingerprints. Editing
`src/indexer` invalidates an index without touching the indexed repository, so
one model saw nothing changed and the other saw everything changed.

### Readiness state matrix

Ten states, every dimension evaluated — nothing short-circuits, which is what
makes `sourceFresh=true, schemaCompatible=false` expressible at all.

| Case | srcFresh | schema | capability | repo | worktree | ready | reason | action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| current ready index | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | `fresh` | `none` |
| source changed (new HEAD) | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | `head_changed` | `incremental_refresh` |
| dirty source changed | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | `dirty_fingerprint_changed` | `incremental_refresh` |
| schema incompatible | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | `schema_changed` | `full_rebuild` |
| newer unsupported schema | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | `schema_unsupported` | `unsupported_runtime_upgrade` |
| capability missing (required) | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | `capability_missing` | `full_rebuild` |
| wrong repository | — | — | — | ✗ | — | ✗ | `wrong_repository` | `inspect_index` |
| wrong worktree | — | — | — | ✓ | ✗ | ✗ | `wrong_worktree` | `inspect_index` |
| missing index | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `index_missing` | `full_rebuild` |
| unreadable / corrupt index | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `index_unreadable` | `full_rebuild` |

Notes that matter:

- **`source_stale` never recommends a full rebuild.** The incremental planner
  resolves it; recommending a rebuild would be slower *and* untrue.
- **`schema_unsupported` is not a rebuild.** An index written by a newer
  runtime cannot be fixed by re-indexing with an older binary — that would
  produce a readable index that silently discarded what the newer one recorded.
- **A corrupt index is not a stale index.** It gets its own state and fails
  safely rather than being misreported as drift.
- **The scan-config hash is a source input, not a schema one.** It governs
  which files are in scope, so a change means the indexed *set* may no longer
  match the requested source state. Its action stays `incremental_refresh`,
  exactly as before M141.

### Cross-tool parity

Ten states × six surfaces, **0 disagreements**.

| Surface | Policy | Behavior on a not-ready index |
| --- | --- | --- |
| `index_status` | authoritative | `ready:false` + state/reason/action |
| `get_code_context` | `fail_closed` | stale envelope, same reason code |
| `get_context_capsule` | `fail_closed` | product context `resolved:false`, same reason |
| `run_pipeline` | `fail_closed` | product context `resolved:false`, same reason |
| `get_impact_graph` | `serve_with_warning` | bounded static evidence (M131 older-index contract) |
| `search_logic_flow` | `serve_with_warning` | bounded static evidence (M131 older-index contract) |

Tools agree on the **verdict**; they differ in the **policy** they apply to it,
and that difference is declared rather than discovered. Changing the two
evidence tools to fail closed would alter frozen M140 behavior for no
correctness gain, so M141 did not.

One capability difference is explicit and expected: an index missing
`edge_call_sites` is `capability_incompatible` for a request that declares it
needs call-site evidence and `ready` for every current product tool, because no
product tool declares that requirement. That is §14's own acceptable case, and
the matrix records it as a `capabilityDifference` rather than a disagreement.

### Post-index self-consistency

`index_repo` → `index_status` → every product tool, on a repository whose index
was schema-incompatible beforehand:

```text
before rebuild   index_status ready=false  state=schema_incompatible
index_repo       ok, indexReadiness.ready=true, state=ready
after rebuild    index_status ready=true, isStale=false
                 all five product tools serve the index
```

`index_repo` does not construct its own optimistic success status; it runs the
same evaluator.

### No schema bump

Readiness is derived entirely from metadata that already existed. M140
deliberately avoided a bump for `symbols.kind = module` because the DB allowed
it; M141 adds no version churn either. M140's structural modules are
deliberately *not* modelled as a capability — with no schema bump there is no
truthful cheap probe distinguishing "index predates M140" from "this repository
has no module-scope imports", and a flag that lies on small repositories is
worse than no flag.

---

## B — `index_repo` response boundedness

A normal successful run on a 290-file repository:

| | before | after |
| --- | ---: | ---: |
| response bytes | 26,797 | **3,023** |
| estimated tokens | ~6,700 | **~756** |
| detailed outcomes delivered | 290 | 0 |
| detailed outcomes omitted | 0 | 0 |
| files total / indexed / updated / unchanged / removed / skipped / failed | 290 / 290 / 0 / 290 / 0 / 0 / 0 | identical |

Counts are exact; only presentation moved. The index database, manifest, symbol
and edge counts, and the internal per-file outcome records are untouched.

### Scale

| files | response bytes | est. tokens |
| ---: | ---: | ---: |
| 10 | 446 | 112 |
| 300 | 451 | 113 |
| 3,000 | 456 | 114 |
| 30,000 | 461 | 116 |

Fifteen bytes of growth across three orders of magnitude — the digits in the
counts themselves. The whole serialized response is measured, not a bounded
component of it (the M130/M133 lesson).

### Failure visibility

Failures are never displaced by warnings, and neither is displaced by ordinary
successes. With 3,000 successes and 250 parse failures: `failed` is exactly 250,
20 are delivered, 230 are reported as omitted with a per-status breakdown, and
the note says what was summarized rather than listed. `detail: "debug"` raises
the cap to 500 — larger, still bounded, because "unbounded" is how the
290-entry response happened in the first place.

---

## C — `memoryRulesMs`

### Root cause

Not memory classification. `getObservationStaleness` took its comparison run
from a **default parameter**, so it re-queried the latest index run once per
observation, then re-walked the entire index-run chain per observation —
materializing every run's file and symbol run-state tables again each time. On
the real ARC index that is 35 observations × 7 run steps × ~17k rows, roughly
4M rows loaded to answer a question whose answer is identical for every
observation sharing a source run.

Measured decomposition: `searchMemory` is essentially all of `memoryRulesMs`;
project-rule selection is 0.1 ms and 5 queries.

### Before / after, real ARC index, 35 observations

| | before (249f61f) | after (86c4cb0) |
| --- | ---: | ---: |
| cold | 6,869 ms | 349 ms |
| median | 6,787 ms | **337 ms** |
| p90 | 6,901 ms | 349 ms |
| DB queries | 1,309 | **184** |
| project-rule selection | 0.1 ms | 0.1 ms |
| classification result | — | **byte-identical** |

20× on latency, 7× on queries. Three exact changes: the comparison head is
resolved once per request; a request-local memo holds each run's diffs (they
depend on the run id, never on the observation); each memoized step carries
lookups keyed the way observation links are matched, replacing a scan of
thousands of symbol diffs per link. Staleness is also no longer resolved for
observations that cannot survive scoring — every other signal contributes a
non-negative score and the stale penalty only subtracts, so those are discarded
either way.

### Scaling shape

A property test over 1 / 10 / 40 observations shows run-chain discovery growing
by **< 4 queries per observation** (it was ~37 before). Listing the observations
is legitimately O(N); the expensive external discovery behind them is not.

### What remains

~295 ms of the 337 ms is the one-time run-chain diff itself, measured
independently. That is what M138 freshness is *defined* as, and it is not
avoidable without changing the semantics — so it is reported rather than
optimized away. No process-global cache was introduced; the memo is
request-local and caller-owned, because a global one would outlive the index it
describes and break M114/M138 freshness.

---

## D — Benchmark and workspace hygiene

201 runners audited. The pattern was searched for, not fixed only where it was
observed: 6 runners were seen misbehaving during M140, and the audit found 19
more writing tracked evidence by default.

| | before | after |
| --- | ---: | ---: |
| runners on a shared output contract | 0 | **26** |
| runners writing tracked evidence by default | 25 | **2** |
| tracked evidence mutated by a preservation run | yes | **no** |
| large scratch state configurable off `/tmp` | no | **yes** |

The remaining two (`run_stage5_m48_ruleout_sufficiency_validator.ts`,
`run_stage5_m49_ruleout_sufficiency_checker.ts`) read raw run artifacts from
`results/runs/` as *input* as well as writing there. Retrofitting them
mechanically would break their input path, they are pre-M100 live-agent audit
tooling outside the M134–M140 preservation band, and they cannot be exercised
without live agents. They are left unchanged and recorded here rather than
silently retrofitted.

### Contract

```text
output:     --out <dir>  >  --evidence  >  $VTRACE_BENCH_OUT  >  untracked run dir
workspace:  --workspace-root <dir>  >  $VTRACE_BENCH_WORKSPACE  >  $TMPDIR  >  os.tmpdir()
```

A caller-provided `TMPDIR` is respected, never overridden. No machine-specific
path is committed — a test asserts `/home/calvin` does not appear in the
contract module. Ordinary runs cannot masquerade as evidence generation, and
the archive-then-restore workflow that silently reverted the M140-C acceptance
artifact is no longer needed for any normal run.

The value of this showed up immediately during M141's own validation: the
predecessor's M137 smoke died with `EDQUOT` copying a 505 MB index into the
32 GB `/tmp` tmpfs, and had to be re-run with `TMPDIR` redirected. The candidate
run of the same smoke resolved its workspace through the new contract and never
touched `/tmp`.

### Immutability gate

A test snapshots the SHA-256 of every tracked file under `results/`, runs a
representative preservation command, and asserts the hashes are unchanged —
plus `git status --porcelain` over that directory, where the only permitted
entries are the two pre-existing outcome-ledger files.

---

## E — Preservation provenance

M140-C recorded M132 as 20/21. The failing row demanded a strict query
reduction against a baseline that already contained the batching it was
preserving:

```text
34 -> 34 queries for 40 dependents
queryReduction: 0
semanticEquivalence: identical_dependent_set_size
```

That is the correct unchanged result. The row was unsatisfiable by
construction. The problem is not the number 34 — it is that a preservation
check did not know what kind of claim it was making, or whether its baseline
predated the change it asserts.

| Check | Baseline implementation | Baseline contains change? | Declared | Effective | Old | New |
| --- | --- | --- | --- | --- | --- | --- |
| `impact_hydration_batched` | `7093e2d` | **yes** (9260d37 is an ancestor) | `less_than` | `less_or_equal` | FAIL (34→34 read as a missing reduction) | **PASS** (34→34 read as preserved) |

Assertion kinds are now explicit — `absolute_correctness`,
`historical_improvement`, `non_regression`, `equivalence`, `boundedness`,
`capability_presence` — and only `historical_improvement` is provenance
sensitive. Ancestry against the commit that introduced the change decides it.
Against a pre-change baseline the strict reduction still gates (tested).
Unknown ancestry fails closed rather than granting the relaxation (tested). A
real regression still fails against a post-change baseline (tested).

**M132 smoke: 21/21 PASS.** No product flow code was changed to reach it.

The committed M140-C artifacts are left as written. This report records why the
old assertion is no longer valid rather than rewriting the history that
recorded it.

---

## M140 preservation

ARC fixture `/home/calvin/bench/vtrace-m140/m140c/arc-fresh.sqlite`, unchanged:

```text
files 324   symbols 8,986   edges 21,618   imports 2,281   structural <module> symbols 273
```

Exactly the M140 expectation.

**M140-C acceptance: 28/28 PASS on the candidate, 28/28 PASS on the
predecessor.** Artifact-by-artifact diff of the two runs:

| Artifact | Result |
| --- | --- |
| `stage5_m140c_arc_selection_trace.json` | byte-identical |
| `stage5_m140c_budget_behavior.json` | byte-identical |
| `stage5_m140c_generic_orchestration.json` | byte-identical |
| `stage5_m140c_negative_controls.json` | byte-identical |
| `stage5_m140c_preservation.json` | byte-identical |
| `stage5_m140c_acceptance.json` | timing + `vtraceHead` only |
| `stage5_m140c_activation_summary.json` | timing only |
| `stage5_m140c_arc_before_after.json` | timing only |
| `stage5_m140c_performance.json` | timing only |

Key rows, identical on both sides:

- `ARCSpecies.from_dict` delivered as `orchestration_support`, ordinary rank
  **93/132**, ordinary score **0.9749** — not inflated, not lead.
- `mol_from_xyz` delivered; `perceive_molecule_from_xyz` delivered; branch
  evidence retained; `contrastKind=alternative_branches`.
- Max one path-completion item across 11 requests; 1/11 activation.
- 0 structural `<module>` leaks across 5 queries; 273 structural symbols, 0 in
  the centrality metric.
- M136 budget delivery, M137 direct answer (`get_dihedral` lead, penalty 0.28,
  0 path-completion items), M139 impact truthfulness, M131 flow — all preserved.

One difference from the *committed* M140-C artifact deserves naming:
`arc_entry_point_not_lead` records `lead=ARCSpecies` there and
`lead=are_coords_compliant_with_graph` in both runs here. That artifact was
generated at `4172a26`, before `c267816` dropped the support twin a path
completion replaces. The difference predates M141, and the predecessor run at
`249f61f` reproduces the candidate's value exactly.

### M139 impact, measured directly

`ARCSpecies.copy` through `getImpactGraph` on both implementations:
**byte-identical**. Exact and potential callers stay separate
(`exactCallerCount: 0`, `potentialCallerCount: 63`, 10 delivered, 53 omitted),
coverage status is truthfully `incomplete` with its reason codes, false
positives remain excluded, and the response stays bounded.

### M138 memory

`searchMemoryDetailed` over five queries plus staleness and compatibility for
every one of the 35 observations in the real ARC index, dumped canonically:
**274,717 bytes, byte-identical** between predecessor and candidate.

The standalone M138 smoke crashes with
`TypeError: undefined is not an object (evaluating 'normal.results[0].observation')`
— **identically on the M140 predecessor**, at the identical line. Pre-existing,
exactly as the milestone anticipated. Not an M141 regression.

### M132 worktree routing

M132 smoke 21/21 PASS, including nested-worktree exclusion, correct requested
worktree, wrong-worktree fail-closed, and refresh isolation.

### TCKDB

`/home/calvin/code/TCKDB_v2` @ `1896a855`, read-only. (The brief quoted
`main@b91f69e`; the current intended fixture on this machine is `1896a855`, and
the measured identity is what is recorded.) Same-checkout predecessor/candidate
acceptance: **0/4 changed on both sides**, `leadChanged=false` and
`selectionChanged=false` for every case. **0 retrieval-semantic changes.**

---

## Known limitation: M137 standalone smoke

`M137 smoke: FAIL; ARC lead=get_dihedral; 3000=false` — **identically on the
predecessor**, with identical budget rows.

Cause: the runner drives `get_code_context` against `/home/calvin/code/ARC`
with `auto_refresh: "never"` while supplying a copied index. That checkout has
drifted since it was indexed, so the shared product-context layer fails closed
and no budget row can resolve on this machine. The direct-answer row it exists
to protect **passes** (`ARC lead=arc/species/vectors.py::get_dihedral`), and the
M136 budget behavior it duplicates passes in the M140-C acceptance, which reads
the fixture index directly.

Pre-existing and environmental, not an M141 regression. It is the same *class*
of problem Workstream E addresses — a preservation check whose precondition no
longer holds — and it is a natural first candidate for M142-era harness work.

---

## Paired retrieval comparison

M141 is not a ranking milestone, but it touches shared request plumbing, so the
provenance-safe paired protocol was run: each side loads its declared
implementation against its own independently prepared index over the same
immutable target corpus.

```text
predecessor  /home/calvin/bench/vtrace-m141/pred @ 249f61f (M140-C functional)
candidate    /home/calvin/code/vtrace @ 96d64d9
```

**Frozen 50 (Django expanded 20 + cross_repo_30): `provenanceValid=true`,
`0/50 changed cases`.**

| Metric | predecessor | candidate |
| --- | ---: | ---: |
| cases / evaluated | 50 / 50 | 50 / 50 |
| Top-1 gold file | 39 | 39 |
| Top-3 gold file | 44 | 44 |
| gold file anywhere | 47 | 47 |
| gold symbol anywhere | 31 | 31 |
| missing gold | 3 | 3 |
| mean pivots | 2.10 | 2.10 |
| mean support | 3.88 | 3.88 |
| mean estimated tokens | 1806.44 | 1806.44 |

Per suite: django `valid=true changed=0/20`, cross_repo `valid=true
changed=0/30`. Every metric is identical, and identical to M140-C's frozen-50
figures. No unexplained retrieval-semantic change.

### Static corroboration

Not one file under `src/retrieval`, `src/capsuleV2`, `src/capsule`, `src/graph`,
`src/parsers`, `src/impact`, `src/logicFlow`, or `src/db` was touched by M141.
The whole diff is `src/indexer` (readiness + outcome summary), `src/mcp/tools.ts`
plumbing, `src/runtime` status/freshness, one import line in
`src/productContext`, and `src/observations` staleness/search.

The one retrieval-adjacent change is `searchMemory`, because memory items reach
product context — and that path is proven byte-identical over 274,717 bytes of
canonical verdicts on the real ARC index.

Field changes that are intentional and are **not** retrieval movement:
`indexReadiness` blocks, reconciled `freshness.state`/`isStale`/
`recommendedAction`/`reasons` on status surfaces, and `index_repo`'s bounded
`fileOutcomes` plus its new `outcomes` block.

## Verification

```text
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun test                       4170 pass / 0 fail / 49 skip, 253 files
git diff --check               clean
```

New tests added by M141: 50 across 6 files — readiness states (16), bounded
indexing outcomes (7), cross-tool parity (4), memory-rule scaling and
equivalence (3), the output/workspace contract (11), preservation-assertion
provenance (9).

Repository hygiene: the only modified tracked files outside M141's own work are
`stage5_outcome_ledger.{json,md}`, which were dirty before M141 started and
were not staged.

No live agents, no paid APIs, no Docker, no VEXP, no network-dependent
evaluation was used at any point.

---

## Recommended M142 scope

M141 makes single-repository readiness and lifecycle truthful, which is the
precondition M142 needed. Carry forward:

- **Workspace and repository identity.** A workspace identity distinct from the
  repository identities under it; repository-scoped indexes addressable from
  one workspace; readiness evaluated per repository and aggregated without
  ambiguity. The readiness object is already per-repository and already routed
  through workspace repo status, so the aggregation point exists.
- **Cross-repository query routing** and workspace-level candidate provenance,
  built on the identity model rather than on path heuristics.
- **Harness precondition declarations.** The M137 limitation above is a
  preservation check with an unstated environmental precondition, which is the
  same failure mode Workstream E fixed for baseline provenance. Extending the
  assertion model to cover fixture preconditions would convert that FAIL into
  an honest `skipped: precondition_unmet`.
