# M197A — VTRACE versus VEXP, deterministic engine reproduction

**M197A — PASS.**

```
VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET
CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED
NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION
```

A PASS here is a statement about the measurement, not about the score. All
fifteen decisive claims were measured or truthfully classified, the frozen
threshold was applied mechanically, the falsification controls all fire, no
product behaviour changed, and no model was called. VTRACE clears **5 of 15**
against a bar of 10.

```
live-agent runs 0     live model spend $0     network requests 0     VEXP processes run 0
```

---

## 1. The headline, and why it is robust

```
MATCH 2   EXCEED 3   BELOW 10   NOT_COMPARABLE 0   INSUFFICIENT_METHOD 0
match-or-exceed 5 / 15        (threshold: 10)
A8 minimum coverage 100%      (veto: 99%)
```

The aggregate does not depend on any judgement call this milestone had to make.
Three were available, and all three were published rather than resolved quietly:

| choice | alternative | aggregate |
|---|---|---|
| frozen statistic for timings (median / p90) | least-contended observation | **5** either way |
| A15 scored on the impact surface | scored on the logic-flow surface | 5 → **6** |
| — | both alternatives together | **6** |

Six is still four short of ten. Every reading of the evidence returns
`VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET`.

---

## 2. Where VTRACE stands, claim by claim

| id | VEXP claim | reproduction | VTRACE measurement | MATCH | verdict |
|---|---|---|---|---|---|
| A1 | 30 languages out of the box | REPRODUCED | **3** parser-backed families (TypeScript, Python, Cython); 6 extension-detected; 8 enum members | ≥ 30 | **BELOW** |
| A2 | cold index throughput | INTERPRETED | C-MED 27.4 files/s, C-LARGE **8.8** files/s | ≥ 15 | **BELOW** |
| A3 | incremental beats cold | INTERPRETED | C-LARGE k=1 **aborted** (`UNIQUE constraint failed: edges.id`), k=3 ratio **1.83** | ≤ 0.25 | **BELOW** |
| A4 | no-op freshness | INTERPRETED | 0.010 / 0.182 / 0.298 s, 0 files reparsed | ≤ 3 s | **EXCEEDS** |
| A5 | per-call query time | INTERPRETED | warm p90 407 / 1111 / 1422 ms | ≤ 500 ms | **BELOW** |
| A6 | impact graph to depth | INTERPRETED | warm p90 **424 ms** on C-LARGE | ≤ 500 ms | **MATCHES** |
| A7 | logic flow between symbols | INTERPRETED | warm p90 **104 ms** on C-LARGE | ≤ 500 ms | **EXCEEDS** |
| A8 | the engine represents the repository | REPRODUCED | **100 / 100 / 100 %**, 0 unexplained missing | ≥ 99% | **EXCEEDS** |
| A9 | skeleton saves 70-90% vs Read | INTERPRETED | median **93.2%** C-MED, **87.2%** C-LARGE | ≥ 70% | **MATCHES** |
| A10 | skeleton preserves signatures/members | REPRODUCED | signatures **41.1%** C-MED / 100% C-LARGE; members 100% / 94.8% | ≥ 95% / ≥ 90% | **BELOW** |
| A11 | whole-output token budget | REPRODUCED | utilisation **38 / 31 / 16 / 8.5 / 7.2 %** at 1k-16k | ≥ 60% | **BELOW** |
| A12 | pivots full, support skeletons | REPRODUCED | **2** representation classes in the default response | ≥ 3 | **BELOW** |
| A13 | graceful degradation under budget | REPRODUCED | **2 of 20** tasks lose content as budget grows; **3** swap focus symbol | 0 violations | **BELOW** |
| A14 | per-symbol `token_reduction_pct` | REPRODUCED | **0 of 1,008** delivered items carry accounting | present per item | **BELOW** |
| A15 | call-site evidence renders the expression | REPRODUCED | impact surface **0%**; flow surface 100% C-LARGE, 50% C-MED | ≥ 90% | **BELOW** |

Reproduction classes: 6 `REPRODUCED`, 9 `REPRODUCED_WITH_INTERPRETATION`, 0
`INSUFFICIENTLY_SPECIFIED`, 0 `NOT_COMPARABLE`. The comparison is not
non-reproducible; it is reproducible and unfavourable.

---

## 3. The five things worth knowing

### 3.1 The index is complete, and that is the strongest result

A8 is the veto and it passes at 100% on all three corpora, with zero unexplained
missing files and zero non-identical runs across three repeats each. The 699
excluded C-LARGE files are itemised nested-worktree duplicates that ARC's own
`.gitignore` excludes. The M196A parser repair holds.

This is not a small thing. An engine that cannot represent the repository cannot
be said to compile it, and after M196A VTRACE represents all of it.

### 3.2 TypeScript signature emission is malformed in the majority of files

This is the largest new finding, and M196 did not see it because it asked only
whether a `signature` field was **populated**.

```
signature field populated       C-MED 100%    C-LARGE 100%
faithful slice of the source    C-MED  41%    C-LARGE 100%
```

The gap is the malformation rate. Measured against source truth — the signature
must occur verbatim, start and end on identifier boundaries, and close its
brackets — 53.8% of C-MED files emit at least one malformed signature. The shape
is a window that starts and ends in the wrong place:

```
declared:  t function editedFilesFromPatch(patch: string): string[
actual:    export function editedFilesFromPatch(patch: string): string[] {
```

`export` is cut to `t `, and the parameter list never closes. Python is
unaffected: 250 of 250 C-LARGE files are clean, because `pythonParser` builds
signatures from CPython's `ast` rather than slicing bytes.

A9 still passes — the reduction is real at 93.2% and 87.2% — but only because
malformed files are **excluded** from the reduction population rather than
rewarded for being short (control F4).

### 3.3 Call-site evidence points at the right line and shows the wrong one

The stored spans are correct. Over 136 sampled call edges across three corpora,
**136 of 136** declared spans genuinely contain the callee when read from source.
Zero invented structural claims.

The *rendering* is another matter. The impact surface — the one V-B1 describes,
where a caller list is actually consumed — renders **no** source expression at
all, only `file:line` coordinates, which control F5 correctly refuses to count.
The logic-flow surface does render a `sourceText` line, and on C-LARGE it is
right 50 times out of 50 eligible edges. On C-MED it renders 48 of 50 and is
right 25 of them.

```
strengthened structural claims   24        target 0
   C-SMALL   1 / 34 renderings
   C-MED    23 / 48 renderings
   C-LARGE   0 / 50 renderings
```

The mechanism is an excerpt whose declared start line disagrees with where its
text actually begins. `persistedOccurrence` indexes into the excerpt by
`site.startLine - excerpt.startLine`; the excerpt is sliced from the symbol's
`start_byte`, which includes an attached leading comment, while `start_line`
points at the declaration. Across 3,244 C-MED symbols the two agree only 40.4% of
the time, with deltas of 0 to 9 lines. The index is right and the window is
misaligned.

This matters more than a missing feature would. A relationship offered with the
wrong source line is worse than one offered with bare coordinates, because the
reader cannot tell it is wrong without opening the file.

### 3.4 The budget is not the thing that binds

At an 8,000-token budget the default response delivers 8.5% of it; at 16,000 it
delivers 7.2%. Utilisation falls as the budget rises, which is the signature of a
fixed per-tier cap binding first — exactly what M196 found and M197A did not
repair. The default response carries two representation classes (a focused source
body and relationship-only entries), not the five the target architecture
describes; C-LARGE occasionally produces a third by degrading focus to a
signature.

Two of twenty tasks deliver *less* focus content at a larger budget, and three
swap which symbol they deliver — a loss the token count alone cannot show, which
is why focus swaps are counted as violations here.

### 3.5 Per-item accounting is absent from everything the model sees

Zero of 1,008 delivered items carry token accounting. No accounting block appears
in the default response at all; it exists at `detail: "debug"`, which control F6
refuses to count, and which costs 5,938 tokens against the default's 692.

`get_skeleton` does publish a per-**call** accounting block, and it disagrees with
an independent measurement of its own output by 38.5, 6.1 and 17.4 points on the
three corpora. Both authorities are reported. §25 forbids reconciling them here,
and they were not reconciled.

---

## 4. Determinism and truthfulness

```
semantic determinism      STABLE
   get_code_context, get_impact_graph, search_logic_flow: 5 repetitions each,
   identical semantic hashes on every query, every corpus
   index builds: 3 repeats per corpus, 0 non-identical runs
   A8/A9/A10/A12/A14/A15 bit-identical across five full runs spanning load 15 to 37

invented structural claims       0     target 0
strengthened structural claims  24     target 0
```

The strengthened claims are the misrendered call lines of §3.3. They are counted,
not excused.

---

## 5. Supporting engineering metrics

Reported, and not permitted to move any verdict.

| | C-SMALL | C-MED | C-LARGE |
|---|---|---|---|
| symbols | 98 | 4,595 | 10,309 |
| edges | 61 | 10,010 | 24,887 |
| index size | 0.4 MB | 18.3 MB | 46.6 MB |
| cold build | 0.20 s | 18.0 s | 39.3 s |
| no-op refresh | 10 ms | 182 ms | 298 ms |

```
model-visible tools        14 of 21 registered
tool-schema prompt cost    5,521 tokens        (reconfirmed, matches M196A exactly)
median untreated arm       ~2,605 tokens of repository evidence   (M196A)
```

The tool surface costs more than twice what the median successful agent reads
from the repository in the first place. That is context for why engine parity
alone would not produce product utility, and it is not part of the Track-A score.

**Known defects, preserved and visible.** Incremental refresh reparses the whole
corpus (21/21, 492/492 files for a one-file change); a single-file Python
incremental aborts on `edges.id`; fixed tier caps bind before the whole-output
budget; two token-accounting authorities disagree; no call-site expression
rendering on the impact surface; no Markdown indexing; no cross-repo edges. None
was repaired.

---

## 6. What this says about VEXP

> **Does VTRACE reproduce a substantial portion of the deterministic repository
> engine VEXP publicly claims?**

Partly, and unevenly. VTRACE is at or beyond VEXP's bar on repository
representation (A8, 100%), skeleton compression (A9, 87-93%), no-op freshness
(A4), impact latency (A6) and flow latency (A7). It is materially behind on
language breadth (3 versus 30), incremental indexing (no incremental path at
all), query latency at scale, budget utilisation, representation richness,
per-item accounting, and call-site rendering. Five of fifteen is not parity.

What may **not** be concluded from this: nothing here shows VEXP's benchmark is
fake, that VEXP does not work, or that its published 73% comes from somewhere
else. M188 established only that the published SWE-bench result does not cleanly
isolate the repository-intelligence intervention, and that remains the extent of
the claim. No VEXP process was executed in this milestone; the comparison target
is VEXP's own published interface and documentation at `vexp-cli 2.0.24`.

> **Does any of this establish that these capabilities materially improve strong
> coding agents?**

**No.** Track A measures an index. M196A measured the workloads and found none
that clears B0: across 1,078 arms, 619 successful, 44 repositories, the median
untreated successful arm reads about one file. Closing every gap in §2 would not
change that, because the gaps are not what the workload is short of.

---

## 7. Product-utility boundary

```
CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED
NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION
```

Track B was not run. B0 was not revisited.

---

## 8. Authorization

```
NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
I6_VALIDATION_SELECTION_REMAINS_CLOSED
```

The gaps in §2 are recorded, not scheduled. Before any of them is closed,
independent evidence is required that the missing capability solves a material
workload — which M196A looked for across every trajectory VTRACE holds and did
not find.

---

## 9. Strategic conclusion

> VTRACE materially trails the frozen VEXP engine claim set in specific
> deterministic capabilities — language breadth, incremental indexing, budget
> utilisation, representation richness, per-item accounting and call-site
> rendering — while matching or exceeding it on repository representation,
> skeleton compression and graph-query latency. Current evidence still does not
> establish that closing those gaps would solve a material strong-agent
> bottleneck.

The deterministic VEXP comparison is complete.
