# M183 — frozen protocol

Frozen before the first paid call. Product HEAD `9517ccce` (M182 closure). The
hash over this document, the other frozen documents and every source file that
can reach the agent is in `stage5_m183_protocol_hash.json`.

## Arms

| | A — BASELINE | B — VTRACE_ORIENTATION |
|---|---|---|
| protocol | `baseline` | `baseline` |
| model | claude-opus-4-5-20251101 | claude-opus-4-5-20251101 |
| max turns | 250 | 250 |
| cost limit | $3 | $3 |
| ordinary tools | full whitelist | full whitelist |
| MCP servers | none | **none** |
| mandate / prohibition / search guard / anti-loop | none | **none** |
| environment | — | `VTRACE_TASK_TRIGGER_FILE` |

The two arms issue a byte-identical command. The whole treatment is one
environment variable. This is proved rather than asserted:
`stage5_m183_arm_equivalence.json` runs both wiring builders and diffs their
output, parses the driver and checks no flag is chosen by arm, and compares every
field of the arm contract.

## What the treatment is

`structuredContent.result.output` of a real default `run_pipeline` call —
`initialize`, then `tools/call`, over Content-Length stdio — against a clone of
the instance's base commit indexed at the current product HEAD. No `detail`, no
`max_tokens`, `saveObservation: false`. The shipped default IS the treatment.

Injected as the last prompt section under the frozen M163 heading, preceded by
one provenance sentence containing no imperative addressed to the agent. The JSON
is serialized **compactly**, so the injected bytes are byte-identical to the
bytes `content[0].text` carries on a real reply — measured per instance, not
assumed.

## What the treatment is not

Not M173's arm B. That carried `M168_MANDATE_TEXT` ("call `run_pipeline` FIRST",
"ALWAYS FIRST") and an MCP tool inventory arm A lacked. §7 forbids the first; §6
holds the second fixed.

Not an uncoerced MCP arm. M164 measured 0 voluntary reuse, so such an arm would
deliver orientation on approximately no task — measuring adoption, not utility.
Recorded as a deliberate design choice, not omitted.

## Isolation

Neither live arm creates a Stage 5 workspace or carries a `.vtrace` directory.
The external harness prepares each arm's repository itself with `git checkout
<base> --force` and `git clean -fdx`, identically. The orientation is generated in
a separate workspace whose bytes alone travel to the treatment arm.

## Sample

30 pairs, frozen and hashed before any live run: 12 M173 replication + 18 drawn
from Broad100-A minus those 12, stratified by repository then by difficulty tier,
seed `M183-extension/v1`. Strata interleaved in execution order. Arm order
alternates by position, 15/15.

## Spend

Expected $38.31, hard cap $80.00, maximum possible $80.00. The guard starts a
pair only when headroom ≥ $6 — the harness's enforced $3/instance ceiling doubled
— and extrapolates nothing. Evaluated at task entry so the cap cannot censor a
pair.

## Gold

Never in the prompt, the query, the orientation or the ranking. Read only by
`run_stage5_m183_diagnostics.ts`, which runs after grading and after the pair
records have been sealed.

## Stopping

Allowed: the authorised ceiling, provider/system failure, apparatus defect,
resource failure. Forbidden: any stop motivated by how the results look.
