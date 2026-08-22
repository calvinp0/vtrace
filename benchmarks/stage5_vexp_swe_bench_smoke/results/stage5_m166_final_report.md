# M166 — MCP Response Tax and Model-Visible Compression Audit

```text
M166 overall:
PASS

A: PASS   response path traced; tax verdict issued
B: PASS   12/12 decomposed; M165's headline reconciled
C: PASS   six counterfactuals simulated; primary decision issued
D: RUN    scoped as directed; 8/8 acceptance criteria at 12/12
E: PASS   12-task paired replay; standard verification green

token-tax verdict:
MODEL_VISIBLE_METADATA_TAX_CONFIRMED

compression verdict:
MODEL_VISIBLE_TAX_DOMINATED_BY_TRANSPORT
(secondary: DOMINATED_BY_DUPLICATION)

product changed:
YES   machine-facing diagnostics held for detail=debug

live extension:
AUTHORIZED?  NO
RECOMMENDED? NO
```

Predecessor `506dbb500e6695bd8dfbd160d163c7fab1922786` (M165). Branch `main`, not
pushed, no co-author trailers, 14 worktrees at start (M165 reported 13; verified).

---

## 1. The headline, reconciled

M165 observed a median ~7,407 metadata tokens against ~996 model-visible evidence
tokens and called it a nominal 7.4:1 ratio. §92 asks where those tokens went.

```text
Of the 7,407 metadata tokens (measured on the twelve payloads M164's agents received):

internal only:            0
MCP transmitted:      6,415   — and transmitted TWICE, see §3
model visible:        6,415   — 12/12 payloads parse as complete JSON, all 22 output keys
model request traffic: 8,145   — the product estimates at chars/4; the provider bills at 3.15
billed / cache-relevant: 8,145 — charged once as cache-creation, re-read on every later request

Of the 996 evidence tokens:

internal only:            0
MCP transmitted:        563
model visible:          563
model request traffic:  715
billed / cache-relevant: 715
```

**The correction M165 needs is not to the figure but to the label.** Its
`estimated_model_visible_tokens` is a domain term meaning *the rendered context
section*, produced by `src/mcp/responseEnvelope.ts buildAccounting` as
`estimateTokens(productContext.modelVisibleContext)`. It never claimed to describe
what the model receives. The model receives all of it.

The tax is therefore **real, model-visible, billed, and larger than M165 stated** —
and its composition is different from what one word could carry.

---

## 2. What one call actually costs

Measured from the twelve real M164 trigger-arm transcripts. No new agent spend.

```text
model-visible characters      median 28,178   p90 34,519
billed first-call tokens      median  8,944   bounded [8,721 , 8,975]
cache-read amplification      median 120,950 tokens re-read across the run
share of total run traffic    median 21%      (min 15.4, max 23.5)
VTRACE is the largest tool result in the run    12/12
```

Attribution rests on an identity the transcripts either satisfy or do not:
`cache_read[n+1] == cache_read[n] + cache_creation[n]`, which **held on 358 of 363
turns**. Where it holds, a turn's cache-creation is exactly what that turn added and
every later request re-reads it. The five violations are named in
`stage5_m166_token_authority.json`.

**Known-positive control (§15).** Real tool results across both arms, bucketed:

| bucket | samples | median chars | median billed tokens |
| --- | ---: | ---: | ---: |
| tiny | 142 | 79 | 393 |
| small | 117 | 803 | 700 |
| medium | 80 | 3,146 | 1,410 |
| large | 24 | 25,895 | 8,319 |

Monotone across three orders of magnitude; least-squares fit R² = 0.926 over 363
samples. The measurement path can tell a small result from a large one. Verdict:
`PASS`.

The calibration is itself a finding: tool-result JSON bills at **3.15 characters per
token**, against the `chars_div_4` the product assumes. `responseBudget` understates
its own cost by a factor of **1.27**.

---

## 3. The boundary matrix

| boundary | representation | agent sees | model sees | median size |
| --- | --- | :-: | :-: | ---: |
| internal pipeline | handler result, already bounded | no | no | 34,715 ch |
| MCP `content[0].text` | `JSON.stringify(result.output)` | **no** | **no** | 34,715 ch |
| MCP `structuredContent` | the whole tool envelope | yes | yes | 34,872 ch |
| runtime `tool_result` | one string, complete, untruncated | yes | yes | 28,178 ch |
| model request | cached input tokens | yes | yes | 8,944 tok |
| billing | cache-creation, then cache-read | no | no | +120,950 tok |

Two findings the matrix makes unavoidable:

- **The payload crosses the wire twice.** `src/mcp/startServer.ts` populates both
  `content[0].text` and `structuredContent` with the same result on every call.
- **The client reads the copy VTRACE did not design as agent-facing.** All 12/12
  M164 payloads begin `{"schema":{"name":"vtrace.mcp_server"…` — that is
  `structuredContent`, the envelope-wrapped copy. `content[0].text` is produced,
  serialized, transmitted, and discarded. `formatListedToolDescriptor`
  (src/mcp/startServer.ts:735) advertises no `outputSchema`, so this is the client's
  choice, established from transcripts rather than from the specification (§12).

---

## 4. What the response is made of

12/12 decomposed; every character charged to exactly one category; categories sum to
the payload (asserted by test). Detector controls: **no suspicious category** — none
zero-everywhere, none uniform across all twelve.

| category | median tokens | share |
| --- | ---: | ---: |
| TRANSPORT_STRUCTURE | 3,745 | 41.9% |
| DUPLICATE | 1,952 | 21.8% |
| REPOSITORY_EVIDENCE | 1,266 | 14.2% |
| MACHINE_DIAGNOSTIC | 1,010 | 11.3% |
| AGENT_USEFUL_CONTROL | 690 | 7.7% |
| PROVENANCE | 350 | 3.9% |
| OTHER | 2 | 0.0% |

Measured ratio of non-evidence to evidence: **6.1 : 1**. (M165's 7.4:1 counted only
the rendered section as evidence; M166 credits evidence wherever it appears —
neighborhood excerpts, inspect-first — and charges second and third renderings of the
same facts to DUPLICATE.)

**Transport structure is the largest single category.** JSON keys, braces and commas
are 42% of what the model pays for. Per section it ranges from 12% (`taskSummary`) to
**76%** (`memory`, `workspaceRouting`) — sections whose entire content is a handful of
nulls and booleans wrapped in long key names.

### Top model-visible offenders (§94)

| field / group | median tokens | consumers | agent needs it | safe to compress |
| --- | ---: | --- | :-: | :-: |
| `productContext.modelVisibleContext` | 850 | agent, 12 benchmark analyzers, 9 tests | YES | NO |
| `diagnostics.retrieval` | 612 | 1 benchmark analyzer, 3 tests, no product code | NO | **YES** |
| `productContext.items[]` | 162 | 3 analyzers, 3 tests | PARTIAL | CONDITIONAL |
| `productContext.diagnostics` (limitations) | 139 | agent | YES | NO |
| `capsuleResult.digest` | 122 | 1 analyzer | NO | CONDITIONAL |
| `diagnostics.freshness` | 117 | agent, 4 product files | PARTIAL | CONDITIONAL |
| `productContext.accounting` | 100 | 1 test, no product code | NO | **YES** |
| `productContext.timing` | ~60 | none found | NO | **YES** |

Two duplications worth naming. `productContext.freshness.refreshDiagnostics` was
**byte-identical** to `diagnostics.indexFreshness` in all twelve payloads — the
envelope has always intended to replace it with a reference, and the `get_code_context`
wrapper was overwriting the reference back to the full object after compaction. And
the derived task text appeared eight times per response, the worktree root seven, the
head commit nine.

---

## 5. Compression simulation

Six counterfactual renderings, applied offline to the captured payloads. None was
implemented as a `responseV2` (§33).

| variant | median model tokens | reduction | evidence retained | safety retained |
| --- | ---: | ---: | ---: | :-: |
| FULL_CURRENT | 8,944 | — | 1,266 | yes |
| NO_DUPLICATES | 7,005 | 21.7% | 1,266 | yes |
| NO_MACHINE_DIAGNOSTICS | 4,151 | 53.6% | 1,266 | yes |
| COMPACT_PROVENANCE | 3,623 | 59.5% | 1,266 | yes |
| AGENT_MINIMAL_SAFE | 4,883 | 45.4% | 1,266 | yes |
| EVIDENCE_ONLY | 813 | 90.9% | 1,266 | **no — 13 failure kinds** |

`EVIDENCE_ONLY` is the control that must fail, and does: it loses component-status
distinguishability, readiness truth, degraded state, absence semantics, authority
limitations and omission disclosure. A safety suite that never fails is not evidence
that the other variants are safe.

`AGENT_MINIMAL_SAFE` — the same content rendered as `path: value` lines instead of
JSON — is **worse** than pruned JSON. Repeating dotted paths per line costs more than
the braces it removes. The win is in *what* is included, not in JSON versus text.

### Two defects the safety checks caught in the analysis itself

- **Duplicate accounting and duplicate removal are different operations.**
  `memory.durable.skipReason` and `memory.capsuleSurfaced.skipReason` can both carry
  the string `"no_relevant_observations"`. The accounting is right to call the second
  a restatement; *removing* it collapses `NO_RELEVANT_EVIDENCE` into `NOT_OBSERVED` —
  a bounded absence reading as an unobserved one, the §38 failure exactly. Control
  leaves are now exempt from duplicate removal.
- **Short enumerated labels are not restatements.** A role label such as
  `"documentation"` appears both in the rendering and in an item's `roles` array;
  removing the second deletes one of that item's roles. Removal now requires a value
  long enough to be an identity (24 characters); accounting still starts at 12.

Primary decision: `MODEL_VISIBLE_TAX_DOMINATED_BY_TRANSPORT`, secondary
`DOMINATED_BY_DUPLICATION`.

### The shipping lever, measured before inventing one (§75)

`run_pipeline` already accepts `detail` with `compact | standard | debug`. Over the
same twelve workspaces:

```text
median model-facing tokens   standard 11,068   compact 10,908   debug 11,026
compact saves                160 tokens (1.4%)
compact costs                pivot-neighborhood excerpts, dropped entirely on 2/12
selection unchanged          12/12
```

**The lever exists and does not address the tax.** It trims explanatory prose and
spends the saving on evidence, while diagnostics, duplication and transport scaffolding
survive untouched at every level.

---

## 6. The product change

```text
implementation verdict:
MODEL_RENDERER_COMPACTED
```

Scoped as directed: machine-facing diagnostics held for `detail=debug`; no broader
provenance compression, no generic deduplication, no transport change, no retrieval
change.

- `src/mcp/responseEnvelope.ts` — `reduceDiagnosticsToAgentFacing` and
  `agentFacingIndexFreshness`. At compact and standard, `diagnostics` keeps the
  readiness truth (`status`, `reason`, `action`, `readiness`, `state`, `isStale`,
  `summary`, `whyItMatters`, `recommendedAction`, `reasons`) and drops `retrieval`,
  `budget`, `nudge`, `intent`, `memory`, `rules`, `impact`, `flow`, `deferredCount`,
  `omittedSectionCount` and the indexer's own working out. The removal is disclosed in
  `diagnostics.omittedForDetail`, said where the removal happened, because the
  envelope's `expansion_available` list is bounded and would truncate a note placed
  only there.
- `src/mcp/tools.ts` — `get_code_context`'s post-pipeline freshness overwrite now
  lands in the shape the envelope settled on. Its declared `outputSchema` marks the
  machine-facing diagnostics members detail-conditional and declares the disclosure
  field. Tool **input** schemas are unchanged; `outputSchema` is not advertised over
  MCP, so no external client contract moved.

### Acceptance, 12/12 on every criterion

```text
repository evidence never lost           12/12
rendered evidence identical              12/12
agent-useful control identity            12/12
omission disclosure tracks compaction    12/12
readiness and absence semantics          12/12
default diagnostics removed              12/12
detail=debug diagnostics retained        12/12
selection unchanged                      12/12
index writes                              0/0
```

### Before and after

```text
median standard tokens        11,067  ->  10,734   (-3.0%)
p90 standard tokens           11,715  ->  11,695
evidence tokens (median)       1,900  ->   1,966
diagnostics section chars      4,007  ->   1,147   (-71.4%)
diagnostics members               12  ->        3
refreshDiagnostics        full object  ->  {"ref":"diagnostics.indexFreshness"}
debug tokens (median)         11,023  ->  10,600
neighborhood excerpts (total)      8  ->       28
```

---

## 7. Why the projected 53.6% did not arrive

Investigated rather than met by widening scope, as directed.

**The response is envelope-bound.** `responseTokenCeiling(requested_context_tokens)`
caps it at 9,200 product-tokens and the progressive packer fills the cap. Before the
change, 6/12 responses sat within 500 tokens of the ceiling — three of them within 54,
one within 8.

The simulation deleted spans from a captured payload and reported the difference. That
models a response as a fixed set of fields. It is not: it is a budget that gets spent.
Removing the diagnostics did not make the response smaller — it freed budget the packer
immediately spent on evidence it had been compacting away. Pivot-neighborhood excerpts
went from 8 to 28 across the twelve, restored on 5/12 tasks that previously received
none. Three cases got *larger* in tokens while gaining evidence.

M166-B/C measured the composition correctly; the projection mis-modelled the mechanism.
The outcome is better than a token saving and worse for an economics ablation: the tax
was **converted into evidence**, not removed.

This also closes M165's open smell. `run_pipeline` cost 613 fewer tokens than its own
wrapper because the wrapper restored, after compaction, the freshness detail the
envelope had just held back — twice over, as `refreshDiagnostics` and as
`diagnostics.indexFreshness`. Compaction really was trading evidence for diagnostics;
now it is not.

---

## 8. Could response tax explain M164's neutral utility?

```text
PLAUSIBLE_BUT_UNPROVEN
```

The mechanism is real and now measured: the first call cost a median 8,944 billed
tokens, 21% of the run's total traffic, of which 14% was repository evidence, and it
was re-read on every subsequent request. An agent paying that to receive ~1.3k tokens
of evidence is making a defensible economic trade.

But M164 recorded **no reasoning to that effect** — nothing in thirteen transcripts
says the tool was expensive. §65 requires framing this as an *interaction-cost
hypothesis*, not an agent motive, and M166 did not test it: the shipped change moved
the cost by 3%, so no arm exists that would isolate representation economics.

On the 0/12 voluntary second calls: M166 supplies a mechanism the hypothesis needs
(the first result is large, persists in context and is re-read) without supplying
evidence that the mechanism operated. It remains an alternative to the standing
explanation — that the task population, not the product surface, is the untested
variable.

## 9. Evidence-efficiency, for context not for scoring

```text
repository evidence tokens / total first-call VTRACE tokens   =  1,266 / 8,944  =  14.2%
```

The three taxes stay separate (§67, §68). M162 measured the fixed tool-schema and
suite-policy prefix; this milestone measured the per-call result tax; the trigger text
is a third. A result-compression change cannot touch the first two.

M164's neutral arm reached the same files with a median of a few greps and reads.
Those cost hundreds of tokens each, against ~8,944 for one VTRACE call — but M164 never
ran the counterfactual, so this is scale, not a savings claim.

VEXP's advertised reductions were not used as an acceptance threshold anywhere (§66).

## 10. Next milestone

```text
NO NEXT MILESTONE LICENSED
```

M166 removes response tax as an explanation for M164's null — joining retrieval
quality, composition, adoption and answerability. The remaining untested variable is
the task population. `stage5_m166_live_extension_decision.md` records the two designs
that would make a live experiment informative; neither is started.

## 11. Standard verification

```bash
bun run typecheck              # tsc --noEmit, clean
bun run typecheck:benchmarks   # tsc -p tsconfig.benchmarks.json, clean
bun test                       # 5,184 pass / 49 skip / 0 fail across 335 files
git diff --check               # clean
```
