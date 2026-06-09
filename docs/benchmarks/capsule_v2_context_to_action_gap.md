# Capsule v2 — the context-to-action gap

**Status:** documentation only. No retrieval, scoring, prompt, or agent code was
changed to write this note. It records a single, specific finding from the
localization-gap live work so the next person does not re-derive it.

## The finding

On `sphinx-7462`, the limiting factor is **not only retrieval**. Capsule v2 already
does the hard part — it surfaces the hidden, non-traceback root-cause file and flags
it — yet the live agent still does not edit it. The gap is **context-to-action**:
getting a correct, prominently-flagged pivot from the injected context into an
actual edit.

This matters because the earlier conclusion ("retrieval localizes the hidden target;
the agent must act on it") was then tested directly: we added explicit multi-pivot /
hidden-pivot guidance to the injected context (render-only — see
[`capsule_v2_stage5r_milestone.md`](./capsule_v2_stage5r_milestone.md) and the
`Clarify Capsule v2 multi-pivot edit guidance` commit) and re-ran the case. The
guidance rendered exactly as intended; the outcome did not change.

## Smoke result

A single live `vtrace-indexed` force-inject run of `sphinx-7462` after the
multi-pivot guidance landed (label `eval-locgap-multipivot-sphinx-7462`):

```text
sphinx-7462:
  hidden pivot surfaced:          sphinx/pycode/ast.py::unparse   (capsule pivot #2)
  hidden pivot warning rendered:  yes  (## Multiple edit targets + "hidden candidate" note)
  agent edited hidden pivot:      no
  agent edited:                   sphinx/domains/python.py only   (the traceback-named file)
  resolved (Docker):              false
```

The gold patch for `sphinx-7462` edits **both** `sphinx/domains/python.py` and
`sphinx/pycode/ast.py`. The traceback names only the first; the second is named
nowhere in the problem statement. Capsule v2 surfaced the second as pivot #2 and the
render flagged it as a hidden candidate with an explicit "inspect it before
finalizing the patch" note — and the agent still edited only the traceback-named
file, so `tests/test_pycode_ast.py::test_unparse[()-()]` continued to fail.

Full context: the baseline-vs-vtrace shape of this case is in
[`stage5_localization_gap_live_comparison.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_localization_gap_live_comparison.md).

## Product implication

Capsule v2's job — find and flag the right files, including the non-obvious one — is
being done here. The remaining lever is the **agent loop**, not the context render.
Prompt-side wording was the cheap thing to try; it was tried, and on this run it was
not enough. Further improvement on the context-to-action gap likely requires the
agent loop to *enforce* pivot inspection rather than merely *suggest* it. Candidate
mechanisms (none implemented; out of scope here):

- **Force an explicit inspect/rule-out step for every pivot** before any edit is
  allowed.
- **Require the agent to state which pivots it inspected** (and why it ruled each
  out) before editing.
- **Block patch finalization while uninspected pivots remain** — a gate, not a hint.
- **Add a tool/check that compares edited files against the capsule's pivots** and
  surfaces any pivot that was surfaced-but-never-opened.

These are agent-orchestration changes (loop, tools, gates), not retrieval or
rendering changes. The distinction is the point: better context did not convert,
so the next experiment should be on how the agent is made to *use* the context.

## Non-claims

- **This is one stochastic live smoke run.** A single sample on one instance; a
  rerun could land differently.
- **It does not prove the guidance can never help.** The wording is correct and the
  hidden pivot was flagged; another run, another instance, or a stronger phrasing
  could still convert.
- **It does show that prompt-side guidance alone is insufficient evidence of
  context-to-action conversion.** One render-only change that surfaced and flagged
  the right file did not, by itself, produce the edit — so "the context now mentions
  it" cannot be treated as "the agent will act on it."
- **Not a public SWE-bench score, not a benchmark.** A targeted diagnostic on a
  single hand-picked instance.
