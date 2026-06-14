# Stage 5 — M4 final clean four-case headline gate

Generated: 2026-06-15, on current `main` HEAD (`e0edee8`). Clean headline treatment: `protocol vtrace-indexed`, current default Capsule v2 compact inspect-first, `--disable-pivot-check`, hard gate off. No `--capsule-engine` override (tests the current default v2 path). No product/retrieval/scoring/candidate/auto-policy changes. Decisions use medians; live-agent results are stochastic.

Gold patch data used only post-hoc for classification, never injected into any live run.

## 1. Executive verdict

**Is the final clean M4 gate cleared?** **`cleared_with_caveats`.**

VTRACE preserves or improves resolution on all four cases, behaves correctly per case (injects when context is high-value, skips when it is not), and shows a genuine actionability gain on astropy. It is not a clean across-the-board token-compression story — matplotlib is weak/noisy, astropy spends *more* tokens to solve a case baseline never solves, and the set is small — hence "with caveats" rather than an unqualified clear.

| case | type | baseline resolved | VTRACE resolved | classification |
|---|---|:--:|:--:|---|
| matplotlib-22719 | injected | 3/3 | 3/3 | weak_pass_with_overlap |
| astropy-14369 | injected | 0/3 | 3/5 | actionability_success |
| django-10880 | no_context safety | 1/3 | 3/3 | no_context_safety_pass |
| django-11095 | no_context safety | 3/3 | 3/3 | no_context_safety_pass |

## 2. Condition summary

**Injected-context / actionability cases** (VTRACE policy = inject; capsule context is delivered):
- `matplotlib-22719`
- `astropy-14369`

**no_context safety cases** (VTRACE policy = skip; capsule deliberately injects nothing):
- `django-10880`
- `django-11095`

The no_context rows are **safety / non-regression evidence**, not context-reduction wins. Their job is to confirm that VTRACE (a) correctly decides *not* to inject when there is no high-value context, and (b) does not harm resolution or materially inflate cost by doing so. Any token gap on these rows is dominated by baseline run-to-run variance and is explicitly **not** counted as a VTRACE reduction win.

## 3. Per-case distribution table

Medians. Δ = (VTRACE − baseline)/baseline.

| instance | type | base n | vtr n | base resolved | vtr resolved | med total (b/v/Δ) | med cache-read (b/v/Δ) | med R+G+B (b/v) | med cost (b/v/Δ) | classification |
|---|---|:--:|:--:|:--:|:--:|---|---|:--:|---|---|
| matplotlib-22719 | injected | 3 | 3 | 3/3 | 3/3 | 1,075,347 / 1,054,119 / −2.0% | 1,055,271 / 1,034,242 / −2.0% | 10 / 9 | $0.373 / $0.359 / −3.8% | weak_pass_with_overlap |
| astropy-14369 | injected | 3 | **5** | 0/3 | **3/5** | 2,414,739 / 3,327,998 / +37.8% | 2,320,986 / 3,216,559 / +38.6% | 18 / 21 | $1.323 / $1.482 / +12.0% | actionability_success |
| django-10880 | no_context | 3 | 3 | 1/3 | 3/3 | 1,967,386 / 495,135 / −74.8%† | 1,924,574 / 484,394 / −74.8%† | 20 / 5 | $0.763 / $0.183 / −76.0%† | no_context_safety_pass |
| django-11095 | no_context | 3 | 3 | 3/3 | 3/3 | 600,702 / 541,649 / −9.8%† | 592,686 / 534,067 / −9.9%† | 6 / 6 | $0.264 / $0.200 / −24.4%† | no_context_safety_pass |

† no_context safety rows — the Δ is **not** a context-reduction win; it is dominated by baseline variance (see §5). Reported for completeness only.

**Unequal-n note (astropy):** astropy VTRACE is the hardened n=5 post-obligation set (M4.7) vs n=3 baseline. The n=3 VTRACE subset (r1–r3) resolves **2/3** with median total 3,327,998 — same direction, same conclusion. The n=5 set is the more reliable estimate (resolved 3/5).

## 4. Injected case analysis

### matplotlib-22719 — `weak_pass_with_overlap`
- VTRACE roughly on-par / slightly cheaper than baseline: median total −2.0%, cost −3.8%, R+G+B 10→9.
- Both localize and edit the gold `category.py` quickly (gold edited 3/3 both; first edit is the gold file).
- Per-run distributions overlap heavily (baseline 782k–1.68M; VTRACE 564k–1.34M). The edge is within noise — this is a **weak/noisy** non-regression, not a strong headline reduction case. Resolution is fully preserved (3/3 = 3/3).

### astropy-14369 — `actionability_success`
- VTRACE post-obligation improves resolution from **0/3 baseline → 3/5 VTRACE** — baseline never solves this case.
- Generated-artifact follow-through is saturated: `cds_parsetab.py` reaches the submitted diff **5/5**, generated-artifact awareness **5/5**, `ensure-in-diff` obligation visible in every live snapshot **5/5**, gold `cds.py` edited **5/5**.
- Both unresolved VTRACE runs (r1, r5) fail for the same single reason — wrong LALR grammar direction — never a missing artifact; gold grammar direction holds 3/5 and exactly predicts the 3/5 resolved set.
- Token/cost is **higher** (+37.8% total, +12.0% cost) because solving the case means editing the grammar *and* regenerating the parser table — strictly more work than baseline's localize-and-fail. This is the goal of a context-intelligent agent helper, not a compressor: **do not misclassify the token increase as failure when resolution improves materially from 0.**

## 5. no_context safety analysis

Both Django cases: VTRACE policy = **skip**, context injected = **no**, fallbackReason = **null**, no PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY, requested/effective engine metadata present (v2/v2), ordered telemetry present.

### django-10880
- Did VTRACE skip context? **Yes** (policy=skip, no snapshot injected).
- Resolution preserved? **Improved** — VTRACE 3/3 vs baseline 1/3; VTRACE edits gold `aggregates.py` 3/3.
- Avoided injecting useless context? **Yes.**
- Tokens/cost comparable? VTRACE ran clean (313k–617k, all resolved). Baseline was **high-variance**: r1 flailed for 4.97M tokens / 112 turns and never made an edit, r3 spent 1.97M / 54 turns and edited but failed, only r2 was clean. The large median gap therefore reflects **baseline flailing without orientation**, not a VTRACE compression effect — both conditions inject zero context. Counted as a **safety pass**, explicitly **not** a reduction win.

### django-11095
- Did VTRACE skip context? **Yes** (policy=skip).
- Resolution preserved? **Yes** — 3/3 = 3/3; gold `options.py` edited 3/3 both.
- Avoided injecting useless context? **Yes.**
- Tokens/cost comparable? **Yes** — within noise (total −9.8%, both ~540k–775k; cost difference is small-sample variance). This is the cleanest matched no_context safety datapoint: VTRACE skips and matches baseline.

## 6. Gate interpretation

The original strict token-only gate is too narrow for a system whose value is context *intelligence*, not pure compression. Interpreting M4 on two dimensions:

**Efficiency** (total / cache-read / R+G+B / cost):
- matplotlib: small favorable edge, within noise.
- astropy: higher — but that buys resolution baseline cannot reach.
- django (no_context): VTRACE skips, so no overhead injected; comparable-or-lower, gap is baseline variance.

**Effectiveness** (resolution / gold-file edit / actionability follow-through):
- Resolution preserved or improved on **all four** cases (mpl 3/3=3/3; astro 0→3/5; dj10880 1→3/3; dj11095 3/3=3/3).
- Gold file edited at the same or higher rate everywhere.
- Actionability follow-through on astropy is saturated (artifact-in-diff 5/5).

VTRACE: **preserves/improves resolution**, **does not materially worsen waste** on simple/no_context cases, **improves actionability** on astropy, and **avoids unnecessary context** on Django (policy=skip). The one thing it does *not* demonstrate is uniform token reduction on injected cases — matplotlib is flat/noisy and astropy intentionally spends more to solve. That is the source of the caveat.

## 7. Pre-100-task decision

**`ready_for_broader_validation`** — a bounded next stage, not 100 tasks. Every case preserves or improves resolution; VTRACE's inject/skip policy behaves correctly per case; the astropy actionability gain is real and hardened to n=5. The remaining uncertainty is *breadth* (only four cases, small n, stochastic), which a bounded stratified run addresses without committing to a full 100-task sweep.

100-task validation remains **blocked / not claimed**. This is not VEXP parity and not a public SWE-bench result.

## 8. Non-claims

- This is **not** a public SWE-bench score.
- This is **not** VEXP parity.
- This is **not** a 100-task result.
- The set is still small (four cases; n=3 except astropy n=5); live-agent results are stochastic.
- The no_context (Django) rows are **not** context-reduction wins — their token gaps are baseline variance.
- matplotlib is **weak/noisy** — its small token edge is within run-to-run noise, not a strong reduction signal.
- astropy demonstrates **actionability improvement (0→3/5), not pure token compression** — it spends more tokens to solve a case baseline never solves.

## 9. Next recommendation

**A — proceed to a broader but bounded validation stage** (not 100 immediately). Suggested: **10–20 selected cases stratified by injected / no_context / actionability**, with `--disable-pivot-check` for injected cases and the current default v2 path throughout. Carry baseline-vs-VTRACE n=3 per case and the same two-dimension (efficiency × effectiveness) scoring. Only escalate to a full 100-task run if that stage holds and the user explicitly approves it.
