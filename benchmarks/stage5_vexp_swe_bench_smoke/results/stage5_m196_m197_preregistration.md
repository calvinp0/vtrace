# M197 preregistration — frozen before measurement

Frozen by M196 on 2026-09-01 at VTRACE `e3ec0ae4f050450a051659ee8f905acaa706f55c`.

M197 is the go/no-go proof for the context-compiler thesis. It is **$0 live model
spend, 0 agent runs, no product rewrite, no treatment experiment**. Every number
below is fixed now, before any M197 measurement is taken, per §63.

Thresholds are derived from **VEXP's published claims** (`stage5_m196_vexp_claim_ledger.json`)
and from the **observed agent consumption** in M194, never from VTRACE's measured
capability. Where M196 already measured VTRACE against a threshold, that
measurement is recorded here as a *declared prior*, so nobody can later claim the
bar was set to clear it: **the bar is set where VEXP put it, and VTRACE currently
fails several of them.**

---

## 0. What M197 may and may not look at

**Permitted inputs to compilation:** the task text, the pristine repository state,
and the frozen compiler/retrieval rule at the M197 commit.

**Forbidden inputs to compilation:** the gold patch, the reference patch, the gold
tests, the final model patch, the agent's future reads, the trajectory, and the
resolution outcome. These are evaluation-only and are revealed only after the
compiled output is written to disk and hashed.

Mechanically: Track B runs in two phases with a hash barrier.

```
phase 1   task + repo  →  compile  →  write output  →  sha256 recorded in the ledger
phase 2   ONLY THEN    →  read trajectory  →  score
```

A phase-2 process that can reach a phase-1 input fails the run closed.

---

## 1. Corpora, frozen

| id | Corpus | Language | Files | Provenance |
|---|---|---|---|---|
| `C-SMALL` | `vexp-swe-bench/src` | TypeScript | 21 | `Vexp-ai/vexp-swe-bench@d658e345` |
| `C-MED` | VTRACE `src/` at the M197 commit | TypeScript | 492 | this repository |
| `C-LARGE` | ARC `*.py` tree | Python | 975 | `/home/calvin/code/ARC`, copied read-only |
| `C-TRAJ` | M194 arms | mixed | 33 arms / 12 repositories | `results/m194/runs/` |

`C-LARGE` is the largest genuinely substantial repository VTRACE holds. **No
5,000-file claim will be reproduced and no 975-file measurement will be
extrapolated to one** (§47, §65).

Every reported figure carries `n`, repositories, languages, median and p90.

---

## 2. Measurement conventions, frozen

- **Tokenizer.** `ceil(characters / 4)`. No real tokenizer is available offline.
  It is applied **identically to both sides of every ratio** and every reported
  reduction is labelled an approximation (§27).
- **Whole-response accounting.** Every model-facing byte counts: headers,
  provenance, paths, prose, metadata. Nothing is excluded (§73).
- **Cold.** No `.vtrace/` directory exists; process start to process exit.
- **Warm.** Index present and unchanged; a preceding identical call has completed.
- **Incremental.** Index present; exactly *k* files modified; process start to exit.
- **Latency.** 5 repetitions, report median / p90 / p95 / max. Machine, CPU count
  and corpus recorded with every timing.
- **Determinism.** Every measurement runs 3× and must be byte-identical, or the
  measurement is reported as non-deterministic and cannot support a PASS.

---

## 3. Track A — VEXP claim reproduction

15 claims are testable; 9 are not (`MARKETING_EXAMPLE_ONLY`, `NOT_COMPARABLE`, or
`INSUFFICIENT_METHOD` with no derivable local analogue) and are recorded as such
rather than approximated.

| id | Claim under test | Corpus | Measurement | MATCH | EXCEED | Declared M196 prior |
|---|---|---|---|---|---|---|
| A1 | 30 languages | code | parsers × detected extensions | ≥ 30 | > 30 | **4 families — FAILS** |
| A2 | index throughput | C-MED, C-LARGE | files/s cold, 3× | ≥ 15 files/s | ≥ 30 | 18 files/s (C-LARGE) |
| A3 | incremental beats cold | C-LARGE | `t(k=1,3,10)` vs `t(cold)` | ratio ≤ 0.25 | ≤ 0.05 | **2.0–3.0 — FAILS** |
| A4 | no-op freshness | C-LARGE | `t(k=0)` | ≤ 3 s | ≤ 1 s | 1.0 s — passes |
| A5 | query latency | all | `get_code_context` warm, 5× | p90 ≤ 500 ms | p90 ≤ 200 ms | 113–221 ms — passes |
| A6 | impact latency | C-LARGE | `get_impact_graph` depth 3, 5× | p90 ≤ 500 ms | ≤ 200 ms | 159 ms — passes |
| A7 | flow latency | C-LARGE | `search_logic_flow`, 5× | p90 ≤ 500 ms | ≤ 200 ms | 5.3 ms — passes |
| A8 | **ingestion completeness** | C-SMALL, C-MED, C-LARGE | indexed ÷ eligible | ≥ 99% | 100% | **58.3% TS / 100% Py — FAILS** |
| A9 | skeleton reduction (V-C1) | C-MED, C-LARGE | skeleton ÷ full file, per file | median ≥ 70% | ≥ 90% | 88.9% / 90.0% — passes |
| A10 | skeleton preservation (V-C1) | 30 sampled symbols | signature, return type, docstring, member retention | ≥ 95% signatures, ≥ 90% members | 100% | 100% / 91.6% signatures |
| A11 | budget binds (V-C5) | C-MED | delivered ÷ requested across 1k–32k | ≥ 60% utilisation at every budget | ≥ 80% | **4.5% at 8k — FAILS** |
| A12 | representation classes (V-C6) | C-MED | classes present in the **default** response | ≥ 3 distinct classes | 5 | **2 (FULL ×1, RELATIONSHIP_ONLY) — FAILS** |
| A13 | graceful degradation (V-C7) | C-MED, 20 tasks × 5 budgets | class-by-class degradation, no focus swap | 0 monotonicity violations | 0, plus a stated drop order | **1/3 tasks violated — FAILS** |
| A14 | per-item token accounting (V-C3) | C-MED | reduction reported per delivered item | present and internally consistent | plus an accumulated ledger | **absent, and 2 disagreeing authorities — FAILS** |
| A15 | call-site evidence (V-B1/B2) | C-LARGE, 50 edges | fraction rendering the call **expression** | ≥ 90% | 100% with bounded surrounding lines | **0% rendered (100% stored) — FAILS** |

**Not reproduced, and why:** V-B3 cross-repo synthetic edges (VTRACE has no
cross-repo edge; measuring absence is not a reproduction), V-C2 ~60% pipeline
savings (no baseline published), V-C8 prose compression (absent), V-C9 savings
ledger (absent), V-D1 73% pass@1 (**NOT_COMPARABLE**, M188), V-D2/D4/D5/D6
(no protocol, no artifact).

**Track A verdict rule.** For each id, one of `VTRACE_BELOW_VEXP_CLAIM`,
`VTRACE_MATCHES_VEXP_CLAIM`, `VTRACE_EXCEEDS_VEXP_CLAIM`, `VEXP_CLAIM_NOT_COMPARABLE`.
A claim is only ever `VEXP_CLAIM_REPRODUCED` when a fair local test was
constructed — which is a statement about the test, never about who won.
Any measurement taken under conditions VEXP did not state (hardware, corpus,
tokenizer, cache state, language mix) is reported `NOT_COMPARABLE` regardless of
which side it favours (§64).

---

## 4. Track B — successful-agent trajectory compression

### 4.1 Evidence taxonomy, frozen

Derived **only** from the trajectory and the final patch, never from human
judgment (§39).

```
E1  PATCH_CRITICAL      a file or symbol the final patch edits, or whose
                        content the patch's identity depends on
E2  CONTRACT_CRITICAL   evidence read or searched in the 3 tool calls preceding
                        an E1 edit, or naming a symbol the patch references
E3  SUPPORTING          repository evidence inspected with no observed
                        downstream use in the patch
E4  INCIDENTAL          reads/searches whose result is never referenced again
```

Primary recall is over **E1 ∪ E2**. E3 and E4 are reported and never rewarded:
reproducing an agent's dead ends is not a capability. Where necessity cannot be
established the row is labelled `OBSERVED_CONSUMED_EVIDENCE`, never
`REQUIRED_EVIDENCE` (§67).

### 4.2 Denominator, frozen

The denominator is the **actual Read+Grep+Glob result tokens** consumed by the
arm — nothing else. Concatenating the repository is forbidden (§42). The
already-measured values are stated here so they cannot be re-chosen later:

```
33 arms   median 3,708   p90 19,122   max 23,962
23 resolved   median 2,619   p90 8,302   max 19,122   (median 1 file read, 1 edited)
10 unresolved median 7,317   p90 23,962
```

### 4.3 Corpus adequacy gate — runs FIRST

Because 70% of 2,619 tokens is 1,833 tokens, and VTRACE's own cheapest compiled
response already costs 578–1,154, a compression proof on this corpus can be
*passed* without being *worth anything*. M197 therefore opens with an adequacy
gate, and the gate is not a formality:

```
B0   MATERIALITY
     median repository-evidence tokens over successful arms >= 20,000
     OR repository-evidence >= 25% of total model-facing tokens for the arm
```

Candidate corpora for B0, in order: M194 (33 arms), M108 (100-case), M107
(50-case), M106 (24-case). If **no** available corpus clears B0, Track B returns

```
TRACK_B_CORPUS_INADEQUATE
```

which is **not** a pass and **not** a neutral result. It means the thesis cannot
be proven on any evidence VTRACE holds, and §7 of the verdict rule applies.
Declared prior: **M194 gives 2,619 — B0 FAILS on M194.**

### 4.4 Metrics

```
recall        E1 file, E1 symbol, E1 implementation span, E2 contract, tests, config/docs
truth         invented relationship, invented symbol, invented path, wrong owner,
              strengthened possible relationship, stale source        TARGET 0
size          raw evidence tokens, compiled tokens, absolute saved, relative reduction
              net saved = raw - compiled - tool-schema cost (5,521 tokens amortised)
breadth       pre-compilation candidate count vs delivered count, per M195A: the
              bound is measured on the PRE-truncation set, and the discarded
              tail's contents are recorded, not just its cardinality
latency       compile latency, median / p90 / p95 / max
curve         budgets 1k, 2k, 4k, 8k, 16k → recall, tokens, classes, latency
```

### 4.5 Skeleton and structural proofs

- **B-SKEL.** 30 symbols stratified by size across C-MED and C-LARGE: full source
  vs support representation; token reduction, signature/type/doc/relationship
  retention, and *critical behavioural loss* judged against the E1 span. A
  skeleton that deletes what the task needs scores zero regardless of reduction.
- **B-FLOW.** 10 fixtures with a hand-verified true path: required nodes, edges,
  ordering, cross-file transitions, concrete call-site evidence, **false edges**.
- **B-IMPACT.** 10 changed-symbol fixtures with hand-enumerated consumers:
  direct, transitive, tests, config/docs, false positives, boundedness, call-site
  rendering.

Fixtures are authored from the corpora before any VTRACE output is inspected.

---

## 5. Frozen go/no-go thresholds

`VTRACE_CONTEXT_COMPILER_THESIS_SUPPORTED` requires **all** of:

```
G1   Track A: >= 10 of 15 claims MATCH or EXCEED,
     AND A8 ingestion completeness >= 99% on every measured corpus
G2   Track B B0 materiality gate PASSED on some available corpus
G3   E1 ∪ E2 critical evidence recall >= 90%   (target 95%)
G4   median model-facing repository-context reduction >= 70%,
     measured against 4.2's denominator, net of the compiled output's own cost
G5   invented / strengthened structural claims == 0
G6   p90 compile latency <= 500 ms warm on C-LARGE
G7   budget curve monotone: 0 violations over 20 tasks x 5 budgets
```

**G1 and G8 are hard.** A8 is a veto: an engine that cannot represent the
repository cannot be said to compile it, whatever the other rows say.

```
G8   VETO — any of these fails the milestone outright:
     ingestion completeness < 99% on a measured corpus
     any invented structural claim
     any non-deterministic measurement
```

**Minimum economically meaningful effect (§55), frozen for the eventual M199:**
a same-solve-rate outcome must displace **≥ 20,000 model-facing tokens per task
at the median, or ≥ 25% of total per-task tokens**, net of VTRACE's own
prompt-prefix and response cost. A 5% reduction is explicitly declared
insufficient.

---

## 6. Instruments M197 must build

```
run_stage5_m197_track_a_claims.ts        A1-A15, one JSON row per claim
run_stage5_m197_track_b_compile.ts       phase 1: compile + hash, trajectory-blind
run_stage5_m197_track_b_score.ts         phase 2: taxonomy + recall + truth audit
run_stage5_m197_fixtures.ts              flow / impact / skeleton fixtures
run_stage5_m197_report.ts                verdict assembly, fails closed on any gap
```

Each fails closed on a missing corpus, a hash mismatch, a non-deterministic
repetition, or a phase-2 process able to reach a phase-1 input. Silent
truncation of coverage is a failure, not a smaller result (M164).

---

## 7. Stop consequences, frozen

If `VTRACE_CONTEXT_COMPILER_THESIS_NOT_SUPPORTED` — including via
`TRACK_B_CORPUS_INADEQUATE` — the preregistered consequence is:

> Stop development of VTRACE as a general coding-agent accelerator unless
> genuinely new external evidence justifies another thesis.

and specifically **do not**: build a runtime debugger, reopen I5, reopen I6,
invent I7, add another orientation packet, or continue tuning retrieval.

If `VTRACE_CONTEXT_COMPILER_THESIS_SUPPORTED`, then and only then:

```
M198_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_LICENSED
```

M197 does not restructure anything. M196 has not licensed M198.
