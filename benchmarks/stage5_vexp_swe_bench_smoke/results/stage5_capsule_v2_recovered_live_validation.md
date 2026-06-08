# Stage 5 — Capsule v2 recovered-case live validation

A **targeted** live-agent sanity check, not a benchmark. It asks one narrow
question: for three instances that recent retrieval/input fixes specifically
*recovered* in the deterministic cross-repo eval, does that improved context
actually reach the live agent and help it edit the right place?

It is **not** a public SWE-bench score, not a vexp comparison, and not a broad
benchmark. Three instances, one condition (`vtrace-indexed`), Capsule v2 always
injected. Deterministic retrieval evidence and live patching evidence are kept
strictly separate below.

## How it was run

One condition only — the vtrace-indexed treatment with Capsule v2 forced on.
No baseline, no vexp, no auto-policy (the cost-aware gate was overridden to
always inject, so this measures the context, not the gate). Each instance ran
under its own run-label so nothing overwrote anything else.

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <one full instance id> \
  --run-label eval-capsulev2-recovered-live-<short> \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
# then: --mode evaluate --eval-mode docker --eval-dataset princeton-nlp/SWE-bench_Verified  (per label)
#       --mode ingest                                                                       (per label)
```

- Engine `v2`, intent `debug`, budget `8000`, context policy `force-inject` — confirmed in every `_run.meta.json` (`vtraceCapsuleEngine=v2`, `vtraceCapsuleIntent=debug`, `vtraceCapsuleBudget=8000`, `vtraceContextPolicyAction=inject`).
- The harness cloned each repo fresh to its base commit and indexed it (it did **not** reuse the deterministic-eval workspaces). Workspaces: `results/workspaces/eval-capsulev2-recovered-live-<short>/<instance>/`.
- All three are **valid** indexed-context treatments: `vtraceTreatmentValid=true`, `vtraceContextInjected=true`, `vtraceInjectionObserved=true`, `vtraceIndexedContext=true`.
- Model: `claude-opus-4-5-20251101`. Evaluation: real SWE-bench Docker suite (`dockerUsed=true`, `evaluationRan=true`, `evaluationError=null` for all three).

## Results at a glance

| Instance | Recovered by | Stage 5R deterministic (cross-repo-30) | Live capsule **lead pivot** | Agent edited lead pivot? | Live status | Docker `resolved` |
| --- | --- | --- | --- | --- | --- | --- |
| psf__requests-5414 | abbreviation / task-truncation fix | **pivot, top-1** (rank 1) | `requests/models.py::prepare_url` | yes | completed_patch | **false** |
| sympy__sympy-16766 | title-symbol anchoring via `PythonCodePrinter` | **pivot, top-1** (rank 1) | `sympy/printing/pycode.py::PythonCodePrinter` | yes | completed_patch | **true** |
| astropy__astropy-14369 | literal/acronym anchoring via `CDS` | **top-3, rank 2** (top-1 was `io/ascii/cds.py`) | `astropy/units/format/cds.py::CDS` | yes | completed_patch | **true** |

**Live outcome: 2 / 3 resolved.** In all three the agent edited *exactly the file
and symbol Capsule v2 put at the top of the injected context* — so retrieval
steered the agent correctly on every case, including the one that did not pass.

> Deterministic vs live retrieval are two different query constructions. The
> Stage 5R numbers above come from `stage5_retrieval_eval_cross_repo_30.json`
> (packed task string, expected-label scoring). The **live** capsule lead pivot
> comes from the Capsule v2 `debug`-intent query (clean task string) actually
> injected at run time — recorded in each `_run.meta.json`. For astropy they
> *disagree in the agent's favour*: the live debug-intent query promoted the
> correct `units/format/cds.py` to the **lead pivot**, ahead of the
> wrong-subsystem `io/ascii/cds.py` that topped the deterministic eval.

## Per-instance live effort

Token/cost/duration are **single-condition** numbers (vtrace-indexed only); there
is no baseline here, so these are absolute effort, not a reduction. "Total tokens"
sums input + output + cache-read + cache-create from the run JSONL.

| Instance | resolved | cost (USD) | duration | turns | total tokens | injected context |
| --- | --- | --- | --- | --- | --- | --- |
| psf__requests-5414 | false | $0.3009 | 74.2 s | 17 | 543,663 | 5,270 chars · est 1,282 tok · mode `standard` |
| sympy__sympy-16766 | true | $0.6317 | 92.5 s | 36 | 1,658,843 | 3,793 chars · est 914 tok · mode `standard` |
| astropy__astropy-14369 | true | $3.0240 | 392.8 s | 78 | 4,298,912 | 12,027 chars (truncated to 12,000) · est 5,086 tok · mode `standard` |

## Per-instance detail

### psf__requests-5414 — recovered, edited right place, **did not pass**

- **Retrieval reason for choosing it:** recovered by the abbreviation / task-truncation fix.
- **Stage 5R:** `requests/models.py` was the **top-1 pivot** (best rank 1, role `pivot`, `hit_top1_pivot`).
- **Injected lead pivot:** `requests/models.py::prepare_url` — chosen because the issue's source-line anchor points straight at that symbol ("explicit edit site"). The pivot body was injected.
- **Patch summary:** the agent edited `requests/models.py::prepare_url` — the exact target. It restructured the host-handling block: it moved the `host.startswith(u'*')` → `InvalidURL` check ahead of IDNA encoding, then made `_get_idna_encoded_host(host)` run **unconditionally** (dropping the original `if not unicode_is_ascii(host)` guard).
- **Why it failed:** the gold fix is a one-liner — extend the wildcard guard to `host.startswith((u'*', u'.'))`. The agent's refactor IDNA-encodes every host, including pure-ASCII ones that previously skipped encoding. That almost certainly satisfies the single `FAIL_TO_PASS` (`test_invalid_url[InvalidURL-http://.example.com]`) but regresses `PASS_TO_PASS`, so Docker reports `resolved=false`. This is a **patch-synthesis** miss on top of a **correct retrieval** — the context did its job (right file, right function); the agent's chosen edit shape was wrong.
- **Used the vtrace context:** yes. The injected snapshot led with `requests/models.py::prepare_url` and the agent's only edit is to that exact function.

### sympy__sympy-16766 — recovered, **resolved**

- **Retrieval reason for choosing it:** recovered by title-symbol anchoring (`PythonCodePrinter` → `sympy/printing/pycode.py::PythonCodePrinter`).
- **Stage 5R:** `sympy/printing/pycode.py` was the **top-1 pivot** (best rank 1, role `pivot`, `hit_top1_pivot`), via `title_symbol_matches: PythonCodePrinter -> pycode.py::PythonCodePrinter`.
- **Injected lead pivot:** `sympy/printing/pycode.py::PythonCodePrinter` (with class source body).
- **Patch summary:** the agent added a `_print_Indexed` method to `PythonCodePrinter` in `sympy/printing/pycode.py` — the same fix as gold, implemented as `"%s[%s]" % (self._print(expr.base.label), ", ".join(self._print(i) for i in expr.indices))`. Functionally equivalent to the gold `_print_Indexed`.
- **Result:** `resolved=true`. Clean end-to-end: title-symbol anchoring → correct lead pivot → correct symbol edited → test passes.
- **Used the vtrace context:** yes. Lead pivot `pycode.py::PythonCodePrinter` was injected with its body; the support set even included sibling `_print_Indexed` implementations (`ccode.py`, `jscode.py`, `glsl.py`) the agent could mirror.

### astropy__astropy-14369 — recovered into top-3, **resolved**

- **Retrieval reason for choosing it:** recovered by literal/acronym anchoring (`CDS` → `astropy/units/format/cds.py::CDS`).
- **Stage 5R:** `astropy/units/format/cds.py` was **top-3, rank 2** — the deterministic top-1 pivot was the wrong-subsystem `astropy/io/ascii/cds.py`; `units/format/cds.py` was recovered into top-3 by `literal_anchor_matches: CDS -> units/format/cds.py::CDS`. (This is the case the prior state doc listed as an unrecovered wrong-subsystem miss; literal anchoring lifted it into top-3.)
- **Live retrieval did better than the deterministic eval:** the `debug`-intent capsule query promoted `astropy/units/format/cds.py::CDS` to the **lead pivot** (top-1), ahead of the I/O-subsystem file.
- **Patch summary:** the agent made the exact gold grammar fix in `astropy/units/format/cds.py` — `division_of_units : ... | combined_units DIVISION unit_expression` (swapping the jumbled `unit_expression DIVISION combined_units`). For the generated LALR table it did **not** hand-edit `cds_parsetab.py`; it **deleted** the file, so `ply` regenerates a correct table at import time. Both the grammar fix and the stale-table problem are handled.
- **Result:** `resolved=true` across all three `FAIL_TO_PASS` cds-grammar tests. The hardest case (wrong-subsystem framing + a generated parser table) passed — deleting the cached table is a legitimate substitute for the gold's regenerated `cds_parsetab.py`.
- **Used the vtrace context:** yes. The injected lead pivot was `units/format/cds.py::CDS`; the agent's grammar edit lands inside that class's `_make_parser`. Context was truncated at the 12,000-char budget cap, which did not prevent the edit.

## Failure analysis (unresolved cases)

Only **psf__requests-5414** is unresolved, and it is a clean separation of
concerns:

- **Retrieval: correct.** `requests/models.py` was top-1 deterministically and the injected lead pivot, and the agent edited `prepare_url` — the exact gold edit site. Nothing about retrieval or context steered it wrong.
- **Synthesis: incorrect.** The agent chose a broader control-flow rewrite (unconditional IDNA encoding) instead of the minimal `startswith((u'*', u'.'))` guard, which regresses previously-passing behaviour. This is the known live-stochasticity caveat: improved context reliably gets the agent to the right place, but does not guarantee the agent picks a minimal, regression-free edit on any single run.

No case failed for an infrastructure reason: no `api_error_status`, no
`agent_failed`, no `policy_skip`, no `infra_failed`. Every run is
`completed_patch` and was Docker-evaluated.

## What this does and does not show

- **Shows:** on these three recovered cases, the recent retrieval/input fixes carry through to the live agent — Capsule v2 (force-inject, `debug`, 8 k) put the correct file/symbol at the top of the injected context every time, the agent edited that exact target every time, and 2 of 3 produced passing patches under the real Docker suite.
- **Does not show:** any public SWE-bench score, any vexp comparison, any token/cost *reduction* (no baseline arm was run), or statistical significance. Three instances, one condition. Live patch synthesis is stochastic; requests-5414 is the standing example of correct retrieval with an incorrect edit shape.

## Artifacts

| Instance | Run label | Raw JSONL + meta |
| --- | --- | --- |
| psf__requests-5414 | `eval-capsulev2-recovered-live-requests-5414` | `results/runs/eval-capsulev2-recovered-live-requests-5414/raw/vtrace/` |
| sympy__sympy-16766 | `eval-capsulev2-recovered-live-sympy-16766` | `results/runs/eval-capsulev2-recovered-live-sympy-16766/raw/vtrace/` |
| astropy__astropy-14369 | `eval-capsulev2-recovered-live-astropy-14369` | `results/runs/eval-capsulev2-recovered-live-astropy-14369/raw/vtrace/` |

Each run dir also holds the immutable injected-context snapshot
(`_vtrace_instructions.snapshot.md`) and `_run.meta.json` (capsule audit) /
`_eval.meta.json` (Docker evaluation evidence).
