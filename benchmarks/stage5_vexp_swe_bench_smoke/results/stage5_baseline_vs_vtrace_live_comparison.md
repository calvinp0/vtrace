# Stage 5 — baseline vs vtrace live comparison (recovered cases)

A small, controlled product validation: does Capsule v2 force-injected context
change live-agent behaviour versus the **same** agent and harness with no vtrace
context? Run on the three retrieval-recovered instances, one baseline arm and one
vtrace arm each, both Docker-evaluated.

This is **not** a public SWE-bench score and **not** a broad agent benchmark —
three instances, deliberately chosen because recent retrieval fixes recovered
them. Live patching is stochastic; read every number below as one sample.

## Executive summary

- **Resolution is parity in aggregate, split by instance.** Baseline resolved
  **2/3**; vtrace resolved **2/3** — but on *different* instances. vtrace **won**
  one (astropy-14369), **regressed** one (requests-5414), and **tied** one
  (sympy-16766). Net: 1 win, 1 regression, 1 parity.
- **Localization was identical.** In all three cases, **both** arms edited the
  correct gold file *and* the correct gold symbol — with or without vtrace. On
  these three, the live agent reaches the right file on its own even when the task
  framing is misleading (astropy's wrong-subsystem case), so vtrace did **not**
  change *where* the agent edited.
- **The differences were patch *shape*, not patch *location*.** Where the two
  arms diverged, it was in how broad or minimal the edit was — and that is exactly
  where live stochasticity dominates.
- **No clean efficiency story.** vtrace was cheaper on the case it lost
  (requests) and more expensive on the two it tied/won (sympy, astropy). Injected
  context adds tokens; on astropy that extra spend bought a resolution, on sympy
  it did not change the outcome.

The honest one-line read: **on these three recovered cases, vtrace neither broadly
helped nor broadly hurt; it traded one instance for another while leaving
localization unchanged.**

## Setup and protocols

Two protocols per instance, identical model/harness, differing only in the context
condition (the one variable this validation isolates):

| Arm | Command shape | Context |
| --- | --- | --- |
| baseline | `run --no-vexp` | none injected |
| vtrace | `run --no-vexp` + Capsule v2 indexed-context, `--context-policy force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000` | always injected |

- Model `claude-opus-4-5-20251101`, real SWE-bench Docker evaluation
  (`dockerUsed=true`, `evaluationError=null`) for all six runs.
- vexp disabled throughout; **auto-policy not used** — the cost-aware gate was
  overridden to always inject so this measures the context, not the gate.
- No retrieval, scoring, candidate-generation, benchmark, or prompt logic was
  changed; the only manipulated variable is baseline-vs-injected context.

### vtrace arm is reused (not rerun)

The vtrace arm **reuses the already-completed force-inject runs** from the
recovered-case live validation (labels `eval-capsulev2-recovered-live-<short>`),
because those runs used the identical settings this comparison specifies — verified
in each `_run.meta.json`: `vtraceCapsuleEngine=v2`, `vtraceCapsuleIntent=debug`,
`vtraceCapsuleBudget=8000`, `vtraceContextPolicyAction=inject`,
`vtraceTreatmentValid=true`, same model. Only the **baseline** arm was run fresh
for this comparison (labels `eval-baseline-vs-vtrace-baseline-<short>`). Reusing
the vtrace side avoids re-spending tokens on an identical condition; the trade-off
is that the two arms were executed at different times, so per-run stochastic noise
is not controlled beyond holding all settings fixed.

## Per-instance comparison

| Instance | baseline resolved | vtrace resolved | Outcome | Expected file edited (both) | Expected symbol edited (both) |
| --- | --- | --- | --- | --- | --- |
| psf__requests-5414 | **true** | false | **vtrace regression** | yes (`requests/models.py`) | yes (`prepare_url`) |
| sympy__sympy-16766 | true | true | **parity** | yes (`sympy/printing/pycode.py`) | yes (`PythonCodePrinter._print_Indexed`) |
| astropy__astropy-14369 | false | **true** | **vtrace win** | yes (`astropy/units/format/cds.py`) | yes (`CDS._make_parser` grammar) |

Resolution totals: **baseline 2/3, vtrace 2/3.** Localization (correct file and
symbol): **baseline 3/3, vtrace 3/3.**

## Patch behaviour comparison

### psf__requests-5414 — baseline win / vtrace regression

Both edited `requests/models.py::prepare_url` (the gold edit site).

- **baseline (resolved):** added a minimal, *additive* guard after the existing
  checks — a `try: host.encode('idna') except UnicodeError: raise InvalidURL(...)`
  block. It left the original `if not unicode_is_ascii(host)` structure intact, so
  it catches the empty-label `.example.com` case without disturbing previously
  passing behaviour.
- **vtrace (failed):** restructured the block so IDNA encoding runs
  **unconditionally** (dropping the `if not unicode_is_ascii` guard) and only
  special-cased `*`. That almost certainly satisfies the single `FAIL_TO_PASS` but
  regresses `PASS_TO_PASS`, so it does not resolve.
- **Read:** same file, same function, both arms. The injected pivot showed the full
  `prepare_url` body including the `if/elif` structure; under vtrace the agent
  chose to refactor that structure rather than add to it. Context did not localize
  better here (baseline localized identically) and the broader edit shape cost it
  the resolution. A stochastic edit-shape regression, not a retrieval failure.

### sympy__sympy-16766 — parity

Both added `_print_Indexed` to `PythonCodePrinter` in `sympy/printing/pycode.py`,
functionally equivalent to gold.

- **baseline:** added `_print_Indexed` **and** a bonus `_print_IndexedBase` (extra,
  harmless).
- **vtrace:** added `_print_Indexed` only.
- **Read:** the target is essentially named in the problem statement
  (`PythonCodePrinter`, and the desired method body is quoted), so both arms solve
  it cleanly. vtrace's title-symbol anchoring matches what the agent already finds
  unaided here — no behavioural difference.

### astropy__astropy-14369 — vtrace win

Both edited the gold file `astropy/units/format/cds.py::CDS` grammar — so even the
wrong-subsystem case was localized correctly by **both** arms.

- **vtrace (resolved):** made the *minimal* gold-matching swap
  (`division_of_units : ... | combined_units DIVISION unit_expression`) and
  **deleted** the generated `cds_parsetab.py` so `ply` regenerates a correct table.
- **baseline (failed):** made a *broader* grammar rewrite — introducing
  left-recursive rules (`division_of_units DIVISION product_of_units`,
  `product_of_units : unit_expression PRODUCT product_of_units`) and committing a
  regenerated 35 KB `cds_parsetab.py` plus `parser.out`. The likely failure: the
  added left-recursion makes chained-division input such as `km/s.Mpc-1` *parse*
  when `test_cds_grammar_fail[km/s.Mpc-1]` expects it to be **rejected**.
- **Read:** the genuine vtrace effect on this set. Both arms found the right file,
  but the injected `CDS` pivot + grammar context oriented the agent toward the
  precise, minimal rule change instead of a sweeping rewrite — and minimality is
  what passed all three `FAIL_TO_PASS` tests.

## Token / cost / duration comparison

Absolute per-run effort (vexp disabled, same model). "Total tokens" sums
input + output + cache-read + cache-create from the run JSONL; **cache-read
dominates and scales with turn count**, so treat it as an effort proxy, not an
injected-context-size measure.

| Instance | Arm | resolved | cost (USD) | duration | turns | total tokens |
| --- | --- | --- | --- | --- | --- | --- |
| requests-5414 | baseline | true | $0.4726 | 71.6 s | 20 | 736,898 |
| requests-5414 | vtrace | false | $0.3009 | 74.2 s | 17 | 543,663 |
| sympy-16766 | baseline | true | $0.5185 | 77.9 s | 33 | 1,414,441 |
| sympy-16766 | vtrace | true | $0.6317 | 92.5 s | 36 | 1,658,843 |
| astropy-14369 | baseline | false | $1.5550 | 393.1 s | 60 | 3,076,313 |
| astropy-14369 | vtrace | true | $3.0240 | 392.8 s | 78 | 4,298,912 |

- **requests:** vtrace cheaper (−36% cost, −26% tokens) but **failed** — a cheaper
  wrong answer is not a win.
- **sympy:** vtrace more expensive (+22% cost, +17% tokens, +3 turns) for the
  **same** resolved outcome — context overhead with no payoff here.
- **astropy:** vtrace much more expensive (+94% cost, +40% tokens, +18 turns) but
  **resolved** where baseline did not — the extra spend bought the resolution.

There is **no consistent efficiency direction**: injected context adds tokens/turns
in the two cases that tied/won and was lighter only on the case it lost. On this
set vtrace is not a cost-reduction story.

## Failure analysis

- **requests-5414 (vtrace fail / baseline pass):** regression by edit shape, not
  localization. Both edited `prepare_url`; vtrace's unconditional-IDNA refactor
  regresses `PASS_TO_PASS` while baseline's additive guard does not. The injected
  context correctly identified the symbol; the agent's broader rewrite under that
  context is the proximate cause.
- **astropy-14369 (baseline fail / vtrace pass):** baseline localized correctly but
  over-generalized the grammar (left-recursive rules) and regenerated the parse
  table by hand, most likely accepting an input that `test_cds_grammar_fail`
  requires to be rejected. vtrace's minimal swap + table deletion is the resolving
  difference.
- **No both-fail case**, so the "did vtrace at least localize better when both
  fail" tie-breaker does not apply. Where the arms disagreed on resolution, they
  *agreed* on localization — the deciding factor was always patch breadth.

No run hit an infrastructure error (`api_error_status` null, all
`completed_patch`, all Docker-evaluated).

## What this says about vtrace

- **Retrieval reliably reaches the right place — and so, here, does the unaided
  agent.** vtrace put the correct file/symbol at the lead pivot on all three, but
  the baseline agent also localized correctly on all three (including the
  wrong-subsystem astropy case). On instances this tractable, *localization* is not
  where injected context changes the outcome.
- **Where context helped, it helped via edit minimality (astropy).** The one vtrace
  win came from the injected grammar context steering the agent to a minimal,
  spec-matching change rather than a sweeping rewrite.
- **Where context hurt, it hurt via edit breadth (requests).** The injected
  `prepare_url` body appears to have invited a refactor that regressed passing
  behaviour.
- Net effect on this tiny set: **resolution parity (2/3 vs 2/3), identical
  localization, mixed cost** — one win, one regression, one tie. That is a neutral,
  honest result, not a superiority claim.

## Non-claims

- **This is not a public SWE-bench score.** Internal smoke harness on a fixed local
  fixture, not the SWE-bench leaderboard.
- **This is not a broad agent benchmark.** Three instances, one baseline arm and one
  (reused) vtrace arm each; no statistical power.
- **This is a small controlled validation on retrieval-recovered cases.** The three
  instances were chosen *because* recent retrieval fixes recovered them — a
  favourable, non-random selection for vtrace, and even so the result is parity, not
  a win.
- **Live-agent results are stochastic.** Patch synthesis varies run to run; the
  win/regression split here could shift on a rerun. No broad superiority (or
  inferiority) should be inferred from three cases.
- **The vtrace arm was reused, not freshly co-run.** Baseline and vtrace executed at
  different times with identical settings; per-run noise between arms is not
  controlled beyond holding the configuration fixed.

## Artifacts

| Instance | baseline (run fresh) | vtrace (reused) |
| --- | --- | --- |
| psf__requests-5414 | `results/runs/eval-baseline-vs-vtrace-baseline-requests-5414/` | `results/runs/eval-capsulev2-recovered-live-requests-5414/` |
| sympy__sympy-16766 | `results/runs/eval-baseline-vs-vtrace-baseline-sympy-16766/` | `results/runs/eval-capsulev2-recovered-live-sympy-16766/` |
| astropy__astropy-14369 | `results/runs/eval-baseline-vs-vtrace-baseline-astropy-14369/` | `results/runs/eval-capsulev2-recovered-live-astropy-14369/` |

Each run dir holds the raw `swebench-*.jsonl`, `_run.meta.json`, and
`_eval.meta.json` (Docker evidence); the vtrace dirs also hold the immutable
`_vtrace_instructions.snapshot.md` injected-context record. Curated reports are
tracked; the raw per-run artifacts are not tracked by default.
