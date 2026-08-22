# Stage 5 — M168 pre-spend report: VEXP protocol reproduction and differential attribution

```text
M168-A:  PASS
M168-B:  PASS
M168-C:  MIXED
M168-D:  BLOCKED

protocol verdict:        PARTIAL_PROTOCOL_REPRODUCTION
accounting equivalence:  ACCOUNTING_METRICS_PARTIALLY_EQUIVALENT
                         (ACCOUNTING_DEFINITION_GAP_CONFIRMED within VEXP's own artifact)

public VEXP benchmark authority:
  https://github.com/Vexp-ai/vexp-swe-bench @ d658e3457b82b5cb041f586093cc5002008a8cea
  authored 2026-03-22, package vexp-swe-bench@0.1.0

sample:        NOT SELECTED (selection deferred until an arm B can exist)
arms:          4 designed, 1 currently executable
planned runs:  0
live spend:    $0.00
```

VTRACE product state is unchanged: `de7bfe48`, no `src/` edit, no retrieval change,
no live agent, no Docker.

---

## 1. What M168 set out to do, and where it actually landed

M168 was scoped as protocol archaeology followed by a paired four-arm live
differential. The archaeology finished. It also changed what the live experiment
would mean, so the stop is earlier and more consequential than §136 anticipated.

Two independent findings do the work:

1. **The published result artifact does not evidence that the published treatment
   was active.** The grading is real; the runtime telemetry is not consistent with
   the harness that ships alongside it.
2. **VEXP is not operable on this machine, and the version that could be made
   operable is not the version the benchmark was published against.**

Together these mean the headline comparison M168 was built to run — *reproduce the
published protocol, then diff it against VTRACE* — cannot be executed as specified.
What can still be executed is a genuinely useful experiment, but it is a different
one, and it needs a decision rather than an assumption. Section 7 states it.

---

## 2. M168-A — the benchmark authority is frozen

| Field | Value |
|---|---|
| Repository | `https://github.com/Vexp-ai/vexp-swe-bench` |
| Commit | `d658e3457b82b5cb041f586093cc5002008a8cea` |
| Commit date | 2026-03-22 |
| Task manifest | `data/swe-bench-100.jsonl`, sha256 `7bd07d5e…3971d7d` |
| Task count | 100, all 12 SWE-bench Verified repositories represented |
| Model | `claude-opus-4-5-20251101` |
| Budgets | 250 turns, $3/task, no global timeout |
| Grader | official SWE-bench Verified Docker evaluation |
| vexp-cli version used | **UNKNOWN** — the harness requires ≥1.2.0 and records nothing else |
| Claude Code version used | **UNKNOWN** |

The frozen manifest exists and was read rather than regenerated from prose. One
methodology detail does not survive contact with the code: the published
description mentions a complexity ceiling of ≤250, and `scripts/select-subset.py`
at this commit applies **no such filter**. Seed 42, proportional per-repo
allocation and quintile sampling are all present as described.

### The treatment, in bytes

`setupVexpRepo` writes four things into each benchmark repository, once per repo:

```text
.claude/CLAUDE.md          MANDATORY: call run_pipeline FIRST
                           Do NOT use grep, glob, Bash, Read, or cat to search
.claude/settings.json      PreToolUse matcher "Grep|Glob" → .claude/hooks/vexp-guard.sh
.claude/hooks/vexp-guard.sh   exit 2 (deny) IF .vexp/daemon.sock AND .vexp/healthy exist
.bench-mcp-config.json     mcpServers.vexp = npx -y vexp-mcp
```

**Stated policy and enforced policy are different, and the gap is load-bearing.**
The prose forbids five things — grep, glob, Bash, Read, cat. The hook denies two:
`Grep` and `Glob`. `Bash` and `Read` are never enforced, so `bash -c "grep ..."`
was always available. And the hook is conditional: if the daemon socket or the
healthy marker is missing it exits 0 and the search proceeds. A daemon that fails
to come up within 120s produces a warning and the run continues — silently
converting the strict arm into an unguarded one. The same is true of indexing:
`indexRepo` catches its own failure, prints `Continuing without index`, and returns
normally.

### What the published result artifact evidences

`results/swebench-2026-03-22.jsonl` reproduces the headline exactly: 73/100
resolved, mean `costUsd` $0.6721. The grading behind it is real — 98 official
`report.json` files are committed and they tally 73 resolved / 25 unresolved, with
two instances graded nowhere (`django__django-13513`, `pydata__xarray-6992`) and
counted as failures.

Four mechanical checks on the same file:

```text
timestamps         100 rows, every consecutive gap exactly 300s, rows ordered by
                   instance id; the rows' own durations sum to 16,927s against a
                   29,700s span  → the timestamp column is generated, not observed

product metrics    vexpMetrics null on 100/100 rows — the token-saving block the
                   harness collects when vexp is enabled was never collected

mandated tool      run_pipeline appears on 5/100 rows (5 calls total), under a
                   policy that requires it first on every task

denied tools       Grep on 78 rows (441 calls) and Glob on 22 rows (46 calls),
                   79/100 rows total, under a hook configured to deny both

tool naming        the mandated tool appears under two spellings in one file —
                   bare `run_pipeline` (4 rows) and `mcp__vexp-mcp__run_pipeline`
                   (1 row). A single MCP config produces exactly one, and the
                   harness's own config key is `vexp`, which would produce
                   `mcp__vexp__run_pipeline` — neither of the two observed forms.

grading logs       the committed directory vexp-swebench-1774184993333 contains
                   logs citing 7 distinct evaluation run ids spanning 2026-03-21
                   and 2026-03-22; only 1 of 99 log files cites the directory's
                   own id
```

The honest reading: **the resolution number is backed by real Docker grading, and
the artifact does not establish which agent configuration produced the patches
that were graded.** The evaluation directory is an assembly of several grading
passes, and the telemetry columns are inconsistent with the treatment shipped in
the same commit. This is a statement about what the artifact can support, not an
accusation about how it was produced.

---

## 3. M168-B — the accounting does not agree with itself

The published file carries both a cost column and token columns, and its own price
table. Re-pricing the tokens with that table does not reproduce the cost:

```text
rows where re-pricing reproduces the stored cost      5 / 100
median ratio (repriced / stored) on the other 95      1.227
published mean cost per task                          $0.6721
mean cost per task implied by the published tokens    $0.8298   (+23.5%)
largest single-row disagreement                       $1.39
```

The mechanism is identified and confirmed, not guessed. `parseStreamJson` returns
early the moment the stream emits a `result` event carrying `total_cost_usd`, so
95 rows report **Claude Code's own billed figure** while their token columns keep
accumulating from assistant events. The 5 agreeing rows are exactly the 5 runs
killed at the $3 cost limit, which never emit that event and therefore fall back
to the harness's own arithmetic. Predicted set, observed set, identical: 5/5.

This matters for the leaderboard framing. The published table reads
"vexp $0.67 · 22% cheaper than the next best agent ($0.86)". Priced from the same
file's own token columns with the same file's own price table, the figure is $0.83
and the margin is roughly 3.5%. Which number is right depends on which boundary
you are measuring at, and the artifact contains both without saying.

Two further columns are **NOT COMPARABLE** to anything VTRACE reports:

- **tokens used / saved / saving %** — `(token_budget - tokens_used) / token_budget`
  read from the capsule's own SQLite feedback table. This is how much of its *own*
  budget the capsule spent. It is not a model-context token count and it is not
  measured against a counterfactual where the tool is absent. VTRACE's
  `vtraceContextBudget` is the same species of number, and comparing the two would
  be as meaningless as comparing either to billed tokens. It is also moot here:
  null on 100/100 published rows.
- **"~60% fewer tokens", "70–90% savings vs Read", "58% lower cost per task,
  90% fewer tool calls"** — product-surface claims in the tool descriptions and the
  npm package description. No baseline, boundary or measurement is published with
  any of them. Recorded as UNKNOWN.

Two columns are directly comparable and should carry the live comparison if one
runs: cache-read/cache-creation tokens and total model traffic. Note that
`inputTokens` has a median of **2** — 99.97% of the 114.1M tokens of traffic are cache
read and write —
so that column must never be read as the model's context size.

---

## 4. M168-C — what differs, on the evidence available offline

The parts that can be measured without running VEXP were measured. The part that
needs VEXP running was not, and is marked as such.

### Tool surface

```text
                        VTRACE (default)     VEXP (default)
tools in tools/list           14                    4
registered but hidden          7                    7
description chars          3,699                2,181
```

VEXP's bundled MCP server registers eleven tools and serves four —
`run_pipeline`, `get_skeleton`, `index_status`, `expand_vexp_ref` — unless
`VEXP_ALL_TOOLS=1` promotes the rest. It spends **more words on fewer doors**.

The gap concentrates on the one tool both systems name identically:

```text
run_pipeline description      VTRACE   223 chars     VEXP   949 chars
get_skeleton description      VTRACE    74 chars     VEXP   718 chars
```

VEXP's reads *"PRIMARY TOOL — Use this for ANY codebase task … Before ANY code
change — always call this first … ALWAYS prefer this over Read, Grep, Glob"*.
VTRACE's reads *"Default Vtrace repo-context pipeline. get_code_context is the
agent-friendly alias for this tool"*. VTRACE's routing weight lives on
`get_code_context` (1,360 chars), and that text is careful in the opposite
direction — it tells the model what the tool does **not** cover, that a miss is
not proof of absence, and that it answers about one worktree at one revision.

Both choices are defensible and they are not the same intervention. The schema
channel is re-read every turn (M162), so this is a routing-pressure differential
sitting in the most expensive real estate either product owns.

VTRACE already ships `createRestrictedMcpToolRegistry`, so matching VEXP's narrow
surface is a configuration of existing behaviour, not a product change.

### Response architecture

```text
                    VEXP                          VTRACE
channel             content[0].text only          content[0].text + structuredContent
shape               rendered markdown string      JSON
first-call budget   max_tokens 10,000 default     median 10,526 model-visible tokens (M167)
compression lever   prose_compression, default    detail lever + section-priority
                    "lite"                        truncation (M45/M166)
```

The budgets land in the same place. The **shapes** do not, and M166 already priced
what that costs on the VTRACE side: 41.9% of the model-visible payload is transport
structure, and 34.6% is duplicated fact. VEXP's server assembles prose and returns
one string. Whether that converts into a real evidence-density advantage is exactly
the measurement M168-C could not take.

### Not measured

First-call payload content, evidence density and retrieval quality on matched
tasks all require VEXP's pipeline to run. See section 5.

### Corpus overlap — a useful surprise

```text
Broad100-A        100 tasks   100% overlap   IS the VEXP manifest, exactly
M155 paired30     100 tasks   100% overlap   same set
M158 corpus        61 tasks   100% overlap   subset
M110 frozen         3 tasks   100% overlap   subset
Broad100-B        100 tasks     0% overlap   disjoint holdout
M162/M164 pilot    12 tasks     0% overlap   drawn from Broad100-B
```

**VTRACE's broad retrieval evidence since M156 was already measured on the
competitor's own task set**, and an uncontaminated holdout already exists. This was
not known when those corpora were frozen. It means a paired sample can be drawn
from the VEXP manifest with VTRACE-side retrieval evidence already in hand, and
Broad100-B remains clean for any later extension.

---

## 5. M168-D — blocked, with the blocker stated exactly

The four-arm smoke cannot run. Arms A (baseline) and D (VTRACE clean) are
executable today; arm C (VTRACE strict parity) needs only a hook and a policy file.
Arm B — the one the whole milestone is about — is blocked on three things:

```text
1. native core absent      @vexp/core-linux-x64 is an optionalDependency and did
                           not install; getBinaryPath() throws

2. CLI hard-gated          the installed vexp-cli 2.0.24 refuses every command,
                           including `--version` and `license status`, with
                           "vexp update required! Installed 2.0.24, Available 2.7.0"

3. licence required        the harness calls ensureVexpLicense() and aborts unless
                           the plan is Pro or Team. No licence is present on this
                           machine (~/.vexp/license.jwt absent). A 14-day trial is
                           advertised behind an account signup.
```

Clearing 1 and 2 means `npm install -g vexp-cli@latest`, which installs **2.7.0** —
five minor versions past anything the March benchmark could have used, and past the
policy change VEXP is understood to have made after finding that stronger search
blocking raised cost. That is `CURRENT_DEFAULT_POLICY`, not
`PUBLISHED_BENCHMARK_POLICY`. Even with a licence, the best available verdict is
`FAITHFUL_PROTOCOL_REPRODUCTION_WITH_RUNTIME_DRIFT`.

Clearing 3 is a commercial and legal decision — a signup, a trial code, and running
a licensed competitor product against public benchmark repositories. That is the
user's call, not mine.

Network activity so far: one npm registry version query, triggered by probing the
installed CLI. No repository content left the machine. VTRACE source was never
exposed to VEXP.

---

## 6. Hypotheses, scored on the evidence in hand

```text
H1  AGENT_POLICY_GAP          UNTESTED — but the published artifact does not show
                              the policy operating, so the 73% cannot be attributed
                              to it

H2  PIPELINE_OUTPUT_GAP       PLAUSIBLE, UNMEASURED — same nominal budget, very
                              different shape; needs matched-task payloads

H3  RETRIEVAL_QUALITY_GAP     UNTESTED — needs arm B

H4  ACCOUNTING_DEFINITION_GAP CONFIRMED, within VEXP's own published artifact:
                              two accountings 23.5% apart, plus three
                              product-surface claims with no measurable definition

H5  BENCHMARK_SCAFFOLD_GAP    STRONGLY SUPPORTED — the published comparison sets a
                              caching-heavy Claude Code cost column against
                              competitors' own published figures from unrelated
                              scaffolds, never runs those competitors, and its own
                              73% row carries telemetry inconsistent with its own
                              treatment
```

The apparent contradiction M168 was created to resolve — *VTRACE has the
architecture and shows neutral marginal utility, VEXP reports a strong system
result* — is substantially dissolved without arm B. The public 73% is a real
achieved score on a real grader. **It is not evidence of a marginal VEXP effect,
because the artifact contains no paired no-VEXP baseline and does not establish
that VEXP was steering the runs it reports.** M164's null and the public 73% were
never in contradiction; they were never measuring the same thing.

---

## 7. The decision this report exists to force

Three ways forward. They cost very different things and answer different questions.

**Option 1 — three arms, no VEXP.** Run A / C / D on 12 tasks drawn from the frozen
VEXP manifest. Answers the question VTRACE actually needs answered: *does forcing
pipeline-first and suppressing native search change outcomes or economics at all?*
That is C vs A and D vs C — the M164 null's most likely untested cause. Costs ~36
runs. Needs no licence, no competitor install, no legal question. It cannot answer
"what does VEXP do better".

**Option 2 — four arms with current VEXP.** Option 1 plus arm B on vexp-cli 2.7.0
under a Pro/Team licence. Answers the product differential against *today's* VEXP.
Costs ~48 runs plus a signup and a licence. Must be labelled
`FAITHFUL_PROTOCOL_REPRODUCTION_WITH_RUNTIME_DRIFT`; it is not a reproduction of
the March benchmark and cannot validate or invalidate the published 73%.

**Option 3 — close M168 here.** A and B already delivered the milestone's actual
purpose: the contradiction is explained, and it is explained by the benchmark's
construction and accounting rather than by a capability VTRACE lacks. No further
spend.

My recommendation is **Option 1**. It buys the causal baseline the public
leaderboard never had, it isolates policy from retrieval — the one live variable
M162 through M167 never manipulated — and it spends nothing on reproducing an
artifact whose provenance we have just shown is not recoverable. Arm B stays
available afterwards if C vs A turns out to be positive and the mechanism needs a
competitor comparison.

Nothing further runs until this is chosen. No sample has been selected, precisely
so that selection cannot be contaminated by knowing which arms will exist.

---

## 8. Verification

```text
bun run typecheck               PASS
bun run typecheck:benchmarks    PASS
bun test m168Authority          15/15 pass  (5 identity controls, 7 known positives,
                                             3 boundary cases)
git diff --check                clean
```

Environment at start: `TMPDIR` unset, `/tmp` tmpfs 21G free / **89% inodes used**
(927,361 of 1,048,576) — unchanged from M167's observation and still a hazard for
any run that creates many small files. No `/tmp` content was deleted. All M168
scratch work stayed in the session scratchpad.
