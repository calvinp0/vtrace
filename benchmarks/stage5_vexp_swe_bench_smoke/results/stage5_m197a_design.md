# M197A — design and execution record

Deterministic reproduction of VEXP's advertised repository-engine claims. No
coding agent was run, no model or provider was called, no network request was
made, and no product behaviour was changed.

```
live-agent runs      0
live model spend     $0
network requests     0
VEXP processes run   0
product files changed 0
```

---

## 1. What this milestone is, and what it is not

M197A answers one question:

> Can VTRACE reproduce, match or exceed VEXP's concrete deterministic
> repository-engine claims?

It does **not** answer whether those capabilities improve a strong coding agent.
M196A measured 1,078 arms across 44 repositories and found no workload whose
repository-consumption burden clears the frozen materiality gate B0, so Track B
has no corpus and was not run. The two claims are kept apart throughout:
`VTRACE_MATCHES_VEXP_CLAIM` is a statement about an index, never about a product.

---

## 2. Frozen authority, verified before scoring

`run_stage5_m197a_authority.ts` re-derives the authority from committed artefacts
and exits non-zero on any mismatch. It ran first and passed 15 of 15 checks.

| check | result |
|---|---|
| preregistration sha256 | `736e8a9b5beba4a26d29ca068bafa2f4aede973ec50dab53bba6673f6697d8f0` — matches the value frozen by M196A |
| G1 wording still `>= 10 of 15 claims MATCH or EXCEED` | present verbatim |
| G8 wording still `ingestion completeness < 99%` | present verbatim |
| VEXP claim ledger | 24 claims, `vexp-cli 2.0.24`, "no vexp process was executed" |
| cited claims present | 9 of 9 (V-A1, V-A5, V-B1, V-B2, V-C1, V-C3, V-C5, V-C6, V-C7) |
| M196A ingestion repair still in tree | `typescriptParser` passes an explicit `bufferSize` |
| C-SMALL | 21 files @ `vexp-swe-bench d658e3457b` |
| C-MED | 492 files @ `vtrace 4ab01a72ef` |
| C-LARGE | 276 `.py` files @ `ARC 826144342e`, plus 699 nested-worktree duplicates excluded |

The C-LARGE denominator is M196A's corrected 276, not M196's 975. The 699
excluded files were re-counted here and still sit under `.claude/worktrees/`.

---

## 3. Comparison mode

```
DIRECT_REPRODUCTION        not used
CLAIM_TARGET_COMPARISON    used for every claim
VTRACE_LOCAL_ANALOGUE      labelled on every latency and throughput row
```

No VEXP binary was executed. §31's preconditions (provably no provider call, no
network, no mutable state) could not be established for `vexp-core` without
running it, so the published claims recovered by M196 are the comparison target.

**Comparability is asymmetric and is recorded as such.** VEXP publishes a
`query_time_ms` field and a "70-90% savings" range without stating hardware,
corpus, cache state, tokenizer, or protocol. Every latency threshold in the
frozen table is therefore VTRACE's own bar, preserved from M196 and applied
unchanged — not a number VEXP published. Rows measured this way are marked
`VEXP_CLAIM_REPRODUCED_WITH_INTERPRETATION`, which is a statement about the test,
never about who won.

---

## 4. Measurement conventions

Taken verbatim from the preregistration §2 and not modified:

- **Tokenizer** `ceil(characters / 4)`, applied identically to both sides of
  every ratio. Every reduction figure is an approximation and is labelled one.
- **Whole-response accounting.** Every model-facing byte counts.
- **Cold** no `.vtrace/` exists; process start to exit. **Warm** index present
  and unchanged, a preceding identical call completed. **Incremental** index
  present, exactly *k* files modified.
- **Latency** 5 repetitions; median / p90 / p95 / max / min reported.
- **Determinism** every semantic measurement repeated and hashed; content must
  be identical or the measurement cannot support a pass.

Everything is measured through the **default model-facing product path** — the
MCP server's own request handler at its default options. A capability reachable
only from an internal function or at `detail: "debug"` satisfies no claim about
what the model is given (control F6).

---

## 5. Machine, and the contention that affected it

```
CPU        12th Gen Intel Core i7-12700KF, 20 threads
RAM        62 GB;  scratch on tmpfs
load       15.8 → 37.7 across the measurement window, on 20 CPUs
```

The machine was shared throughout with an unrelated MLIP benchmark belonging to
the operator, consuming roughly 11 cores continuously. This is recorded with
every timing, and it is the reason the report publishes a **contention
sensitivity** block: contention can only add time, never remove it, so the
frozen statistic is an upper bound on true latency and the least-contended
observation is a lower bound.

**Verdicts use the frozen statistic** — median for throughput, p90 for latency.
Switching statistic after seeing which one passes is the precise failure §32
exists to prevent. The least-contended alternative is published beside it, along
with the aggregate it would produce, so the reader can see how much of the result
is the engine and how much is the machine. In the event, the aggregate is
identical under both.

The semantic measurements are unaffected: A8, A9, A10, A12, A14 and A15 returned
bit-identical values across five full runs spanning load 15 to 37.

---

## 6. Corpora

| id | source | language | eligible | on disk | excluded |
|---|---|---|---|---|---|
| C-SMALL | `vexp-swe-bench/src` @ `d658e345` | TypeScript | 21 | 21 | 0 |
| C-MED | `vtrace/src` @ `4ab01a72` | TypeScript | 492 | 492 | 0 |
| C-LARGE | `ARC` @ `826144342` | Python | 276 | 975 | 699 nested worktrees |

Each is copied read-only into scratch before indexing: `indexProject` writes a
`.vtrace/` directory into the repository root, so measuring ARC in place would
mutate an unrelated active repository as a side effect of a benchmark.

A8's denominator is derived by walking the filesystem **independently of the
product's own enumeration**. Asking the system under test to also define what
counts as eligible is how a coverage metric becomes unfalsifiable.

---

## 7. Instruments

```
m197aParity.ts             pure: verdict vocabulary + aggregate evaluator
m197aScoring.ts            pure: the rules F4-F8 are written against
m197aFixtures.ts           frozen corpora, authored task sets, derived fixtures
run_stage5_m197a_authority.ts   freeze verification; exits non-zero on mismatch
run_stage5_m197a_indexing.ts    A2, A3, A4, A8
run_stage5_m197a_engine.ts      A1, A5-A7, A9-A15, determinism, truth audit
run_stage5_m197a_report.ts      claim ledger + aggregate; fails closed on a gap
m197aParity.test.ts        F1, F2, F3
m197aScoring.test.ts       F4, F5, F6, F7, F8
```

Two properties are enforced **structurally** rather than by convention:

- a claim whose comparison was never reproduced cannot contribute a win. The
  evaluator discards any verdict attached to such a row and records the attempt
  in `structuralViolations`, so an incomparable claim dressed as a match is
  visible rather than merely uncounted;
- the A8 veto reads the per-corpus coverage numbers, never A8's own verdict row,
  so an A8 row asserting MATCH while a corpus sits at 98% cannot carry the gate.

Fixtures that must be **authored** (the 20 C-MED budget tasks, the per-corpus
query sets) are written down once. Fixtures that can be **derived** (impact
targets, flow pairs, sampled call edges) are derived from the index by a stated
ordering. Hand-picking a symbol that happens to have callers turns a latency
benchmark into a benchmark of the author's taste.

---

## 8. Instrument corrections made during execution

Five defects were found in the **measurement code** and fixed. Each is recorded
because each would have produced a wrong number about the product, and three of
them would have produced a number unfavourable to VTRACE.

| # | defect | effect had it stood | resolution |
|---|---|---|---|
| 1 | the runner reopened the index with a bare `new Database`, skipping `PRAGMA foreign_keys` and schema initialisation | every incremental refresh aborted on `UNIQUE constraint failed: edge_call_sites`, on all three corpora — a product failure the instrument caused | use the product's own `openIndexerDatabase` |
| 2 | the incremental probe appended a `//` comment to a **Python** file | the file failed to parse, was skipped, and the incremental defect could not fire — a probe that hides what it probes for | comment marker follows the corpus language |
| 3 | skeleton validity counted angle brackets | every signature containing `=>` was flagged malformed; 227 of 459 C-MED files scored invalid on a fact about the checker | validity decided against source truth: verbatim, token-aligned, brackets closed |
| 4 | validity required a signature on M140's `<module>` symbol | all 250 C-LARGE files scored malformed for a structural symbol that carries no body by design | structural declarations excluded |
| 5 | the determinism hash included latency-derived size counters | every impact and flow query scored non-deterministic because timing floats change decimal length | documented `semanticProjection`, with a test that a real content change still trips it |

Correction 5 needs its justification stated precisely, because stripping token
counts could otherwise hide a real change. `estimatedOutputTokens`,
`serializedCharacters` and their derivatives are computed **over the serialized
response**, and at that moment the string still contains the timing floats. A
float whose decimal length changes moves the count without any content changing:
the counters are downstream of the clock, not of the evidence. The projection is
tested both ways — a timing difference must not trip it, and a changed node, span
or ordering must.

---

## 9. Falsification controls

All eight pass, and are executed by both the test suite and the report.

```
F1  fewer than 10 of 15 matches must not meet the threshold
F2  14 of 15 with A8 at 98.9% must still fail; the veto reads coverage, not A8's verdict
F3  a NOT_COMPARABLE claim must not increase the match count, and the discarded win is reported
F4  a structurally invalid skeleton must fail A9 and A10 — and `=>` must not be mistaken for one
F5  file:line must not satisfy call-expression rendering
F6  a debug-only field must not satisfy a default-output claim
F7  thirty declared enum members with no parsers must score zero
F8  a semantically unstable repeated output must fail the measurement
```

---

## 10. What was deliberately not done

No product behaviour was changed. The known defects listed in §39 of the brief
were measured, not repaired: incremental refresh has no incremental path, a
single-file Python incremental aborts on `edges.id`, fixed tier caps bind before
the whole-output budget, the default renderer discards the compiled
`productContext` richness, two token-accounting authorities disagree, there is no
call-site expression rendering on the impact surface, no Markdown indexing, no
cross-repo edges, and the tool surface costs 5,521 prompt-prefix tokens.

Track B was not run. B0 was not revisited. No capability was built in order to
make a benchmark pass.
