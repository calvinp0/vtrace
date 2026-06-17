# Stage 5 — M36: Live A/B for the M35 Multi-Pivot Action Plan

A live-agent A/B isolating ONE variable — the M35 Multi-Pivot Action Plan section —
via the M36.1 rendering-only toggle. Two arms, identical in every other respect
(retrieval, ranking, candidate generation, pivots, scoring are byte-identical between
arms; only the rendered action-plan section differs):

- **control** — `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0` (no action-plan section)
- **treatment** — default env (M35 action-plan section rendered at the top of the capsule)

Core question (mechanism, not headline resolution): **does the action plan make the
agent inspect/edit the required SECONDARY co-edit pivot more often?** Secondary
question: does that convert to canonical resolution?

Matrix: 2 instances × 2 arms × 3 replicates = **12 protocol runs** (the spec's preferred,
fully-powered matrix — NOT underpowered), then canonical Docker evaluation on those 12
labels. No pivot revision, no diagnostic verifier, no pivot-inspection enforcement, no
`--allow-docker-verify`. All 12 protocol runs and all 12 Docker evals completed (exit 0).

Gold files (oracle, from the dataset gold patch — used ONLY to label which secondary was
the required co-edit; never an input to retrieval or the plan):

| Instance | Lead gold | Required secondary co-edit | FAIL_TO_PASS |
| --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | `sphinx/domains/python.py::_parse_annotation` | `sphinx/pycode/ast.py::unparse` | 2 |
| mwaskom__seaborn-3187 | `seaborn/_core/scales.py` | `seaborn/utils.py` (`get_view_interval`/`spacer`) | 2 |

> Note: an earlier brief named `seaborn/_core/properties.py` for seaborn; the actual gold
> lead is `seaborn/_core/scales.py` and the secondary co-edit is `seaborn/utils.py`. This
> report uses the dataset gold patch as the oracle.

## 1. Executive verdict

- **Did M35 improve multi-pivot actionability? No.** The mechanism target — editing the
  required secondary co-edit pivot — was **unchanged**: secondary-edit rate 3/6 in BOTH
  arms (sphinx 0/3 both; seaborn 3/3 both). The only movement was secondary *inspection*
  on sphinx (control 2/3 → treatment 3/3), a one-run bump that did **not** convert to a
  single additional edit or resolution.
- **Did it improve resolution? No** (slightly lower, within noise). Resolved: control
  **3/6 (50%)** vs treatment **2/6 (33%)**. The one-run gap is a seaborn-r1 patch-synthesis
  miss (treatment edited BOTH gold files but the patch content failed FAIL_TO_PASS) — not a
  co-edit that the plan failed to surface. With n=3 per instance this is noise, not a
  causal regression.
- **Did it increase tool/token burden? Marginally.** The plan adds ~**155–157 tokens** to
  the injected block (median injectedContextTokens 2869 → 3025). Tool calls, turns, and
  cost were otherwise comparable or slightly *lower* in treatment (it converged sphinx to
  identical, more-decisive — but still wrong — patches).

Bottom line: on these two genuine M32 multi-pivot failures, the action plan changed the
agent's *reading* slightly but not its *editing*, and did not move resolution. The
bottleneck is **not salience** of the secondary pivot.

## 2. Run matrix

All 12 protocol runs valid (context injected, patch produced); all 12 Docker-evaluated.

| # | label | instance | arm | rep | valid | plan rendered | patch files | resolved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | eval-m36-control-sphinx-7462-r1 | sphinx-7462 | control | 1 | ✓ | no | python.py | no |
| 2 | eval-m36-control-sphinx-7462-r2 | sphinx-7462 | control | 2 | ✓ | no | python.py | no |
| 3 | eval-m36-control-sphinx-7462-r3 | sphinx-7462 | control | 3 | ✓ | no | python.py | no |
| 4 | eval-m36-treatment-sphinx-7462-r1 | sphinx-7462 | treatment | 1 | ✓ | yes (157t) | python.py | no |
| 5 | eval-m36-treatment-sphinx-7462-r2 | sphinx-7462 | treatment | 2 | ✓ | yes (157t) | python.py | no |
| 6 | eval-m36-treatment-sphinx-7462-r3 | sphinx-7462 | treatment | 3 | ✓ | yes (157t) | python.py | no |
| 7 | eval-m36-control-seaborn-3187-r1 | seaborn-3187 | control | 1 | ✓ | no | scales.py, utils.py | **yes** |
| 8 | eval-m36-control-seaborn-3187-r2 | seaborn-3187 | control | 2 | ✓ | no | scales.py, utils.py | **yes** |
| 9 | eval-m36-control-seaborn-3187-r3 | seaborn-3187 | control | 3 | ✓ | no | scales.py, utils.py | **yes** |
| 10 | eval-m36-treatment-seaborn-3187-r1 | seaborn-3187 | treatment | 1 | ✓ | yes (155t) | scales.py, utils.py | no |
| 11 | eval-m36-treatment-seaborn-3187-r2 | seaborn-3187 | treatment | 2 | ✓ | yes (155t) | scales.py, utils.py | **yes** |
| 12 | eval-m36-treatment-seaborn-3187-r3 | seaborn-3187 | treatment | 3 | ✓ | yes (155t) | scales.py, utils.py | **yes** |

Toggle behaved exactly as designed in the live path: every control snapshot has **0**
`## Multi-Pivot Action Plan` headings; every treatment snapshot has the section
(155–157 estimated tokens). Retrieval/ranking/pivots were identical between arms.

## 3. Sphinx mechanism analysis — `ast.py::unparse`

This is the case the plan was built for: the fix requires editing both
`python.py::_parse_annotation` (lead, issue-anchored) and `ast.py::unparse` (secondary).
Both are surfaced as pivots; in treatment the plan elevates `ast.py::unparse` to the
numbered required-inspection set at the very top of the capsule.

Result — the plan moved inspection but **not** editing:

| metric | control | treatment |
| --- | --- | --- |
| `ast.py` inspected (read/grep) | 2/3 | **3/3** |
| `ast.py` edited | **0/3** | **0/3** |
| stopped after only `python.py` | 3/3 | 3/3 |
| resolved | 0/3 | 0/3 |
| median tool calls | 8 | 7 |
| median turns | 25 | 20 |

- In every treatment run the agent **inspected** `ast.py::unparse` (Grep/Read) — the plan
  reliably drew its attention there — but in all 6 sphinx runs (both arms) it **edited only
  `python.py`** and finalized. All three treatment patches converged to an *identical*
  1012-char `python.py`-only patch (control varied: 1489/1450/1012 chars) — the plan made
  the agent more decisive, but decisively wrong.
- Mechanistic read: on sphinx the secondary pivot is already in context AND already gets
  inspected; the failure is the agent's **edit decision** (it reads `unparse`, judges the
  `python.py` change sufficient, and stops). Raising salience does not fix a wrong
  edit-sufficiency judgment. `retrieval_success_action_failure` in all 6 sphinx runs.

## 4. Seaborn negative-control analysis — `utils.py`

Seaborn is a built-in negative control: the required co-edit `seaborn/utils.py` is **not a
pivot**. In every run it is surfaced only as **support**, and under the wrong symbol
(`utils.py::load_dataset`, not the gold `get_view_interval`/`spacer`). The two pivots are
`scales.py::_setup` (gold lead) and `relational.py::scatterplot` (**non-gold**).

Consequence for the plan: because it is driven by pivot ranking, the treatment action plan
lists `scales.py` + **`relational.py`** — it never mentions `utils.py`. So on seaborn the
plan **elevates the wrong secondary**:

```
Required inspection set:
1. seaborn/_core/scales.py::_setup (lead pivot) — ...explicit edit site
2. seaborn/relational.py::scatterplot (pivot) — actionable function...   <-- non-gold distractor
```

Yet the agent edited `scales.py` + `utils.py` in **all 6 seaborn runs (both arms)** and
ignored the plan's `relational.py` suggestion — it found `utils.py` through its own
exploration, independent of M35.

| metric | control | treatment |
| --- | --- | --- |
| `utils.py` surfaced as | support (not pivot) | support (not pivot) |
| `utils.py` edited | 3/3 | 3/3 |
| resolved | **3/3** | 2/3 |
| median tool calls | 23 | 17 |
| median turns | 66 | 51 |

The treatment shortfall is run r1: it edited BOTH gold files but the patch content failed
FAIL_TO_PASS (`retrieval_success_synthesis_failure`) — a synthesis miss, not a co-edit the
plan failed to surface. seaborn confirms M35's mechanism does not apply when the gold
co-edit is mis-ranked as support; the co-edit's success here is **not attributable to M35**.

## 5. Aggregate A/B table

Rates over the 6 valid runs per arm (3 sphinx + 3 seaborn):

| metric | control | treatment | delta |
| --- | --- | --- | --- |
| secondary-pivot **inspected** rate | 5/6 (83%) | 6/6 (100%) | +1 run (sphinx) |
| secondary-pivot **edited** rate | 3/6 (50%) | 3/6 (50%) | **0** |
| **resolved** rate | 3/6 (50%) | 2/6 (33%) | −1 run (seaborn synth) |
| median tool calls | 10.5 | 13 | +2.5 |
| median reads | — | — | comparable |
| median injectedContextTokens | 2869 | 3025 | **+155** (the plan) |
| median input tokens (uncached) | 219.5 | 261.5 | +42 |
| median cost (USD) | 0.537 | 0.506 | −0.03 |
| median turns | — | — | lower in treatment |

(Per-instance medians in the JSON; aggregate tool-call median rises because treatment
sphinx is lower but treatment seaborn is lower too — the +2.5 is a cross-instance mix
artifact, not a within-instance increase. Within each instance, treatment median tool
calls and turns are ≤ control.)

## 6. Failure / regression analysis

- **Actionability failure (dominant):** sphinx, 6/6. Secondary pivot surfaced AND inspected
  (more so in treatment) but never edited. The plan does not change the edit decision.
- **Patch-synthesis failure:** seaborn treatment-r1, 1/6. Both gold files edited; content
  failed FAIL_TO_PASS. Stochastic synthesis variance (n=3); not a co-edit miss.
- **Retrieval / co-edit evidence failure:** seaborn, structural. The gold co-edit
  `utils.py` is ranked as support, not a pivot, and under the wrong symbol — so the plan
  cannot target it and instead elevates the non-gold `relational.py`. This is the ranking
  gap, untouched by M35 (and out of M36 scope).
- **Overhead regression:** mild. +155 injected tokens per treatment run for zero edit/
  resolution benefit on these cases. Cost/turns were not worse (slightly better), so the
  overhead is token-footprint only, not wall-clock or dollar.
- **Stochastic/inconclusive:** none invalid; all 12 produced patches and evaluated.

## 7. Recommendation

**C — M35 does not improve actionability; investigate co-edit evidence/ranking next,
especially seaborn `utils.py`.**

The mechanism target (secondary-pivot *editing*) was flat at 3/6 in both arms, and
resolution did not improve. The two instances point at two distinct, ranking/decision-level
bottlenecks that salience cannot fix:

1. **seaborn — ranking gap.** The gold co-edit `utils.py` is surfaced as *support* under
   the wrong symbol, so the action plan (pivot-driven) elevates the non-gold
   `relational.py` instead. The next lever is co-edit *evidence/ranking*: get
   `utils.py::get_view_interval`/`spacer` ranked as a pivot (or attached as a co-edit hint)
   so any downstream salience aid can target the right file.
2. **sphinx — edit-decision gap.** `ast.py::unparse` is surfaced AND inspected even more
   reliably under treatment, yet never edited. The bottleneck is the agent judging the
   `python.py` edit sufficient — a synthesis/decision problem, not a visibility one.

Secondary notes (do not change the single recommendation): the +155-token overhead bought
no edit/resolution gain here, and treatment was one resolution lower (within n=3 noise), so
this evidence does **not** support flipping the default broadly. The M36.1 toggle already
keeps the section gated, so no rollback is needed — leave it available, default unchanged,
and pursue the co-edit ranking work before any wider rollout or 10-instance benchmark.

---

### Methodology / reproducibility

- Protocol: `--mode run-protocol --protocol vtrace-indexed --capsule-intent auto
  --capture-product-v2-accounting --disable-pivot-check`, control with
  `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0`, treatment default. Sequential (shared
  `_agent_stream.jsonl`).
- Evaluation: `--mode evaluate --eval-mode docker` per label (canonical SWE-bench; NOT the
  diagnostic verifier; no `--allow-docker-verify`).
- Analysis: `run_stage5_m36_live_ab_multi_pivot_action_plan.ts` (offline, read-only) reads
  each label's `swebench-*.jsonl` (patch/turns/cost), `_tool_calls.json` (inspection),
  `_eval.meta.json` (resolution), `_run.meta.json` (pivots/injection), and the immutable
  `_vtrace_instructions.snapshot.md` (action-plan rendering + M34 token accounting via
  `buildProductV2Accounting`). Functional labels via `classifyFunctionalActionability`.
- Outputs: this report, `stage5_m36_live_ab_multi_pivot_action_plan.csv` (per-run),
  `stage5_m36_live_ab_multi_pivot_action_plan.json` (per-run + aggregates).
- Not modified: no scoring/ranking/retrieval/candidate-generation change; no pivot revision;
  no pivot-inspection enforcement. Source code unchanged except the additive analysis script.
