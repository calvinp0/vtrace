# M170 — Transparent Agent Workflow Integration and Automatic Reduction Qualification

**Status: plan frozen before any mediation result was inspected.** The
acceptance thresholds (§C-gate), the safety classes (§semantics), the
preservation definition and the no-fire overhead definition are written down
here first so that they cannot be chosen afterwards to fit whatever the replay
happens to produce.

## The question M170 exists to answer

M169 closed the proactive architecture:

```text
pipeline attributable cost   $0.0985 / task
investigation displaced      $0.0026 / task
aggregate ratio              ~38x
economic classes             10 LOSS  1 ROUGH_BREAK_EVEN  0 WIN  1 NOT_MEASURABLE
next lever                   NO_FURTHER_PROACTIVE_PIPELINE_WORK
```

M170 asks a different question, and it is the product question:

> Can VTRACE be placed **underneath** an agent's ordinary repository
> investigation so that it automatically reduces search/read cost, with no
> separate model-visible VTRACE call and no up-front context tax?

M170 begins as an audit. Expected `src/` changes before the C gate: **0**.
No live agents, no paid APIs, no VEXP, no Docker. Expected live spend: **$0.00**.

## Workstreams

```text
M170-A   normal-agent investigation surface audit      (M168 baseline arm)
M170-B   existing producer / reuse / seam audit
M170-C   transparent mediation designs + counterfactual replay
M170-D   ONE minimal automatic mediation, only if C licenses it
M170-E   offline preservation + economic qualification, Broad100-A and -B
         STOP for live authorization
M170-F   paired automatic-utility qualification, only if separately authorized
```

## Frozen definitions

### The mediated unit is an OPERATION, not a task

M169's unit was the run. M170's unit is one ordinary tool call the agent
already chose to issue. A design that has to decide anything at task start is
out of scope by §30 — the trigger must be an operation already requested plus
local authoritative state.

### Semantic safety classes (§10)

Every candidate mediation is classified before it is measured:

```text
SAFE_NARROWING     the native tool's own contract already permits the bound,
                   and the bound is stated in the native tool's own output
SAFE_RANKING       the same result set, ordered differently; nothing removed
SAFE_AUGMENTATION  strictly added material; costs tokens by construction
SEMANTICALLY_UNSAFE_REPLACEMENT
                   the agent's stated intent is not answered by what returns
```

Only SAFE_NARROWING and SAFE_RANKING may be implemented. SAFE_AUGMENTATION is
disqualified on arrival by §13 unless it displaces more than it adds, which it
must prove, not assert.

### Truthfulness (§22, §23, §24)

Unchanged and binding:

```text
bounded omission  != absence
ranked subset     != complete result
unobserved        != not present
support           != ownership
```

A mediation that narrows an enumerative operation must leave the narrowing
legible in the operation's own result, and the omitted material must remain
reachable by an ordinary follow-up the agent can issue without knowing VTRACE
exists.

### Token authority

Inherited from M166/M169 unchanged. Provider `result` event first; per-request
`message.usage` deduplicated on `message.id` second; character-derived figures
last and always labelled `OFFLINE_ESTIMATED_TOKENS`. Billing identity for
`claude-opus-4-5-20251101`: input $5 / 1h-write $10 / read $0.50 / output $25
per Mtok. Per-operation cost is `attributePayload` from `m169Economics.ts`:
one cache write plus one re-read per subsequent request. Local CPU time and
model tokens are reported in separate columns and never summed (§19).

### C gate — frozen acceptance thresholds (§27, §28)

A mediation family may be implemented only if, on the M170-A corpus:

```text
G1  operation-local reduction     >= 20%  of model-visible tokens of the
                                          operations the design actually fires on
G2  evidence preservation         >= 95%  of ultimately-used source evidence
                                          still present in the mediated result
G3  unsafe mediation              == 0    (RECOVERABLE_OVERPRUNE is allowed
                                          and counted separately)
G4  whole-run projection          reported, not thresholded — but a design whose
                                  whole-run projection rounds to zero is reported
                                  as such and does not get implemented on the
                                  strength of G1 alone (§28)
G5  fixed non-fire overhead       == 0 model-visible tokens
```

"Ultimately-used source evidence" is frozen now: for each task, the set of
file paths the baseline agent EDITED, plus the file paths it read after the
mediated operation and before its first edit. It is derived from the baseline
transcript, never from the gold patch — the gold patch is the grader's, not the
agent's, and using it would measure a different thing.

### Level 1 vs Level 2 (§26)

M170-C establishes Level 1 only: could the mediated result have contained the
ultimately-used information for fewer tokens. Whether an agent behaves better
with it is Level 2 and is not decidable offline. No M170 artifact may state a
Level 2 conclusion.

### No-fire overhead (§39)

Measured as: model-visible tokens added on an operation where the mediation
declines, which must be zero by construction, plus local decision latency,
reported in milliseconds. A design that cannot decide to decline without
emitting tokens fails G5 regardless of its fire-case economics.

### Fresh-index invariant (§36, §37)

Every M170 measurement records source revision, index revision, derivation
compatibility, and workspace root. `results/workspaces/cross_repo/` is not
current-build authority and is not read. Broad100-A is read from the M169
re-materialised root `results/workspaces/m169_broad_a`; Broad100-B from its own
fresh root; both are re-verified for derivation compatibility at use time, and
a case whose index does not answer is excluded and counted, never imputed.

### What M170 may not conclude (§50)

Not available as conclusions: that optional tools are the product; that the
pipeline needs another budget; that agents need better prompting; that native
search should be blocked; that the user should decide when to invoke analysis.

### Live authorization

M170-E stops. M170-F does not run in this milestone under any result.
