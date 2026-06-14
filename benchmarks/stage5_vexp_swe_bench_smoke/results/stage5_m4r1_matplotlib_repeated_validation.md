# Stage 5 — M4.1 controlled repeated matplotlib-22719 validation

Generated: 2026-06-14 from live repeated runs on current `main` HEAD (n=3 per condition). Single hinge case `matplotlib__matplotlib-22719`. No product code, retrieval, scoring, candidate, or auto-policy changes. Decisions use **medians of n=3**, not best draws.

Conditions: **A** = baseline/no-context; **B** = current clean VTRACE context provider (default v2 compact inspect-first, `--disable-pivot-check`, hard gate off); **C** = current default policy (soft `strict_risk_gated` PIVOT_CHECK, hard gate off). B is the headline; C is reported separately and never mixed into the B-vs-A headline.

## 1. Executive verdict

Does clean current VTRACE beat baseline on matplotlib-22719 under repeated runs (median of n=3)? **YES, but weakly (within noise).** Clean VTRACE (B) is below baseline (A) on all four median metrics with resolution preserved (3/3) — so the earlier PASS was not a one-off lucky draw and the M4 regression is disconfirmed. **However the margin is only ~2% on total tokens and the per-run distributions overlap heavily** (A 782,082-1,677,907, B 564,290-1,341,699 total tokens), so this is a *weak* win, not a robust reduction. The more decisive finding is that **baseline localizes and patches the gold file just as fast** (A also edits at turn 1 in 2/3 runs), so on this case context is roughly *on par with* — not clearly better than — no context. Separately, **the default-policy condition C (soft PIVOT_CHECK on) is the most expensive of all three** (median total 1,235,060 vs B 1,054,119), i.e. the soft guard adds cost without a resolution benefit on this case.

Medians — A baseline: total 1,075,347, cacheRead 1,055,271, R+G+B 10, cost $0.3726, resolved 3/3. B clean VTRACE: total 1,054,119, cacheRead 1,034,242, R+G+B 9, cost $0.3585, resolved 3/3.

## 2. Repeat table

| cond | label | resolved | total tok | cache-read | R/G/B | cost | 1st-edit turn | post-edit Bash | gold edited |
|---|---|:--:|--:|--:|--:|--:|--:|--:|:--:|
| A | `eval-m4r1-baseline-matplotlib-22719-r1` | yes | 1,677,907 | 1,603,582 | 16 | $0.7108 | 3 | 10 | yes |
| A | `eval-m4r1-baseline-matplotlib-22719-r2` | yes | 1,075,347 | 1,055,271 | 10 | $0.3726 | 1 | 9 | yes |
| A | `eval-m4r1-baseline-matplotlib-22719-r3` | yes | 782,082 | 764,704 | 7 | $0.2887 | 1 | 6 | yes |
| B | `eval-m4r1-current-clean-matplotlib-22719-r1` | yes | 564,290 | 509,127 | 4 | $0.3402 | 1 | 2 | yes |
| B | `eval-m4r1-current-clean-matplotlib-22719-r2` | yes | 1,341,699 | 1,315,964 | 12 | $0.4858 | 1 | 6 | yes |
| B | `eval-m4r1-current-clean-matplotlib-22719-r3` | yes | 1,054,119 | 1,034,242 | 9 | $0.3585 | 1 | 6 | yes |
| C | `eval-m4r1-current-default-matplotlib-22719-r1` | yes | 1,235,060 | 1,172,279 | 11 | $0.5581 | 1 | 8 | yes |
| C | `eval-m4r1-current-default-matplotlib-22719-r2` | yes | 1,377,258 | 1,349,584 | 12 | $0.5019 | 1 | 8 | yes |
| C | `eval-m4r1-current-default-matplotlib-22719-r3` | yes | 1,161,396 | 1,140,004 | 10 | $0.4064 | 1 | 9 | yes |

## 3. Distribution summary

| cond | resolved/n | median total | min/max total | median cacheRead | min/max cacheRead | median R+G+B | median cost |
|---|:--:|--:|--:|--:|--:|--:|--:|
| A (baseline (no context)) | 3/3 | 1,075,347 | 782,082/1,677,907 | 1,055,271 | 764,704/1,603,582 | 10 | $0.3726 |
| B (clean VTRACE (--disable-pivot-check)) | 3/3 | 1,054,119 | 564,290/1,341,699 | 1,034,242 | 509,127/1,315,964 | 9 | $0.3585 |
| C (default policy (strict_risk_gated)) | 3/3 | 1,235,060 | 1,161,396/1,377,258 | 1,172,279 | 1,140,004/1,349,584 | 11 | $0.5019 |

## 4. Strict gate interpretation — clean VTRACE (B) vs baseline (A)

- resolution preserved/improved? **yes** (B 3/3 vs A 3/3)
- median total tokens down? **yes** — 1,054,119 vs 1,075,347 (DOWN -2.0%)
- median cache-read down? **yes** — 1,034,242 vs 1,055,271 (DOWN -2.0%)
- median Read+Grep+Bash down? **yes** — 9 vs 10 (DOWN -10.0%)
- median cost down? **yes** — 0.4 vs 0.4 (DOWN -3.8%)

**Classification: `strict_pass_distribution`** — but note the margins are ~2% on total tokens with **heavily overlapping** per-run ranges (A 782,082-1,677,907, B 564,290-1,341,699). At n=3 this is a *weak* distributional pass, not a robust reduction; the honest read is 'clean VTRACE is at least on par with baseline,' not 'clearly better.'

## 5. Trajectory diagnosis

- B (VTRACE) first-edit turn index per repeat: [1, 1, 1]; tool calls before first edit: [1, 1, 1].
- B post-edit Bash count per repeat: [2, 6, 6] (median 6).
- B first edit file per repeat: ['matplotlib/category.py', 'matplotlib/category.py', 'matplotlib/category.py'].
- B Read→Edit category.py early? yes — all repeats edit category.py at/near turn 1.
- Baseline (A) lacks ordered tool telemetry (no `_tool_calls.json`); A Read/Grep/Bash aggregate counts per repeat: [{'Read': 4, 'Grep': 2, 'Bash': 10}, {'Read': 1, 'Grep': 0, 'Bash': 9}, {'Read': 1, 'Grep': 0, 'Bash': 6}].
- Cost dominated by post-edit Bash verification? yes — B edits early then varies in post-edit Bash depth.
- Did baseline localize/patch just as quickly? Baseline median total 1,075,347 vs B 1,054,119; baseline R+G+B median 10 vs B 9 — see interpretation in verdict.

## 6. Pivot-check note — Condition C (default soft PIVOT_CHECK), reported separately

- C default policy: resolved 3/3, median total 1,235,060, median cacheRead 1,172,279, median R+G+B 11, median cost $0.5019.
- `--disable-pivot-check` removed the block in B? PIVOT_CHECK present in B snapshots: [False, False, False]; in C snapshots: [True, True, True]. EDIT_GUARD present B: [False, False, False] / C: [True, True, True]; PATCH_VERIFY B: [False, False, False] / C: [True, True, True].
- B median total 1,054,119 vs C median total 1,235,060: indicates whether the soft guard shifts cost.

## B condition VTRACE confirmations

- `eval-m4r1-current-clean-matplotlib-22719-r1`: reqEngine=v2, effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, hardGateText=False, pivotCheckText=False, inspectFirst→category.py::convert=True, jsonlRows=1
- `eval-m4r1-current-clean-matplotlib-22719-r2`: reqEngine=v2, effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, hardGateText=False, pivotCheckText=False, inspectFirst→category.py::convert=True, jsonlRows=1
- `eval-m4r1-current-clean-matplotlib-22719-r3`: reqEngine=v2, effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, hardGateText=False, pivotCheckText=False, inspectFirst→category.py::convert=True, jsonlRows=1

## 7. Next decision

Classification `strict_pass_distribution` (weak — within-noise margins, overlapping distributions) → **hybrid A + C:**
- **A (proceed):** clean VTRACE (B) median beats baseline (A) with resolution preserved and the M4 'regression' is disconfirmed → it is safe to proceed to a repeated **astropy** n=3 (the still-unresolved injected case that actually carries the gate) and/or a 4-case n=3 gate. astropy, not matplotlib, is the real blocker.
- **C (caveat the case):** matplotlib-22719 is a **weak context-reduction benchmark** — baseline localizes and patches the gold file immediately too, so it cannot by itself prove a reduction win. Do not headline matplotlib as a reduction result; treat it as a 'no-regression / on-par' confirmation.
- **Pivot-check action:** the clean path (B, `--disable-pivot-check`) should be the headline; the default soft PIVOT_CHECK (C) is the most expensive condition here and adds cost without resolution benefit. Keep PIVOT_CHECK off for headline gate runs (a measurement-design choice, not a product-code change).

## Non-claims

- Single instance, n=3 per condition; medians reduce but do not eliminate stochastic noise.
- B is the clean context-provider headline; C (soft PIVOT_CHECK) is reported separately and not mixed into B-vs-A.
- No VEXP parity, no 100-task run, no retrieval/scoring/candidate/policy changes; raw artifacts not committed.