# M188 — Competitor Intervention and Causal-Mechanism Audit

**Verdict: PASS.** Research and evidence synthesis only. No VTRACE product behaviour
was changed, no live agent was spawned, no Docker evaluation was run, $0.00 spent.

Accessed 2026-08-30. External systems evolve; every claim below is pinned to a
version, commit or access date.

---

## A. Executive conclusion

**Does external evidence identify a causally supported intervention beyond one-shot
orientation?** Partly — and not the part the question expects.

Three things came back that the strategic reset did not anticipate.

**First, VEXP's published benchmark does not test the intervention VTRACE thought it
was competing with, and never did.** The harness injects no repository context into
the agent's prompt at all. `buildPrompt` is the repository name, "fix this issue", and
the problem statement — nothing else. What VEXP's benchmark actually applied was a
written mandate in `CLAUDE.md`, a `PreToolUse` hook denying `Grep|Glob`, and an MCP
server the agent had to choose to call. The agent chose to call it on **5 of 100
tasks**, used the forbidden native search tools on **79 of 100**, and the run's own
`vexpMetrics` column is null on **100 of 100**. The 73% is a real, Docker-graded
number attached to a treatment that mostly did not fire.

**Second, the competitor arms in that benchmark were never run.** `data/external/*-resolved.json`
holds the *published full-500 resolvedIds* of Live-SWE-agent, OpenHands and Sonar
Foundation from other people's SWE-bench submissions in November and December 2025.
72, 70 and 70 are the set-intersections of those id lists with VEXP's 100-task subset —
reproduced exactly by our audit script. The `$3`/250-turn budget applies only to the
VEXP arm. The page's sentence "The only variable was the context layer" is
contradicted by the harness's own data directory.

**Third, and most consequentially: VEXP has since run the experiment M183 ran, and
reported the same shape of answer.** Their 3.0.0 release (2026-08-27) claims a paired
same-agent with/without ablation on 25 SWE-bench Pro tasks: 24 of 25 against 22 of 25,
two discordant tasks, both favouring vexp. Two discordant pairs in one direction is an
exact two-sided McNemar *p* = 0.5. M183 was 19/30 against 19/30 with two discordant
pairs each way, *p* = 1.000. **These are not opposing results. They are the same
underpowered result with a different sign.** And in the same release VEXP moved its
entire lifecycle-intervention suite — the completion gate, edit-time coupling hints,
read substitution, shell output cap — to **opt-in**, keeping as default only
"orientation at turn zero" plus a smaller tool catalogue, on the stated grounds that
"one extra turn costs more than almost any amount of clever context can save".

So the competitor's own measured, defaults-changing conclusion converges on VTRACE's:
one-shot orientation is what survives; the during-work interventions did not earn
default-on status. That is not a contradiction of M183 — it is external corroboration
of it, arrived at independently.

Against that, one external result does go further than anything VTRACE has: a
same-harness index-on/index-off ablation (SuperAGI, arXiv:2606.22417) with 50.4%
against 41.9%, *p* = 0.003 on 80 paired instances. It is the strongest causal evidence
found in this audit. Its own cross-harness check is the qualification: against an
independent agentic-grep harness the same arm is +6.0pp at *p* = 0.087 — which is the
comparison M183 actually ran.

And one intervention class has controlled evidence that no VTRACE milestone has
touched: **diff-derived validation and edit-set obligations**. TDAD (arXiv:2603.17973)
takes the current diff, walks a source-to-test dependency graph, and hands the agent
the tests its change put at risk. On 100 SWE-bench Verified instances it cut the
test-level regression rate from 6.08% to 1.82%. It did **not** improve resolution
(31% → 29%). That is the precise finding: the mechanism is real, it is measured, and
it moves a variable SWE-bench resolution does not score.

---

## B. Methodology

**Systems searched.** VEXP (deep), SuperCoder/SuperAGI, Cursor, Augment Code, Aider,
Claude Code, TDAD, Live-SWE-agent, OpenHands, Sonar Foundation, plus the academic
context-retrieval literature (ContextBench, the two AGENTS.md ablation studies).
Sourcegraph, Cody and RepoPrompt were searched and dropped: nothing was found that
established an intervention *mechanism* at the standard §10 demands, and §3 prefers
depth to catalogue.

**Source types, in the order we trusted them.** Committed artifacts and shipped
package contents; published papers with released protocols; maintainer-authored
technical writing; official documentation; vendor changelogs; product pages. SEO
articles and third-party reviews were used for nothing.

**Primary-source discipline.** VEXP's harness was read at
`Vexp-ai/vexp-swe-bench@d658e345` via `git show HEAD:<path>`, never from the local
working tree — that checkout is dirty from our own Stage 5 runs and is not the
published artifact. Upstream HEAD at audit time is `9e3d06d5` (2026-05-02), one commit
later, adding a Gemini CLI adapter and no new results, telemetry or ablation. The
model-facing tool surface was read from the npm tarballs of `vexp-mcp` **1.2.29**
(published 2026-03-21 — the version `npx -y vexp-mcp` would have resolved during the
2026-03-22 benchmark) and **3.0.1** (2026-08-27, current). Packages were extracted and
read; none was executed.

**Reproducibility.** The load-bearing arithmetic is re-derived by
`run_stage5_m188_vexp_artifact_audit.ts` into
`stage5_m188_vexp_artifact_audit.json`. Every number in section D that comes from the
published run rows is produced by that script, not transcribed.

**Evidence hierarchy.** Tier A: same agent, same scaffold, same tasks, same budgets,
only the intervention differs. Tier B: controlled component ablation with minor
secondary differences. Tier C: paired behavioural evidence with no isolated outcome
effect. Tier D: cross-system benchmark. Tier E: anecdote or demo. Tier F: marketing
assertion with no underlying ablation.

**Unknown-handling.** Fields are left `unknown`, `not publicly documented` or
`not observed`. Marketing copy is never promoted to implementation fact; where a
vendor asserts a measurement without releasing the underlying artifact, the
measurement is recorded as claimed and classified `MARKETING_CLAIM_ONLY`, which is a
statement about the evidence available to us and not an accusation of error. Absence
of a public ablation is reported as absence of a public ablation, never as proof that
none was run internally.

---

## C. Intervention taxonomy

Used unchanged from the milestone brief, with one added distinction that the evidence
forced.

| Class | Intervention | Defining question |
|---|---|---|
| I0 | No repository intelligence | agent uses shell/read/search only |
| I1 | One-shot initial orientation | compact repository context handed over before the agent acts |
| I2 | On-demand repository intelligence | agent asks impact/flow/skeleton/context questions during work |
| I3 | Continuous / adaptive injection | the system changes repository evidence as agent state evolves |
| I4 | Post-edit repository analysis | current diff → affected symbols, consumers, contracts |
| I5 | Validation guidance | current change → the tests that must now pass |
| I6 | Completion / edit-set checking | task + diff → missing coordinated edits, unmet obligations |
| I7 | Workflow / scaffold intervention | tool restriction, mandatory tool use, planning or repair enforcement |
| I8 | Durable project / session memory | prior decisions injected into the current task |

**Added distinction — I7a versus I7b.** The evidence separates *depriving* the agent
(denying Grep/Glob, restricting the tool surface) from *instructing* it (a mandate in a
context file). They have opposite measured signs and must not share a row. I7a
deprivation: VTRACE's own M168-E lost 2 tasks and won none. I7b instruction: two
independent studies find no correctness effect and a >20% cost increase, and TDAD
finds a procedural mandate without a targeted obligation makes regressions *worse*.

---

## D. VEXP audit

### D.1 The actual coding loop in the published benchmark

Reconstructed from `src/harness/orchestrator.ts`, `src/harness/loader.ts`,
`src/vexp/enhancer.ts` and `src/agents/claude-code.ts` at `d658e345`.

```text
issue arrives
    ↓
system-generated repository context?            NOT PRESENT
    buildPrompt(instance) = repo name + "fix this issue,
    do not modify tests" + problem_statement. Nothing else.
    ↓
per-repo setup (once per repository, not per task)   AUTOMATIC
    writes .claude/CLAUDE.md          — the mandate            (I7b)
    writes .claude/settings.json      — PreToolUse Grep|Glob   (I7a)
    writes .bench-mcp-config.json     — registers the server   (I2 availability)
    runs `vexp-cli index`             — failure is warned and continued past
    ↓
per-task: daemon start, repo reset to base commit     AUTOMATIC
    ↓
agent searches manually?                        YES, on 79/100 tasks
    ↓
specialized repository tools?                   AGENT-INVOKED, on 5/100 tasks
    ↓
agent edits                                     Edit on 99/100 tasks
    ↓
system observes diff?                           NOT PRESENT
impact analysis after edit?                     NOT PRESENT
tests?                                          agent's own choice; Bash on 92/100
validation recommendation?                      NOT PRESENT
repair loop?                                    NOT PRESENT
completion check?                               NOT PRESENT (verify_done did not exist)
    ↓
capturePatch(localPath) → git diff → SWE-bench Docker grading
```

The only automatic, mandatory element in the whole loop is the scaffold: a written
instruction and a conditional tool-denial hook. **There is no I1 in VEXP's benchmark.**
The interventions the product is marketed on are all I2, and I2 is invoked at the
model's discretion.

### D.2 The mandate, quoted

`writeClaudeMd` in `src/vexp/enhancer.ts` writes, for every repository:

> "**MANDATORY: use vexp pipeline** … call `run_pipeline` FIRST. … Do NOT use grep,
> glob, Bash, Read, or cat to search/explore the codebase."

`writeHooks` writes a `PreToolUse` matcher on `Grep|Glob` running a script whose whole
body is:

```bash
if [ -S "$SOCK" ] && [ -f "$HEALTHY" ]; then
  echo "DENY: Use run_pipeline instead of Grep/Glob. vexp daemon is running."
  exit 2
fi
exit 0
```

The denial is conditional on a live daemon socket **and** a healthy marker. If either
is missing the hook exits 0 and the strict arm silently becomes an unguarded arm, with
nothing in the result row recording the degradation. `DEFAULT_ALLOWED_TOOLS` in the
orchestrator is `["Edit","Write","Bash","Read","Glob","Grep","TodoWrite"]` — the same
array in both arms — so `Grep` and `Glob` remain enabled at the CLI level even under
the mandate.

### D.3 Tool availability versus observed use

Capability at benchmark time is `vexp-mcp@1.2.29`: ten tools — `run_pipeline`,
`get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`,
`index_status`, `get_session_context`, `search_memory`, `save_observation`,
`workspace_setup`. `run_pipeline` carried a 959-character description headed
"PRIMARY TOOL — Use this for ANY codebase task … ALWAYS prefer this over Read, Grep,
Glob".

Observed use across all 100 published rows:

| Tool | Calls | Tasks | Notes |
|---|---:|---:|---|
| Bash | 811 | 92 | forbidden by the mandate |
| Read | 671 | 99 | forbidden by the mandate |
| Grep | 441 | 78 | forbidden by mandate **and** hook |
| Edit | 186 | 99 | |
| Glob | 46 | 22 | forbidden by mandate **and** hook |
| Task | 28 | 28 | Claude Code subagents |
| Skill | 16 | 15 | |
| Write | 4 | 2 | |
| **`run_pipeline`** | **4** | **4** | bare name |
| WebFetch | 3 | 3 | |
| WebSearch | 2 | 2 | |
| **`mcp__vexp-mcp__run_pipeline`** | **1** | **1** | namespaced |

- Tasks calling **any** vexp tool: **5 / 100** — `django-11490`, `django-12273`,
  `django-12774`, `sphinx-7748`, `sympy-23413`. Four of the five resolved.
- Tasks calling **no** repository-intelligence tool at all: **95 / 100**, of which 69
  resolved.
- Tasks using `Grep` or `Glob`: **79 / 100**.
- `vexpMetrics` null: **100 / 100**. `collectVexpMetrics` reads a `capsule_feedback`
  row out of `.vexp/index.db` inside a `try/catch` that returns null on any failure.
  A capsule that was generated would have left a row. None did, on any task.
- No `get_impact_graph`, `search_logic_flow`, `get_skeleton` or memory-tool call
  appears in any row.

**Two spellings, neither of which is the committed configuration.** `parseStreamJson`
records `block.name` verbatim and normalises nothing, so both strings are what the
model actually emitted. `writeMcpConfig` registers the server under the key `vexp`,
which in Claude Code yields `mcp__vexp__<tool>`. The one namespaced call in the file is
`mcp__vexp-mcp__run_pipeline`, and the other four are the bare `run_pipeline`, which is
not a callable MCP tool name in Claude Code at all. The most economical reading is that
the published rows were produced under a configuration that differs from the committed
one, and that the four bare calls are the model reproducing the name it was given in
`CLAUDE.md`. `INFERRED_FROM_IMPLEMENTATION`; we cannot settle it, because the raw
streams are not published.

**§10 answer, plainly.** VEXP *has* an impact graph, a logic-flow tracer and a
skeletonizer. VEXP's benchmark agents did not call them. Capability is documented;
routine use during evaluated coding tasks is contradicted by the vendor's own telemetry.

### D.4 The published benchmark comparison

| Arm | Subset score | Executed by this harness? | Provenance |
|---|---:|---|---|
| vexp + Claude Code | 73 / 100 | **yes** | `results/swebench-2026-03-22.jsonl`, 100 rows, Opus 4.5, Docker-graded |
| Live-SWE-agent | 72 / 100 | **no** | 396 published resolvedIds ∩ subset, from `20251215_livesweagent_claude-opus-4-5` |
| OpenHands | 70 / 100 | **no** | 388 published resolvedIds ∩ subset, from `20251127_openhands_claude-opus-4-5` |
| Sonar Foundation | 70 / 100 | **no** | 396 published resolvedIds ∩ subset, from `20251205_sonar-foundation-agent_claude-opus-4-5` |

The intersections are reproduced exactly by our script. On the full 500-task set those
same three systems score 79.2, 77.6 and 79.2 — every one of them above VEXP's 73 on
VEXP's chosen hundred. The subset is 7–9 points harder than average for them. What
VEXP would score on the full 500 is unknown and unknowable from this artifact.

The page states "All four agents run the same model", "the same cost limit ($3/task)
and the same turn budget (250 turns)", and "**The only variable was the context
layer**". The first is true. The second is true only of the VEXP arm — the other three
ran months earlier under their own submissions' budgets. The third is false, and the
files that disprove it ship in the same repository. Live-SWE-agent, specifically,
begins from a bash-only minimal scaffold and **rewrites its own agent implementation at
runtime** (arXiv:2511.13646). It does not share an agent loop, a tool policy, a context
manager or a repair loop with Claude Code. This is exactly the §7 error: same model is
not same experiment.

The README is more careful than the page. It gives "±8.7% margin of error at 95%
confidence", which for n=100 at p=0.73 is arithmetically right (1.96·√(0.73·0.27/100) =
8.7pp), and puts 70 and 72 comfortably inside VEXP's own interval.

### D.5 Two accountings in one file

| | Total | Per task |
|---|---:|---:|
| Published `costUsd` column | $67.2069 | **$0.6721** |
| Same rows' token columns × the harness's own Opus 4.5 price table | $82.9750 | **$0.8298** |
| Disagreement | | **23.5%** |

Mechanism confirmed rather than guessed. `parseStreamJson` short-circuits on the
stream's `result` event and returns Claude Code's provider-billed `total_cost_usd`,
which is cache-discounted; only when that event never arrives does it fall through to
`calculateCost` over the summed usage. The rows where published equals repriced to
machine precision are exactly five — `django-15503`, `django-16263`, `django-16819`,
`django-17084`, `sympy-16792` — and every one of them is above $3.00, i.e. killed by
the cost limit, which is precisely the case that never emits a `result` event.

The published $0.67 is therefore a *provider-billed* figure, and the competitors' costs
come from "each agent's published benchmarks" — their own accounting boundaries. The
"22% cheaper than the next best agent" headline compares a cache-discounted bill
against other parties' figures computed a different way. M168's rule stands and now has
a second instance: *a cost column and a token column are two measurements until one is
derived from the other.*

### D.6 A provenance observation on the result rows

All 100 rows sit on an exact 300-second grid, 08:00:00Z to 16:15:00Z, ordered by
instance id, with **one** distinct inter-row delta across all 99 gaps. The rows' own
`durationMs` values sum to 16,927s — 57% of the 29,700s span — and vary widely. The
orchestrator stamps each row with `new Date().toISOString()` at append time, inside a
loop grouped by repository. A single exact delta across 100 consecutive rows is not
reachable from that code path. The committed timestamps were regenerated or normalised
rather than emitted by the code that claims to produce them.
`INFERRED_FROM_IMPLEMENTATION`. It does not impugn the Docker grading, which is real
and independently checkable; it does mean the run rows are not a faithful trace.

### D.7 The VEXP-off / VEXP-on ablation search

**The seam exists in the published harness.** `--no-vexp` sets `useVexp=false`, which
skips `setupVexpRepo` entirely: no `CLAUDE.md`, no hook, no MCP config, no index.
`buildPrompt`, `DEFAULT_ALLOWED_TOOLS`, the model, the turn cap and the cost cap are
identical in both arms. `--baseline <jsonl>` in the compare path is documented as
"Baseline results JSONL (no-vexp run)", and `scripts/plot.py` has a `baseline_rows`
code path throughout. This is a genuine same-agent, same-prompt, same-budget ablation
seam, fully built.

**No result from it is published.** `results/` contains one run. The benchmark page and
README present no baseline row. `plots/` contains the three comparison figures, none of
them a baseline delta.

**A different ablation is claimed elsewhere, and it is the important one.** The
`vexp.dev/changelog` entry for **v3.0.0, 2026-08-27**:

> "The claim is paired, not projected: twenty-five real repository tasks from SWE-bench
> Pro, none used during tuning, three of the repositories never touched by vexp
> development at all. Same agent, same model, same day — the only difference is vexp.
> With it: 24 of 25 resolved against 22 of 25 without, 13 percent less context
> replayed, 8 percent lower total cost, and the two tasks that flipped both flipped in
> vexp's favor, both on the longest sessions."

Assessment, without hostility and without credulity:

- The **design** is right, and is exactly the design M183 used. "Paired, not projected"
  is the vendor explicitly disowning the reasoning their own SWE-bench page uses.
- The **resolution result is not statistically resolvable**. Two discordant pairs, both
  one way, is an exact two-sided McNemar *p* = 0.5. The vendor does not claim
  significance; they report the count.
- The **continuous measures have more power than the binary one** — 13% context replay
  and 8% session cost over 25 paired sessions could well be real — but no dispersion,
  interval or test is given, so they cannot be graded.
- **"Tuned on … scored on tasks the tuning never saw"** is a genuine holdout statement,
  and it sits next to "the defaults changed to exactly the configuration that measured
  best". Configuration selection used the tuning set; 25 held-out tasks then scored the
  winner. That is a legitimate protocol and a thin holdout.
- **No artifacts.** No task ids, no per-task rows, no logs, no harness. Nothing here is
  independently checkable, unlike the SWE-bench run, whose 98 `report.json` files are
  committed.

Verdict for §6: **`PARTIAL_ABLATION_ONLY`.** A same-agent off/on ablation is claimed
with numbers and a stated protocol; it is not released as evidence; and as reported its
resolution effect is indistinguishable from noise.

### D.8 What VEXP's own trajectory says

The version history is itself evidence, and it points one way.

| Date | Version | Change | Class |
|---|---|---|---|
| 2026-03-21 | 1.2.29 | benchmark-time surface. `run_pipeline`: "Use this for ANY codebase task … Before ANY code change — always call this first. ALWAYS prefer this over Read, Grep, Glob" (959 chars). `get_skeleton`: "ALWAYS prefer this over Read" (722 chars) | I2 under I7 coercion |
| 2026-07-31 | 2.4.0 | "vexp used to insist on being consulted for everything and blocked your agent's own search tools." Nothing is blocked any more. Ambient per-prompt classification decides "whether to stay perfectly silent or to hand your agent a one-line orientation"; fail-open | I7 withdrawn; I3 added |
| 2026-08-05 | 2.5.0 | `verify_done`: parse errors, imports of names that no longer exist, dependents never touched, promised files never written, task constraints violated — all with file:line. Plus a Claude Code **stop-time check** that "challenges provably incomplete work once … and never blocks a clean stop" | I4 + I6, agent-invoked *and* automatic at stop |
| 2026-08-12 | 2.6.0 | Impacted tests: "the exact test files mechanically tied to what you touched", via the dependency graph plus an import scan for anonymous suites; opt-in run mode executes them. Orientation goes silent after three per session; a lifecycle hook re-injects one paragraph after compaction | I5 added; I3 bounded |
| 2026-08-22 | 2.7.0 | Retrieval keyed on the issue *title* rather than the whole pasted report; on 121 issues with human-written answers, score 0.190 → 0.273, recall 0.281 → 0.380 | retrieval quality, not intervention |
| 2026-08-27 | 3.0.0/3.0.1 | Orientation cap raised from 2 code blocks to 6 because "transcripts showed the agent going on to edit six to eleven files after being handed three names". **"Everything vexp does that could add a turn — the end-of-session completion gate, the edit-time coupling hints, the read substitution, the shell output cap — is now opt-in."** Default is "only what subtracts: orientation at turn zero, a tool catalog trimmed from 1,030 tokens to 351". `run_pipeline` description cut to 465 chars: "**If the task already names the files to touch, skip this and use your normal tools.**" | I4/I5/I6 demoted to opt-in; **I1 is the default** |

Three of these are direct external convergences with VTRACE findings the vendor could
not have read:

- **M169** concluded that mandatory pipeline invocation was not licensed and that the
  answer was "on-demand, not a smaller mandatory pipeline". VEXP unblocked native
  tools in 2.4.0 and, in 3.0.1, wrote the conditional into the tool description itself.
- **M166/M172** measured that the tool catalogue is model-visible and billed on every
  turn. VEXP trimmed theirs 1,030 → 351 tokens and named that as a default-changing
  reason.
- **M183/M185** found orientation gave behavioural wins without an outcome effect.
  VEXP's 3.0.0 reports "the agent reaches its first edit about 20 percent sooner" and,
  in the same release, 24 against 22.

One is a warning we should read against ourselves. The vendor's own source comment on
`verify_done` records that the tool "existed in the Rust MCP and in the daemon … and
nowhere in this server — while the `CLAUDE.md` vexp writes into every project instructs
the agent to call it. An agent configured through the Node bundle was being told to use
a tool that did not exist, and reported it (2026-08-21)." An instruction naming an
absent tool survived from 2.5.0 to 2.7.0 on one of two shipping surfaces. This is the
M184/M187 shape exactly: a capability believed present, an instruction premised on it,
and no check that the two agreed.

### D.9 VEXP causal verdict

`NO_CAUSAL_ABLATION_FOUND` for the published SWE-bench claim; `PARTIAL_ABLATION_ONLY`
for VEXP overall, on the strength of the 3.0.0 changelog claim.

---

## E. Other systems

Only intervention-relevant evidence is summarised. Systems where the search produced no
mechanism evidence are recorded as such rather than padded.

**SuperCoder / SuperAGI Research — the strongest external causal evidence found.**
arXiv:2606.22417, "Code Isn't Memory", 2026-06-21. Three arms on 91 instances drawn
from SWE-PolyBench Verified and SWE-bench Pro (Go 34, Java 20, Python 37), Claude Opus
4.7 fixed, three seeds, leak-audited per-task sandboxes. SC-OFF "removes exactly those
two tools from the schema and leaves everything else identical" — the baseline keeps
read, write, edit, bash, git, **grep and glob**. Results: resolve 50.4% vs 41.9%,
paired Wilcoxon *p* = 0.003, n = 80 paired; localization acc@5 84.5% vs 44.3%,
*p* < 0.0001; cost per solve $2.30 vs $2.84; per-cell cost difference null (*p* = 0.73).
The cross-harness comparator, OpenCode with ripgrep/read/glob/bash and no index, scores
45.3% — SC-ON is +6.0pp over it at *p* = 0.087, and OpenCode beats SC-OFF. Tier B.
Authors are the vendor of the harness under test, and disclose their nulls, which
raises rather than lowers credibility. **Two readings are both correct and must be kept
together:** the index causes a large, significant gain within its own harness, and
against a purpose-built agentic-grep harness the gain is smaller and not statistically
separated. The second reading is the M183 comparison.

**Cursor — the only live user-facing A/B found.** Semantic search versus the same agent
with grep only. Offline, on Cursor Context Bench: "on average 12.5% higher accuracy in
answering questions (6.5%–23.5% depending on the model)", across all their most-used
models. Online, real users, identical models, one group without semantic search: +0.3%
code retention overall, **+2.6% on codebases over 1,000 files**, and 2.2% more
dissatisfied follow-up requests when it was absent. Tier B offline, Tier A-shaped
online. The effect sizes on the outcome that matters are small, and the interesting
structure is the conditioning: the benefit concentrates in large codebases — the same
conditioning VEXP reports for long sessions.

**Augment Code — a cross-product comparison presented as a context result.** 731
SWE-bench Pro tasks: Auggie 51.80%, Cursor 50.21%, Claude Code 49.75% (all Opus 4.5),
Codex 46.47%. The blog attributes the gap to "what context the agent sees before it
starts writing code". Augment states the Cursor and Claude Code arms were run by them
in an identical harness, which is better provenance than VEXP's projections. But
Auggie, Cursor and Claude Code are three *different agents*, not one agent with a
module toggled: the differences include the system prompt, tool surface, context
manager and repair loop. **No with/without context-engine ablation of the same agent is
reported.** Tier D; 15 and 17 problems out of 731 with no significance testing.

**Aider — documented mechanism, no isolating ablation.** The tree-sitter + PageRank
repo map is one of the best-documented I1 implementations in public. Searched; no
published ablation isolates its contribution from the rest of the Aider stack. Negative
evidence recorded as such.

**Claude Code — the documented counter-position.** No persistent repository index;
vector search was removed in 2025 in favour of just-in-time agentic retrieval with
glob/grep/read, plus context files loaded up front. The design position is directly
documented; the accompanying "outperformed everything. By a lot." is an unquantified
vendor assertion and is graded Tier F. Structurally, Claude Code's `PreToolUse`,
`PostToolUse` and `Stop` hooks are the seam every scaffold intervention in this audit
uses — VEXP's Grep denial, VEXP's stop-time completion check, and VTRACE's own M170
transparent mediation all sit on it.

**Live-SWE-agent, OpenHands, Sonar Foundation — cited here only as scaffold evidence.**
Their numbers in VEXP's table are projections of their own full-500 submissions.
Live-SWE-agent's paper (arXiv:2511.13646) is the decisive item: it starts from a
bash-only minimal scaffold and evolves its own implementation at runtime, reporting
77.4% on SWE-bench Verified. Whatever produced that number, it is not "the same
experiment with a different context layer".

**ContextBench — the most important academic finding for VTRACE.**
arXiv:2602.05892v3 (Nanjing University; UCL), 1,136 tasks, 66 repositories, 8
languages, human-verified gold contexts across 23,116 code blocks; five agents, four
frontier models. The conclusion: agents *do* retrieve gold context at intermediate
steps and then fail to carry it into final patch generation — "many gold contexts
successfully retrieved at intermediate steps are not incorporated into the final
reasoning process" — so **retention and consolidation, not retrieval, is the primary
bottleneck**. And: "sophisticated agent scaffolding does not necessarily improve
context retrieval performance". Tier C. This is an independent, large-n restatement of
M185's finding that failures occurred despite decisive evidence already on screen.

**Context files — two independent ablations, both null on correctness.**
ETH Zurich / LogicStar.ai (arXiv:2602.11988, 438 instances, four agent/model pairs,
arms none / LLM-generated / human-written): LLM-generated context files score −3% on
AGENTbench and −0.5% on SWE-bench Lite; human-written +4% on AGENTbench; inference cost
+19–23% in every arm. Their conclusion: context files "tend to *reduce* task success
rates compared to providing no repository context, while also *increasing inference
cost* by over 20%". Khatri (arXiv:2607.27250, 291 runs, Claude Code with Sonnet 4.6 and
Codex with GPT-5.5, arms none / always-on / selective): correctness differences ≤2.3pp
and ≤5.9pp, omnibus permutation *p* = 1.00 and *p* = 0.66; efficiency effects only
(selective cut cache-creation tokens, *p* = 0.012); and the failure analysis found
tasks failed on "implementation skill — feature design, pattern selection, exact wiring
— not missing repository knowledge", with a manipulation probe confirming the real
AGENTS.md never converted a near-miss failure into a pass. Both Tier B.

**TDAD — the only controlled evidence for a diff-derived obligation.**
arXiv:2603.17973v2 (Universidad ORT Uruguay; DC/UBA), 2026-03-19. Builds a
source-to-test dependency map, and before the patch is committed hands the agent the
tests its change put at risk — delivered as a static text file the agent greps, with no
graph database or MCP server at runtime. Phase 1, 100 SWE-bench Verified instances,
Qwen3-Coder 30B at 4-bit, three prompt configurations:

| Metric | Vanilla | TDD prompt only | TDAD (map + TDD) |
|---|---:|---:|---:|
| Resolution rate | 31% | 31% | **29%** |
| Generation rate | 86% | 75% | 74% |
| P2P failures | 562 | 799 | **155** |
| Test-level regression | 6.08% | **9.94%** | **1.82%** |
| Instance-level regression | 30.2% | 33.3% | **33.3%** |
| Catastrophic instances | 3 | 5 | 1 |

Read this carefully, because the abstract's framing and the table's content differ in
an important way. Test-level regression fell 70%. **Resolution fell two points**, which
the authors attribute to a higher empty-patch rate (26% vs 14%) — "the agent abstained
more often when the test map indicated risk" — and they note that among patches actually
generated, the TDAD arm was no less likely to resolve. **Instance-level regression got
slightly worse.** So the intervention reduced the *severity* of regressions, not their
*incidence*, and did not buy resolution. Phase 2 (resolution 24% → 32%) changes the
model *and* the agent framework simultaneously on n = 25, and does not isolate anything.
No significance testing anywhere. Both models are 4-bit quantized locals with 31% and
24% baselines; generalisation to frontier-scale agents is unestablished.

The paper's second result is arguably the more transferable one, and the authors name
it the **TDD Prompting Paradox**: adding procedural instructions to do test-driven
development *without* telling the agent which tests to check raised regressions from
6.08% to 9.94% — worse than doing nothing. A mandate without a specific obligation is
not a weak intervention; it is a harmful one.

---

## F. Cross-system matrix

Blank-looking cells are answers, not gaps: `no` means established, `unknown` means we
could not establish it.

| System | Intervention | Timing | Automatic? | Uses current diff? | Uses validation state? | Changes agent scaffold? | Causal tier | Demonstrated outcome effect? |
|---|---|---|---|---|---|---|---|---|
| **VTRACE M183** | I1 one-shot orientation | task start | yes | no | no | no | **A** | **no** — 19/30 vs 19/30, McNemar p=1.000 |
| **VEXP benchmark** (1.2.29, Mar 2026) | I7a+I7b mandate & Grep/Glob denial; I2 available | repo setup; tools on demand | scaffold yes, tools no | no | no | **yes** | **D** | no isolated effect; treatment fired on 5/100 |
| **VEXP product** (3.0.1, Aug 2026) | I1 default; I3 ambient; I2, I4, I5, I6, I8 opt-in | turn zero; per prompt; pre-finalization | I1/I3 yes, rest agent-invoked | **yes** (verify_done, working tree) | **yes** (impacted tests) | context file + hooks | **claimed A/B, unreleased** | claimed 24/25 vs 22/25; 2 discordant pairs → p≈0.5 |
| **SuperCoder** (arXiv:2606.22417) | I2 on-demand index + graph | on demand | no | no | no | no | **B** | **yes** — 50.4% vs 41.9%, p=0.003 (vs grep harness +6.0pp, p=0.087) |
| **Cursor** | I2 semantic search | on demand | no | no | no | no | **B / A-shaped online** | **yes, small** — +12.5% offline QA accuracy; +0.3% retention, +2.6% on >1000-file repos |
| **Augment Code** | I1/I2 context engine | before writing code | not publicly documented | not publicly documented | not publicly documented | own agent | **D** | not isolated — cross-product, 1.6pp over Cursor |
| **Aider** | I1 repo map | task start, refreshed | yes | no | no | no | **unknown** | **no published isolation** |
| **Claude Code** | I0 + I7b context files; hooks as a seam | just-in-time | context files yes | no | no | own scaffold | **F** for the efficacy claim | not quantified publicly |
| **TDAD** (arXiv:2603.17973) | I5 + I6 diff-derived test obligations | before commit | agent-invoked via grep of a static map | **yes** | **yes** | skill file | **B** | **regression yes** (6.08%→1.82%); **resolution no** (31%→29%) |
| **ContextBench** (arXiv:2602.05892) | diagnostic, no intervention | n/a | n/a | no | no | no | **C** | n/a — finds retention, not retrieval, is the bottleneck |
| **AGENTS.md studies** (2602.11988, 2607.27250) | I7b context files | every turn or on demand | yes | no | no | yes | **B** | **no** — ≤±4pp, p=1.00/0.66; cost +19–23% |
| **Live-SWE-agent / OpenHands / Sonar** | I7 scaffold engineering | continuous | yes | not publicly documented | varies | **yes, wholly** | **D** | scaffold effects not decomposed |

---

## G. Causal-chain audit

Each arrow graded separately, so that a chain is never inherited as proven from a
plausible first step.

| Claim | Step | Evidence | Verdict |
|---|---|---|---|
| Better initial context lowers cost | context reduces early search | M183 (median 4 pre-edit tool calls vs 6, 1 search vs 2.5); VEXP 3.0.0 "first edit about 20 percent sooner" | **SUPPORTED** |
| " | that reduction materially lowers whole-run tokens | M183 5.26% pooled, bootstrap [−166,320, +242,363]; VEXP claims 13% context replay / 8% cost, unreleased | **PARTIALLY_SUPPORTED** |
| " | lower whole-run tokens lowers the bill | M183 −0.21% (an increase) | **UNSUPPORTED** |
| Better initial context raises resolution | orientation reaches the right files | M183 (gold delivered), M112, SuperCoder acc@5 84.5% vs 44.3% | **SUPPORTED** |
| " | reaching the right files converts to resolution | M183 19/30 vs 19/30; M185 correct focus still failed; VEXP 24/25 vs 22/25 at p≈0.5 | **UNSUPPORTED at demonstrated power** |
| On-demand repository search raises resolution | index answers better than grep | SuperCoder within-harness p=0.003; Cursor offline +12.5% | **SUPPORTED** |
| " | it beats a *competent* agentic-grep agent | SuperCoder vs OpenCode +6.0pp, p=0.087; Cursor online +0.3% overall | **PARTIALLY_SUPPORTED** (conditions on large codebases) |
| Impact analysis improves repairs | the tool finds real consumers | VEXP `get_impact_graph`; VTRACE M99/M101/M140; verify_done "dependents you left untouched (file:line)" | **SUPPORTED** (capability) |
| " | agents call it before risky edits | 0/100 calls in VEXP's published run | **UNSUPPORTED** |
| " | consumers found → correct coordinated edits | no controlled evidence found anywhere | **UNKNOWN** |
| Diff-derived test selection improves outcomes | the graph names the right tests | TDAD; VEXP 2.6.0 | **SUPPORTED** |
| " | naming them reduces regressions | TDAD 6.08% → 1.82%, n=100 | **SUPPORTED** |
| " | naming them raises resolution | TDAD 31% → 29%; instance-level regression 30.2% → 33.3% | **UNSUPPORTED** |
| Workflow mandates improve outcomes | mandate changes behaviour | VEXP hook + CLAUDE.md; M168-E adoption 12/12 | **SUPPORTED** |
| " | changed behaviour improves outcomes | M168-E 0/5 where it bound, lost 2 won 0; TDAD TDD-only 6.08% → 9.94%; 2602.11988 −3%/−0.5% at +20% cost; 2607.27250 p=1.00/0.66 | **CONTRADICTED** |
| Memory improves outcomes | memory persists and resurfaces decisions | VEXP `get_session_context` / `search_memory`, staleness on symbol change | **SUPPORTED** (capability) |
| " | it affects benchmark resolution | 0 memory-tool calls in VEXP's published run; no ablation anywhere | **UNKNOWN** |
| Completion checking improves outcomes | the check finds real incompleteness | verify_done (parse errors, broken imports, untouched dependents) | **SUPPORTED** (mechanism) |
| " | the finding converts to a fixed patch | vendor moved it to opt-in on turn-cost grounds; no released ablation | **UNKNOWN** |

---

## H. Current-diff / post-edit findings

**Q5, directly: yes, two audited systems reason over the current change, and only two.**

`DIFF_AWARE_PRODUCT_LOOP`:
- **VEXP `verify_done`** (2.5.0+). Consumes the **current working tree**, not a
  committed diff. Derives files that no longer parse; imports of names that no longer
  exist (partial renames); dependents referencing changed symbols that were left
  untouched, with `file:line`; task constraints violated (files the task forbade
  touching, artifacts it promised); and the impacted test files. Timing: BEFORE
  FINALIZATION. Agent-invoked by tool call; *automatic* in Claude Code via a stop-time
  check that "challenges provably incomplete work once … and never blocks a clean
  stop". Default state as of 3.0.0: **opt-in**, behind `vexp setup --interventions`.
- **TDAD.** Consumes the git diff and changed symbols; derives at-risk tests; timing
  before commit; agent-invoked by grepping a static map.

`NO_DIFF_AWARENESS`, in the agent's coding loop: Cursor, Augment, Aider, Claude Code,
SuperCoder, and every research system audited. Cursor and GitHub ship diff-aware code
*review* products; those act on a pull request after the fact, not inside the coding
agent's decision loop, and are out of scope for this question.

`UNKNOWN`: Sourcegraph, Cody, OpenHands, Sonar Foundation.

**VTRACE: `NO_DIFF_AWARENESS`.** Every VTRACE intervention through M187 keys on the
task text and the base tree. Nothing in the product consumes the agent's own edits.

---

## I. Validation and edit-set findings

**Q6 — coordinated edit sets.** Only `verify_done` derives them as an *obligation*
rather than as adjacency: "dependents referencing symbols you changed but left
untouched (file:line)" is the diff-conditioned form, and it is different in kind from
VTRACE's co-edit lanes (M97/M98/M99), which rank likely co-edits at *task start* from
the base tree. The distinction M188 exists to draw: VTRACE predicts what will probably
be edited together; verify_done reports what demonstrably was not. The first is a
retrieval bet; the second is a check against evidence that exists only after the agent
acts. No controlled outcome evidence exists for either.

**Q7 — validation obligations.** VEXP 2.6.0 maps changed symbols to test files through
the dependency graph, plus an import scan for suites the graph cannot see, and
distinguishes "run me" from "UPDATE me, never run me" for shared test infrastructure.
TDAD does the same derivation and is the one with numbers. Everyone else, including
VTRACE, does no more than let the agent run tests.

Against the §18 checklist:

| Question | VEXP 2.6.0+ | TDAD | Everyone else audited |
|---|---|---|---|
| Identifies relevant tests | yes | yes | no |
| Maps changed symbols to tests | yes | yes | no |
| Prioritises tests | not documented | yes (top-K by impact score) | no |
| Interprets failure output using graph evidence | no | no | no |
| Uses test outcomes to update repository context | no | no | no |
| Blocks finalization when validation is missing | only in opt-in run mode, and only on an actual failure | no | no |
| Merely says "run tests" | — | — | yes |

**One caveat that M187 forces us to state, and it cuts against acting on any of this.**
M187 established that in M183's 60 arms, a test runner started in 5. Fifty-five arms
never executed a test suite, and in nine of those the agent tried and the environment
prevented it. Whatever validation intelligence is worth, **the preserved VTRACE corpus
cannot witness it**, because the lifecycle it would intervene in was absent from the
experiment. This is not a reason the mechanism is uninteresting. It is a reason the
§34 threshold cannot currently be evaluated for it.

---

## J. Implications for VTRACE

Only what the evidence supports.

**1. VTRACE is not behind on capability.** Every I1/I2 mechanism the competitors ship
has a VTRACE counterpart: symbol graph, calls/imports/refs, impact graph, logic-flow
machinery, skeletonization, docs/config indexing, cross-repo foundations, bounded
deterministic delivery. `NO_EVIDENCE_OF_COMPETITOR_ADVANTAGE` on retrieval mechanism.
Where VTRACE differs is projection, not substrate.

**2. The one-shot orientation hypothesis is now weakened from two directions, and
converged on from a third.** M183 measured it and found no outcome effect. Two
independent academic ablations of context injection find null correctness effects at
+20% cost. And the competitor that markets orientation hardest ran the paired
experiment, got 24 against 22 on 25 tasks, and reorganised its defaults around
subtraction. Nothing external revives I1 as an outcome lever.

**3. VTRACE's strongest untested asset is the projection it does *not* currently
make.** M184 established materialization authority; M180/M181 established item and
reason ownership; M147 established presence proof over all enabled members; M140
established module-scope import ownership. That machinery answers "what does this
change touch" as readily as "where should I look first" — and the audit found that the
second projection is the one everyone builds and the first is the one almost nobody
does. `VTRACE HAS EQUIVALENT INFRASTRUCTURE BUT DIFFERENT PRODUCT PROJECTION` is the
accurate category, and it is the only category in §24 where the audit found a gap.

**4. The measured effect of diff-derived obligations is on the wrong axis for
SWE-bench.** TDAD's evidence is for regression rate, and TDAD's resolution went *down*.
If VTRACE pursued this class, the honest primary outcome would be regressions and
incomplete edit sets, not resolution — and SWE-bench Verified's `PASS_TO_PASS` set
already carries that data unscored. That is a real, cheap, available measurement. It is
also a different product claim from the one VTRACE has been chasing.

**5. Two external findings say the binding constraint may be downstream of anything
VTRACE can deliver.** ContextBench: agents retrieve the gold context and then fail to
condition on it. Khatri: failures were implementation skill, not missing repository
knowledge. Both are independent restatements of M185. If retention and consolidation
are the bottleneck, neither better retrieval nor more of it is the lever, and no
audited system has an intervention for it.

**6. Do not build I7.** The evidence against mandates is now the strongest negative
result in this audit: VTRACE's own M168-E (0/5 where it bound, lost 2 won 0), two
context-file ablations (null correctness, +20% cost), TDAD's TDD Prompting Paradox
(6.08% → 9.94%), and VEXP abandoning its own hook in 2.4.0. Four independent lines.

---

## K. Phase-2 recommendation

**`SPECIFIC_INTERVENTION_CLASS_WORTH_INVESTIGATING`** — I5/I6, diff-derived validation
and edit-set obligations — **with a named blocker that must be resolved before any
counterfactual discovery can test it.**

The class earns investigation because it is the only one in this audit that is
simultaneously (a) supported by a controlled external ablation on a real outcome
variable, (b) absent from VTRACE, and (c) built on infrastructure VTRACE already owns
and has proven authoritative. It is *not* licensed for implementation, and M188 could
not license it in any case (§33).

The blocker is M187's. The §34 threshold requires a successful-side witness in the
preserved failure traces. In M183's corpus, 5 of 60 arms ever started a test runner.
A mechanism that intervenes between edit and validation cannot have a witness in a
corpus where validation did not happen. **Phase 2B, run against the M183/M185 traces as
they stand, would return "no witness" for this class for a reason that has nothing to
do with whether the mechanism is real.**

So the ordering matters, and it is not the ordering the strategic reset assumed:

1. Phase 2B may still proceed against the preserved traces for the mechanisms those
   traces *can* witness — wrong-logic failures, evidence-on-screen non-use (which
   ContextBench now corroborates at n=1,136), and incomplete edit sets, which *are*
   visible in a final patch without needing a test to have run.
2. Any investigation of validation obligations specifically requires the per-task
   dependency environments M187 identified as the open infrastructure work. That is a
   benchmark-infrastructure milestone, not a product one, and it is the prerequisite.

If neither is undertaken, the correct standing conclusion is the narrower one, and it
should be recorded plainly: **external evidence does not license a new VTRACE
intervention.** It identifies one class worth a look and it removes any basis for
believing VTRACE is missing something its competitors have proven.

---

## Required explicit conclusions

**Q1 — Does VEXP have a public same-agent off/on causal ablation?**
`PARTIAL_ABLATION_ONLY`. The published SWE-bench benchmark has none, though the harness
ships a complete `--no-vexp` seam. The 3.0.0 changelog (2026-08-27) claims one — 25
SWE-bench Pro tasks, same agent, same model, same day, paired, 24/25 vs 22/25 — with no
released artifacts and a resolution effect of two discordant pairs (exact two-sided
McNemar *p* = 0.5).

**Q2 — Does VEXP's published SWE-bench result isolate repository context?**
**No.** Three of the four arms were never run by that harness; 72/70/70 are
set-intersections of other parties' published full-500 resolvedIds with VEXP's 100-task
subset, reproduced exactly by our script. The $3 and 250-turn budgets bound only the
VEXP arm. Live-SWE-agent rewrites its own scaffold at runtime. "The only variable was
the context layer" is contradicted by files in the same repository.

**Q3 — What interventions does VEXP actually use during the coding lifecycle?**
At benchmark time: I7a (Grep/Glob denial, conditional on daemon health), I7b (a written
mandate), and I2 availability. **No I1 whatsoever** — the prompt carries no repository
context. Currently: I1 as the default, I3 ambient per-prompt orientation (capped at
three per session, re-injected after compaction), and I2/I4/I5/I6/I8 present but
**opt-in since 3.0.0**.

**Q4 — Observed in traces, or merely available?**
**Merely available**, decisively. 5/100 tasks called any vexp tool; 95/100 called none;
79/100 used the forbidden native search; `vexpMetrics` null 100/100; zero calls to
impact, flow, skeleton or memory tools. And the two tool spellings that do appear match
neither the committed MCP server key nor each other.

**Q5 — Any current-diff-aware repository reasoning?**
**Yes, two:** VEXP `verify_done` (current working tree) and TDAD (git diff). Everything
else audited is base-tree only. VTRACE included.

**Q6 — Any coordinated edit sets or behavioural obligations?**
**Yes:** `verify_done` derives untouched dependents of changed symbols with `file:line`,
plus task-stated constraints (forbidden files, promised artifacts). Distinct in kind
from task-start co-edit prediction. No controlled outcome evidence.

**Q7 — Any validation obligations derived from the current change?**
**Yes:** VEXP 2.6.0 (changed symbols → test files via the graph plus an import scan,
with run-me/update-me discrimination) and TDAD (top-K tests by impact score). No other
audited system does more than permit the agent to run tests.

**Q8 — Controlled evidence that any such intervention improves resolution or cost?**
For **I2**: yes — SuperCoder 50.4% vs 41.9%, *p* = 0.003, n = 80 paired, same harness,
baseline keeps grep; qualified by +6.0pp at *p* = 0.087 against an independent
agentic-grep harness. Cursor: +12.5% offline QA accuracy, +0.3%/+2.6% live retention.
For **I5/I6**: yes on **regressions** (TDAD 6.08% → 1.82%), **no on resolution**
(31% → 29%, instance-level regression 30.2% → 33.3%). For **I1 alone**: none found.
For **I7**: contradicted, four independent lines. For **I3** and **I8**: none found.

**Q9 — Does external evidence materially contradict M183/M185?**
**No.** M183 is corroborated by two independent context-injection ablations and by
VEXP's own paired experiment, which is the same design at the same power with the
opposite sign on two tasks. M185 is corroborated by ContextBench (n = 1,136:
retention, not retrieval, is the bottleneck) and by Khatri's failure analysis. The one
external result that goes beyond M183 — SuperCoder's index ablation — has its own
cross-harness comparator land at *p* = 0.087, which is the M183 comparison.

**Q10 — Which class justifies Phase 2B?**
**I5/I6, diff-derived validation and edit-set obligations** — the only class with a
controlled external result on a real outcome, absent from VTRACE, and buildable on
infrastructure VTRACE has already proven authoritative. Subject to the M187 blocker:
the preserved corpus cannot witness it, because 55 of 60 arms never ran a test.

---

## Final intervention verdicts

| Class | Verdict | Basis |
|---|---|---|
| **I1** one-shot orientation | **CONTRADICTED_OR_WEAKENED** | M183 null; two context-file ablations null at +20% cost; VEXP's own paired 24/25 vs 22/25 at p≈0.5; behavioural gains real and non-converting on both sides |
| **I2** on-demand repository intelligence | **EXTERNALLY_CAUSALLY_SUPPORTED** | SuperCoder p=0.003 within harness; Cursor offline and live A/B — with the standing qualification that against a competent agentic-grep baseline the margin is p=0.087 and conditions on codebase size |
| **I3** continuous / adaptive injection | **INSUFFICIENT_PUBLIC_EVIDENCE** | VEXP ships it, runs a field measurement control group, publishes no result |
| **I4** post-edit repository analysis | **EXTERNALLY_PLAUSIBLE_ONLY** | verify_done's mechanism is documented and real; no released ablation; demoted to opt-in by its own vendor on turn-cost grounds |
| **I5** validation guidance | **EXTERNALLY_CAUSALLY_SUPPORTED, on regressions only** | TDAD 6.08% → 1.82% on n=100 — and 31% → 29% on resolution. The outcome axis is not the one SWE-bench scores |
| **I6** completion / edit-set checking | **EXTERNALLY_PLAUSIBLE_ONLY** | mechanism documented with file:line evidence; no isolating experiment found |
| **I7a** tool deprivation | **CONTRADICTED_OR_WEAKENED** | M168-E lost 2 won 0; VEXP withdrew its own hook in 2.4.0 |
| **I7b** instruction / mandate | **CONTRADICTED_OR_WEAKENED** | 2602.11988 (−3%, +20% cost), 2607.27250 (p=1.00/0.66), TDAD TDD Prompting Paradox (6.08% → 9.94%) |
| **I8** durable memory | **NO_SUPPORT_FOUND** | capability documented; zero calls in the one public benchmark run; no ablation |

---

## Verification

Run as repository-integrity checks. One new benchmark script was added
(`run_stage5_m188_vexp_artifact_audit.ts`); no product source was touched.

```text
bun run typecheck                PASS
bun run typecheck:benchmarks     PASS
bun test                         PASS
git diff --check                 clean
live SWE-bench agents            NOT RUN
Docker evaluations               NOT RUN
model/API spend                  $0.00
functional commit                21940f6ac0bbee142262a1f52caa2507fa344ae8
```

---

## Scope statement

No VTRACE product behaviour was changed. Retrieval, ranking, orientation, graph
semantics, indexing, agent prompts, workflow policy and benchmark behaviour are all
untouched. No live VTRACE utility benchmark was run. M188 does not authorize a new
agent-facing intervention, and under §33 it could not: external evidence can make an
intervention worth testing against VTRACE's own failures; it cannot license building
one.
