# Capsule v2 — the context-to-action gap

**Status:** documentation only. No retrieval, scoring, prompt, or agent code was
changed to write this note. It records a single, specific finding from the
localization-gap live work so the next person does not re-derive it.

> **Follow-up (resolved on this case).** The gap below predicted that the agent
> loop must *enforce* pivot inspection, not merely *suggest* it. That enforcement
> was then built (compact, benchmark-only `PIVOT_CHECK`) and measured live: on
> `sphinx-7462` the hidden pivot moved from **discovered-only / ignored** to
> **inspected**. See [PIVOT_CHECK live result](#follow-up--pivot_check-enforcement-resolved-on-this-case)
> at the bottom of this doc. The original finding is kept intact above it as the
> historical "before".

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

---

# Follow-up — PIVOT_CHECK enforcement (resolved on this case)

The render-only guidance above (the historical "before") did not convert. The
next experiment built the enforcement the Product implication called for and
measured it end-to-end. This section is the resolution.

## Context-to-action progression

The full Stage C arc, in order:

```text
1. render-only hidden-pivot guidance        → failed (agent still edited python.py only)
2. ordered tool-call telemetry added        → initially failed to materialize
                                               (adapter had the old instructions
                                               patch but not the newer stream patch)
3. telemetry patch migration fixed (6dfbc1b) → independent instruction/stream
                                               markers, stream patch self-heal,
                                               runtime sentinel/debug distinction,
                                               _agent_stream.jsonl → _tool_calls.json
4. telemetry proved the gap                  → hidden pivot was Grep-discovered only,
                                               never Read, never edited
5. PIVOT_CHECK enforcement added (13c7a25)   → hidden pivot converted to inspected
```

Each step is a different lever; keep them distinct. Retrieval already surfaced
the pivot (step 0, see the historical finding above). Telemetry is measurement,
not behavior. PIVOT_CHECK is the prompt lever. The patch is the end state.

## PIVOT_CHECK live result

`PIVOT_CHECK` is a compact, **benchmark-only** instruction block injected into the
Capsule v2 context on multi-pivot runs. It is seeded with the actual pivot rows,
says explicitly that Search/Grep does **not** count as inspection, requires a
direct `Read`/open of every pivot before editing, and does **not** require editing
every pivot. It is gated on `capsule_engine == v2 && pivot_count >= 2` and carries
a hidden-pivot note when any pivot is non-source-anchored. (Commit `13c7a25`.)

## Telemetry fixed the measurement gap

The conversion could only be *seen* because ordered tool-call telemetry was made
to work first. Before commit `6dfbc1b`, the external `vexp-swe-bench` adapter
carried the old instructions patch but not the newer stream patch, so
`_agent_stream.jsonl` / `_tool_calls.json` were never materialized and the hidden
pivot's status was unobservable. `6dfbc1b` made the instruction and stream patches
independent (separate markers), gave the stream patch self-heal/migration, split
the runtime sentinel from debug output, and materialized
`_agent_stream.jsonl → raw/vtrace/_tool_calls.json`. Only then could a run report
whether a surfaced pivot was actually opened.

## Context-to-action result

Exact before/after, same instance (`sphinx-doc__sphinx-7462`), hidden pivot
`sphinx/pycode/ast.py::unparse`:

```text
Before PIVOT_CHECK
  Run:                 eval-pivot-telemetry-vtrace-sphinx-7462-r2
  _agent_stream.jsonl: present
  _tool_calls.json:    present
  vtraceToolLogOrdered: true
  vtraceToolCallCount:  6
  hidden pivot sphinx/pycode/ast.py::unparse:
    discovered via Grep
    inspected: false
    edited:    false
    status:    discovered-only / ignored

After PIVOT_CHECK
  Run:                  eval-pivot-check-vtrace-sphinx-7462
  vtraceToolLogOrdered:  true
  vtraceToolCallCount:   11
  vtraceToolCallError:   null
  PIVOT_CHECK injected:  true
  seeded both pivots:    true
  hidden-pivot note:     true
  hidden pivot sphinx/pycode/ast.py::unparse:
    directly Read twice (full read, then a focused read around unparse)
    inspected: true
    edited:    false
    status:    inspected
  vtracePivotChecklistEmitted: false
```

The hidden pivot moved from **discovered-only / ignored → inspected**. The agent
still edited only `sphinx/domains/python.py`; reading `ast.py` and choosing not to
edit it is still a context-to-action improvement (the surfaced pivot was engaged,
not skipped).

## Interpretation

PIVOT_CHECK produced **behavioral compliance without textual checklist
compliance**. The agent inspected the hidden pivot but did **not** echo the
checklist table (`vtracePivotChecklistEmitted: false`). The product lesson:

```text
Ordered tool evidence is the authoritative compliance signal.
Checklist text is a prompt lever, not the source of truth.
```

Reports must therefore keep four signals separate:

```text
- prompt injected                  (snapshot contains PIVOT_CHECK)
- checklist emitted by assistant   (vtracePivotChecklistEmitted)
- ordered tool-call evidence       (_tool_calls.json: Read vs Grep on a pivot)
- final patch files                (which pivots were actually edited)
```

## Non-claims

- Do **not** claim PIVOT_CHECK improves Docker resolution yet (resolution is
  reported separately from context-use conversion).
- Do **not** claim it guarantees correct edits.
- Do **not** claim checklist emission is required for compliance — here it was
  absent while behavior converted.
- Do **not** claim broad benchmark performance from one `sphinx-7462` smoke.
- Do **not** claim this is a public SWE-bench result.

The current safe claim:

```text
VTRACE can now surface hidden pivots, inject explicit inspection requirements,
record ordered tool use, and verify whether the agent actually inspected the
surfaced pivots. On sphinx-7462, compact PIVOT_CHECK converted the hidden pivot
from discovered-only to inspected.
```

## Next steps

```text
1. Stop adding more loop complexity for now.
2. Preserve this as the first measured context-to-action conversion milestone.
3. Run a small additional validation set only after documenting this result.
4. Keep ordered tool evidence as the source of truth.
5. Treat checklist parsing as secondary; row-level checklist parsing can remain TODO.
6. Report Docker resolution separately from context-use conversion.
```
