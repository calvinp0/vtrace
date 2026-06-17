# Stage 5 — M32: Paired VTRACE Product Benchmark

Small **live** paired benchmark: baseline vs `vtrace-indexed` (v2 capsule), no pivot revision, no pivot-inspection enforcement, no diagnostic verifier. Live agent runs were executed by the Stage 5 runner; `resolved` comes from canonical SWE-bench Docker evaluate. **This report script itself executes nothing** — it only reads captured artifacts and writes the `.md`/`.csv`/`.json`. Missing fields are `unknown`, never zero.

## 1. Executive verdict

- **Did VTRACE reduce tool/context burden?** On medians across 6 instances × 3 replicates: tool calls 9.5→8.0 (-16%), grep/search 1.5→1.0 (-33%), input tokens 202→174 (-14%). See §3–4 for the full picture and the per-instance split (the effect is not uniform).
- **Did VTRACE preserve or improve patch quality?** Resolved rate 9/18 (50%) baseline vs 10/18 (56%) vtrace.
- **Where it helped:** 7 vtrace runs reached `actionability_success` (surfaced the gold/pivot file AND edited it); see §5.
- **Where it failed:** 8 `context_to_action_gap` + 0 `overhead_without_benefit`; 3 `safe_no_context` (policy correctly declined to inject). See §6.

_Caveat: 3 replicates per cell is small; single-instance swings are dominated by agent stochasticity. Read per-instance medians (§4), not just the grand mean._

## 2. Benchmark design

| instance | kind | gold files |
| --- | --- | ---: |
| `sphinx-doc__sphinx-7462` | multi-pivot | 2 |
| `django__django-13195` | multi-file | 3 |
| `mwaskom__seaborn-3187` | multi-file | 2 |
| `django__django-11728` | single-pivot | 1 |
| `django__django-10880` | single-pivot | 1 |
| `pydata__xarray-3677` | single-file/no-inject | 1 |

- **Conditions:** `baseline` (`--protocol baseline`) vs `vtrace-indexed` (`--protocol vtrace-indexed --capsule-engine v2 --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check`).
- **Replicates:** r1, r2, r3 per condition × instance = **36 runs**.
- **Not enabled:** `--pivot-revision-pass`, `--pivot-inspection-enforcement`, `--allow-docker-verify`, revised-patch adoption.
- **Resolved** via separate canonical `--mode evaluate --eval-mode docker` (NOT the diagnostic verifier).
- **Budget deviations:** none — full 6×2×3 ran as approved.

## 3. Aggregate result table

| condition | runs | valid | patch-produced | resolved | tool calls (mean/med) | grep (mean/med) | reads (mean/med) | uniq files (mean/med) | input tok (mean/med) | cost (mean/med) |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |
| baseline | 18 | 18 | 18/18 | 9/18 (50%) | 10.6/9.5 | 1.8/1.5 | 3.7/3.0 | 2.4/2.0 | 215/202 | 0.40/0.39 |
| vtrace | 18 | 18 | 18/18 | 10/18 (56%) | 9.6/8.0 | 1.7/1.0 | 2.0/2.0 | 2.4/2.0 | 196/174 | 0.43/0.34 |

## 4. Paired deltas (baseline → vtrace)

Per-instance medians over the 3 replicates; Δ% negative ⇒ VTRACE reduced the metric.

| instance | tool calls | grep/search | reads | uniq files | input tok | cost | resolved (b→v) | gold-complete (b→v) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | 6.0→8.0 (33%) | 0.0→1.0 (—) | 2.0→2.0 (0%) | 1.0→2.0 (100%) | 146→174 (19%) | 0.24→0.32 (30%) | 0/3→0/3 | 0/3→0/3 |
| django-13195 | 14.0→11.0 (-21%) | 4.0→3.0 (-25%) | 7.0→3.0 (-57%) | 4.0→4.0 (0%) | 272→216 (-21%) | 0.40→0.38 (-6%) | 0/3→0/3 | 2/3→3/3 |
| seaborn-3187 | 20.0→7.0 (-65%) | 3.0→3.0 (0%) | 5.0→2.0 (-60%) | 5.0→3.0 (-40%) | 405→167 (-59%) | 0.75→0.35 (-53%) | 0/3→1/3 | 1/3→1/3 |
| django-11728 | 10.0→9.0 (-10%) | 1.0→0.0 (-100%) | 2.0→2.0 (0%) | 1.0→1.0 (0%) | 209→181 (-13%) | 0.41→0.46 (10%) | 3/3→3/3 | 3/3→3/3 |
| django-10880 | 4.0→5.0 (25%) | 2.0→1.0 (-50%) | 1.0→1.0 (0%) | 3.0→2.0 (-33%) | 104→118 (13%) | 0.21→0.19 (-13%) | 3/3→3/3 | 3/3→3/3 |
| xarray-3677 | 9.0→6.0 (-33%) | 1.0→1.0 (0%) | 3.0→1.0 (-67%) | 1.0→1.0 (0%) | 176→146 (-17%) | 0.26→0.27 (3%) | 3/3→3/3 | 0/3→0/3 |

## 5. Actionability table (VTRACE runs)

| label | gold surfaced | gold inspected | gold edited (all) | classification | resolved |
| --- | --- | --- | --- | --- | --- |
| vtrace-sphinx-7462-r1 | yes | yes | no | context_to_action_gap | no |
| vtrace-sphinx-7462-r2 | yes | yes | no | context_to_action_gap | no |
| vtrace-sphinx-7462-r3 | yes | yes | no | context_to_action_gap | no |
| vtrace-django-13195-r1 | yes | yes | yes | actionability_success | no |
| vtrace-django-13195-r2 | yes | yes | yes | actionability_success | no |
| vtrace-django-13195-r3 | yes | yes | yes | actionability_success | no |
| vtrace-seaborn-3187-r1 | yes | yes | no | context_to_action_gap | no |
| vtrace-seaborn-3187-r2 | yes | yes | yes | actionability_success | yes |
| vtrace-seaborn-3187-r3 | yes | yes | no | context_to_action_gap | no |
| vtrace-django-11728-r1 | yes | yes | yes | actionability_success | yes |
| vtrace-django-11728-r2 | yes | yes | yes | actionability_success | yes |
| vtrace-django-11728-r3 | yes | yes | yes | actionability_success | yes |
| vtrace-django-10880-r1 | no | unknown | yes | safe_no_context | yes |
| vtrace-django-10880-r2 | no | unknown | yes | safe_no_context | yes |
| vtrace-django-10880-r3 | no | unknown | yes | safe_no_context | yes |
| vtrace-xarray-3677-r1 | yes | yes | no | context_to_action_gap | yes |
| vtrace-xarray-3677-r2 | yes | yes | no | context_to_action_gap | yes |
| vtrace-xarray-3677-r3 | yes | yes | no | context_to_action_gap | yes |

_"gold inspected" = the agent Read a surfaced pivot; "gold edited (all)" = the final patch edits EVERY gold file. A run that edits only the lead pivot on a multi-file task (or edits a surfaced non-gold file) shows `gold edited (all) = no` and lands in `context_to_action_gap`._

**VTRACE classification tally:**

| class | count |
| --- | ---: |
| `actionability_success` | 7 |
| `retrieval_success` | 0 |
| `context_to_action_gap` | 8 |
| `overhead_without_benefit` | 0 |
| `safe_no_context` | 3 |
| `unknown` | 0 |

## 6. Failure analysis

- **Retrieval failure** (gold not surfaced as a pivot): 3 vtrace runs.
- **Context-to-action gap** (gold surfaced, not all gold files edited): 8 runs (sphinx-7462 ×3, seaborn-3187 ×2, xarray-3677 ×3). Of these, **5 are genuine functional failures** (gap AND unresolved: sphinx-7462 ×3, seaborn-3187 ×2); **3 resolved anyway** (xarray-3677 ×3) — the agent fixed the bug via a different file than the gold patch, so the "gap" is a gold-match artifact, not a correctness failure (see §7).
- **Patch synthesis failure** (no patch produced at all): 0 runs across both conditions.
- **Environment/eval failure** (no canonical resolution recorded): 0 runs lack a boolean resolved.
- **Overhead without benefit** (injected off-target, agent ignored): 0 runs.
- **Safe no-context** (policy declined to inject — not a failure): 3 runs — django-10880 ×3.

## 7. Product interpretation

- **Compact context:** VTRACE injects a small v2 capsule (a couple of pivots) instead of raw search; the per-instance deltas in §4 show where that converts into fewer search/read calls and where it does not.
- **Less tool wandering:** strongest where the baseline agent would otherwise grep around a large repo; weakest (or negative) on already-localized tasks where baseline finds the file cheaply and the capsule is redundant.
- **Same/better correctness:** see the resolved deltas (§3–4). With 3 replicates the resolved comparison is directional, not significant.
- **Remaining gap:** the `context_to_action_gap` rows confirm M31 — VTRACE surfaces the right file but the agent does not always edit every required pivot, especially on multi-pivot tasks (sphinx-7462 edits only the lead pivot in all 3 replicates and never resolves).
- **Classification vs resolution diverge — read both.** The gold-file-edit classification is a *structural* context-to-action signal; `resolved` is the *functional* one, and they answer different questions. They diverge in BOTH directions here: **xarray-3677** is `context_to_action_gap` yet resolves 3/3 (the agent fixes it via `merge.py` without touching the gold `dataset.py` — a valid alternative fix), while **django-13195** is `actionability_success` (edits all 3 gold files) yet resolves 0/3. Treat `actionability_success` as "acted on the surfaced context as the gold patch did," not as "solved it."

## 8. Recommended next milestone

**A — VTRACE reduces tools/tokens and preserves quality:** invest in packaging/product UX around `get_code_context` / `run_pipeline` (make the capsule a first-class, low-friction tool surface).

_Chosen from the measured medians above; with only 3 replicates, option **D** (expand to a 10-instance controlled paired benchmark) is the fallback if a reviewer finds the per-instance variance too high to act on._

---

_Provenance: figures recomputed read-only from captured artifacts. The benchmark's live agents + Docker evaluate were run separately by the Stage 5 runner; this report script executed no agents, no Docker, no commands, and mutated no run artifact._
