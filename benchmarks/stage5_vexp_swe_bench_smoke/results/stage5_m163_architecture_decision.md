# M163 architecture decision

## Formal verdicts

```text
architecture verdict:  HARNESS_INVALID   (scope: the utility transition only)
adoption verdict:      ADOPTION_CAUSALLY_INCREASED
utility verdict:       UTILITY_NOT_MEASURABLE
extension decision:    DO NOT EXTEND
overall M163:          MIXED
```

The three are deliberately separate. M163 exists to keep them apart, and this
sweep is the case that proves why: one transition was answered decisively and
the next one never ran.

## The causal chain, and where M163 got to

```text
TOOL AVAILABILITY          proven per run, 36/36
      ↓
TOOL CONSIDERATION         ANSWERED — policy does not cause it, a task-level
                           trigger does
      ↓
VTRACE EVIDENCE EXPOSURE   FAILED — 14 calls, 0 delivered any evidence
      ↓
AGENT UTILITY              NOT REACHED
```

M162 established the first transition and failed at the second. M163 answered
the second and failed at the third — for a reason that had nothing to do with
agent behaviour and everything to do with a seam between two components that
were each individually correct.

## Adoption: answered, and the answer is unambiguous

| Arm | adopted / available | rate | VTRACE calls |
| --- | ---: | ---: | ---: |
| TOOLS_ONLY | 0 / 12 | 0% | 0 |
| TOOLS_NEUTRAL_POLICY | 0 / 12 | 0% | 0 |
| TOOLS_TASK_TRIGGER | 12 / 12 | 100% | 14 |

Trigger compliance 12/12. Median first-call index 0 — in every trigger run the
VTRACE call was the first repository action, with zero ordinary repository
actions before it.

**Passive discoverability and descriptive policy are insufficient. Direct
task-level routing causes exposure reliably.**

The A→B comparison is the sharper half. Arm B served the neutral policy, which
states in so many words that `get_code_context` is the initial
repository-orientation tool for coding and debugging tasks. Twelve agents were
served that sentence and called the tool zero times. Arm C moved one instruction
from the server's initialize channel into the task prompt and got 12/12. The two
say materially the same thing; what differs is where the instruction sits
relative to the moment the agent decides what to do first.

That is a stronger statement than M162's. M162 showed availability is not
consideration. M163 shows the server's own instruction channel is close to inert
for routing decisions, while the task prompt is not — and that the gap is
mechanically closable.

## Utility: not measurable, and not for want of asking

Every one of the 14 VTRACE calls was refused by the product. Ten returned
`repo_not_ready`; two were rejected as malformed and then also returned
`repo_not_ready` on retry.

The workspaces the Stage 5 runner builds contain `index.sqlite` and
`index.meta.json` but no `config.json` or `state.json`, because the runner
prepares them with `vtrace index` and never `vtrace init`. The MCP server gates
every engine-backed tool on `config.initialized && state.initialized`, so it
refused regardless of how complete the index was. The refusals carried
diagnostics reporting `ready: true`, `status: fresh`, `coverageComplete: true`
and an indexed worktree identical to the requested one, down to the head commit.

See `stage5_m163_delivery_defect.json` for the isolated offline proof.

**No VTRACE evidence reached any agent in any arm.** Reporting the B↔C outcome
identity as "forced exposure did not help" would be precisely the M162 error the
milestone was built to avoid — concluding no effect from never delivered. The
utility verdict is therefore NOT_MEASURABLE, not NEUTRAL.

## What the B↔C comparison actually shows

| | NEUTRAL | TRIGGER |
| --- | ---: | ---: |
| resolved | 8 / 12 | 8 / 12 |
| shared success | 8 | |
| shared failure | 4 | |
| unique wins | 0 | 0 |

Identical on all twelve tasks. Under zero evidence exposure this is the expected
result and carries no information about repository intelligence. It does carry
one useful negative: forcing an unproductive tool call at turn zero did not
measurably harm anything. Median paired deltas were 0 turns and −$0.011, with
improved/worsened splitting 6/6.

The one non-null behavioural signal — median one fewer ordinary search in the
trigger arm, 7 improved against 2 worsened — cannot be attributed to VTRACE
evidence, because there was none. It is at most an effect of being told to
orient before investigating.

## Token economics

| Arm | schema | policy | dynamic evidence (median) | total exposure |
| --- | ---: | ---: | ---: | ---: |
| TOOLS_ONLY | 1937 | 0 | 0 | 1937 |
| TOOLS_NEUTRAL_POLICY | 1937 | 128 | 0 | 2065 |
| TOOLS_TASK_TRIGGER | 1937 | 128 | 1370 | 3435 |

The trigger arm's ~1370 dynamic tokens are the refusal message and its
diagnostics. It is the worst case of M162's schema-tax finding: the interface was
paid for, a call was made, and what came back was an apology with a readiness
report attached.

## Implications, kept separate

**Interaction / routing.** The adoption problem is real and mechanically
solvable. That result stands on its own and does not depend on the defect.

**Retrieval.** Nothing is licensed. §98's precondition — triggered adoption plus
an appropriate question plus systematically wrong evidence — is not met, because
no question reached retrieval. Do not tune ranking, candidate generation or
support selection on the basis of this milestone.

**Product readiness seam.** The real finding is that a correctly routed tool is
not a tool that can answer. The MCP readiness gate and the benchmark's workspace
preparation disagree about what "initialized" means, and every layer of testing
between them passed.

## Extension decision

```text
DO NOT EXTEND
```

Running more tasks would re-observe the same refusal. The informative next step
is to repair the readiness seam and re-run the NEUTRAL vs TRIGGER comparison with
evidence actually delivered — a separate, separately authorized milestone. No
product change is made here.
