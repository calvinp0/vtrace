# M188 — outstanding defects and unresolved evidence

M188 changed no product code, so nothing here is a VTRACE defect. These are the gaps
the audit could not close and the traps it thinks a later milestone will otherwise
walk into.

## Unresolved in the external evidence

1. **VEXP's claimed 3.0.0 ablation has no artifacts.** Twenty-five SWE-bench Pro task
   ids, per-task rows, logs and the harness are all unreleased. The claim is checkable
   in principle — SWE-bench Pro is public — and is not checkable in fact. Its
   resolution effect (2 discordant pairs) is not statistically resolvable as reported;
   its continuous measures (13% context replay, 8% session cost) have more power and no
   dispersion, so they can be neither graded nor dismissed.

2. **The two tool spellings in VEXP's published run rows are unexplained.** The
   committed MCP config registers the server as `vexp`, which yields
   `mcp__vexp__run_pipeline`. The rows contain `mcp__vexp-mcp__run_pipeline` once and
   the bare `run_pipeline` four times, and the parser normalises nothing. The rows were
   most likely produced under a different configuration than the committed one, and the
   bare calls are most likely the model echoing the name from `CLAUDE.md`. The raw
   streams are not published, so this stays `INFERRED_FROM_IMPLEMENTATION`.

3. **VEXP's result-row timestamps are not a faithful trace.** One hundred rows on a
   single exact 300-second delta, spanning 29,700s while the rows' own durations sum to
   16,927s, from an orchestrator that stamps `new Date()` per row. Regenerated or
   normalised. The Docker grading is unaffected and independently checkable; the run
   rows are not a timeline.

4. **`I3` has a field experiment we cannot see.** `vexp doctor` reports, among its
   silence reasons, "this prompt is in the measurement control group" — so ambient
   orientation is being A/B tested against real users continuously. No result is
   published. This is the single largest body of relevant evidence known to exist and
   inaccessible.

5. **TDAD's models are not frontier-scale.** Qwen3-Coder 30B and Qwen3.5-35B-A3B, both
   4-bit quantized on consumer hardware, with 31% and 24% baselines against ~52% and
   ~69% for the same models under full scaffolds. Whether a diff-derived test obligation
   helps an Opus-class agent that could have found those tests itself is untested.

6. **Sourcegraph, Cody, OpenHands and Sonar Foundation are `UNKNOWN` on every
   intervention question in this audit.** They were searched and produced no mechanism
   evidence at the standard section 10 requires. Their absence from the matrix is a
   coverage limit, not a finding about them.

7. **No audited system has an intervention for the bottleneck ContextBench names.**
   Retrieval reaches the gold context; the agent then fails to condition on it.
   Retrieval products cannot address that by retrieving harder, and nothing in this
   audit addresses it at all.

## Traps for a later milestone

8. **The preserved VTRACE corpus cannot witness the class M188 recommends.** M187
   established that 55 of 60 M183 arms never started a test runner. Phase 2B run
   against those traces would return "no witness" for validation and edit-set
   obligations for a reason that has nothing to do with the mechanism. Any
   counterfactual-discovery milestone must state which mechanisms its corpus is capable
   of witnessing before it counts absences.

9. **The outcome axis for this class is regressions, not resolution.** TDAD's
   resolution went down two points while its test-level regression fell by 70%. A
   VTRACE experiment in this class that scores only SWE-bench resolution would be
   measuring the wrong variable and would probably find nothing. `PASS_TO_PASS` is
   already collected by the Docker harness and already unscored by our ledger.

10. **A mandate without a specific obligation is worse than nothing.** Three
    independent lines now say so — M168-E, TDAD's TDD Prompting Paradox (6.08% to
    9.94%), and the two context-file ablations. If any future intervention is delivered
    as instruction rather than as evidence, this is the expected sign.

11. **VEXP shipped an instruction naming a tool that did not exist, on one of two
     surfaces, for three minor versions.** Their own source comment records it. The
     shape is M184's and M187's: a capability believed present, an instruction premised
     on it, and no check that the two agreed. Any VTRACE guidance text that names a
     tool needs a test that the named tool is listed on every surface that reads the
     guidance.
