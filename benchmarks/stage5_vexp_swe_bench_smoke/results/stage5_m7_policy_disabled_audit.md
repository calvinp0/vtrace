# Stage 5 — M7.3 traceback-localized auto-skip DISABLED-by-default audit (offline)

## Scope

**Deterministic, offline policy audit — no Claude, no Docker, no agent run, no API calls.**

Runs the Capsule v2 cost-aware context policy over the 20 M6 bounded-validation
cases under BOTH settings: DEFAULT (M7.3, traceback-localized skip disabled) and
the explicit experimental flag (`enableTracebackLocalizedSkip` /
`VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP=1`). Capsule v2 is built in-process from
the SAME task text the live harness feeds it (`buildCapsuleV2Task`). The
localization detector reads ONLY issue text + the repo index — never the gold
patch. M6 classifications are the CORRECTED clean-Docker labels from
`stage5_m7_clean_docker_rebaseline.md`.

- dataset (full issue text): `/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl`

## Headline

- cases audited: **20**
- DEFAULT inject→skip flips: **0** (excluding capsule-driven safe skips) — the traceback downgrade no longer fires
- DEFAULT no_context cases: **3** — flask-5014, django-11095, sympy-12481 (all capsule/cheap-local safe skips, NOT traceback downgrades)
- skip CANDIDATES detected (telemetry retained): **2** — sympy-13372, xarray-3677
- flag-enabled inject→skip flips: **2** — sympy-13372, xarray-3677
- sympy-13372 default action: **inject**
- xarray-3677 default action: **inject**

## Success criteria

1. ✅ sympy-13372 returns to **inject** by default
2. ✅ xarray-3677 returns to **inject** by default
3. ✅ known useful injected wins remain **inject** (6/6)
4. ✅ astropy actionability remains **inject**
5. ✅ safe no_context remains **skip** (3/3)
6. ✅ localization skip-CANDIDATE telemetry retained by default (2 cases)
7. ✅ the experimental flag restores the downgrade (2 flips)

## Per-case decisions

| case | corrected M6 class | loc conf | kind | top pivot localized? | actionability | default | flag-on | skip candidate? | flips under flag? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | strict_efficiency_pass | strong | file_named | no | — | inject | inject | — | — |
| sphinx-7748 | strict_efficiency_pass | medium | file_named | no | — | inject | inject | — | — |
| requests-1142 | strict_efficiency_pass | strong | file_named | no | — | inject | inject | — | — |
| matplotlib-25960 | strict_efficiency_pass | strong | file_named | yes | — | inject | inject | — | — |
| django-11728 | strict_efficiency_pass | strong | file_named | yes | — | inject | inject | — | — |
| astropy-14369 | actionability_success | strong | file_named | yes | 2 | inject | inject | — | — |
| astropy-14365 | resolution_improvement_with_cost | strong | file_named | no | — | inject | inject | — | — |
| flask-5014 | no_context_safety_pass | strong | file_named | no | — | no_context | no_context | — | — |
| django-11095 | no_context_safety_pass | weak | none | no | — | no_context | no_context | — | — |
| sympy-12481 | no_context_safety_pass | medium | symbol_named | no | — | no_context | no_context | — | — |
| sphinx-7462 | inject_without_benefit | strong | traceback | yes | — | inject | inject | — | — |
| sympy-16766 | inject_without_benefit | medium | symbol_named | no | — | inject | inject | — | — |
| requests-5414 | inject_without_benefit | strong | file_named | yes | — | inject | inject | — | — |
| sympy-12419 | resolution_regression | medium | symbol_named | no | — | inject | inject | — | — |
| astropy-14539 | resolution_regression | strong | file_named | yes | — | inject | inject | — | — |
| pylint-8898 | resolution_regression | strong | traceback | yes | — | inject | inject | — | — |
| sympy-13372 | strict_efficiency_pass | strong | traceback | yes | — | inject | no_context | yes | yes |
| xarray-3677 | resolution_improvement | strong | traceback | yes | — | inject | no_context | yes | yes |
| seaborn-3187 | patch_synthesis_bound | strong | file_named | yes | — | inject | inject | — | — |
| django-13195 | patch_synthesis_bound | medium | symbol_named | no | — | inject | inject | — | — |

## Genuine regressions (NOT addressed by traceback skip)

These persist under clean Docker and are NOT traceback-lead-pivot cases, so the
M7 downgrade never addressed them — confirming the downgrade was not the right
tool. They require a different policy/actionability feature.

- **sympy-12419** — default=inject, skip-candidate=no; genuine (persists under clean Docker); not a traceback-lead-pivot case
- **astropy-14539** — default=inject, skip-candidate=no; genuine (empty-patch run); not addressed by traceback skip
- **pylint-8898** — default=inject, skip-candidate=no; genuine (multi-file co-edit follow-through); not addressed by traceback skip

## Conclusion

The traceback-localized `inject → no_context` downgrade is **disabled by default**
because the corrected clean-Docker M6 results show it removes useful injection
(sympy-13372 strict-efficiency, xarray-3677 a resolution improvement) with no
resolution gain. By default both return to **inject**, and all known useful /
actionability / safe-no_context behaviour is preserved. The localization detector
and its diagnostics (including a recorded skip CANDIDATE signal) remain available
for future policy work, and the downgrade itself stays reachable behind the
explicit experimental flag. The 3 remaining genuine regressions (sympy-12419,
astropy-14539, pylint-8898) are NOT traceback-lead-pivot cases and require another
policy/actionability feature, not traceback-lead-pivot skipping.
