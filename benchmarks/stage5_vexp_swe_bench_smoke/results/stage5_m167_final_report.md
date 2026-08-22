# M167 — MCP Result Transport and Single-Representation Audit

```text
M167 overall:        PASS

A: PASS
B: PASS
C: PASS
D: NOT RUN — CORRECT STOP
E: PASS

transport verdict:   TRANSPORT_TAX_REQUIRED_FOR_COMPATIBILITY
compression verdict: COMPRESSION_NOT_MATERIAL

product changed:     NO
retrieval changed:   NO
live spend:          $0.00 — no agents, no Docker, no paid APIs
live extension:      NOT AUTHORIZED
next milestone:      NONE LICENSED
```

## The headline

**VTRACE does serialize the same semantic result twice on every call, and it costs the
model nothing.** The second copy is discarded before the model ever sees it. The
duplication is real, it is 51.5% of the JSON-RPC line, and removing it would reduce
model-visible tokens by exactly zero — while breaking the only channel the protocol
revision VTRACE advertises actually defines.

M166 asked what one repository-context call costs. M167 asked whether we are paying for
it twice. The answer is that we are paying twice at the wire and once at the model, and
that only one of those two bills is the one M165 and M166 were trying to reduce.

## §76 — the actual path, in plain language

VTRACE builds **one** authoritative value: the output the `run_pipeline` handler
assembles, packed to the context budget and then run down the compaction ladder. That
value is wrapped in a tool envelope — `schema`, `requestId`, `toolId`, `result` — and
then serialized **twice**, in one return statement in `src/mcp/startServer.ts`:

- `content[0].text` = `JSON.stringify(output)` — the output alone
- `structuredContent` = the whole envelope — the output plus a 157-character wrapper

Both cross the wire in a single JSON-RPC line. The client then picks one. The observed
agent client picks `structuredContent` and **discards `content[0].text` entirely**, so
cache creation happens over the structured channel and the text channel is billed to
nobody. This is re-derived here rather than inherited: all 12/12 M164 model-visible
payloads begin with `{"schema":{"name":"vtrace.mcp_server"`, a prefix the text channel
cannot produce because it never serializes the wrapper.

There is one authority and two derivations of it — the structure §13 asked for is
already in place, and the two cannot drift because they are two expressions over the
same binding in the same statement.

## §77 — before/after representation table

No `after` column: D was not run and no product code changed.

| layer | M166 | M167 |
| --- | ---: | ---: |
| semantic packed evidence (chars) | — | 33,005 |
| structuredContent (chars) | 34,872 | 33,162 |
| content text (chars) | 34,715 | 33,005 |
| content text as it sits on the wire, escaped | — | 35,284 |
| transmitted JSON-RPC line (chars) | 71,990 | 68,459 |
| model-visible tokens | 8,944 (M164 population) | 10,526 (local replay) |
| debug information | behind `detail=debug` | unchanged |
| evidence items | unchanged | unchanged |

The two model-visible token figures are **not** a regression and must not be subtracted:
they are different populations. M166's 8,944 is the billed median over real M164 agent
runs; M167's 10,526 is a local replay against the preserved workspaces at this HEAD.
`stage5_m167_composition_reconciliation.json` holds the attribution.

## §78 — economics

```text
median first-call model-visible tokens    10,526
p90                                       11,694
min / max                                  8,239 / 11,713

absolute reduction from any safe change         0
percentage reduction from any safe change    0.0%

repository evidence tokens                 1,966   (18.7%)
control                                      681   (6.5%)
provenance                                   344   (3.3%)
transport overhead                         2,689   (25.5%)
restatement                                3,647   (34.6%)
machine diagnostics                          887   (8.4%)

second channel, on the wire               11,199 tokens equivalent
second channel, to the model                   0 tokens
```

Session schema tax, reported separately and never added to per-call cost (§47):
`tools/list` costs a median 8,141 characters, ~2,584 tokens, once per session. No tool
declares an `outputSchema`.

Cache amplification: the M166 identity `cache_read[n+1] == cache_read[n] +
cache_creation[n]` held on 358/363 turns, and a first-call result is re-read as cache
for a median 120,950 tokens across a run — roughly 13.5× its creation cost. So the
projected cache-amplified traffic reduction from the best available transport change is
`0 × 13.5 = 0`. **Token traffic is not money**: cache reads bill at a different rate
from cache creation, and no dollar figure is derived here.

Estimator authority: `DERIVED_FROM_PROVIDER_REPORTED` — 3.15 chars/token, least squares
over 363 turns, R² 0.926. Not `chars/4`.

## §79 — compatibility

```text
Stage5 / benchmark harnesses:  SUPPORTED_BY_CODE — read content[0].text for the
                               semantic profile and structuredContent for width
Claude Code:                   PROVEN — delivers structuredContent, discards the text
                               channel, 12/12 M164 payloads
Codex:                         UNKNOWN — advertised in the README, its MCP config
                               written by src/runtime/codexConfig.ts, and not one line
                               of result-handling code or a single transcript here
generic MCP at 2024-11-05:     SUPPORTED_BY_CODE — content[] is the only result channel
                               that revision defines; structuredContent is an
                               undeclared extension it has no reason to read
MCP transport tests:           PROVEN — assert both channels, and assert the text block
                               equals JSON.stringify(output)
VTRACE CLI:                    N/A — calls the handler in-process, never crosses MCP
```

The inversion worth stating plainly: **the channel the proven client reads is the
unsupported one, and the channel it discards is the only one VTRACE may assume anybody
reads.**

## §80 — semantic preservation

D was not run, so these are controls on the audit rather than on a change:

```text
primary evidence identity:      12/12   (selection identical to M166's independent
support identity:               12/12    capture of the same twelve tasks at this HEAD:
impact identity:                12/12    same lead pivot, same item paths, 0
structural identity:            12/12    disagreements)
readiness/absence identity:     12/12
debug diagnostics preserved:    12/12   (10 carry the full set; 2 disclose an envelope
                                         omission; 0 lost anything silently)
index writes:                       0   (digested before and after all 12 workspaces)
product code diff vs M166:          0   (src/ byte-identical to 749434ee)
```

## §81 — what remains expensive

Not the second channel. Inside the one channel the model actually receives:

| category | median tokens | share |
| --- | ---: | ---: |
| DUPLICATE | 3,647 | 34.6% |
| TRANSPORT_STRUCTURE | 2,689 | 25.5% |
| REPOSITORY_EVIDENCE | 1,966 | 18.7% |
| MACHINE_DIAGNOSTIC | 887 | 8.4% |
| AGENT_USEFUL_CONTROL | 681 | 6.5% |
| PROVENANCE | 344 | 3.3% |

**114 of 122 repository facts (93.4%) are rendered on more than one surface of the same
response** — the prose context, the structured item list, the capsule digest, the legacy
context section. That is where the model-visible restatement lives.

It is reported, not proposed. Compressing it means deduplicating semantic items across
surfaces, which §22 places behind an independent authority-preservation audit; and
M166 proved that removing restatement from an envelope-bound response converts it into
evidence rather than into savings. Neither of those is a reason it cannot be done.
Both are reasons it is a separate milestone with its own gate.

## §88 — the four strategic questions, answered separately

**Is the full `content[0].text` representation semantically duplicating
`structuredContent`?**

Yes, completely. On 36/36 captured calls the relation is `SUBSET`: `content[0].text` is
byte-identical to `structuredContent.result.output`, and `structuredContent` adds only
the 157-character envelope wrapper. Every one of the eleven semantic categories probed
— primary evidence, support, impact, structural context, memory, readiness, absence and
control state, provenance, diagnostics, component status, token accounting — is present
in both channels on every task. There is no category either channel carries alone.

**Does the actual coding-agent client/model need both representations?**

No, and neither channel is safe to remove, for two different reasons. The agent client
needs only `structuredContent` — proven on 12/12. But VTRACE advertises protocol
`2024-11-05`, which does not define `structuredContent`, and declares no `outputSchema`
on any tool. A conformant client reads `content[]` and nothing else. Simulated against
a text-only read rule, `STRUCTURED_ONLY` recovers 0/12 — an empty result, silently — and
`STRUCTURED_PLUS_SUMMARY` recovers 0/12 in the more dangerous way, handing back 53
tokens of plausible-looking counts where evidence was expected. Codex is advertised in
the README and its behaviour is UNKNOWN.

**Can VTRACE preserve exactly the same repository intelligence while materially
reducing transported/model-visible tokens?**

Transported: yes — 51.4% of the wire line, by dropping either channel. Model-visible:
**no**. The best candidate saves 0.5%, which is the 157-byte wrapper, and buys it by
removing the channel the proven client reads. The 20% materiality gate is missed by a
factor of forty. Materiality and contract fail independently; either alone stops D.

**Does the resulting change materially alter the economic premise of the M165 pipeline
experiment enough to justify a future live requalification?**

No. Nothing changed, and nothing safe could have. M165's treatment cost the model the
same number of tokens before this audit as after it. No live requalification is
justified, authorized or recommended.

## §83 — what this does not do to M165 and M166

M165's utility result and M166's economics were measured under this transport
representation, which M167 did not change. They stand as measured. No figure in either
is recalculated here.

## Artifacts not produced, and why

`stage5_m167_transport_repair.json` and `stage5_m167_model_visible_reduction.json` are
D artifacts. D was not run, so there is no repair to describe and no reduction to
measure; recording zeros under those names would imply a change was made and measured.
The reasoning that would have justified them is in
`stage5_m167_intervention_decision.md`. The raw MCP captures behind every figure here
are deliberately untracked (§8): they are 12 whole tool results, reproducible with
`run_stage5_m167_capture.ts`.

## §56 — verification

```text
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       5,191 pass / 49 skip / 4 fail, 5,244 tests across 336 files [338.98s]
git diff --check               clean
```

The suite did not reach zero failures in one run on this machine, and the four are
accounted for rather than waved past. One is caused by the workaround below: it asserts
`TMPDIR` precedence under a clean environment, and the `TMPDIR` I set leaks into it.
The other three are 5.18–5.23 second timeouts against a 5 second limit on watcher and
MCP-startup tests. All four pass in isolation — `runnerPaths.test.ts` 11/0,
`fileWatcher.test.ts` 10/0 in 2.54s, `mcp.test.ts` 83/0 — and none is a defect in the
code under test, which is in any case byte-identical to the M166 commit.

An earlier run on the default temp root reported **606** failures, every one
`SQLITE_CANTOPEN`. The cause is worth recording for whoever meets it next: `/tmp` is a
32 GB tmpfs at **89% inode** use — 932,044 of 1,048,576 — and this suite creates a temp
workspace per fixture, so it exhausts inodes long before it exhausts space. A mass
`SQLITE_CANTOPEN` here is an inode symptom, not a database defect; check `df -i /tmp`
before diagnosing. Nothing in `/tmp` was deleted.

## Method notes worth carrying forward

- **The uniform-label smell fired on my own harness.** The first candidate scoring
  returned `0/12` semantic preservation for every candidate *including the unchanged
  status quo*, which is impossible. The cause was mine: the preservation check was
  given the prose section where it expects the whole model-facing payload. Fixed, and
  the scoring then discriminated exactly as it should — CURRENT 12/12, the text-only
  read rule 0/12 under both structured-preferring candidates.
- **The classifier was validated against M166 before being trusted.** Run over M166's
  own population it returns M166's numbers (41.0 / 22.2 / 13.7 against a reported
  41.9 / 21.8 / 14.2, the residual being median versus mean), so M167's different mix
  is caused by what changed, not by how it is counted.
- **Escaping is a real width.** `content[0].text` is a JSON string inside the line, so
  its wire footprint is its escaped width: 35,284 characters for a 33,005-character
  payload, a 6.9% inflation. Measuring the raw string would have understated the wire
  cost of the channel this milestone was investigating.
- **`detail=debug` is not an unconditional guarantee.** On 2/12 tasks the debug
  response exceeds the envelope ceiling and the escalation ladder drops the machine
  diagnostics, disclosing it through `diagnostics.sectionDecisionsOmitted`. Pre-existing
  behaviour, unchanged by M167 — but a maintainer debugging a large response should
  know that the level they switched to in order to see everything can still hold
  things back, truthfully.
