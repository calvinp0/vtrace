# M161 — Fresh paired coding-agent utility qualification

**Frozen:** 2026-08-18. **Predecessor:** M160 (`3ae72d007b6e606ed40fb9ba8f085cb8a76a6761`).
**Product freeze:** post-M160 state; `git status --porcelain src/` empty throughout.

---

## Why this milestone is not another retrieval milestone

M157 asked whether delivery was the bottleneck. It mostly was not. M158 asked
whether support packing was the bottleneck. It was not. M159 asked where residual
failures first occur. They were heterogeneous. M160 asked whether the largest
causal theory generalizes to an unfamiliar corpus. It did not — the subject→owner
bridge recovers **0 of 6** on the very corpus that inspired it, and M160's verdict
was `NO_SINGLE_DOMINANT_CEILING` / **NOT REPLICATED — do not build**.

Four milestones have now improved, ruled out, or failed to replicate a retrieval
mechanism without anyone measuring whether the retrieval helps a coding agent at
all. M161 does not ask what to build next. It asks:

> **Does the product, as it now exists, materially help the coding agent?**

Freeze the product. Freeze a fresh corpus. Run the same agent both ways.

The specific unresolved fact that makes this urgent: across two independent
corpora, `gold anywhere` is stable (89% → 87%) while Top-1 falls hard (58% → 41%).
The product finds the right file at nearly the same rate on unfamiliar tasks and
**leads with the wrong one far more often**. Whether an agent cares is not
answerable from a retrieval metric (§8).

---

## Treatment definition — and where M161 departs from history

The historical Stage 5 treatment was **capsule evidence + a `STAGE5_TOKEN_DISCIPLINE`
search/edit policy**. That block is vtrace-only, default-ON, and tells the agent to
*patch first, not rediscover with grep*, to spend *at most N searches before the
first edit*, and *not to run broad recursive grep once the capsule names a pivot*.

M161's treatment is **capsule evidence only**. The block is disabled in both arms.

- **Why.** §26 defines M161's subject as the utility of the injected *context*, and
  §30 forbids instructing the VTRACE arm to avoid broad search. The runner's own
  comment calls the block "NOT a user-facing product mode" — it is benchmark
  scaffolding, not the product being qualified. Left on, every §64/§66/§70 anchoring
  finding and every §113 efficiency delta would be attributable to an explicit
  instruction rather than to the evidence, and §109's "a lead-selection milestone is
  now justified" conclusion would rest on a confound.
- **What is NOT done.** The historical implementation is not deleted or modified.
  M161 declines to inject it and records the divergence.
- **What it costs.** M161's absolute numbers are **not directly comparable** to
  M155's paired-30, which carried the block.
- **What stays.** The Capsule v2 digest decision contract (M112) is retained: it is
  product delivery, shipped default-ON, and it does not suppress search — it says
  "a Search/Grep hit is not enough; inspect/read the file" and "inspect optional
  context and search as needed".
- **Follow-up.** A token-discipline policy ablation is a separate experiment, to be
  considered only after the capsule-only utility result.

So:

```text
baseline  = normal agent + normal tools
vtrace    = normal agent + normal tools + VTRACE capsule
diff      = the injected VTRACE evidence block, and nothing else
```

VTRACE is **not** exposed as callable tools: the agent is launched with
`--strict-mcp-config` against `{"mcpServers":{}}`. Tool discoverability, voluntary
invocation and `get_code_context` / `get_impact_graph` utility are marked
**UNAVAILABLE UNDER THIS PROTOCOL**, never zero (§26, §61).

---

## Corpus

| | |
| --- | --- |
| population | SWE-bench Verified, 500 rows, bound by content hash to the bytes M160 read |
| consumed | Broad100-A 100 (development/audit) + Broad100-B 100 (replication) = 200 |
| eligible | **300**, metadata exclusions **0** |
| drawn | 120 = **paired100** extension + **20** predeclared reserve |
| first live sample | **paired30**, a strict prefix |
| overlap with A / B | **0 / 0**, asserted mechanically from committed manifests |

The eligible pool is **58.7% django** — more concentrated than Broad100-A's 44%,
because Broad100-B's balanced quota drained every small repository. So the
repository **quota** is balanced against the pool (§16) while the **ordering** is
proportional to the drawn sample (§13): the first 30 must look like the 120, or
"extend to the pre-frozen larger set" would pool two differently-shaped samples.

Result: paired30 spans **8 repositories**, max share **django 20.0%**.

Selection consumed only instance id, repository and difficulty. A test asserts that
adding Top-1, gold state and score to every candidate changes nothing (§14).

**Integrity gate:** 50/50 VALID over paired30 + reserve, **0 needed a retry**. The
gate verifies per-path against `git ls-tree`, serializes access to each shared bench
clone, and retries 4× — M160 reproduced a `git fetch` repacking a clone while a
`git archive` streamed out of it, yielding django-12741 at 1902 of 3381 paths with
`tar` exiting 0.

---

## Workstreams

| | scope | gate |
| --- | --- | --- |
| **A** | fresh corpus, integrity gate, manifests, schedule, rerun policy, protocol freeze | §91 |
| **B** | offline validity controls + one paid smoke pair outside the frozen sample | §92 |
| **C** | 30-case paired live execution + docker grading | §93 |
| **D** | unique win/loss, lead quality, false authority/absence, token & work deltas | §94 |
| **E** | utility verdict, strategic gate, extension decision | §95 |

**C PASS means execution validity, not product utility** (§96). The utility verdict
is separate and may be negative.

---

## What M161 must not do

- No product feature changes (§3). No retrieval feature work of any kind (§7).
- No behavioural routing in either arm (§4).
- No selection or replacement conditioned on how VTRACE looks (§14, §22).
- No reruns of results, only of infrastructure failures (§43).
- No membership, prompt, limit or retrieval change after reading outcomes (§50).
- No product change between the 30 and any authorized extension (§106).
- No defending VTRACE from the answer (§153).

---

## Standing rule carried into every count

> A plausible zero is not evidence until the detector has demonstrated a known
> positive (§123).

Every M161 detector — pool exclusions, integrity failures, treatment states, lead
quality, prompt parity, baseline evidence leakage — ships with a synthetic positive
that makes it fire. Counts that rest on a silent detector are not reported as
findings.
