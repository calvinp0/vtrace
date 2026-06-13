# Stage 5 — Product Capsule v2 milestone reconciliation

Generated: 2026-06-13. Follow-up to the VTRACE-vs-VEXP feature-parity audit
(commit `fe277fc`, `stage5_vtrace_vs_vexp_feature_parity_audit.{md,json}`). This is
a **reconciliation**, not a new audit: it measures the work done since `fe277fc`
against the five milestones that audit named, and decides the next product step.
No code or behavior is changed in this task; all evidence is cited against tracked
Stage 5 artifacts and the commit log `fe277fc..HEAD`.

Read-only. No agents, Docker, retrieval, or telemetry changes were run.

---

## 1. Executive conclusion

**Milestone status, in one line each:**

- **M1 (Capsule v2 on MCP / run_pipeline):** plumbing **complete but opt-in** —
  `capsule_engine=v2` exists on `get_context_capsule` and `run_pipeline`; the
  default path is still v1 and byte-compatible. Not default-on.
- **M2 (tokens used/saved + latency per tool response):** **complete as an
  estimate** — an `accounting` block (emitted tokens, naive-full-file baseline,
  clamped savings, latency) is attached to single-repo product responses. It is a
  `chars/4` estimate, not tokenizer truth, and multi-repo is deferred.
- **M3 (per-hop / per-caller excerpts):** **engine complete, inert on the default
  path.** `search_logic_flow`/`get_impact_graph` excerpts are wired and bounded
  (positive control confirms), but on the shaped debug/auto gate queries neither
  section fires, so zero excerpts reach the first response. `pivotNeighborhood`
  was added as the always-on substitute.
- **M4 (turn-reduction validation on the 4 overhead cases):** **open / not
  achieved.** Only matplotlib-22719 produced live telemetry, and every live
  product-v2 datapoint is entangled with an enforcement layer. The clean 4-case
  result does not exist.
- **M5 (unify intent systems, ungate impact for refactor intent):** **open,
  untouched.**

**What the recent canaries actually proved:** that context *generation* and
*delivery* work (bounded excerpts, neighborhood injected, offline-validated), but
that on the one live case we have (matplotlib-22719) the richer context did **not**
reduce follow-up turns or tokens — and that stacking enforcement on top of it made
things strictly worse (soft PIVOT_CHECK: +609k tokens; hard gate: blocked the solve
entirely). They did **not** prove that product-v2 context reduces turns, and they
did not disprove it either, because no clean single-shot product-v2-vs-prior
measurement was run without an enforcement layer.

**Mainline product work:** M1 (consider default-on or a clean labeled condition),
M2 (accounting), M3-as-pivotNeighborhood, and M5. These keep the normal single-shot
agent workflow, the same tools, and the same patch/evaluate protocol with VTRACE as
a pure context provider.

**Diagnostic / protocol-only (must NOT back headline claims):** the soft
PIVOT_CHECK / context-to-action enforcement, the hard pivot-check gate, the
two-phase read-only preflight, and the `strong_context_patch_first` token-discipline
injection. All of these change the agent's solve protocol.

**Do we need another broad audit now?** **No.** The parity audit's gap map still
holds; nothing here invalidates it. What is missing is not more surface analysis —
it is one clean, headline-comparable measurement and a tidy-up of run labels so
diagnostic runs stop reading as product wins.

---

## 2. Original audit milestone status

| Milestone | Orig. priority | Current status | Evidence | Remaining gap | Next action |
| --- | --- | --- | --- | --- | --- |
| **M1** — Wire Capsule v2 into MCP `get_context_capsule`/`run_pipeline` (token-budgeted pivots + supports + skeletons + impact/memory in one response) | P0 / Rank 1 | **partial (complete-but-opt-in)** | `814568a` (MCP `capsule_engine=v2` via `productAdapter`), `4e1828a` (run_pipeline `--capsule-engine v2`, `contextEngine=v2` discriminator). Default stays v1, byte-compatible. | Not default-on; v2 product envelope still lacks the unified impact/memory-in-one-response shape M1 described (it carries pivots/support/budget/diagnostics, not the full single-call assembly). Multi-repo v2 rejected. | Decide default-on vs. keep as a labeled benchmark condition; either way measure it clean (see §8). |
| **M2** — Tokens used / saved / latency in every product tool response | P0 / Rank 2 | **complete (estimated)** | `714af96` — `src/metrics/contextAccounting.ts`; `accounting` block on `get_context_capsule` (v1+v2), `run_pipeline`, `get_code_context`. Reports emitted tokens, naive-full-file baseline, clamped savings + %, latency, skipped files. | `chars/4` estimate, not tokenizer truth; single-repo only; "saved vs naive full-file read" is a synthetic baseline, **not** a measured turn-level saving. | Keep as estimate; do not let the accounting `%` stand in for a measured turn/token reduction. |
| **M3** — Per-hop excerpts in `search_logic_flow`, per-caller excerpts in `get_impact_graph` | P1 / Rank 3 | **partial (engine done, inert on default path)** | `2f6f229` — `src/source/sourceExcerpt.ts`, excerpts on flow/impact, bounded (≤lines/≤chars). Positive control on `django-11095`: impact 10 excerpts (budget), flow 1 excerpt, bounds respected (`stage5_product_v2_excerpts_turn_reduction.md`). | On the 4 shaped debug/auto gate queries, flow is skipped (`not_enough_endpoints`) and impact is skipped (`not_refactor_like`) → **0 excerpts on the first response** for all 4. Feature never reaches the default debug path. | Covered tactically by `pivotNeighborhood` (`2b70e76`, always-on under v2); root cause needs M5 (ungate impact for refactor intent). |
| **M4** — Turn-reduction validation on the 4 overhead cases (matplotlib-22719, astropy-14369, django-10880, django-11095) | P1 / Rank 4 | **open (not achieved)** | Harness built (`0af4d4c`, `e44176c`, `1e2fdf3`). Live telemetry only for matplotlib-22719, and every run is entangled with an enforcement layer: neighborhood canary NOT-PROMISING (+64k tok), pivotcheck canary NOT-PROMISING (+609k tok), hard-gate run INSUFFICIENT-DATA (blocked). | No clean 4-case product-v2-vs-prior result; n=1 live, contaminated; django-10880/11095 still have no ordered-telemetry live runs. | Run one clean single-shot product-v2-vs-prior pass with **no** enforcement layer (see §8/§9). |
| **M5** — Unify `src/intent/` + `src/capsuleV2/intent.ts`; ungate impact for refactor intent | P1 / Rank 5 | **open (untouched)** | No commit in `fe277fc..HEAD` touches intent unification or the `run_pipeline` impact gate (`runPipelineOrchestrator.ts:627-685`). | Whole milestone. This is the root cause of M3 inertness on auto-intent queries. | Best candidate for the *next* product milestone after the clean M4 measurement. |

---

## 3. Recent changes since `fe277fc`

Ledger of `fe277fc..HEAD` (newest first within groups). "Headline-safe" means safe to
include in a VTRACE-vs-baseline / VTRACE-vs-VEXP *performance* comparison.

| Commit | Change | Product or benchmark? | Default-on or opt-in? | Affects normal single-shot path? | Changes agent protocol? | Headline-safe? |
| --- | --- | --- | --- | --- | --- | --- |
| `814568a` | Capsule v2 via MCP `get_context_capsule` | product | opt-in (`capsule_engine=v2`) | only when opted in | no | yes, **as a labeled condition** |
| `4e1828a` | Capsule v2 via `run_pipeline` / `get_code_context` | product | opt-in | only when opted in | no | yes, as a labeled condition |
| `714af96` | `accounting` block on product context tools | product | additive, best-effort | yes (additive field) | no | yes (but it is an *estimate*, not a measured saving) |
| `2f6f229` | Source excerpts on flow + impact | product | on when those sections fire | yes (when sections fire) | no | yes |
| `2b70e76` | `pivotNeighborhood` excerpts in run_pipeline | product | opt-in via `capsule_engine=v2` | yes when v2 (adds ~1k tok first call) | no | yes, as a labeled condition |
| `cc3cbe5` | Render pivotNeighborhood in **injected** capsule context | benchmark | benchmark injection | changes injected text only | borderline (changes context content, not tools) | yes if treated as a context variant |
| `e44176c` | Detect pivotNeighborhood / first-call investment in gate report | benchmark | report-only | no | no | n/a (reporting) |
| `1e2fdf3` | Enforce context-to-action for v2 injection (checklist) | benchmark | enforcement | injects an instruction demanding a checklist | **yes (soft protocol change)** | **no** — protocol diagnostic |
| `0af4d4c` | product-v2 turn-reduction validation harness | benchmark | harness | no | no | n/a (measurement scaffold) |
| `9cd9beb` | Add hard pivot-check gate | benchmark | enforcement | n/a | **yes (hard protocol change)** | **no** — protocol diagnostic |
| `f68d034` | Wire hard pivot-check gate into Stage 5 | benchmark | enforcement | n/a | **yes** | **no** |
| `7072836` | Sum phase-1 token components in hard-gate telemetry | benchmark | telemetry | n/a | yes (hard-gate path) | **no** |
| `3ee09a6` | Make hard pivot-check preflight read-only (two-phase) | benchmark | enforcement | n/a | **yes (two-phase protocol)** | **no** |
| `35b0157` | matplotlib token-discipline pilot result (`strong_context_patch_first`) | benchmark | injection | injects patch-first discipline | **yes (behavior change)** | **no** — diagnostic |

**Takeaway:** the genuinely product-side changes (`814568a`, `4e1828a`, `714af96`,
`2f6f229`, `2b70e76`) are additive, opt-in, and protocol-neutral — safe for a
labeled headline comparison. Everything in the enforcement family (`1e2fdf3`,
`9cd9beb`, `f68d034`, `3ee09a6`, `35b0157`) changes the solve protocol and is
diagnostic-only.

---

## 4. Stage 5 evidence chain

The matplotlib-22719 chain is the only chain with live product-v2 telemetry. Read it
as a *layered* experiment: each step added an enforcement layer on top of the
previous context, so the steps are confounded and not directly comparable to each
other. Separated by what was actually exercised:

### 4a. Context **generation** (offline, deterministic)
- `pivotNeighborhood` offline validation: all four shaped gate queries went from
  **0 → 8** bounded excerpts; first-call token increase **+980…+1161 tok/case**
  (`stage5_pivot_neighborhood_offline_validation.md`).
- Excerpt positive control (`django-11095`): impact 10 excerpts (budget cap), flow
  1 excerpt, bounds respected (`stage5_product_v2_excerpts_turn_reduction.md`).
- **Valid:** generation works and is bounded. **Diagnostic-only:** none. **Inconclusive:** none.

### 4b. Context **delivery** (offline)
- The four gate queries do **not** include flow (`not_enough_endpoints`) or impact
  (`not_refactor_like`), so the M3 excerpt feature emits **0** excerpts on the first
  response; `pivotNeighborhood` is the only excerpt path that reaches the default
  debug response.
- **Valid:** neighborhood delivery confirmed (8 excerpts injected). **Inconclusive:**
  whether flow/impact excerpts ever help on real agent-issued calls (not exercised).

### 4c. Context **use** (live, n=1, contaminated)
- pivotcheck canary: **context-to-action checklist emitted = no; neighborhood
  mentioned = no** (`stage5_product_v2_pivotcheck_canary_matplotlib.md`). The agent
  received the enriched block and did not visibly act on it.
- **Valid:** the agent did not use the block on this case. **Inconclusive:** whether a
  scannable/compacted rendering would change that (untested).

### 4d. **Performance** (live, n=1, contaminated)

| Step | Report | Verdict | total tok Δ | cache-read Δ | Read/Grep/Bash | First-call investment paid off? |
| --- | --- | --- | --- | --- | --- | --- |
| product-v2 **before** pivotNeighborhood | prior telemetry baseline `eval-product-v2-turn-reduction-4case` | (baseline) | — | — | — | — |
| product-v2 **+** pivotNeighborhood | `stage5_product_v2_neighborhood_canary_matplotlib.md` | NOT-PROMISING | **+64,127** | +4,199 | Bash 6→7 | **no** |
| **+ soft PIVOT_CHECK** | `stage5_product_v2_pivotcheck_canary_matplotlib.md` | NOT-PROMISING | **+609,097** | +639,649 | Read 1→3, Bash 7→9 | **no** |
| **+ hard pivot-check gate** | `stage5_vtrace_product_v2_turn_reduction.md` | INSUFFICIENT-DATA | n/a | n/a | n/a (blocked) | n/a |

- The hard-gate run **blocked the solve** (`edit_before_gate`, 1 file patched in the
  read-only preflight); Phase 2 never ran, no Docker evaluation. `resolved 1→0` is an
  artifact of the block, **not** a resolution loss.
- **Valid:** none of these is a clean product measurement. **Diagnostic-only:** the
  PIVOT_CHECK and hard-gate rows (protocol). **Inconclusive:** the neighborhood row
  (n=1, and the +64k swing dwarfs the ~1k first-call cost, so it is turn/stochastic
  noise, not a context-size effect).

### 4e. Protocol **enforcement** (diagnostic)
- Soft PIVOT_CHECK + context-to-action (`1e2fdf3`) and the hard gate / two-phase
  preflight (`9cd9beb`/`f68d034`/`3ee09a6`) are the enforcement layers. The hard
  gate's only live outcome was to block the run. These confirm the *machinery* works
  (it detected `edit_before_gate`) but produce **no** product-performance signal.

### 4f. Separate diagnostic — matplotlib token-discipline pilot
`stage5_token_discipline_pilot_matplotlib_22719.md` reports total tokens −56.3% and
Bash 16→5 vs the *historical* bloated run. This is **not** a controlled before/after:
it compares a `strong_context_patch_first`-injected run against an old unconstrained
run, so it mixes a behavior change with a different agent trajectory. Diagnostic
only; not a product-v2 result.

### 4g. The one clean comparison we have (different cases)
`stage5_baseline_vs_vtrace_live_comparison.md` — Capsule v2 force-injected vs
no-context, 3 retrieval-recovered cases, both Docker-evaluated: **resolution parity
(2/3 vs 2/3), identical localization (3/3 both arms), no efficiency direction.** This
is the cleanest signal in the corpus and it is neutral. Note: it is a
context-vs-**no-context** comparison, not product-v2-before vs product-v2-after.

---

## 5. Benchmark validity classification

| Result / run type | Classification |
| --- | --- |
| `run-protocol --protocol vtrace-indexed` single-shot (default v1, or v2 as a labeled condition) | **headline-comparable** — the headline path |
| `baseline` arm (`run --no-vexp`, no context) | **headline-comparable** as a *context-vs-no-context* contrast (not a product-v2 before/after) |
| product-v2 + pivotNeighborhood neighborhood canary | **product diagnostic** (n=1, additive context, but contaminated downstream) |
| soft PIVOT_CHECK / context-to-action runs | **protocol diagnostic** |
| hard pivot-check gate / two-phase preflight runs | **protocol diagnostic** |
| `strong_context_patch_first` token-discipline pilot | **protocol diagnostic** |
| `accounting` block savings `%` | **product diagnostic** (synthetic naive-full-file baseline, not a measured saving) |
| 4-case excerpts gate, hard-gate gate | **insufficient data** (excerpts inert / solve blocked) |

Explicit statements (per the correction in the task):

- **Normal single-shot `run-protocol --protocol vtrace-indexed` runs are the
  headline path.** Product-v2 must be measured there (as the default, or as a
  labeled `capsule_engine=v2` condition), with the same tools and the same
  patch/evaluate protocol.
- **Hard-gate / two-phase runs are protocol diagnostics only.** They change the solve
  protocol (read-only preflight, edit-before-gate blocking) and must not back any
  VTRACE-vs-baseline or VTRACE-vs-VEXP performance claim.
- **`run-vtrace` (and any force-inject / enforcement variant) must not be mixed into
  headline comparisons** unless explicitly justified and labeled as a distinct
  condition; the force-inject arm in §4g is acceptable only because it is clearly
  scoped as a context-vs-no-context probe.
- **The no-context baseline is useful but is not a product-v2 before/after.** It
  isolates "context vs none," not "richer context vs prior context." Treat the two
  questions separately.

---

## 6. What we learned about token reduction

Current evidence only; no new runs.

- **Did richer context reduce Read/Grep/Bash?** On the only live case
  (matplotlib-22719): **no.** Bash went 6→7 (+neighborhood) and 7→9 (+PIVOT_CHECK),
  Read 1→3 (+PIVOT_CHECK). n=1 and contaminated by enforcement, so this is
  suggestive-negative, not conclusive.
- **Did pivotNeighborhood increase first-call tokens?** **Yes, by a bounded
  ~980–1161 tokens/case** (offline-measured). This is small and predictable.
- **Did total / cache-read tokens rise because of context size, instruction
  re-read, extra turns, or protocol?** **Predominantly extra turns and protocol, not
  context size.** The first-call neighborhood cost (~1k) is two-to-three orders of
  magnitude smaller than the observed swings (+64k with neighborhood, +609k with
  PIVOT_CHECK). Cache-read scales with turn count; the big jumps line up with the
  enforcement layers and with stochastic trajectory length, not with the size of the
  injected block.
- **Can we attribute any performance change to VTRACE product behavior?** **No.** No
  clean product-v2 before/after exists; the one clean context-vs-no-context
  comparison (§4g) is resolution-neutral with no efficiency direction. Every
  product-v2 live datapoint is entangled with an enforcement layer or is n=1.
- **What remains unknown?** Whether product-v2 context (with pivotNeighborhood, no
  enforcement) reduces turns on a clean single-shot path across more than one case;
  whether a compacted/scannable rendering changes the agent's use of the block (in
  §4c it ignored the verbose block); and whether M5 (ungated impact for refactor
  intent) makes the M3 excerpt feature fire often enough to matter.

---

## 7. Current risk

- **Continuing hard-gate work and accidentally benchmarking a different agent
  workflow.** The hard gate / two-phase preflight is a protocol change; its only
  live result so far was to block a solve. Treating its telemetry as a product
  signal would compare VTRACE-with-a-different-protocol against a normal baseline.
- **Adding more context without reducing turns.** pivotNeighborhood added bounded
  first-call tokens and, on n=1, did not buy back turns. Stacking further enrichment
  risks paying the first-call cost with no turn payoff.
- **Stale / incomparable run labels.** The single label
  `eval-product-v2-turn-reduction-4case` is reused across the neighborhood, soft
  PIVOT_CHECK, and hard-gate canaries — three different protocols under one label.
  This invites mistaking a protocol diagnostic for a product result.
- **Mistaking diagnostic instrumentation for product improvement.** The `accounting`
  savings `%`, the context-to-action checklist, and the token-discipline pilot all
  *look* like wins but are estimates or protocol changes.
- **Making VTRACE look better/worse for protocol reasons, not context quality.** The
  token-discipline pilot's −56% is mostly a patch-first behavior change; the
  hard-gate "resolved 1→0" is a block, not a regression. Either could be misread as a
  context-quality verdict.

---

## 8. Recommended next step

**Primary recommendation — compact the injected single-shot context (add a short,
at-a-glance "inspect-first" summary; reduce verbose pivotNeighborhood rendering)
while preserving the full structured data for reports, then re-measure product-v2
vs prior on the normal single-shot path with no enforcement layer.**

This preserves the normal single-shot agent workflow, the same tools, and the same
patch/evaluate protocol, with VTRACE as a pure context provider. It is evidence-based,
not speculative:

- §4c shows the agent *received* the 8-excerpt neighborhood block and did **not**
  mention or act on it. The lever is making delivered context *scannable*, not
  enforcing its use via protocol (enforcement was tried in §4d and made things
  strictly worse).
- §6 shows the ~1k-token block is **not** the source of the large token swings, so
  trimming verbosity is low-risk and the real question is usability, not size.
- The "actionable summary" here is an *informational* header rendered inside the
  context block — **not** the context-to-action checklist of `1e2fdf3`, which injects
  an instruction and is a protocol change. The structured `pivotNeighborhood` /
  accounting data stays intact for reports.
- This is verifiable **offline** (first-response token + render-shape measurement,
  exactly as `stage5_pivot_neighborhood_offline_validation.md` did), so it needs no
  live run to land; a clean labeled live A/B is the *follow-up*, not a precondition.

**Alternative 1 — report-label and validity hygiene only.** Stop reusing one run
label across enforcement variants; tag every PIVOT_CHECK / hard-gate / token-
discipline run as `protocol-diagnostic` in the reports; add explicit validity
warnings so diagnostic runs cannot be read as product wins. Pure reporting; zero
behavior change. Cheapest, but it does not move any product metric.

**Alternative 2 — proceed to original Milestone 5 (intent unification + ungate impact
for refactor intent).** This addresses the §3/§4b root cause: the M3 excerpt feature
is inert on the default debug/auto path because impact only fires on refactor-like
intent. Unifying `src/intent/` with `src/capsuleV2/intent.ts` and ungating impact
would make excerpts actually reach the first response. Higher value but larger scope;
do it after the clean product-v2 measurement so its effect is isolable.

**Not recommended as mainline:** any further hard-gate / two-phase work. It is a
protocol change with a single live result (a blocked solve) and no product signal.

---

## 9. Concrete next prompt

> Working in `/home/calvin/code/vtrace`. Do not change retrieval, ranking, candidate
> generation, intent classification, the solve protocol, the tool set, or the
> patch/evaluate flow. No PIVOT_CHECK, no context-to-action enforcement, no hard
> gate, no two-phase preflight. No live agent run.
>
> Goal: make the **default single-shot** injected Capsule v2 context (the
> `run-pipeline --capsule-engine v2` / `get_code_context` product path) more
> scannable without adding tokens, so the agent can act on the pivotNeighborhood it
> already receives.
>
> 1. Add a short, bounded, **informational** "inspect first" header to the rendered
>    v2 context: the top 1–2 pivots and their neighborhood files/symbols as a compact
>    list (file:symbol, relationship label). This is rendering only — it must NOT
>    inject any instruction telling the agent to emit a checklist, and must NOT gate
>    or block anything. It is not the `1e2fdf3` context-to-action mechanism.
> 2. Compact the existing verbose `pivotNeighborhood` rendering (tighter excerpt
>    framing, drop redundant labels) while keeping the full structured
>    `pivotNeighborhood` array and `accounting` block **unchanged** in the response
>    object for reports.
> 3. Net first-response estimated tokens must be **≤** the current product-v2 first
>    response on all four gate queries (matplotlib-22719, astropy-14369,
>    django-10880, django-11095) — the header's cost must be paid for by the
>    compaction, not added on top.
>
> Verify offline only, the same way as
> `stage5_pivot_neighborhood_offline_validation.md`: replay each of the four shaped
> gate queries through `run-pipeline --capsule-engine v2 --capsule-intent auto
> --capsule-budget-tokens 8000`, and report per-case estimated first-response tokens
> before vs after, confirming (a) the structured data is byte-identical and (b) the
> rendered token count did not increase. Run the unit tests for
> `runPipelineOrchestrator`, `pivotNeighborhood`, `formatRunPipelineOutput`, and
> `contextAccounting`. Write the offline result to
> `results/stage5_product_v2_context_compaction_offline_validation.md`. Commit
> locally; do not push; no co-author trailers; do not commit raw run artifacts.

The follow-up *after* that lands (separate task, not part of the prompt above): one
clean labeled live A/B — `vtrace-product-v2` (compacted) vs the prior product-v2
telemetry — on the normal single-shot path with **no** enforcement layer, across all
four cases, decided on measured total/cache-read tokens, Read+Grep+Bash counts, and
Docker resolution.

---

## Non-claims

- No agents, Docker, retrieval, scoring, or telemetry were run in producing this
  reconciliation; all figures are quoted from existing tracked Stage 5 artifacts and
  the `fe277fc..HEAD` commit log.
- This does not claim VTRACE matches, beats, or trails VEXP on tokens, latency, or
  resolution; no head-to-head was run and the VEXP model remains the
  product/website description from the original audit.
- "Complete" labels are scoped to the milestone text, not to production-readiness;
  documented limitations (chars/4 estimates, exact-FQN resolution, opt-in v2,
  single-repo accounting) stand.
- The matplotlib-22719 performance figures are n=1 and contaminated by enforcement
  layers; they are read here as diagnostic, never as a product verdict.
- The matplotlib token-discipline pilot's −56% is a behavior-change diagnostic
  (`strong_context_patch_first` vs an old unconstrained run), not a controlled
  product-v2 before/after.
