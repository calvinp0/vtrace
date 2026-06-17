# Stage 5 — M29.2: Discriminative fair-verifier candidate audit (offline, no Docker)

Goal: from existing artifacts only, find a label fit for the next diagnostic original-vs-revised
verifier comparison — i.e. one where (a) a revised patch exists, (b) revised ≠ original (a real
delta to measure), and (c) the M26 planner finds an eligible fair agent-selected command. No Docker,
no live agents, no `--allow-docker-verify`.

## 1. Executive verdict

**No ready candidate exists.** The intersection of "revised ≠ original" and "planner-eligible
command" is **empty** across all 10 labels that carry a `_pivot_revision_revised.patch`:

- **5 labels have a genuine patch delta** (revised ≠ original) — but every one is planner-**ineligible**
  (provenance `ambiguous`/`injected_metadata`, a shell-piped captured command rejected by the safety
  gate, or no test-command artifacts at all).
- **1 label is planner-eligible** (`eval-m28-strong-discovery-current-sphinx-7462-r1`,
  provenance `agent_discovered_hidden_match`, clean command) — but it has **no patch delta**
  (revised == original == canonical modelPatch, all `ec96de0e…`). This is the degenerate M29.1 case.

So the eligible scaffold and the patch deltas never co-occur on one label. → **Recommendation C.**

Notably, all delta and all eligible labels are the **same instance** (`sphinx-doc__sphinx-7462`),
and the revision pass is stochastic across runs of it (some runs produced a delta, the eligible
strong-discovery run produced a no-op). That is what makes C actionable: rerun the working eligible
scaffold and gate on a non-identical revision.

## 2. Candidate scan method

- Enumerated every `results/runs/<label>/raw/vtrace/` directory and selected those containing
  `_pivot_revision_revised.patch` (the only revised-patch artifact the planner/verifier read) — **10
  labels**. (Labels without that exact file cannot be verifier candidates regardless of other
  artifacts.)
- For each: hashed the revised patch text (sha256); hashed the "original" via
  `_pivot_revision_original.patch` (all 10 had it), cross-checked against the canonical row
  `modelPatch`; read `revisionCandidate` / `replacementRecommended` / `canonicalReplaced` from
  `_pivot_revision.json`; recorded presence of `_pivot_revision_test_commands.json` (ptc),
  `_test_commands.json` (tc), `_agent_test_command_plan.json` (plan).
- Ran the planner **offline** (`--mode plan-agent-test-command`, no `--allow-docker-verify`) for
  `--patch-source pivot_revision_revised` against `--command-source pivot_revision_test_commands`
  and, where useful, `first_pass_test_commands`, capturing `eligibleForFutureExecution`, `blockers`,
  `fairProvenance`, `commandSafety`, `selectedCommand/Tests`, `expectedImageKey`.

## 3. Per-label table

Hashes are sha256 prefixes (8 hex). Instance = `sphinx-doc__sphinx-7462` unless noted. `elig` =
`eligibleForFutureExecution` for the best command source. `rc/rr/cr` = revisionCandidate /
replacementRecommended / canonicalReplaced (`–` = field absent).

| label | inst | origHash | revHash | differ | revNE | rc/rr/cr | ptc/tc/plan | elig | provenance | cmdSafe | classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval-m28-strong-discovery-…-r1 | 7462 | ec96de0e | ec96de0e | **No** | yes | F/F/F | 1/1/1 | **True** | agent_discovered_hidden_match | True | eligible_command_but_no_patch_delta |
| eval-m28-discovery-…-r1 | 7462 | 7abdbc87 | 5227bf13 | **Yes** | yes | T/F/F | 1/1/1 | False | ambiguous | False | patch_delta_but_no_eligible_command |
| eval-m21-capture-…-r1 | 7462 | ec96de0e | b4032c35 | **Yes** | yes | T/F/F | 1/1/0 | False | injected_metadata | False | patch_delta_but_no_eligible_command |
| eval-m16-ruleout-guard-…-sphinx-r1 | 7462 | ec96de0e | b4032c35 | **Yes** | yes | –/–/– | 0/0/0 | False | (no command) | False | patch_delta_but_no_eligible_command |
| eval-m16-ruleout-guard-…-sphinx-r2 | 7462 | 6aca9946 | f2362cbd | **Yes** | yes | –/–/– | 0/0/0 | False | (no command) | False | patch_delta_but_no_eligible_command |
| eval-m15-pivot-revision-…-sphinx-r2 | 7462 | 37bbde11 | f4ea407f | **Yes** | yes | –/–/– | 0/0/0 | False | (no command) | False | patch_delta_but_no_eligible_command |
| eval-m23-fair-test-policy-…-r1 | 7462 | 37bbde11 | 37bbde11 | No | yes | F/F/F | 1/1/1 | False | ambiguous | False | no_revision_delta |
| eval-m28-clean-discovery-…-r1 | 7462 | 2ac93bfc | 2ac93bfc | No | yes | F/F/F | 1/1/1 | False | ambiguous | False | no_revision_delta |
| eval-m16-ruleout-guard-…-seaborn-r2 | seaborn-3187 | a526566d | a526566d | No | yes | –/–/– | 0/0/0 | n/a | (not planned) | – | no_revision_delta |
| eval-m15-pivot-revision-…-seaborn-r3 | seaborn-3187 | ea8a220f | ea8a220f | No | yes | –/–/– | 0/0/0 | n/a | (not planned) | – | no_revision_delta |

`revisionRan?` = yes for all 10 (a revised patch was produced). `revised non-empty?` = yes for all
10. `expectedImageKey` for every sphinx label =
`swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` (derivable). Selected commands for
the planned labels and their blockers:

- m28-discovery — ptc: `pytest tests/test_pycode_ast.py -v 2>&1 | head -60`; fp:
  `pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 | head -60`. Blockers:
  `provenance "ambiguous" not allowed`; `command not fair-executable (shell pipeline "|")`.
- m21-capture — ptc: `pytest tests/test_pycode_ast.py::test_unparse -k "()" -x -v 2>&1 | head -40`;
  fp: `pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 | head -50`. Blockers:
  `provenance "injected_metadata" not allowed`; `shell pipeline "|"`.
- m15-sphinx-r2 / m16-sphinx-r1 / m16-sphinx-r2 — no test-command artifacts ⇒ planner finds no
  command (`no test command found in command source`); both command sources ineligible.
- m23 / m28-clean — eligible-shaped artifacts but `provenance "ambiguous"` blocker AND no patch
  delta.

## 4. Ready candidates, if any

**None.** No label satisfies both "revised ≠ original" and "planner-eligible for ≥1 command source".
`ready_for_diagnostic_comparison` = ∅.

## 5. Near misses

- **`eval-m28-strong-discovery-current-sphinx-7462-r1`** — *eligible_command_but_no_patch_delta*.
  The only planner-eligible label (clean command, `agent_discovered_hidden_match`, `cmdSafe=true`,
  `final_patch_verified` proven live in M29). Misses only on the patch delta: its revision was a
  no-op. One stochastic ingredient away from ready.
- **`eval-m28-discovery-current-sphinx-7462-r1`** — *patch_delta_but_no_eligible_command*. Has a real
  delta (`7abdbc87` → `5227bf13`), full artifacts (ptc/tc/plan), `revisionCandidate=true`. Misses on
  eligibility: provenance recomputes to `ambiguous` and the captured command is shell-piped. Same
  instance as the eligible label — closest structural twin.
- **`eval-m21-capture-current-sphinx-7462-r1`** — *patch_delta_but_no_eligible_command*. Delta
  (`ec96de0e` → `b4032c35`), ptc+tc present, `revisionCandidate=true`. Misses on provenance
  (`injected_metadata`) and a shell-piped command.

(`replacementRecommended` and `canonicalReplaced` are `false` everywhere they exist — consistent with
the diagnostic-only, no-adoption posture.)

## 6. Next recommendation

**C. Run one fresh fair-policy live rerun and require a non-identical revision patch before the
verifier.**

Rationale: the bottleneck is the *eligible command*, not the patch delta. Only the M28
strong-discovery scaffold has ever produced a planner-eligible fair command
(`agent_discovered_hidden_match` + clean, non-piped command + `cmdSafe=true`), and we have a working
recipe for it. The patch deltas, by contrast, sit on older labels whose commands are structurally
ineligible (pre-scaffold provenance, shell-piped captures, or missing command artifacts) — reusing
them would mean rebuilding the eligible-command path anyway. Crucially, the revision pass is
**stochastic on the very same instance** (`sphinx-7462`): one run produced a no-op (strong-discovery)
while sibling runs (m28-discovery, m21-capture) produced real deltas. So the most reliable path is to
rerun the proven eligible scaffold and **gate on `revisedSha ≠ originalSha`** before spending a
Docker verification — yielding a label that is eligible *and* has a delta in one shot. (This is an
M30 live step; not executed here.)

Why not B: B would anchor on an existing revision-delta label, but all such labels lack an eligible
command for independent (older-scaffold) reasons, so we would still have to regenerate the eligible
command — i.e. a fresh fair-policy run — making C the more direct, lower-variance route.

---

Scope: offline planner audit only. **No Docker, no live agents, no `--allow-docker-verify`, no
agent-selected command executed.** No source code changed (report-only); planner mode was used purely
to read eligibility. Raw artifacts were not staged.
