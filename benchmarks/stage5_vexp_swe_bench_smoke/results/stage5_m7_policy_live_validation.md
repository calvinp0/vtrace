# Stage 5 — M7 conservative-localization policy: focused LIVE validation

Commit under test: `6564adb Tune auto context policy for localized tasks` (HEAD, `main`).
Date: 2026-06-15. Scope: the 2 cases M7 changes + 3 guardrail cases. No 30-case / 100-case runs.
All resolution numbers below were (re-)evaluated under a **single healthy Docker** after an
infrastructure outage was detected and repaired mid-run (see §6).

---

## 1. Executive verdict

**`policy_live_partial`**

What is validated:

- **Policy wiring + skip behavior — LIVE SUCCESS.** Both target cases deterministically skip
  injection live (3/3 runs each) with the exact M7 metadata: `policyAction=skip`,
  `skip_traceback_localized`, `contextInjected=no`, `localization=traceback/strong`,
  `effectiveCapsuleEngine=v2`, `fallbackReason=null`, no PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY,
  ordered telemetry present. The live path applies the M7 policy — wiring is not broken.
- **Resolution safety — CONFIRMED.** Under clean Docker, M7 skip resolves **3/3 on both cases**,
  equal to inject and ≥ baseline. Skipping the context costs no resolution.
- **Guardrails — PRESERVED (offline/snapshot).** requests-1142 and astropy-14369 still inject;
  django-11095 still no_context.

What is **not** supported — the policy's own premise fails on the live evidence:

- **The M6 "resolution regression" that motivated the skip was a Docker-evaluation artifact, not a
  real effect.** The M6 inject runs that scored `resolved=False` carry patches **byte-identical**
  to the inject runs that scored `resolved=True` (and, for sympy, identical to baseline). A fixed
  patch evaluates deterministically, so those "failures" were silent Docker faults. Re-evaluated
  cleanly, inject resolves 3/3 on both cases — there was no regression to reduce.
- **Injection was not "inject-without-benefit" — it was token-beneficial.** On both cases the
  agent reached the same (sympy: byte-identical) correct patch with **fewer turns/tokens when
  context was injected**, and M7's skip pushes cost back up (xarray: skip uses ~2.3× the tokens of
  inject and more than baseline). On these two cases M7 removes a real efficiency win and buys
  nothing in return.

**Bottom line:** the M7 mechanism works and is resolution-safe, but the live clean-Docker data
contradicts the rationale for downgrading these specific cases. The M6 numbers that justified M7
were contaminated by the same silent Docker failure and need re-baselining before the policy's
value can be judged.

---

## 2. Changed-case comparison

Conditions: **A** = M6 baseline (no context), **B** = M6 pre-M7 "current-clean" VTRACE (inject),
**C** = M7 policy VTRACE (skip). Same agent harness across all three
(`dist/cli.js run --no-vexp`, stage5 tool-use-discipline v1 injected); they differ only in the
vtrace context layer (A: none; B: inject; C: indexed-context machinery → policy skip, 0 items).
n=3 each; medians shown. **Every `resolved` figure was re-evaluated under one healthy Docker.**

### sympy__sympy-13372  (gold = top pivot = `sympy/core/evalf.py`)

| Metric | A. baseline | B. inject | C. M7 skip |
|---|---|---|---|
| resolved / n | **3/3** | **3/3** | **3/3** |
| policyAction | (no vtrace) | inject | **skip** |
| context injected? | no | yes | **no** |
| model patch | `c7e6ba0…` | `c7e6ba0…` | `c7e6ba0…` — **identical across all 9 runs** |
| median total tokens | 764,982 | **588,691** | 664,284 |
| median turns | 25 | **18** | 22 |
| median Read+Grep+Bash | 7 | 5 | 6 |
| median cost (USD) | 0.282 | **0.248** | 0.325 |
| **classification** | — | — | **skip_safe_but_no_resolution_gain** (mild cost regression vs inject) |

Every run — baseline, inject, M7 — emits the **byte-identical** correct patch (two
`else: raise NotImplementedError` hunks in `evalf`). Resolution is therefore deterministic at 3/3;
the M6 `resolved=False` on inject r2 was a Docker artifact. Injection was the cheapest condition
(fewest turns); M7 skip is more expensive for the same result.

### pydata__xarray-3677  (gold = `xarray/core/merge.py`; top pivot = `xarray/core/dataset.py`)

> Task id is `pydata__xarray-3677`, **not** `xarray__xarray-3677` (the brief's id is not in the
> dataset; see §6).

| Metric | A. baseline | B. inject | C. M7 skip |
|---|---|---|---|
| resolved / n | 2/3 (r2 = empty patch) | **3/3** | **3/3** |
| policyAction | (no vtrace) | inject | **skip** |
| context injected? | no | yes | **no** |
| model patch | `9292be9…` (r2 empty) | `9292be9…` (all 3) | r1 `35ba81…`, r2 `a3b808…`, r3 `9292be9…` (all resolve) |
| median total tokens | 1,184,859 | **621,282** | 1,449,793 |
| median turns | 36 | **18** | 43 |
| median Read+Grep+Bash | 12 | **6** | 15 |
| median cost (USD) | 0.432 | **0.221** | 0.495 |
| **classification** | — | — | **skip_safe_but_no_resolution_gain** (clear cost regression vs inject) |

Inject resolves 3/3 using ~half the tokens and half the turns of baseline; M7 skip also resolves
3/3 but is the most expensive condition (43 vs 18 turns, 1.45M vs 0.62M tokens). The baseline's
2/3 is one run that produced no patch at all (empty), a separate agent failure unrelated to
evaluation. The M6 inject `resolved=False` on r2/r3 (identical patches to the resolved r1) were
Docker artifacts.

### Required VTRACE snapshot/metadata checks (all 6 M7 runs)

| Check | sympy r1–r3 | xarray r1–r3 |
|---|---|---|
| policyAction = skip / no_context | ✅ skip | ✅ skip |
| policyReason = skip_traceback_localized | ✅ (decisionSignals) | ✅ |
| context injected = no | ✅ (items=0, chars=0) | ✅ |
| localizationSignals.kind = traceback | ✅ (offline-confirmed) | ✅ (offline-confirmed) |
| localizationSignals.confidence = strong | ✅ | ✅ |
| effectiveCapsuleEngine present | ✅ v2 | ✅ v2 |
| fallbackReason = null | ✅ | ✅ |
| no PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY | ✅ all false | ✅ all false |
| ordered telemetry present | ✅ | ✅ |

Neither target case injected; the stop-and-diagnose trigger did not fire.

---

## 3. Guardrail summary  (OFFLINE / snapshot only)

Validated with an in-process policy probe that builds Capsule v2 from the same task text the live
harness uses and runs `decideCapsuleV2ContextPolicy` at HEAD — no Claude, no Docker, no gold patch.
Live guardrails were intentionally not run (the policy decision is deterministic offline).

| Guardrail | Expected | M7 offline result | Why preserved |
|---|---|---|---|
| psf__requests-1142 | still inject | **inject** ✅ | localization `file_named` (not traceback); `hidden_pivot_advantage` blocks downgrade |
| astropy__astropy-14369 | still inject; actionability; ensure-in-diff | **inject** ✅, **2 actionability hints** | `inject_actionability_hint` advantage blocks downgrade (requires `!actionabilityAdvantage`) |
| django__django-11095 | still skip / no_context | **no_context** ✅ | already no_context; M7 is purely subtractive (inject→no_context only), cannot alter an existing skip |

Cross-check: both changed cases under the same offline probe flip `inject → no_context` with
`skip_traceback_localized`, matching the live runs. (xarray probed under `pydata__xarray-3677`:
localization kind=traceback, confidence=strong, topPivotUserLocalized=true, no advantage signal.)
"ensure-in-diff visible" for astropy-14369 is evidenced by `actionability_hints = 2` on the built
capsule (the mechanism that emits the obligation). Offline only; not re-rendered live.

---

## 4. Policy interpretation

- **Did traceback-localized skip reduce inject-without-benefit?** **No, not in a beneficial sense.**
  The policy does remove injection on both cases, but clean-Docker data shows that injection was
  *token-beneficial* (fewer turns/tokens for the same correct patch), so the removed injection was
  not "without benefit." M7 makes both cases more expensive with no compensating gain.
- **Did it reduce resolution regression?** **No — there was no real regression.** The M6 inject
  "regression" was a Docker-evaluation artifact (identical patches scoring differently). Under
  clean Docker, inject and skip both resolve 3/3 on both cases. M7 neither fixes nor causes a
  resolution regression here; it is resolution-neutral.
- **Did it preserve useful / actionability injection?** **Yes (offline).** requests-1142 (hidden
  pivot) and astropy-14369 (actionability obligation) still inject; django-11095 still skips.

---

## 5. Next recommendation

**Closest to option C (narrow / reconsider the policy) — but gated on re-baselining M6 first.**

1. **Re-baseline the M6 evidence under clean Docker before trusting M7's motivation.** The entire
   M7 rationale (the bounded-20 "24% inject-without-benefit / 25% resolution-regression" rates)
   was measured during a period when the Docker evaluator could silently fail and default
   `resolved=False`. This validation proved that failure mode is real and was present in the M6
   inject numbers for both target cases. Re-evaluate the bounded-20 set (eval-only, no agent
   re-run) under healthy Docker and recompute those rates. If the regression rate collapses (as it
   did for these two cases), the premise for M7 largely disappears.
2. **On the two target cases specifically, the downgrade is net-negative**: resolution-neutral but
   a cost regression (xarray especially: skip ≈2.3× inject tokens). That argues for narrowing the
   traceback-localization gate further or reverting it for cases where injection demonstrably
   reduces turns.
3. Do **not** proceed to option A (rerun the affected 20-case subset under M7) yet — the cases are
   safe but show no benefit, and the comparison baseline (M6) is itself unreliable until step 1.

Option **D** (fix live wiring) is not needed — wiring is confirmed working live.

---

## 6. Docker evaluator failure (detected, repaired, all results re-evaluated)

Initial symptom — every NEW container start (swebench eval and a plain `hello-world`) failed:

```
500 Server Error .../containers/<id>/start: Internal Server Error
("failed to create task for container: failed to start shim: start failed:
 failed to create TTRPC connection: unsupported protocol: Yunix")
```

Diagnosis performed this session:

- **Daemon/socket healthy**: `docker ps` listed long-running containers, `/_ping` = `OK`,
  `docker version` server responded. Fault only on new-container start, at the containerd shim
  TTRPC layer ("Yunix" = a corrupted "unix" emitted inside the running containerd, a dirty build
  `containerd v2.2.3 …m`).
- **Not env**: `DOCKER_HOST` / `CONTAINER_HOST` / `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` /
  `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` all unset; full env scan empty. Re-running `evaluate`
  with a sanitized env (`env -u …`) and a sanitized `hello-world` failed identically.
- **Not context / not config**: `docker context = default`, Host `unix:///var/run/docker.sock`;
  grep of vtrace-benchmark + vexp-swe-bench for `Yunix|DOCKER_HOST|…|unix://` found nothing
  relevant (only unrelated `http+unix://` strings inside a `requests` test fixture).
- **Conclusion**: host containerd fault requiring a daemon restart (no passwordless sudo for this
  agent). After the daemon was restarted out-of-band, `docker run --rm hello-world` succeeded.

Artifact validity (per the directive) during the outage window:

```
run-protocol:        valid
policy telemetry:    valid
patch artifact:      valid
Docker evaluation:   invalid until re-evaluated  (now re-evaluated under healthy Docker)
reason:              evaluator infrastructure error, unsupported protocol: Yunix
```

Re-evaluation method (eval-only; no agent/model re-runs): the external evaluator skips rows whose
`resolved` is already set, so each suspect JSONL had its `resolved` field reset to `null` (patch
preserved) and was re-run via `--mode evaluate --eval-mode docker`. Confirmed real test runs (fresh
`report.json`, ~50–80 s each). All 18 condition-runs (A/B/C × 2 cases × 3 reps) were re-evaluated
under one healthy Docker so the comparison is apples-to-apples.

**Key consequence:** the M6 inject `resolved=False` values for both target cases were Docker
artifacts (their patches are byte-identical to resolved runs). This is why the executive verdict
flags the M6 motivation as needing a clean re-baseline.

### Note on the xarray instance id

The brief specified `xarray__xarray-3677`; the canonical id in `swe-bench-100.jsonl` and the
cross-repo fixture is **`pydata__xarray-3677`**. The first xarray attempt failed instantly
("Instance xarray__xarray-3677 not found in SWE-bench data"); runs were redone with the correct id.

---

## Appendix — labels run / reused

Run live this session (M7, n=3 each; run-protocol + patch valid; Docker eval done after repair):
```
eval-m7-policy-current-sympy-13372-r1 .. r3
eval-m7-policy-current-xarray-3677-r1 .. r3   (instance pydata__xarray-3677)
```
Reused M6, re-evaluated under healthy Docker this session (agent runs untouched):
```
eval-bounded20-baseline-sympy-13372-r1 .. r3
eval-bounded20-current-clean-sympy-13372-r1 .. r3
eval-bounded20-baseline-xarray-3677-r1 .. r3
eval-bounded20-current-clean-xarray-3677-r1 .. r3
```
Guardrails: offline policy probe only (no labels) — `psf__requests-1142`,
`astropy__astropy-14369`, `django__django-11095`.

Code changed: none (report only). Raw artifacts (run dirs, JSONLs) are not committed.
