# M164 — Callable Readiness Repair and Evidence-Delivery Qualification

```text
M164 overall:        PASS
A readiness audit:   PASS
B readiness repair:  PASS
C paired sweep:      PASS
D conditional util:  PASS
E preservation:      PASS

root cause:          SERVER_READINESS_DEFECT
answerability:       ANSWERABILITY_REPAIRED
utility:             UTILITY_NEUTRAL
architecture:        TRIGGERED_CALLABLE_NEUTRAL
extension decision:  DO NOT BUILD PROACTIVE ROUTING
```

M163 forced twelve agents to call VTRACE and the product refused all fourteen
calls. M164 found which authority was wrong, repaired it, proved delivery through
the sweep's own preparation path, and then asked the question M163 could not:
when the evidence actually arrives, does it help?

It does not. Not because the evidence is bad — on eight of twelve tasks the lead
pivot is the gold file — but because the agents were already going to get there.

## 1. Provenance

```text
M163 predecessor      c936106e016a0161cb884693ead0fe5e20c8e3eb
M164 readiness repair 7dc9385a (product; frozen before the sweep)
M164 protocol freeze  be44dc50
M164 analysis         743fa7c3, 701c4d33, e42eafa2, 231c65dc, and the tier fix
M164 preservation     bf567ccb

branch main · not pushed · no co-author trailers · 14 worktrees preserved
stage5_outcome_ledger.{json,md} left unstaged, as since M109
product code changed  YES — src/mcp/tools.ts resolveReadyRepoBinding only
retrieval changed     NO (proved, not asserted — §7)
```

## 2. Readiness authority: what was wrong

`vtrace index` on a never-initialized repository deliberately writes no
`config.json`/`state.json` — a do-not-litter guard in
`refreshRepoLocalStateAfterIndex` dating to `5ef21df4`. The Stage 5 runner
prepares every workspace that way. The MCP gate required
`config.initialized && state.initialized && state.readiness.status === "ready"`
and read their absence as a statement about the index.

The server was wrong, and the evidence is by consumer rather than by taste:

- After the gate, `binding.config` is **never read again**. `binding.state` is
  read at exactly two sites, both passing fields `inspectIndexFreshness` already
  declares optional.
- `get_code_context` had already called `evaluateIndexReadiness` — M141's single
  evaluator, which answers from the index and never reads a lifecycle file — and
  discarded its `ready` verdict for a snapshot written at index time.
- `index_status` carried both answers in one response: `readiness: null` beside
  `indexReadiness: ready`.
- The CLI has served the identical evidence all along, which is why every
  retrieval eval in this benchmark works.

A user reaches this state with no benchmark in sight: `vtrace index ~/repo`, point
an MCP client at it, permanent refusal. The documented escape — `agentGuidance`
says call `index_repo`, which genuinely does call `initRepo` — was unreachable in
M163, because the sweep exposed exactly two tools and `index_repo` was not one.

Full audit: `stage5_m164_readiness_authority_audit.json`,
`stage5_m164_root_cause.md`.

## 3. The repair, and what it refuses

Additive. An initialized repository keeps the pre-M164 gate exactly; a repository
with no lifecycle record takes read authority from the index. An absent index
keeps the old refusal verbatim, and a database-path override with no lifecycle
record still refuses.

| Workspace state | Before | After |
| --- | --- | --- |
| no index | refuses | refuses (unchanged) |
| valid index only | **refuses** | **serves** |
| init + valid index | serves | serves (unchanged) |
| stale index | refuses | refuses |
| wrong revision / worktree | refuses | refuses |
| incompatible schema / derivation | refuses | refuses |
| corrupt / missing manifest | refuses | refuses |
| db-path override, no lifecycle | refuses | refuses |
| degraded but usable (M156) | serves | serves |

Ten negative controls, all as specified. Zero index writes during any read.

## 4. Delivery, proved through the sweep's own path

M163's gates passed on `init` + `index` fixtures while its sweep used `index`
alone, so they could not have caught the seam they depended on. M164's control
therefore uses the **subject workspaces themselves** — the twelve trees the M163
trigger arm ran against — restored to base commit, re-prepared with the runner's
own index step, asserted to carry an index and no lifecycle files, and asked
through a real `mcp-serve` process built from the sweep's own config builder.

```text
                       M163        M164 offline smoke
VALID_NONEMPTY          0/12       12/12
REPO_NOT_READY         12/12        0/12
```

## 5. Execution

24/24 arms, **zero reruns, zero infrastructure failures, zero selective reruns**.
$19.18 of the $22 authorized cap, enforced before each spawn.

Frozen inputs verified by recomputation from live source, not restatement:

```text
neutral policy  6b7fc159f93dc6298958c86ceafa0db222aa0c2192a189000bd6d09144daec8c   preserved
task trigger    99375ef39091d6caea17e2562c7f00d52359b88aea636bf0e6d7ac84964b69f4   preserved
manifest        reused unchanged (the same twelve tasks)
schedule        154434c6… (alternating lead arm)
```

Availability proven from each run's own init event: 24/24. Treatment delivery
24/24 correct (trigger present in TRIGGER, absent in NEUTRAL).

## 6. The three transitions, kept apart

### Adoption — replicates M163 exactly

```text
                available   used    complied
NEUTRAL           12/12      0/12       —
TRIGGER           12/12     12/12    12/12
```

Twelve agents were served a policy naming `get_code_context` as the orientation
tool, on the MCP instructions channel, and called it zero times. The same
sentence in the task prompt produced 12/12. The server's instruction channel
remains close to inert for routing.

### Answerability — repaired

```text
first call:  VALID_NONEMPTY 11/12   INVALID_REQUEST 1/12
             REPO_NOT_READY  0/12   VALID_EMPTY     0/12
             TOOL_ERROR      0/12   NOT_COMPLIED    0/12

evidence ever delivered      12/12
repository evidence chars    89,980
refusal / error chars           155   (never summed with the above)
```

The single `INVALID_REQUEST` is the agent's own: `pydata__xarray-4966` opened with
an empty query, the product correctly rejected it, and the agent immediately
retried and received a full capsule. It is reported on both denominators rather
than resolved into whichever is convenient. Not rerun — a malformed query the
agent constructed is a result.

**`REPO_NOT_READY` went 12/12 → 0/12.** The repair holds live across twelve
repositories.

### Utility — neutral

```text
resolved       NEUTRAL 8/12      TRIGGER 8/12

shared success        8
TRIGGER unique win    0
NEUTRAL unique win    0
shared failure        4
```

The same eight tasks, task for task. Not eight-and-eight by coincidence of
counts — the identical set.

Paired deltas, TRIGGER − NEUTRAL over 12 pairs (negative = trigger used less):

| metric | median | mean | T>N | N>T | tied |
| --- | ---: | ---: | ---: | ---: | ---: |
| turns | +1.5 | −3.5 | 7 | 5 | 0 |
| ordinary calls | −1 | −3.4 | 3 | 7 | 2 |
| searches | −0.5 | −1.8 | 1 | 6 | 5 |
| reads | +0.5 | 0.0 | 6 | 3 | 3 |
| first edit turn | +1 | −0.3 | 9 | 1 | 1 |
| wall time | −3.7s | −19.1s | 5 | 7 | 0 |
| cost | +$0.10 | +$0.03 | 8 | 4 | 0 |
| model traffic | +254k | +38k | 9 | 3 | 0 |

Mean and median disagree in sign on turns, calls and wall time, which is the
signature of one outlier rather than a trend: `sphinx-doc__sphinx-7440` alone
contributes −49 turns, −23 calls and −$0.76. At n=12 that is variance. The one
consistent direction is cost and traffic, both mildly **up** for the trigger arm
— the fixed price of the mandated call.

Totals: NEUTRAL $9.42 / 21.67M tokens; TRIGGER $9.76 / 22.13M.

## 7. What the agents did with the evidence

Now answerable for the first time, and gated on evidence actually delivered.

```text
gold relation      TOP_1 8/12    ABSENT 4/12
query quality      RIGHT_QUERY_RIGHT_EVIDENCE 8   RIGHT_QUERY_WRONG_EVIDENCE 4
                   (no misaligned queries; overlap 0.53–1.00)

agent reaction     VERIFIED_WITH_NORMAL_TOOLS   12/12
                   USED_AS_ORIENTATION          10/12
                   IGNORED                       2/12
                   DISAGREED_AND_RECOVERED       3/12

false authority    0
false absence      0
voluntary follow-up calls   0/12
```

Three of the four `ABSENT` misses are siblings of the gold file —
`sklearn/ensemble/forest.py` for `iforest.py`, `lib/matplotlib/axes/_axes.py` for
`_base.py`. Retrieval landed in the right neighbourhood and named the wrong file.

Two findings carry the milestone:

**Every agent verified independently — 12/12.** None took the evidence on trust.
`USED_AS_ORIENTATION` and `VERIFIED_WITH_NORMAL_TOOLS` fired together on ten runs:
they opened what VTRACE named, then searched and read as if they had not.

**Not one agent went back — 0/12 voluntary follow-ups.** Including the eight where
the lead pivot was exactly the gold file. Given a free, already-connected tool
that had just answered well, no agent chose to use it again.

Where evidence missed, agents recovered on their own: all three
`DISAGREED_AND_RECOVERED` runs resolved. Where evidence led with gold, four of
eight still failed — for reasons downstream of localization, since they had the
right file from turn zero.

## 8. Why utility is neutral, and what that means

The mechanism is not that the evidence was poor. It is that **localization was
not the binding constraint**. The eight `TOP_1` runs received the gold file as
their first action and converted that into no advantage: four failed anyway, and
the four that succeeded were also solved by the neutral arm, which found the file
itself within a handful of ordinary searches.

M163 also observed 8/12 on both arms with zero unique wins. That result was
uninformative — it was measured under zero exposure. This one is measured under
real exposure to correct evidence, and it says something specific: for this agent,
on these tasks, being handed the right file early is worth approximately nothing,
because finding the right file was never the expensive part.

## 9. Preservation

```text
retrieval output, already-valid init+index fixture   IDENTICAL across the repair
tool inventory (from a real mcp-serve process)       unchanged
tool schemas / descriptions                          unchanged
neutral policy hash / trigger hash                   preserved
negative readiness controls                          10/10
degraded index still serves (M156)                   yes
db-path override still refuses                       yes
index writes during reads                            0
session/repository separation (M152)                 held
worktrees                                            14 → 14
```

Retrieval was **compared**, not argued: the same query against the same fixture
under the pre-repair commit in a throwaway worktree and under HEAD, byte-identical
on pivots, support, discarded count, intent, mode, digest and context files.

`bun run typecheck` pass · `bun run typecheck:benchmarks` pass · `git diff --check`
clean · `bun test` — see §12.

## 10. Analyzer defects found and corrected

Four uniform labels were produced by this sweep, all from one cause: the harness
**truncates large tool outputs**, so `JSON.parse` fails on nearly every real
response, and M163's classifiers were written against parsed envelopes. Each fails
*open* into a confident wrong answer rather than into an absent one.

| reader | wrong output | corrected |
| --- | --- | --- |
| query extraction | empty query on every large result | 4/12 → 11/12 recovered |
| gold relation | `ABSENT` 12/12 | `TOP_1` 8, `ABSENT` 4 |
| evidence tier → query class | `WRONG_EVIDENCE` 12/12 | 8 right, 4 wrong |
| agent reaction | `NO_EVIDENCE_DELIVERED` 12/12 | 10 orientation, 12 verified |
| retry vs voluntary | retry counted as voluntary reuse | 0/12 voluntary |

The gold-relation defect would have **inverted the headline**: publishing `ABSENT
12/12` says retrieval never found the right file, and would have licensed a
retrieval milestone on evidence saying the exact opposite. It was caught because a
uniform label across an entire sweep is the signature of a broken classifier, not
a finding — the same lesson M163 learned about degenerate labels, arriving from
the other direction. Items are now recovered structurally from whatever prefix of
the envelope survives truncation, with known-positive controls.

M163's readers are retained beside the corrected ones, marked non-authoritative.
The discrepancy is the record of why the correction exists.

## 11. Standing conditions and inherited limitations

- `STAGE5_TOKEN_DISCIPLINE` is OFF on both arms as instructed. A **different**
  block, `STAGE5_TOOL_USE_DISCIPLINE`, is injected on every run — verified present
  on all 36 M163 runs and both M164 arms. It carries mild search guidance, so it
  is a constant that cannot confound TRIGGER−NEUTRAL, but it may dampen the
  magnitude of any search-reduction effect. Not changed: policy stays frozen
  during a live sweep.
- Source staleness is detected from git head, dirty fingerprint and config hash,
  so a non-git directory cannot report a stale index. Pre-existing, shared
  identically by the initialized path, not introduced here.
- M122 evaluator `renderReport` crashes on a missing performance key. Pre-existing.
- Canonical retrieval suites return `workspace_error` because their fixtures are
  not materialized. Pre-existing since before M163; the direct before/after
  comparison in §9 substitutes for it and is stronger for this change.
- n=12. No single-task difference supports a claim, and none is made from one.

## 12. Standard verification

```text
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun test                       5158 pass, 49 skip, 0 fail (330 files, run idle)
git diff --check               clean
```

## 13. The four questions

**Was M163's `repo_not_ready` a runner, server, or shared lifecycle problem?**
A server problem. The runner's preparation is a legitimate product-produced shape
that the CLI has always served; the MCP read path treated the absence of two
lifecycle files as evidence about an index whose live readiness verdict it was
already holding.

**After repair, did task-level routing reliably deliver actual VTRACE evidence?**
Yes. `REPO_NOT_READY` 12/12 → 0/12; first-call delivery 11/12, evidence delivered
12/12, the one miss being an empty query the agent itself sent and repaired.

**Once evidence was delivered, did it improve outcomes or efficiency?**
No. Identical solve set — the same eight tasks — zero unique wins in either
direction, and cost and token traffic mildly up. Efficiency deltas are dominated
by a single outlier and change sign between mean and median.

**Where does the next milestone belong?**
Nowhere in this line. Not routing: exposure was achieved and bought nothing.
Not retrieval quality: §84's precondition fails — queries were right, evidence was
delivered, and the lead pivot was the gold file on two thirds of tasks, so returned
evidence is not systematically poor. Not result framing: no agent over-trusted
anything, false authority was zero, and all twelve verified independently.

The honest reading is that **callable VTRACE does not justify its cost for this
agent on these tasks**, because it answers a question the agent can already answer
cheaply. The 0/12 voluntary-reuse figure is the strongest single signal in the
milestone: twelve agents were shown what the tool could do, and not one asked it
anything else.

If this line is continued, the informative experiment is not a better tool or a
better prompt — it is a task population where localization is genuinely hard and
ordinary search genuinely fails. Nothing in M162–M164 has tested that, because
SWE-bench Verified tasks come with issue text that names the failure well enough
for grep to find it.
