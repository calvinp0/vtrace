# Stage 5 PIVOT_CHECK post-inspection analysis

_Analysis / reporting only. No live agents, no Docker, no retrieval / PIVOT_CHECK /
telemetry / classifier changes, no raw artifacts modified. Gold patch files are
used ONLY as the analyst's evaluation label — never as agent input._

## Summary

The targeted PIVOT_CHECK comparisons proved one thing — hidden pivots reliably move
from ignored / discovered-only to **inspected** — and left the next question open:
once the agent has directly read a hidden pivot, why does the edited-file set still
not change? This report classifies what happened **after** inspection on the two
after-runs.

| instance | hidden pivot | inspected? | edited? | classification | confidence |
| --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | `sphinx/pycode/ast.py::unparse` | yes (2 reads, ~lines 1–124) | no | `failed_to_connect_to_edit` | medium-high |
| mwaskom__seaborn-3187 | `seaborn/relational.py::scatterplot` | yes (1 read, lines 700–760) | no | `not_actually_edit_relevant` | medium |

**Headline.** Of the two hidden pivots converted to inspected, only **one
(sphinx)** was actually an edit target. On that single informative case, the agent
read the gold-relevant pivot reasonably well and **still did not make the parallel
edit** — i.e. the live bottleneck is post-inspection edit-planning, not inspection.
The other case (seaborn) inspected a pivot that was **not** a real edit target, so
it provides no evidence about edit conversion (and is weak evidence anyway, since
`seaborn/utils.py` was edited in both arms).

With exactly **one** edit-relevant-and-inspected data point, the evidence is too
thin to justify building a new mechanism. Conservative call: **keep PIVOT_CHECK
benchmark-only; gather more edit-relevant hidden-pivot cases before adding
edit-plan or rule-out machinery.**

## Method

For each after-run (`results/runs/eval-pivot-check-vtrace-<case>/`) the following
raw artifacts were read directly (none modified):

- `raw/vtrace/_tool_calls.json` — the ordered tool log (authoritative inspection
  evidence: tool, category, and the Read `offset`/`limit` showing *which region*
  was opened).
- `raw/vtrace/swebench-*.jsonl` — the final `modelPatch` (edited files + hunks) and
  `resolved`.
- `raw/vtrace/_run.meta.json` — `vtraceCapsulePivots`, `vtracePivotChecklistEmitted`,
  `vtraceToolLogOrdered`.
- `_vtrace_instructions.snapshot.md` — the injected PIVOT_CHECK block (what the
  agent was actually told about each pivot).
- `raw/vtrace/_run.stdout.txt` / `_run.stderr.txt` — harness output only.

Limitation that shapes confidence: the JSONL carries **no assistant
message/reasoning array** (`messages`/`history`/`transcript`/`trajectory` all
absent), and `vtracePivotChecklistEmitted=false` for both runs — the agent never
echoed a filled checklist. So *assistant reasoning around the hidden-pivot reads is
not directly recoverable*. Classifications are therefore inferred from: (a) read
depth/coverage in the tool log, (b) the final patch, and (c) whether the pivot is
in the known gold patch (analyst label). Edit-relevance is judged against the gold
patch files, which is an evaluation signal only.

"Edit-relevant (gold)" below means the file appears in the instance's gold patch —
established in the prior retrieval / localization-gap reports, not fed to the agent.

## Case analyses

### sphinx-doc__sphinx-7462

- **instance_id:** `sphinx-doc__sphinx-7462`
- **after_run_label:** `eval-pivot-check-vtrace-sphinx-7462`
- **hidden_pivot:** `sphinx/pycode/ast.py::unparse` (surfaced as pivot #2; not named
  by the traceback, which points at `sphinx/domains/python.py`)
- **inspection evidence:** ordered tool log shows two direct Reads of the hidden
  pivot back-to-back, *before* any edit:
  - `#1 Read ast.py` `offset 1, limit 100` (lines 1–100)
  - `#2 Read ast.py` `offset 95, limit 30` (lines 95–124)
  Combined coverage ≈ lines 1–124, spanning `unparse` and the start of the
  `_UnparseVisitor` methods. This is **not** a shallow single-region peek — the
  agent opened the function it would have had to change.
- **assistant reasoning evidence:** none recoverable (no transcript array;
  `vtracePivotChecklistEmitted=false`). The decision rationale is not in the
  artifacts.
- **edited files:** `sphinx/domains/python.py` only. The patch adds `if node.elts:`
  guards around `result.pop()` in `_parse_annotation` for both the `ast.List` and
  `ast.Tuple` branches (fixes the `IndexError` on an empty `()`/`[]`).
- **classification:** `failed_to_connect_to_edit`
- **confidence:** medium-high
- **why this classification was chosen:** `ast.py::unparse` is in the gold patch —
  the gold fixes the empty-tuple rendering in `unparse` and a co-test
  (`tests/test_pycode_ast.py::test_unparse[()-()]`) exercises exactly that path. The
  agent inspected that file twice with real coverage, yet localized the *entire* fix
  to `domains/python.py`. So a gold-edit-relevant hidden pivot was read and the
  needed parallel edit was missed — the definition of `failed_to_connect_to_edit`.
  It is **not** `shallow_inspection` (coverage was adequate) and **not**
  `correct_rule_out` (the rule-out was, against gold, wrong). Confidence is
  medium-**high** rather than high only because the agent's reasoning is not
  recoverable, so we cannot fully exclude a deliberate (if mistaken) rule-out.
- **recommended implication:** this is the one case that genuinely tests "does
  inspection convert to an edit?" and the answer here is no — the gap is
  post-inspection edit-planning / rule-out reasoning, not getting the file opened.

### mwaskom__seaborn-3187

- **instance_id:** `mwaskom__seaborn-3187`
- **after_run_label:** `eval-pivot-check-vtrace-seaborn-3187`
- **hidden_pivot:** `seaborn/relational.py::scatterplot` (surfaced as pivot #2; the
  public function the issue uses to reproduce the bug)
- **inspection evidence:** a single direct Read — `#1 Read relational.py`
  `offset 700, limit 60` (lines 700–760), opened very early and **never revisited**
  across the run's 29 logged tool calls. One narrow region, no follow-up.
- **assistant reasoning evidence:** none recoverable (same limitation;
  `vtracePivotChecklistEmitted=false`).
- **edited files:** `seaborn/_core/scales.py` (`ContinuousBase`, hunk @ ~line 379 —
  the `ScalarFormatter` offset fix) and `seaborn/utils.py`
  (`locator_to_legend_entries`, hunk @ ~line 707). `relational.py` was **not**
  touched.
- **classification:** `not_actually_edit_relevant`
- **confidence:** medium
- **why this classification was chosen:** `relational.py` is **not** in the gold
  patch (gold = `seaborn/_core/scales.py` + `seaborn/utils.py`). `scatterplot` is the
  reproduction entry point, not the fix site. The agent correctly left it unchanged
  and edited the two actual gold files. So the hidden pivot was an editing
  false-positive — it did not need an edit, and the run confirms that by editing the
  right files instead. This is also partly consistent with
  `used_as_context_no_edit_needed` (reading the entry point can help trace down to
  `scales.py`) and the read itself was thin enough to qualify as
  `shallow_inspection`; `not_actually_edit_relevant` is chosen as primary because
  the decisive, provable fact is non-relevance to the gold edit. Confidence is
  medium (not high) because reasoning is unrecoverable and the single shallow read
  leaves "useful context" vs "glanced and ignored" indistinguishable.
- **recommended implication:** this case is **weak evidence** for the PIVOT_CHECK
  edit-conversion question. The hidden pivot was never an edit target, and
  `seaborn/utils.py` was already edited in both the before and after arms — so
  nothing here speaks to whether inspection changes edits. Useful mainly as a
  reminder that many surfaced hidden pivots are context/rule-out targets, not edits.

## Cross-case pattern

- **2 hidden pivots inspected; 1 was edit-relevant.** Inspection conversion is
  consistent, but edit-relevance of the inspected pivot is not: sphinx's was gold,
  seaborn's was not.
- **On the single edit-relevant case, inspection did not convert to an edit**
  (`failed_to_connect_to_edit`). The file was read with adequate coverage and still
  not edited.
- **The non-edit-relevant case behaved correctly** (read the entry point, edited the
  real fix sites) but tells us nothing about conversion.
- **Effective sample size for the real question is N = 1.** "Does direct inspection
  of an edit-relevant hidden pivot lead to the edit?" has exactly one observation so
  far, and it is a miss. One miss is enough to locate the *next* bottleneck
  (post-inspection edit-planning) but not enough to design or justify a mechanism
  against it.
- **Neither run was Docker-evaluated** (`resolved=null` both), so none of this
  speaks to resolution or patch correctness — only to where in the pipeline the
  hidden-pivot edit is lost.

## Product interpretation

PIVOT_CHECK has done its job at the inspection layer and surfaced the *real* next
problem on the one case able to test it: after the agent directly reads a
gold-relevant hidden pivot, it can still fail to connect that pivot to a needed
edit (sphinx). That is a post-inspection reasoning / edit-planning gap, not a
retrieval or inspection gap.

But the evidence base is two targeted runs, of which only one is even on-topic for
edit conversion, and that one is a single miss with unrecoverable reasoning. The
seaborn case further shows that a surfaced-and-inspected hidden pivot is frequently
**not** an edit target at all — so any future "make the agent edit inspected
pivots" mechanism would risk pushing wrong edits if applied indiscriminately. The
honest reading is: PIVOT_CHECK is an inspection-enforcement mechanism with a
demonstrated cost overhead and **no** demonstrated patch-quality or resolution
benefit, and the data does not yet support escalating it.

### Evaluation of the candidate conclusions

| # | Candidate | Verdict | Rationale |
| --- | --- | --- | --- |
| 1 | Keep PIVOT_CHECK benchmark-only | **Accept** | Inspection works; cost is real; no patch/resolution benefit shown. Benchmark-only is the right containment. |
| 2 | Add stronger edit-plan guidance | **Defer** | Suggested by sphinx, but N=1 edit-relevant case. Don't build against one observation. |
| 3 | Require explicit rule-out justification for inspected hidden pivots | **Defer (leading future candidate)** | Directly targets the sphinx failure mode: forcing "ast.py needs no edit because X" could surface the missed edit. But only warranted if `failed_to_connect_to_edit` recurs across more edit-relevant cases. |
| 4 | Add row-level checklist parsing | **Defer** | A measurement aid, not a fix. The checklist was never even emitted (`vtracePivotChecklistEmitted=false` both runs), so parsing rows would mostly measure non-compliance today. Reconsider alongside #3. |
| 5 | Promote PIVOT_CHECK into shared Capsule v2 rendering | **Reject (now)** | No patch/resolution evidence + measured token/cost overhead on both runs. Promoting to default product behavior is unjustified. |
| 6 | Stop PIVOT_CHECK work due to overhead | **Reject** | The one informative case identifies a concrete, addressable bottleneck; stopping now would discard that signal prematurely. |

## Recommended next step

**Keep PIVOT_CHECK benchmark-only. Do not promote it to default product behavior,
and do not yet add edit-plan or rule-out mechanics.**

Before building any new mechanism, close the evidence gap:

1. **Get more edit-relevant, inspected hidden-pivot cases.** Run the additional
   Tier-1/Tier-2 candidates from
   `stage5_pivot_check_candidate_selection.md` (gated on the capsule pre-check) so
   the "edit-relevant hidden pivot → inspected → edited?" question has more than one
   observation.
2. **Per case, first decide edit-relevance, then decide the failure mode.** seaborn
   shows many surfaced hidden pivots are `not_actually_edit_relevant`; only the
   edit-relevant ones (like sphinx) test conversion. Mixing them would manufacture a
   false "PIVOT_CHECK doesn't help edits" signal.
3. **If `failed_to_connect_to_edit` recurs on edit-relevant pivots, prototype
   conclusion #3** (explicit rule-out justification) as the most targeted mechanism,
   measured with #4 (row-level parsing), still benchmark-only.

If, after more cases, edit conversion still does not appear, the indicated move is
to keep PIVOT_CHECK as a measurement/inspection tool and not invest further in
turning inspection into edits.

## Non-claims

- This analysis is based on **two targeted live runs** (one of which is weak/off-topic
  for edit conversion); it is not a benchmark and has no statistical power.
- It does **not** claim PIVOT_CHECK improves Docker resolution (neither run was
  Docker-evaluated).
- It does **not** claim PIVOT_CHECK improves patch correctness.
- It does **not** claim hidden-pivot inspection should be globally or default-enabled.
- It does **not** use private / gold labels as agent input — gold patch files are
  used only as the analyst's edit-relevance label.
- It does **not** alter retrieval, PIVOT_CHECK injection, telemetry, the classifier,
  or any benchmark behavior, and modifies no raw artifacts.
- Assistant reasoning was **not recoverable** from the artifacts; classifications are
  inferred from tool-log read depth, the final patch, and gold edit-relevance, and
  carry the stated confidence accordingly.
