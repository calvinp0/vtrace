# Stage 5 — M20 in-loop test verification audit

## 1. Executive conclusion

**Fair in-loop test verification is NOT usable today, and the immediate blocker is artifact
capture, not signal availability.**

Two findings decide this:

1. **The agents already run the relevant test, unprompted, in BOTH sphinx r1 and r2.**
   Each first pass ran `python -m pytest tests/test_domain_py.py::test_parse_annotation`
   — the FAIL_TO_PASS test — on its own. So "did the agent run a relevant test?" is
   *identical* for r1 and r2 and cannot, by itself, distinguish them.
2. **The test OUTCOME — the only thing that could distinguish them — is not persisted.**
   `_tool_calls.json` records the pytest *command* but `output_summary` is `null` for every
   call across every target run; `_run.stdout.txt` does not contain agent command output.
   The pass/fail result exists upstream in the raw agent stream (`tool_result` events) but
   VTRACE drops it during tool-call extraction, and that stream is a SHARED file that later
   runs clobber.

So the discriminating signal (test outcome on the final patch) is structurally absent from
the per-label artifacts. Until it is captured — separated by phase (first-pass vs revision)
and tied to the patch state it was run against — no fair adoption signal can even be
*measured*, let alone trusted. A second, independent concern (below) is that the test
*name* reaches the agent through benchmark-derived "failing test" labeling, which must be
classified before any agent-run test result could be called fair.

## 2. Artifact availability

| artifact | available? | first-pass? | revision-pass? | contains commands? | contains stdout/stderr? | contains test results? | usable for fair adoption? |
| -------- | ---------- | ----------- | -------------- | ------------------ | ----------------------- | ---------------------- | ------------------------- |
| `_tool_calls.json` | yes | yes | **no** (none written under `vtrace_pivot_revision/`) | yes (Bash `args.command`) | **no** (`output_summary` null) | **no** | not yet — commands only |
| `_tool_calls.summary.json` | yes | yes | no | counts only (`bashToolCalls`) | no | no | no (aggregate counts) |
| `_run.stdout.txt` / `_run.stderr.txt` | yes | runner-level | runner-level | no (runner output, not agent cmd output) | runner's own | no | no |
| `vtrace_pivot_revision/swebench-*.jsonl` | yes | n/a | yes (revised patch row) | no | no | no (patch only) | no |
| raw `_agent_stream.jsonl` (OUT root) | yes but SHARED/clobbered, untracked | mixed | mixed | yes (tool_use) | **yes (`tool_result` content)** | yes, in principle | not as-is (not per-label, overwritten) |
| `_pivot_revision_prompt.md` | yes | n/a | yes | injects FAIL_TO_PASS names | no | no | see §4 (oracle/ambiguous) |
| `_capsule_v2_context.md` | yes | yes | n/a | surfaces "failing test method" names | no | no | see §4 (ambiguous) |

**Key gap:** outputs exist in the upstream stream but are (a) not extracted into the
per-label `_tool_calls.json` (`output_summary` left null), and (b) only in a shared stream
that is overwritten by the next run. Revision-phase tool calls are not extracted at all.

## 3. Run-level analysis

| label | phase | test commands observed? | outputs available? | test names visible? | signal classification | could distinguish r1/r2? | notes |
| ----- | ----- | ----------------------- | ------------------ | ------------------- | --------------------- | ------------------------ | ----- |
| `...m16...sphinx-7462-r1` | first-pass | yes — `pytest ...::test_parse_annotation` (1 of 5 bash) | no (`output_summary` null) | yes | fair_non_oracle command / **unavailable** outcome | no | agent ran the FAIL_TO_PASS test itself |
| `...m16...sphinx-7462-r2` | first-pass | yes — `pytest ...::test_parse_annotation` (1 of 4 bash) | no | yes | fair_non_oracle command / unavailable outcome | no | same command as r1 — commands don't separate them |
| `...m16...seaborn-3187-r2` | first-pass | no pytest (1 bash, non-test) | no | n/a | unavailable | n/a | revised patch was identical/skipped anyway |
| `...m14...sphinx-7462-r1` | first-pass | yes — `pytest ...::test_parse_annotation` (1 of 2 bash) | no | yes | fair_non_oracle command / unavailable outcome | no | same picture as the m16 chain |
| `...m14...sphinx-7462-r2` | first-pass | yes — `pytest ...::test_parse_annotation` (1 of 3 bash) | no | yes | fair_non_oracle command / unavailable outcome | no | — |
| all five | revision-pass | **not recorded** (no `_tool_calls.json` under `vtrace_pivot_revision/`) | no | n/a | unavailable | no | revision-phase tool activity is not extracted |

Answers to the per-run questions (consolidated, since all five behave the same):
1. **Did the first-pass agent run tests?** Yes, in all sphinx runs (the FAIL_TO_PASS test);
   seaborn r2 ran no pytest.
2. **Did the revision pass run tests?** Unknown from artifacts — revision-phase tool calls
   are not extracted; only the clobberable raw stream might hold it.
3. **Which commands?** `python -m pytest tests/test_domain_py.py::test_parse_annotation`
   plus `python -c` snippets and `git diff`.
4. **Are command outputs visible?** No (`output_summary` null; stdout files are runner-level).
5. **Are test names visible?** Yes (in the command, the capsule context, and the revision prompt).
6. **Did test output distinguish r1 from r2 before shadow eval?** No — outputs absent, and
   the *commands* were identical between r1 and r2.
7. **Could VTRACE use this signal fairly?** Not today; see §4 and §5.

## 4. Signal taxonomy

- **fair_non_oracle**
  - The agent's *decision to run* a test and the pytest command itself (recorded in
    `_tool_calls.json`) — generated inside the normal tool loop, no post-hoc evaluator.
  - Static checks: patch applies, minimal diff, compliance, no over-edit, markers.
    (Fair, but M17.1 proved insufficient — identical for r1/r2.)
- **oracle_assisted**
  - SWE-bench evaluator / shadow-eval resolution (M17/M18) — the discriminator we are
    trying to avoid.
  - The literal `FAIL_TO_PASS` list injected into the **revision prompt** (M15): benchmark
    grading metadata a deployed run would not have, used post-first-pass.
- **ambiguous**
  - The test *name* surfacing in `_capsule_v2_context.md` as a "failing test method" tied
    to a pivot. It reaches the agent through VTRACE's own context, but the "failing"
    labeling appears to derive from benchmark failing-test knowledge. Whether a deployed
    VTRACE has equivalent failing-test signal (e.g. from a user-provided traceback) is a
    product-design question that must be settled before an agent-run test on that name can
    be called fair.
- **unavailable**
  - Test *outcomes* (pass/fail) at the per-label level.
  - Revision-phase tool-call telemetry.
  - A stable, per-label, non-clobbered raw stream.

## 5. Recommendation

**Path C — improve artifact capture first, because test outputs are not persisted.**

Rationale: the investigation shows the agents *already* run the relevant tests unprompted
(so Path B's "instruct the revision to run tests" is largely redundant for the first pass
and premature for the revision pass), and static signals alone cannot separate r1/r2 (so
Path A/D3 is unsupported). The single thing standing between us and even *measuring* a fair
in-loop signal is capture: we must (1) persist agent-run command **outputs** (populate
`output_summary` / a bounded captured-output field) instead of dropping them, (2) extract
**revision-phase** tool calls the same way as first-pass, into a per-label file, and (3)
record which patch state each test ran against, plus a per-label (non-shared) copy of the
stream. Only after that can we answer empirically whether an agent-run test *outcome* is
both fair (§4 classification of the test name resolved) and discriminating (r1 fails / r2
passes). This is capture/measurement work — no canonical replacement, no defaults, no
oracle in scoring.

Sequencing after C: re-examine the captured outcomes to classify the test-name signal
(fair vs ambiguous), then evaluate Path D1 (observe agent-run test results) as a candidate
fair adoption signal. Path B remains a fallback only if agents stop running tests on their
own. Shadow eval (oracle) stays diagnostic/upper-bound (M18/M19).

*(Not recommended yet: 30/100 sweeps.)*

## 6. Scope / safety

- Report-only, read from existing artifacts. No live agents, no Docker, no 30/100 sweep, no
  canonical replacement, no defaults changed, no retrieval/ranking/scoring/candidate
  changes. Revision pass remains off by default.
