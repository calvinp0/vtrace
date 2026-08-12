# M140 continuation — Workstream-A paired benchmark

**Verdict: M140 overall remains INCOMPLETE.** The mandatory paired benchmark is now
run and fully attributed, and Workstream A is corrected and re-frozen — but
Workstream B (bounded upstream rescue) is not implemented, which §94 defines as
INCOMPLETE regardless of how Workstream A scores.

| area | verdict |
|---|---|
| Workstream A retained correctness | **PASS (after correction)** |
| M139→M140-A paired benchmark | **PASS — run, provenance-valid, authoritative** |
| import-change attribution | **PASS — 24 changed, 0 unexplained** |
| rerankGraph calibration | **PASS — audited; weights unchanged; a distinct defect found and fixed** |
| module-node retrieval invisibility | **FAIL at inherited A1 → PASS at A6** |
| source-side signal semantics | PASS |
| target-side import fan-in semantics | PASS |
| aggregate retrieval quality | MIXED — Top-1 at parity, Top-3 −1 (truthful) |
| type safety / hygiene | PASS |
| Workstream B | **NOT IMPLEMENTED** |
| second paired benchmark | NOT RUN (nothing to compare yet) |

---

## 1. Authoritative state

| ref | commit |
|---|---|
| M139 functional (declared predecessor) | `340fd9c6905125ac3942f622c85a9508ddc8cda4` |
| M140-A1 functional (inherited) | `c79346825e0f952051815dc9130dd5227605138d` |
| M140-A1 evidence | `fdeee59aaf7a545ddcf7db50292daff6dd610d51` |
| M140-A2 | `828af6e` keep module scopes out of broad query candidates |
| M140-A3 | `f351716` exclude structural scopes from dependent-symbol centrality |
| M140-A4 | `c995d17` keep module scopes out of graph expansion candidates |
| M140-A5 | `9afecd7` reject structural scopes at hybrid candidate admission |
| M140-A6 | `6a6e922` deliverable representative for generated artifact pairs |

Branch `main`, committed locally, **not pushed**. At session start the branch was
4 ahead / 0 behind `origin/main` — consistent with M138 already being upstream,
and NOT the historically false "14 ahead / nothing ever pushed".

The two pre-existing dirty files (`stage5_outcome_ledger.json/.md`) were left
untouched. No M134–M139 ledger rows were fabricated.

## 2. Benchmark workspace

The earlier attempt died on the 32G `/tmp` tmpfs (7.1G free). This run used
`/home/calvin/bench/vtrace-m140` on the 1.8T root filesystem (673G free). Only
`--out-root`/`--vtrace-root` paths changed; no benchmark semantics were altered.
Details in `stage5_m140a_benchmark_workspace.json`.

`node_modules` is shared between implementation worktrees. This is provenance-safe
by content: `package.json` and `bun.lock` are byte-identical across `340fd9c`,
`c793468`, and HEAD (compared by git object hash), so the dependency closure
cannot differ between sides.

A2–A6 reuse the A1-built indexes. Justified two ways: `git diff c793468 6a6e922`
touches no `parsers/`, `indexer/`, or `db/` source, and a fresh index built under
A2 reproduced **byte-identical** symbol+edge content hashes for both smoke repos.
Predecessor and candidate never share an index.

## 3. Retrospective labelling — §11

M139 never completed the aggregate benchmark. The predecessor numbers here are a
**M140 retrospective replay of M139**, not an M139-measured result. M139's own
verdict remains MIXED and is not rewritten.

## 4. Three-state aggregate

Case counts, out of suite size.

| suite | metric | M139 replay | M140-A1 | M140-A6 |
|---|---|---:|---:|---:|
| Django expanded (20) | Top-1 gold | 18 | 17 | **18** |
| | Top-3 gold | 20 | 19 | **20** |
| | gold anywhere | 20 | 20 | 20 |
| | missing gold | 0 | 0 | 0 |
| | changed cases | — | 9 | 5 |
| cross_repo_30 (30) | Top-1 gold | 21 | 20 | **21** |
| | Top-3 gold | 25 | 25 | 24 |
| | gold anywhere | 27 | 27 | 27 |
| | missing gold | 3 | 3 | 3 |
| | changed cases | — | 25 | 19 |
| **Frozen 50** | **Top-1 gold** | **39** | **37** | **39** |
| | **Top-3 gold** | **45** | **44** | **44** |
| | gold anywhere | 47 | 47 | 47 |
| | gold symbol anywhere | 31 | 31 | 31 |
| | missing gold | 3 | 3 | 3 |
| | changed cases | — | 34 | 24 |

Top-1 is back at M139 parity. Top-3 is one case short, and that case is the
truthful `sympy-12419` regression documented in
`stage5_m140a_rerank_graph_attribution.md` §5. Gold recall and missing-gold are
flat throughout: nothing fell out of context.

## 5. Import-change table — §85

| | M139 | M140-A |
|---|---:|---:|
| ARC import edges (from M140-A1 evidence) | 283 | 2,281 |
| ARC files able to own imports | 49 / 257 (19.1%) | all |
| sympy-12419 import edges (this run) | 988 | 9,603 |
| sympy-12419 `calls` | 26,007 | 26,007 |
| sympy-12419 `contains` | 11,398 | 11,398 |
| sympy-12419 `references` | 12,249 | 12,249 |
| sympy-12419 module symbols | 0 | 1,116 (1,117 files) |

The narrow-correction claim reproduces on a repo outside the original evidence:
imports grow 9.7×, every other edge kind is byte-identical.

## 6. Four defects the benchmark exposed

The inherited A1 was not as clean as its ledger row claimed. All four are
regression-tested, and each test was verified to FAIL against the code it guards.

1. **Broad-query structural leak** (`searchSymbols.ts:199`). Three symbol-query
   sites carried `EXCLUDE_STRUCTURAL_SYMBOLS_SQL`; `queryBroadCandidates`, added
   later as a performance optimization that rebuilds the SELECT by hand, did not.
   Long natural-language tasks route through exactly that path, so `<module>`
   entered the candidate pool — django-10973 delivered
   `db/backends/postgresql/client.py::<module>` at lexical score 98. The existing
   invisibility test only issued single-token queries, which never reach it.
2. **Dependent-symbol centrality** (`graphExpansion.ts:257`). See the attribution
   report §4.
3. **Graph expansion** (`graphExpansion.ts` `materialize`). The edge walk reaches
   module scopes and materialised them as deliverable candidates. Filtered at
   materialisation, not in the walk, so a module still bridges traversal — §24/§65.
4. **Hybrid admission** (`hybridRetrieval.ts` `ensureCandidate`) and **co-edit
   generated-artifact representative** (`coeditExpansion.ts`). The path lane admits
   every symbol in a likely edit file, and the co-edit lane took
   `listSymbolsForFile(...)[0]` as a file's stand-in — and `<module>` sorts first
   because its span is pinned to byte 0. astropy-14369 delivered
   `cds_lextab.py::<module>` and `cds_parsetab.py::<module>` in its context.

### Module-node delivery across checkpoints — §63/§64

| checkpoint | role entries | cases with `::<module>` in model-visible context |
|---|---:|---:|
| M140-A1 (inherited) | 7 | 6 |
| M140-A2 | 6 | 5 |
| M140-A3 | 5 | 4 |
| M140-A4 | 2 | 1 |
| M140-A5 | 2 | 1 |
| **M140-A6** | **0** | **0** |

**The inherited WS-A commit violated §63/§64 in 6 of the frozen 50.** It was not
detectable from the unit suite; it took the aggregate benchmark to surface it,
which is precisely the argument for §61 being a mandatory gate.

Because one invariant was broken independently by four producers, the suite now
also carries a capsule-level backstop that fails if any delivered capsule content
names a module scope — so a fifth producer is caught by property, not inspection.

## 7. Preservation

| check | result |
|---|---|
| M136 budget (ARC 3,000 tokens) | **PASS** — resolved, 9 rows |
| M137 dihedral | **PASS** — lead `arc/species/vectors.py::get_dihedral`, 3,000-token delivery true |
| M138 memory provenance | **FAIL — pre-existing, not caused by M140.** Reproduced identically on the M139 predecessor `340fd9c` (`ARC current=4/4; suppressed=0`), so it is environment/state drift in real historical memory, recorded separately from product failure per §91. |
| M131 flow | MIXED — the flow itself is healthy (`arc=3.252ms`, 21/22 rows); the one FAIL is `response_within_m130_envelope: captured incident payload not provided`, a missing input artifact rather than a product regression. |
| M132 worktree | not run standalone; covered by the full unit suite, which passes |
| ARCSpecies.copy impact, TCKDB acceptance | **NOT RUN** |

Note: these smoke scripts write into the tracked `results/` directory regardless
of `--out`, overwriting prior milestones' committed evidence. All 31 such files
were restored with `git checkout`; only the two pre-existing dirty ledger files
remain modified.

## 8. Verification

```
bun test                       4,075 pass · 49 skip · 0 fail
bun run typecheck              clean
bun run typecheck:benchmarks   clean
git diff --check               clean
WS-A stability suite           130 pass / 0 fail (was 125)
M139-negative discrimination   28 pass / 97 fail against 340fd9c
```

Module span identity (§4) verified on real data: all 1,116 sympy module symbols
at `start_byte=0, end_byte=0, start_line=1`, zero name collisions with real
symbols. Full-vs-incremental import equivalence, determinism, and
relevant-edit-must-change are covered by the stability suite.

No live agents, Docker, VEXP, paid APIs, or network evaluation ran. ARC and
TCKDB were read-only.

## 9. What is NOT claimed

- **Workstream B is not implemented.** No bounded upstream rescue, no ARC
  serialization acceptance, no rescue-scale or candidate-trace tables, no
  high-fan-in/two-hop/cycle fixtures.
- **No second paired comparison and no final aggregate**, because there is no
  final state to compare.
- ARCSpecies.copy impact regression (§66–§69), TCKDB acceptance (§76–§77), and the
  M132 worktree standalone run were not executed.
- Performance measurements (§61) were not collected per stage.

## 10. Next step

Workstream B, per §29–§55, against the corrected M140-A6 graph. The ARC chain
`from_dict → mol_from_xyz → perceive_molecule_from_xyz` and its 62/3/1 call
fan-ins still need confirming against a fresh ARC index before the seed rule and
per-seed cap are sized (§31, §38). Then the A6→final and M139→final comparisons.
