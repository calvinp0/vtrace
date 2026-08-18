# M161 — Fresh paired coding-agent utility qualification

**Execution verdict: PASS.** A · B · C · D · E all PASS.
**Product utility verdict: POSITIVE — scoped to orientation efficiency.**
**Strategic gate: `UTILITY_POSITIVE`. Extension: `DO_NOT_EXTEND`.**

Product code changed: **NO** — `git status --porcelain src/` empty throughout.
Branch `main`, not pushed, no co-author trailers, pre-existing ledger dirt preserved.

---

## The question, and the answer

> Does the current VTRACE product improve a coding agent's end-to-end performance,
> efficiency or behaviour relative to the same agent without VTRACE-selected context?

**It does not help the agent solve more tasks. It reliably helps the agent get
there with less work, at the same price.**

| | baseline | VTRACE |
| --- | ---: | ---: |
| **resolved** | **19 / 30** | **19 / 30** |
| median tool calls | 15 | **10** |
| median searches | 4.5 | **3** |
| median first-edit position | 6 | **4** |
| median turns | 38 | **26** |
| gold file reached before first edit | 29 / 30 | **30 / 30** |
| total tokens | 49.9 M | 44.0 M |
| total cost | $21.23 | $19.84 |

Paired matrix over all 30 pairs, **0 incomplete**:

| baseline | VTRACE | | count |
| --- | --- | --- | ---: |
| PASS | PASS | shared success | 18 |
| FAIL | PASS | **VTRACE unique win** | **1** |
| PASS | FAIL | **VTRACE unique loss** | **1** |
| FAIL | FAIL | shared failure | 10 |

Net unique wins **0**. Discordant pairs **2**, exact two-sided p = **1.0**.

---

## The three things worth knowing

### 1. Top-1 correctness buys efficiency, not solutions

This is the §107 question the milestone existed to answer, and the answer is clean.
All deltas are **within-task paired** (VTRACE − baseline on the same instance), so
task difficulty is controlled by construction.

| lead quality | n | baseline PASS | VTRACE PASS | wins | losses | median token Δ | median search Δ | median turn Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `LEAD_GOLD` | 14 | 9 | 9 | 0 | 0 | **−163,746** | −1 | **−4.5** |
| `LEAD_WRONG_GOLD_ELSEWHERE` | 7 | 6 | 5 | 0 | 1 | +71,314 | −1 | −2 |
| `LEAD_WRONG_NO_GOLD` | 8 | 4 | 5 | 1 | 0 | +71,465 | +1 | −2.5 |
| `VALID_EMPTY` | 1 | 0 | 0 | 0 | 0 | −328,614 | +2 | −8 |
| `TREATMENT_UNAVAILABLE` | 0 | — | — | — | — | — | — | — |

When VTRACE leads correctly the agent spends **164k fewer tokens and 4.5 fewer
turns** on the same task. When it leads wrongly the agent spends ~71k more. And the
solve rate in the correct-lead stratum is **9/14 in both arms — identical**.

So Top-1 is a real efficiency lever and **not** a solve-rate lever. Optimising it as
a proxy for product utility would be optimising the wrong outcome (§108).

### 2. A wrong lead is almost entirely harmless

Of the **15 wrong-lead cases**, the agent **ignored the lead in 13** and edited gold
instead; **11 of 15 resolved anyway**. Only **2** edited the wrong lead — and both
are **shared failures**, where the baseline failed independently on different wrong
files.

**Unique harm caused by lead anchoring: 0.**
**False-absence cases: 0** across all 30 runs, with the detector shown to fire on a
synthetic positive, so the zero is a measurement rather than a silent probe (§123).

§146 requires a repeated pattern of wrong-lead anchoring causing losses the baseline
avoids before a lead-selection milestone is justified. That pattern does not exist
here.

### 3. Both discordant pairs are agent variance, not context effects

Reporting these accurately matters more than the count, because a 1-1 split invites
being read as "one win, one loss, wash" when neither is about retrieval.

**`sympy-13615` — the "win".** The baseline ran 111 turns under budget, found the
gold file at tool call 2, edited it twice, then made `git stash && pytest` its
**final action (call 46 of 47)** and never popped the stash. Its captured patch was
empty. VTRACE's treatment on this case was `LEAD_WRONG_NO_GOLD` — it led with
`sympy/stats/rv.py` and **delivered no gold file at all**. Crediting this to
retrieval would be crediting context that did not contain the answer.
**Confidence HIGH that VTRACE context did not cause it.**

**`sphinx-10673` — the loss.** The lead was wrong and 2 of 3 gold files were
delivered, which looks like anchoring. It is not: **both arms edited the identical
two files**, both missed the same third gold file, both touched gold at call 1
before any edit, and both ran exactly 7 searches. The VTRACE arm simply wrote a
worse patch on the same targets. File selection did not differ, so retrieval cannot
be the cause. **Confidence MEDIUM** — the file evidence is decisive, but why one
patch is right and the other wrong is not recoverable from tool-call telemetry.

---

## Treatment availability — a real product metric

Over the **original frozen 30** (§35, denominator never shrunk):

| state | count |
| --- | ---: |
| `VALID_NONEMPTY` | 29 |
| `VALID_DELIVERY_EMPTY` | 1 |
| `DEGRADED_VALID` | 0 |
| `TREATMENT_UNAVAILABLE` | **0** |
| `CORPUS_INVALID` | 0 |
| **valid treatment rate** | **30 / 30 = 100%** |

M155 was 27/30 on its frozen corpus. M156's containment of per-file parse failures
**generalized to unfamiliar repositories** rather than being specific to the corpus
it was built against. The single empty delivery is the product correctly declining:
*"Capsule v2 recovered no high-confidence pivot; nothing actionable to inject."* The
agent ran normally and was graded normally.

---

## Efficiency, stated honestly

**Work falls reliably. Money does not.**

| metric | pairs VTRACE lower | pairs higher | median Δ | total Δ |
| --- | ---: | ---: | ---: | ---: |
| turns | 18 | 8 | **−3** | — |
| tokens | 14 | 16 | **+24,068** | −5.9 M |
| cost | 13 | 17 | **+$0.017** | −$1.39 |

Turn and tool-call reductions are consistent. Token and dollar deltas are close to a
coin flip per task, and the aggregate saving comes from a couple of large outliers,
not a per-task effect. §57 requires total workflow tokens to fall for a
token-reduction claim; they do in aggregate (−11.8%) but **not** at the median, and
that ambiguity is the honest reading rather than the favourable one.

**VTRACE preparation, kept separate from agent cost (§58, §59):** median index build
**42 s** per task (mean 56 s, p90 115 s); injected context **~3,077 tokens** median.
That preparation time is a real cost the agent-side numbers do not show.

Why fewer turns did not become fewer tokens: the injected capsule is re-read on
every turn through the cache, so a shorter run over a larger prefix roughly cancels.

**Unmeasurable under this protocol (§61) — marked UNAVAILABLE, never zero:** VTRACE
MCP calls, `get_code_context` calls, `get_impact_graph` calls, voluntary invocation,
VTRACE-vs-grep sequencing. The agent ran with `--strict-mcp-config` against an empty
server list; no VTRACE tool was callable.

---

## Corpus and protocol

Fresh, unconsumed, and frozen before the product was ever pointed at it.

| | |
| --- | --- |
| population | SWE-bench Verified, 500 rows, content-hash bound to the bytes M160 read |
| consumed | Broad100-A 100 + Broad100-B 100 = 200, reconstructed mechanically |
| eligible | **300**, metadata exclusions **0** |
| drawn | 120 = 100-case extension set + 20-case predeclared reserve |
| live sample | **paired30**, a strict prefix; manifest hash `e7a15757…` |
| overlap with A / B | **0 / 0**, asserted |
| repositories | 8 — django 6, sympy 6, sphinx 5, matplotlib 4, sklearn 4, xarray 2, pytest 2, astropy 1 |
| max repo share | **20.0%** (Broad100-A was 44% django) |
| integrity gate | **50/50 VALID**, 0 retries needed |
| model | `claude-opus-4-5-20251101`, identical in both arms |
| caps | 250 turns, $3/task — **no run approached either** |
| arm schedule | alternating by frozen rank, hash `513b1b1b…` |
| reruns | **0** — no infrastructure failure occurred |
| sweep wall time | 22:13 → 01:20 (~3h07m) |

### The treatment is deliberately not historical-treatment identical

The historical Stage 5 VTRACE arm shipped the capsule wrapped in **five
benchmark-authored agent-policy blocks** — `STAGE5_TOKEN_DISCIPLINE`,
`PIVOT_CHECK`, `EDIT_GUARD`, `PATCH_VERIFY`, and a trailing *"use the vtrace context
above to orient before broad search"*. All five are authored in the benchmark
runner, not `src/`. On the captured injection they were **2,516 bytes of policy
against 12,249 bytes of evidence (17%)**.

`EDIT_GUARD` and `PATCH_VERIFY` reference nothing from the capsule at all: generic
"plan your edit, verify your patch" instructions handed to one arm only. Left in,
every efficiency delta and every anchoring finding above would have been
attributable to an instruction rather than to the evidence.

M161 disabled all five in both arms and kept the product's own Capsule v2 digest
decision contract (`src/capsuleV2/`). **M161's absolute numbers are therefore not
directly comparable to M155's paired-30.** Nothing was deleted or modified; the
milestone only declined to inject.

Four of the five were found by **reading the snapshot the first smoke run actually
injected**, not by inspection of the runner. That snapshot is committed as the
known-positive control.

---

## Safety and preservation

| | |
| --- | --- |
| behavioural routing | OFF in both arms |
| duplicate support deliveries | 0 |
| `<module>` deliveries | 0 |
| index writes to the product repo | 0 |
| session isolation | valid — per-arm run-label workspaces, no shared path |
| `.vtrace` staged | 0 |
| prompt parity | verified: arms differ only by the injected evidence block |
| baseline VTRACE evidence | 0 bytes, verified from the adapter's own stderr |
| source-integrity failures | 0 |
| treatment-invalid runs | 0 |
| allowed reruns used | 0 |

**Verification:** `bun test` 4943 pass / 49 skip / 0 fail on an idle machine; both
typechecks clean; `git diff --check` clean. No load-induced failures — the suite was
never run concurrently with the sweep.

---

## Harness defects found and fixed (§125)

Three, all in benchmark instrumentation, **none in product behaviour**. Recorded in
`stage5_m161_harness_defects.json` with root cause and known-positive control.

- **D1** — the VTRACE arm carried four undeclared agent-policy blocks. Caught before
  the sweep; treatment narrowed; no measurement affected.
- **D2** — a deliberate no-deliver policy skip was classified as a product
  availability failure. The classifier read `vtraceIndexedContext === false` as "no
  index was produced"; that field is a *delivery* signal, false whenever the product
  declines to deliver. **This is the M155 misclassification inverted** — M155 filed a
  product failure as an empty delivery, this filed the product's good judgement as a
  failure. No live run affected.
- **D3** — an unpopulated sweep classified as 30 valid empty deliveries. A valid
  empty delivery is a claim about a run and now requires a run to point at.

Two of the three are the same error in opposite directions: **a signal meaning
"nothing was delivered" read as "nothing worked."**

---

## Answers to the questions §145 requires

> **Did injected VTRACE context improve coding-agent success?**
> **No.** 19/30 in both arms. Both discordant pairs are agent variance. At two
> discordant pairs this is uninformative about direction, not evidence of no effect.

> **Did it improve efficiency even where success rate did not move?**
> **Yes, for agent work.** Median tool calls 15 → 10, searches 4.5 → 3, turns 38 →
> 26, first edit at position 6 → 4, gold reached before first edit 29/30 → 30/30.
> **No, for tokens and money** — those are a coin flip per task, and VTRACE adds a
> median 42 s of index build.

> **Did wrong VTRACE leads materially harm agents when useful evidence existed
> elsewhere?**
> **No.** Agents ignored the wrong lead in 13 of 15 cases; the 2 that acted on it
> were shared failures. Zero unique harm from anchoring, zero false-absence cases.

> **Is another retrieval / lead-selection feature milestone justified by end-to-end
> evidence?**
> **No.** §146's precondition — repeated wrong-lead anchoring causing losses the
> baseline avoids — does not hold. §147's abstention precondition does not hold
> either: wrong-lead and no-gold contexts produced no repeated harm. §148's
> acquisition precondition does not hold: the 10 shared failures are not
> concentrated in gold-absent contexts.

---

## Recommended next direction

**Stop tuning retrieval for solve rate.** Four milestones of deterministic retrieval
work preceded this one, and the end-to-end evidence says the product's demonstrated
value is **orientation efficiency**, not task resolution. Top-1 correctness buys
work reduction and buys no additional solutions.

Two experiments are worth more than 70 more paired runs:

1. **Policy ablation** — M161 stripped five benchmark-authored policy blocks to
   isolate the evidence. Whether they help is now open, cheap, and is the question
   the historical Stage 5 numbers were silently answering.
2. **Callable tools** — §149 is explicit that injection being neutral does not imply
   callable tools would help. That needs its own experiment; M161 can say nothing
   about it.

**Do not create M162 automatically.**
