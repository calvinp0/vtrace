# Stage 5 M155 — Broad SWE-bench Regression and Agent-Utility Qualification

**M155 execution verdict: PASS** (A PASS · B PASS · C PASS · B2 PASS · D PASS · E PASS).
**VTRACE product utility verdict: MIXED.**

Execution PASS means the qualification completed fairly under a valid,
provenance-safe protocol. It does not mean VTRACE won. The two verdicts are
independent, and this milestone is the case that shows why.

## Provenance

| Field | Value |
| --- | --- |
| Candidate (M154 final functional) | `051a7c559efcc90848390922b8a42293fb66dba5` |
| M154 predecessor | `e3761ab989a14aea4e233844070491084f33b2ce` |
| M155 harness commits | `2ed382d2`, `87c68078`, `188983e0`, `964ad3e1`, `157e2f5e` |
| M155 evidence commits | `0fa1b84e`, `c529503c`, `98c7c4b2`, `<this>` |
| Branch / push | `main`, local-only, **nothing pushed** |
| Co-author trailers | **0** |
| Product code changed | **NO** — `git status --porcelain src/` empty |
| Behavioural routing | **OFF** (asserted, `src/mcp/searchContract.test.ts:129-137`) |
| Worktrees | 13 pre-existing preserved; 5 created by M155-B/C, **removed** |
| Verification | `bun run typecheck` ✅ · `typecheck:benchmarks` ✅ · `bun test` ✅ · `git diff --check` ✅ |
| Prepared multi-era corpora | **retained** (53 GB, `/home/calvin/bench/vtrace-m155/`) |
| M153 sealed holdouts | unconsumed |

---

## Part 1 — Benchmark correction (M155-B2): PASS

### The defect

The committed regression suite opened whatever `.vtrace/index.sqlite` sat beside
each workspace. Asked properly — via VTRACE's own `resolveDerivationRebuildReason`
and `SUPPORTED_INDEX_FORMAT_VERSIONS` — the committed Frozen50 was:

| Verdict | Cases |
| --- | ---: |
| derivation-valid | **5** |
| `schema_unsupported` (`index_format_version: 1` vs supported `{5}`, built 2026-06-08 at `7035429`, 491 commits back) | 41 |
| `meta_missing` (no `index.meta.json` at all) | 4 |

**5 of 50**, across three incompatible evidence regimes, in one artifact labelled
`artifactState: "authoritative"`. Opening a stale index migrates its schema and
leaves the new feature tables **empty**, so in that corpus M129's document lane had
no documents, M150's mechanism facts did not exist, and M140-A's module import
owner was absent. VTRACE's own authority would have rejected those indexes; the
benchmark never asked.

### Re-baseline (before → after)

| | before | after |
| --- | ---: | ---: |
| derivation-valid | 5/50 | **50/50** |
| gate usable | false | **true** |
| cases evaluated | 5 | 50 |
| gold file Top-1 | 0.60 *(of 5)* | **0.76** |
| gold delivered | 0.80 *(of 5)* | **0.90** |

The "after" figures independently reproduce the Frozen50 projection from the broad
100-case run — two drivers, same prepared corpus, same answer.

### Architecture now in force

Three gates, three questions: **fast gate** (Frozen50, stability/observability),
**broad100** (retrieval quality at major checkpoints), **paired30/100** (agent
utility). Indexes are derived evidence keyed on derivation fingerprints, not
timeless fixtures; `vtrace_commit` is deliberately *not* derivation-relevant, which
is what keeps the fast gate fast. Stale, schema-unsupported and unattributable
indexes fail closed with no bypass. All four capability lanes — document, module
import-owner, mechanism fact, delivery/discard — are proven **observable** across a
known-negative and known-positive checkpoint.

**Retrospective qualification (added once; history not rewritten):** preservation
evidence taken on the committed workspaces shows *ranking and delivery code* did not
change behaviour on that corpus. It does **not** show index-side invariance for any
capability introduced after 2026-06-08.

**Frozen50's standing:** retained as the fast stability gate, removed as the broad
quality authority. It is ~19 points easier on Top-1 and 12 on delivery than the
broad corpus, and its delivered-gold is 0.90 at **all five** architecture
checkpoints. A gate that cannot move cannot report progress or its absence.

---

## Part 2 — Broad deterministic retrieval (M155-B/C): PASS

Five architecture-era anchors, 500 freshly built indexes, one immutable 100-case
corpus, four provenance-valid adjacent comparisons.

| Checkpoint | Top-1 | Top-3 | **Gold delivered** | Gold anywhere | Discarded | Missing | Symbol anywhere | Tokens | Latency med / p90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M129 | 56% | 73% | **79%** | 85% | 6% | 15% | 64.0% | 1185 | 593 / 1356 ms |
| M140 | 55% | 72% | **80%** | 84% | 4% | 16% | 64.0% | 1165 | 562 / 1249 ms |
| M150 | 57% | 73% | **78%** | 89% | 11% | 11% | 64.0% | 1165 | 717 / 1607 ms |
| M152 | 57% | 73% | **78%** | 89% | 11% | 11% | 64.0% | 1165 | 711 / 1620 ms |
| M154 | 57% | 73% | **78%** | 89% | 11% | 11% | 64.0% | 1165 | 708 / 1613 ms |

| Transition | Semantic | Outcome | Improve | Regress |
| --- | ---: | ---: | ---: | ---: |
| M129→M140 | 57/100 | 47 | 0 | **3** (all `path authority`) |
| M140→M150 | 76/100 | 95 | 8 | 0 |
| M150→M152 | **0/100** | 0 | 0 | 0 |
| M152→M154 | 2/100 | 6 | 0 | 0 |

Three standing conclusions, unchanged: broad quality is approximately **flat**
(delivered gold 79% → 78%, symbol recall 64.0% at every checkpoint); the +4-point
`gold anywhere` gain at M140→M150 is **five cases moving `missing → discarded`**
while delivered gold fell; and M150 added **~26% median retrieval latency** that
persists through M154. M152's store split is byte-identical (0/100); M154 is
contained (2/100, all outcome-neutral discard-bucket movement).

**Broad retrieval verdict: NEUTRAL / MIXED.**

---

## Part 3 — Paired live agent benchmark (M155-D): PASS

### Protocol

30 tasks, frozen before any live outcome as a **prefix** of a deterministic
stratified ordering over all 100 (so extension to 100 runs the next cases in an
order already fixed). Difficulty from SWE-bench Verified's own human annotation;
ordering consumes only instance id, repository and difficulty — a test asserts that
attaching gold state or Top-1 changes nothing. No seed: the ordering is a pure
function of the corpus. `manifestSha256 d143f807648a7198…`.

10 repositories, difficulty 53/40/7% vs corpus 53/38/8%. Arm order **alternates**
15/15. Model `claude-opus-4-5-20251101` both arms, 250 turns, $3/task cap,
identical tool list (`Edit, Write, Bash, Read, Glob, Grep, TodoWrite`), mandatory
env + shell guards, authoritative Docker grading. VTRACE reaches the agent as
**injected context only** — no callable tools (see Limitations).

### Treatment availability — over all 30 selected tasks

```
selected paired tasks              30
VTRACE treatment available         27   (26 VALID_NON_EMPTY + 1 VALID_EMPTY)
VTRACE treatment unavailable        3
availability rate                90.0%
```

The three unavailable cases are `TREATMENT_UNAVAILABLE_INDEX_FAILURE`:
`psf__requests-1142`, `pytest-dev__pytest-5262`, `pylint-dev__pylint-4551`. In each,
**one unparseable file aborts the whole-repository index**, so no treatment context
can be produced and the agent never spawns. All three files are among the 16 that
the deterministic benchmark's preparer quarantines and continues past. Not rerun:
the failure is deterministic, and adding quarantine to the live path after seeing
them would change the treatment.

**`psf__requests-1142` is baseline PASS with VTRACE unavailable.** That is real
end-to-end product harm. It is deliberately *not* in the agent matrix, because no
VTRACE agent ran, and no counterfactual fallback is assumed.

`django__django-11740`'s first attempt was an `INVALID_HARNESS_ABORT` — VTRACE
indexed cleanly, retrieved 33 candidates including the gold file, delivered 0, and
the harness aborted before spawn because the selection was empty under
`force-inject`. Traced read-only, classified **`VALID_DELIVERY_EMPTY`** (evidence
existed; none survived delivery), harness distinction fixed, and rerun once from a
fresh clone and index: treatment valid, 0 context tokens, agent spawned, 17 turns, a
patch. Both attempts recorded.

### Paired outcome matrix — denominator VALID_PAIRED_AGENT_RUNS (n = 27)

| Baseline | VTRACE | Classification | Count |
| --- | --- | --- | ---: |
| PASS | PASS | shared success | **17** |
| FAIL | PASS | VTRACE unique win | **2** |
| PASS | FAIL | VTRACE unique loss | **2** |
| FAIL | FAIL | shared failure | **6** |

```
net unique wins            0
baseline pass rate    19/27 = 70.4%   CI95 [0.515, 0.841]
VTRACE  pass rate     19/27 = 70.4%   CI95 [0.515, 0.841]
pass-rate delta            0
McNemar exact two-sided p  1.00
```

Solve rate is **exactly flat**. With 2 discordant pairs each way, no aggregate
difference is distinguishable from noise; the intervals overlap almost entirely.

### Efficiency — recomputed strictly on the 27 valid pairs

| Metric | Baseline | VTRACE | Delta |
| --- | ---: | ---: | ---: |
| total end-to-end tokens | 34,794,538 | 20,510,838 | **−14.3 M (−41%)** |
| median tokens/task | 907,914 | 705,564 | −202,350 (−22%) |
| total cost | $16.11 | $12.07 | **−$4.04 (−25%)** |
| median cost/task | $0.482 | $0.426 | −$0.056 (−12%) |
| total turns | 919 | 555 | **−364 (−40%)** |
| median turns/task | 28 | 19 | **−9 (−32%)** |
| Grep calls | 83 | 21 | **−75%** |
| Read calls | 103 | 56 | −46% |
| Bash calls | 124 | 78 | −37% |
| median tool calls before first edit | 3 | 1 | −2 |
| median searches before first edit | 1 | 0 | −1 |
| median first gold-touch index | 1 | 0 | −1 |

Injected context is **1,273 tokens median** (45,163 total across 26 cases). The
token reduction is therefore **end-to-end agent usage**, not a claim about capsule
size — the saving is ~160× the payload, and §55 is satisfied on its own terms.

Index preparation, reported separately: the VTRACE arm indexes each repository
before the agent runs (~30–90 s, ~35–145 MB per repository). Agent-run-only cost is
above; including preparation, VTRACE adds wall-clock per task and still spends less
model budget.

---

## Part 4 — Utility and harm analysis (M155-E): PASS

### Gold-state cross-tab (valid paired runs)

| Deterministic gold state | n | baseline PASS | VTRACE PASS | wins | losses |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GOLD_DELIVERED` | 25 | 17 | 17 | 2 | 2 |
| `GOLD_DISCOVERED_BUT_DISCARDED` | 2 | 2 | 2 | 0 | 0 |

`GOLD_MISSING` has **no** representation among valid pairs: the corpus's one
missing-gold case in the 30 (`pylint-dev__pylint-4551`) is also one of the three
index failures. The cross-tab can therefore only speak to delivered gold — a
limitation flagged before results were seen, and a consequence of correctly
refusing to stratify on gold state.

### Every discordant case, analysed

| Case | Class | Injected lead | Lead = gold? | Both arms reached gold before first edit? | Turns b→v |
| --- | --- | --- | --- | --- | --- |
| `django__django-10973` | win | `db/backends/postgresql/client.py` | **yes** | **yes** | 17 → 13 |
| `django__django-11206` | win | `django/utils/numberformat.py` | **yes** | **yes** | 17 → 16 |
| `matplotlib__matplotlib-24627` | loss | `lib/matplotlib/axes/_base.py` | **yes** | **yes** | 84 → 33 |
| `astropy__astropy-14365` | loss | `astropy/io/ascii/qdp.py` | **yes** | **yes** | 23 → 17 |

**In all four, the injected lead was exactly the gold file, and both arms reached
gold before their first edit.** At n=27 the discordance is therefore not explained
by evidence discovery — it sits downstream, in what the agent did with evidence both
arms already had. Three are labelled `agent variance / unclear` with low confidence.
The fourth carries a hypothesis, not a finding: `matplotlib-24627`'s baseline needed
**84 turns and 15 greps** to pass, while VTRACE passed through in **33 turns with 3
greps** and failed — consistent with less exploration yielding a shallower fix, but
unproven.

### Safety and contract

| Check | Result |
| --- | ---: |
| false-authority losses (wrong lead caused a miss) | **0** |
| wrong actionable lead presented | 7 / 26 |
| …of those, agent still reached gold | **7 / 7** |
| unsupported anti-search advice | **0** (M154's removal holds live) |
| `.vtrace` state staged in a task patch | **0 / 31** |
| stale / wrong-worktree responses | 0 |
| treatment-invalid runs | 3 (all availability) + 1 corrected harness abort |
| reruns | 1 (`django-11740`, benchmark-invalid abort) |
| `srcDirty` | false |

**A real gap, quantified:** `.vtrace` is unignored in **31/31** live task repos.
M154-B's exclusion is applied by `vtrace init` and the MCP surface (verified working)
but **not** by the bare `vtrace index` path the harness uses. Nothing was staged, so
§45 holds — but the hazard M154-B was built to remove is still reachable for a
repository onboarded only through `vtrace index`. Recorded, not fixed.

---

## Product utility verdict: **MIXED**

**For:** a large, systematic efficiency benefit on identical solve rate — 41% fewer
end-to-end tokens, 40% fewer turns, 25% lower cost, 75% fewer greps, and faster
orientation (first gold touch at tool call 0 vs 1; 3 → 1 tool calls before the first
edit). This is measured end-to-end, not inferred from payload size. Zero
false-authority losses; the anti-search constant M154 removed stays removed live.

**Against:** solve rate is exactly flat (19/27 both, p = 1.00) with 2 unique wins
offset by 2 unique losses — and none of the four is attributable to evidence
quality, so VTRACE cannot claim the wins either. **10% of selected tasks could not
receive the treatment at all**, and one of those was a task baseline solved.

Not STRONG POSITIVE or POSITIVE: there are meaningful unique losses and a real
availability failure. Not NEGATIVE: no net unique losses, no systematic harmful
context, and substantially *less* work for the same outcome. That is MIXED, with the
efficiency case the strongest positive evidence M155 produced and availability the
clearest defect.

## Roadmap evidence (observed on the frozen sample; not extrapolated)

| Category | Observed | Note |
| --- | ---: | --- |
| **INDEX_ROBUSTNESS / PER_FILE_PARSE_FAILURE_CONTAINMENT** | **3/30** | One unparseable file makes all repository context unavailable. Independent of ranking quality. The deterministic benchmark quarantines and continues; the live path aborts. |
| Delivery policy (`gold discovered but discarded`) | 11/100 broad, 2/27 paired, 1 empty treatment | `django-11740` shows the end-to-end consequence: gold retrieved, all 33 candidates `support-only`, nothing delivered, treatment empty. |
| Agent interaction / context organisation | 4/4 discordant | Both arms had gold; outcome still diverged. |
| `search_symbols` (enumeration need) | 0 cases identified | Not justified by this evidence. Not added. |
| Result/effect semantics | 0 independent cases | Not justified. Not added. |
| Cross-repository composition | 0 cases | Git sufficed. |

## Limitations

1. **No callable VTRACE tools.** The historical protocol injects context;
   `--vtrace-method mcp` parses but is never dispatched and the harness spawns with
   `--strict-mcp-config` and empty `{mcpServers:{}}`. Tool discovery, voluntary
   invocation, `get_code_context` / `get_impact_graph` usage and VTRACE→grep
   sequencing are **UNAVAILABLE, never zero**.
2. **n = 27.** Wide intervals; only unique wins/losses and the efficiency deltas
   carry information.
3. Gold = patch-modified files, so `misleading lead` (41% broad) is an upper bound.
4. `discarded` treated as not-delivered, per the scorer's product framing.
5. Latency measured by a separate read-only probe; never folded into a semantic hash.
6. Cross-tab cannot speak to `GOLD_MISSING`.
7. The M140→M150 latency and delivery findings are broad-corpus; no live A/B isolates them.

## Recommended next milestone

**Index robustness / per-file parse-failure containment.** It is the only defect
here that makes VTRACE unusable rather than merely unhelpful, it cost 3/30 tasks
including one baseline success, it is independent of ranking, and the deterministic
benchmark already proves containment is achievable. Delivery policy is second: the
`gold discovered but discarded` bucket now has an end-to-end demonstration. Ranking
and retrieval expansion are **not** indicated — the efficiency case is already good
and the discordant outcomes are not explained by evidence quality.
