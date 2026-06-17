# Stage 5 — M23 fair revision test policy & verification provenance audit

## 1. Executive conclusion

M23 adds the **opt-in** fair revision verification policy
(`--revision-verification-policy agent-discovered-tests`) plus the provenance/patch-state
**scaffolding** needed to later decide whether an in-loop test result is fair. It does **not**
adopt anything: no revised patch is wired into canonical evaluation, the revision pass stays
off by default, and the default prompt/artifacts are byte-for-byte unchanged.

Replaying the new classifier on the existing M21.1/M22 capture
(`eval-m21-capture-current-sphinx-7462-r1`) confirms the design intent: **every captured test
is `fairVerificationUsable=false`**, for the right reasons (injected provenance, non-passing
parsed outcome, unverifiable patch-state, and an environment import error). This is the
expected outcome — today's captures cannot fairly verify a revised patch, and the policy now
says so explicitly rather than leaning on hidden FAIL_TO_PASS labels.

## 2. What changed (scaffolding only; no oracle, no adoption)

**Flag.** `--revision-verification-policy none|agent-discovered-tests` (runner). Default
`none`. When `none` (or absent): M15/M16/M21/M22 prompt + artifacts unchanged. When
`agent-discovered-tests`:
- the revision prompt appends a **Fair verification (agent-discovered focused test)** block
  asking the agent to discover/run the smallest relevant repo test it can *justify from its own
  exploration*, to say so if none is discoverable, to report environment failures as such, and
  never to claim verification without passing output;
- literal injected **FAIL_TO_PASS test names are suppressed** from the prompt (Option 1 — the
  stronger fairness design: hidden evaluator labels are not put in front of the agent);
- a per-test-command fair-verification artifact (`_revision_verification_policy.json`) is
  emitted next to the existing `_pivot_revision_test_commands.json`.

**Pure analyzers** (added to `src/capsule/toolOutputCapture.ts`, PURE — no fs/Docker/oracle):
- `fairProvenance(p)` → wraps the M22 provenance class with `allowedForFairVerification`
  (true **only** for `agent_discovered`) + a `disallowReason`.
- `classifyVerificationPatchState(...)` → adds the proof-gated `final_patch_verified` member.
  It is emitted **only** when an explicit `finalPatchProof.applied` carries non-empty evidence;
  otherwise it falls back to the conservative M22 state and `canVerifyFinalPatch=false`.
- `hasEnvironmentFailureMarkers(text)` → ImportError / ModuleNotFoundError / collection errors
  / INTERNALERROR / Traceback.
- `assessFairVerification(...)` → composes policy + provenance + parsed outcome + patch-state +
  env-markers into `{verificationPolicy, verificationProvenance, verificationPatchState,
  fairVerificationUsable, fairVerificationBlockers}`. `fairVerificationUsable=true` **iff** ALL
  hold: policy enabled, provenance `agent_discovered`, parsed outcome `passed`, patch-state
  proves final/revised verification, no environment markers. Each failing condition appends a
  human-readable blocker.
- `buildFairVerificationReport({calls, policy, injectedTestNames})` → one assessment per
  captured test command, deriving `priorCommandText` / `editToolBeforeTest` from the calls
  **before** it in the **same phase**.

**Fairness guarantee.** Injected FAIL_TO_PASS names are passed to the classifier **only** as
DISALLOW evidence: an exact match ⇒ `injected_metadata` ⇒ `allowedForFairVerification=false`.
They are never an allowed basis for a verification claim. The M16 rule-out **conflict
guardrail** in `pivotInspectionCompliance.buildCorrectivePrompt` still consults FAIL_TO_PASS to
*trigger* a revision — that is a trigger, not a verification claim, and is left intact.

## 3. Classifier replay on `eval-m21-capture-current-sphinx-7462-r1`

Injected FAIL_TO_PASS for the instance:
`tests/test_domain_py.py::test_parse_annotation`, `tests/test_pycode_ast.py::test_unparse[()-()]`.
Run with `policy=agent_discovered` (to exercise every check; today's run was captured without
the policy, so this is the would-be classification).

| phase | selected test | parsed | provenance | allowed? | patchState | canVerifyFinal | **usable** |
| ----- | ------------- | ------ | ---------- | -------- | ---------- | -------------- | ---------- |
| first_pass | `tests/test_domain_py.py::test_parse_annotation` | error | **injected_metadata** | **false** | after_observed_edit_state | **false** | **false** |
| pivot_revision | `tests/test_pycode_ast.py::test_unparse` | error | **injected_metadata** | **false** | revision_phase_state | **false** | **false** |

Blockers (identical structure both rows):
1. `provenance "injected_metadata" is not allowed for fair verification`
2. `parsed outcome is "error" (not "passed")`
3. `patch state "<state>" cannot verify the final patch`
4. `environment/import failure markers present: Traceback (most recent call last)`

This matches the M23 expected result exactly:
**provenance = injected_metadata · allowedForFairVerification = false · canVerifyFinalPatch =
false · fairVerificationUsable = false.** The selected tests' names overlap VTRACE-injected
FAIL_TO_PASS (so the *choice* of test is not provably the agent's), both runs errored on the
jinja2 `environmentfilter` import before executing, and no artifact ties either run to the
final/revised patch. Four independent reasons, any one of which alone would already block fair
verification.

## 4. What future opt-in runs will capture

With `--revision-verification-policy agent-discovered-tests` on a future live run (NOT run
here), each captured revision-phase test command will get a `_revision_verification_policy.json`
row with `{verificationPolicy, verificationProvenance, verificationPatchState,
fairVerificationUsable, fairVerificationBlockers}`. To reach `fairVerificationUsable=true` a row
must clear ALL four blockers simultaneously:
- **provenance → agent_discovered**: the agent reaches the test through its own grep/read
  exploration (the suppressed FAIL_TO_PASS labels can no longer seed it), recorded via
  `priorCommandText` discovery evidence;
- **parsed outcome → passed**: a clean pytest summary with no failure/error/traceback markers;
- **patch-state → final_patch_verified**: requires an explicit post-final-edit verification
  artifact (`finalPatchProof`), which the in-loop stream still does **not** provide — so this
  remains the binding gap and `canVerifyFinalPatch` stays false until a future milestone adds a
  re-apply-then-test step;
- **no environment markers**: a clean enough environment that pytest actually executes.

So even a perfectly fair, agent-chosen, passing test will still report `usable=false` until the
patch-state binding is built — which is the correct, honest state for M23 (scaffolding, not
adoption).

## 5. Tests

`src/capsule/toolOutputCapture.test.ts` (M23 block) and `src/capsuleV2/pivotRevisionPass.test.ts`
(M23 prompt block) cover: default-mode prompt unchanged; opt-in renders the discovery
instruction and hides FAIL_TO_PASS names; FAIL_TO_PASS match ⇒ injected_metadata/allowed=false;
agent_discovered via prior exploration; ambiguous ⇒ allowed=false; passed-but-unverifiable ⇒
not usable; failing/error ⇒ not usable; env/import markers block; `final_patch_verified` never
emitted without proof; `deriveTestCommands` shape unchanged (backward compatible);
`buildFairVerificationReport` per-phase prior-exploration wiring.

## 6. Scope / safety

- PURE analyzers + an opt-in prompt block + a separate additive `_revision_verification_policy.json`
  artifact. Existing `_test_commands.json` / `_pivot_revision_test_commands.json` are NOT mutated.
- No live agents, no Docker, no 30/100, no canonical replacement, revision pass still off by
  default, policy off by default.
- No retrieval/ranking/scoring/candidate-generation/Capsule-v2-pivot changes; deterministic
  retrieval eval re-run byte-identical. Raw run artifacts not staged.
