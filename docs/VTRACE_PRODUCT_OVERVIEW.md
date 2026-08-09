# VTRACE — Product Overview (End to End)

A plain-language tour of what VTRACE *is* and how it works, from a repository on
disk to the context an agent receives. No benchmark machinery, no milestone
history — just the product. File references (`path:line`) are anchors you can jump
to, not required reading.

---

## 1. The one-sentence product

**VTRACE reads a codebase once, builds a deterministic map of its symbols and how
they relate, and — for any task you describe — hands back the *smallest useful slice
of code* to work on, instead of whole files or broad grep dumps.**

The point is token economy for coding agents: give the model the two or three
functions that actually matter for the task, up front, so it spends fewer turns
hunting. Everything else in the product exists to make that one answer accurate,
bounded, and inspectable.

It is **structural, local, and deterministic**:
- *Structural* — it works from the parsed AST (symbols + edges), not runtime traces
  or fuzzy guessing.
- *Local* — the whole index lives in `.vtrace/index.sqlite` in your repo; nothing is
  sent to a remote service.
- *Deterministic* — the same repo + same query gives the same answer, every time.

---

## 2. The three surfaces

You reach the same engine three ways:

| Surface | How | Who uses it |
| --- | --- | --- |
| **CLI** | `vtrace <command> <repo> …` (`src/cli/index.ts`) | humans, scripts |
| **MCP server** | `vtrace mcp-serve` exposes tools to Claude Code / Codex (`src/mcp/server.ts:41`) | coding agents |
| **VS Code** | private/local extension wrapping the CLI | editor users |

The MCP surface is the one agents use in practice. The headline tool is
**`get_code_context`** (alias of `run_pipeline`); narrower tools —
`get_context_capsule`, `get_impact_graph`, `get_skeleton`,
`search_logic_flow`, `search_memory` — answer more specific questions. All 19 tool
IDs live in `src/mcp/types.ts:11`; definitions in `src/mcp/tools.ts`.

---

## 3. The core pipeline

Every "give me context for this task" request runs the same pipeline. The authors
state it at the top of `src/capsuleV2/types.ts`:

```
task signals → intent detection → candidate generators → evidence scorecards
             → pivot / support / discard roles → budget allocator → renderer
```

Concretely, a request flows like this:

```
your query ("fix the N+1 in session creation", plus optional failing test / hints)
   │
   ▼
① INTENT        what kind of task is this?            src/runPipeline/selectIntent.ts:41
   │            debug / refactor / modify / explain / impact / test-failure
   ▼
② RETRIEVAL     which symbols could be relevant?      src/retrieval/hybridRetrieval.ts:143
   │            6 search strategies, pooled + scored
   ▼
③ PIVOTS        which 1–2 are the real edit target?   src/capsule/assignCandidateRoles.ts:61
   │            everything else becomes "support" or is discarded
   ▼
④ CAPSULE       render pivots to fit a token budget   src/capsuleV2/buildCapsule.ts
   │            full source → signature → skeleton, greedily
   ▼
⑤ DIGEST        a compact action-map + optional        src/capsuleV2/productAdapter.ts:516
   │            "make a decision on each target" contract
   ▼
the agent receives a small, structured context block
```

The orchestrator that runs these stages (plus memory and rules, below) is
`runPipelineOrchestrator` (`src/runPipeline/runPipelineOrchestrator.ts:316`). The
CLI equivalent is `runCapsuleCommand` (`src/cli/commands/capsuleCommand.ts:95`),
invoked as `vtrace capsule <repo> "<query>" --intent auto --budget 8000 --json`.

The next sections walk each stage.

---

## 4. Stage 0 — Indexing (building the map)

Before any query, VTRACE indexes the repo. This happens on `vtrace setup <repo>` (or
`vtrace index`), and refreshes when files change.

**What it does** (`indexProject`, `src/indexer/indexProject.ts:38`):
1. **Walk the tree** — `scanRepo` (`src/fs/scanRepo.ts:55`) recursively lists files,
   skipping the obvious noise (`.git`, `node_modules`, `dist`, `__pycache__`,
   `.venv`, `vendor`, …) and honoring `.gitignore` / `.ignore` / `.vtraceignore`.
2. **Parse each file** into symbols + relationships. One parser per language
   (dispatch in `src/parsers/LanguageParser.ts:23`):
   - **TypeScript / JavaScript** — functions, classes, interfaces, type aliases, methods.
   - **Python** — runs a CPython `ast` subprocess; functions, classes, methods,
     module-level constants/vars/aliases.
   - **Cython** — Python-plus-typed, with `cimport` / `.pxd` support.
3. **Store it** in `.vtrace/index.sqlite`.

**What's in the map.** Symbols (`SymbolKind`: Function, Class, Method, Interface,
TypeAlias, ModuleConstant, ModuleVariable, ModuleAlias) and edges between them
(`EdgeType`): **Contains** (class→method), **Imports**, **Calls**, **References** —
each with a `[0,1]` confidence. Plus **body literals**: distinctive strings pulled
from symbol bodies (diagnostic codes like `TS2345`, error messages) so a bug report
that quotes an error can be traced back to the code that raises it
(`extractBodyLiterals.ts:127`).

**Storage.** Tables `files`, `symbols`, `edges` (+ run-history tables); two FTS5
full-text indexes `symbol_search_fts` and `symbol_body_literals_fts` power fast
lexical lookup. Schema in `src/db/schema.ts`.

**Staying fresh.** `checkIndexFreshness` (`indexMeta.ts:163`) fingerprints the index
against six things — including a hash of the parser code and git HEAD — so any change
that would alter parsing invalidates the index. Deleted files are pruned with their
symbols/edges (`pruneRemovedFiles`, `indexProject.ts:344`). `vtrace watch` marks the
index stale on change; auto-reindex is opt-in.

> **Boundary:** the map is what the parser can see statically. `Calls` edges exist
> for Python/TS/Cython; a repo in another language still indexes symbols but reports
> no call flow rather than guessing.

---

## 5. Stage 1 — Intent (what kind of task is this?)

`selectRunPipelineIntent` (`src/runPipeline/selectIntent.ts:41`) classifies the query
into one of a small set of intents — **debug, refactor, modify, explain, impact,
test-failure** — using phrase triggers plus a classifier, defaulting to a general
"explore". The caller can also declare an intent explicitly (`--intent debug`);
`auto` lets VTRACE decide (`CapsuleIntent`, `src/capsuleV2/types.ts:23`).

Intent shapes the rest of the pipeline: a *debug* task leans on failing-test and
traceback evidence; an *impact* task turns on the dependency-graph section; an
*explain* task favors breadth over a single edit target.

---

## 6. Stage 2 — Retrieval (which symbols could matter?)

This is where a prose query becomes a ranked list of code. `hybridRetrieve`
(`src/retrieval/hybridRetrieval.ts:143`) runs **six independent search strategies**
and pools their hits — the idea being that no single strategy finds everything:

1. **Lexical** — full-text match of query terms against symbol names/signatures/docs.
2. **Symbol / path** — symbols and files the query names or implies.
3. **Failing-test** — from a failing test, follow imports/calls to the implementation.
4. **Body-literal** — match distinctive task strings (error codes/messages) to the
   symbol source that contains them.
5. **Graph expansion** — bounded BFS (≤2 hops, capped) over the neighbors of hits so far.
6. **Same-module** siblings.

**Scoring.** `combineFinalScore` (`hybridScoring.ts:162`) blends the signals with
fixed weights — test→implementation (1.3) and body-literal (1.4) are the strongest,
raw centrality (0.5) the weakest (a symbol being "popular" never wins on its own).
Two penalties fire before ranking, and they encode hard-won judgment about what goes
*wrong*:
- **Hub penalty** — a framework root like Django's `Model` (thousands of dependents)
  would otherwise dominate every query; it's stripped of graph/centrality boost
  unless there's local evidence it's the real target.
- **Actionability penalty** — a module-level config constant is rarely where you
  edit; it loses graph/domain boost without direct evidence.

Other guards handle *symptom latch* (`IndexError` shouldn't drag in every symbol with
"index" in its name) and *generic-word over-ranking* (matching only on a common word
gets down-weighted 0.25×).

---

## 7. Stage 3 — Pivots (the heart of the product)

Retrieval gives a ranked pile. The product's real value is deciding **which one or
two are the actual place to make the change** — the *pivots* — and demoting the rest.

`assignCandidateRoles` (`src/capsule/assignCandidateRoles.ts:61`) labels every
candidate **pivot / support / discard**. A candidate earns *pivot* only if it clears
a deliberately strict bar:
- it's **actionable** (a function/method/class you can edit, not a bare module var),
- it has **direct evidence** (a symbol/path/test→impl hit, or a strong lexical match),
- it has enough **local evidence** overall,
- it isn't **hub-penalized** and isn't a framework hub.

If the runner-up is within 85% of the leader, that's flagged as *ambiguity*
(`detectPivotAmbiguity`, line 95) — the honest "I'm not sure which of these two"
signal. The default is **one** pivot: VTRACE would rather hand you one confident
target than a vague pile.

An optional **confidence gate** (`classifyDigestPivotConfidence`,
`digestDecisionContract.ts:291`) goes further: it keeps a pivot marked *required*
only when the evidence is genuinely strong (a source-line anchor, exercised by a
failing test, a direct call/import edge, …). Weak evidence (name-match only, a
facade/wrapper, a test file for a non-test issue) gets demoted to *optional*. If
*everything* demotes, VTRACE says so explicitly with a "no high-confidence required
target" marker rather than pretending it found one.

---

## 8. Stage 4 — The capsule (what gets returned)

`buildCapsule` (`src/capsuleV2/buildCapsule.ts`) turns the roles into the
actual returned object, a `CapsuleV2Result`:

- **`pivots[]`** — the edit targets, with `path`, `symbol`, a `roleReason` (why it was
  chosen), and an estimated token cost.
- **`support[]`** — nearby context worth seeing but not the edit site.
- **`discarded[]`** and **`diagnostics`** — what was rejected and why (this is what
  makes the answer inspectable).

**Fitting a budget.** The capsule has a token budget (default 8,000). Each pivot is
rendered on a **ladder** — full source → signature only → skeleton (name only) — and
VTRACE greedily picks the richest rung that still fits. The lead pivot is *always*
rendered at least as a skeleton; support items are dropped first when space runs out.
The budget also sets a tier (`allocateBudget`, `budgetAllocator.ts:49`): **micro**
(<1.5k tokens → 1 pivot), **standard** (→ 2 pivots, 4 support), **full** (→ up to 5
pivots, 10 support). If nothing clears the pivot bar, the capsule comes back
**intentionally empty** rather than padded with noise.

**Truncation that protects the answer.** If the rendered context exceeds the char
budget, `truncateContextByPriority` (`sectionBudgetAccounting.ts:358`) drops whole
*non-essential* sections first (diagnostics, then optional scaffolding), always
preserving the essential pivot source. It never blindly head-slices the pivot
neighborhood away.

---

## 9. Stage 5 — The digest (an action map, not just code)

On top of the capsule, VTRACE can emit a **compact digest** — a short,
bounded action-map — so the agent gets a plan, not just a code dump
(`renderCapsuleV2Digest`, `productAdapter.ts:516`). The query is trimmed to a
head/tail excerpt and each item's reason collapsed to one line, so a giant issue body
can't crowd out the useful part.

Optionally it attaches a **decision contract**
(`buildDigestDecisionContract`, `digestDecisionContract.ts:589`): for each target it
asks the agent to record an explicit decision — **EDIT / RULE_OUT /
INSPECT_ONLY_NO_EDIT** with a reason. This closes the loop: the agent has to
consciously accept or reject each pivot instead of silently ignoring it. When
bounded, it's capped at 4 targets (lead pivot → a hidden co-pivot → up to 2 cross-file
"impact" representatives).

**Impact representatives** are cross-file dependents of the pivot (things that would
be affected by the change). They're deliberately **optional / FYI** — useful to see,
but never presented as a reason to edit, because in practice they almost never *are*
the edit.

---

## 10. The other structural queries

Beyond the capsule, VTRACE answers three focused structural questions directly —
each is also an MCP tool and a CLI command:

- **Skeleton** (`vtrace skeleton <file>` / `get_skeleton`, `src/skeleton/getSkeleton.ts:102`)
  — the AST outline of a file: its imports, exports, top-level declarations, and class
  members, at a chosen detail level. Use when you already know the file.

- **Impact graph** (`vtrace impact-graph <symbol>` / `get_impact_graph`,
  `src/impact/getImpactGraph.ts:138`) — "what breaks if I change this?" A reverse-
  dependency tree: everything that calls/references/contains the target, out to depth
  N, with the edges labelled. Answers blast-radius / callers / dependents.

- **Logic flow** (`search_logic_flow`, `src/logicFlow/searchLogicFlow.ts:143`) — the
  bounded static path(s) between **two exact symbols** over Contains/Imports/Calls
  edges. It reports *coverage* honestly: if call-flow evidence wasn't available it
  says so rather than implying it traced execution. This is structure, not a runtime
  trace.

---

## 11. Memory — how VTRACE gets better within and across sessions

VTRACE keeps a lightweight, repo-local memory so context improves over time.

**Observations** (`src/observations/`) are timestamped notes attached to the repo (and
optionally a session): decisions, insights, warnings, dead-ends, and auto-captured
tool results, each linked to the files/symbols involved. An agent writes them with
`save_observation`; they're recalled with `search_memory` (`searchMemory.ts:36`) and
`get_session_context` (`getSessionContext.ts:21`), which rank by relevance to the
current query/files. The pipeline folds relevant memory into the context block
automatically.

**Staleness** — if a later index run modifies or deletes the files/symbols an
observation was about, it's flagged stale (`src/observations/staleness.ts`) so old
notes don't mislead.

**Compression** — inactive sessions are consolidated: repeated tool-call notes are
pruned into a single durable summary (`compressInactiveSessions`,
`sessionLifecycle.ts:129`), keeping memory small and signal-dense.

**Project rules** (`src/projectRules/projectRules.ts`) are the learned layer: when the
same kind of evidence shows up in the same scope enough times (default ≥3), VTRACE
proposes a *candidate rule* ("before editing X, check Y"). Promote it to *active* and
it gets surfaced on relevant future queries; reindexing marks it stale if its scope
moved. Confidence tiers (high/medium/low) track how well-grounded a rule is.

---

## 12. Continuity — handoff and V-REFs

Two features move context *between* tools or turns without recomputation:

- **Handoff** (`vtrace handoff`, `src/handoff/buildHandoff.ts:68`) serializes a whole
  pipeline result — query, intent, capsule, memories, provenance, trust metadata —
  into a portable JSON payload another tool/session can pick up.

- **V-REFs** (`src/runPipeline/deferredVexpStore.ts`) are short 12-hex handles to a
  deferred payload (a capsule, impact graph, flow, or memory block) that the pipeline
  published. Instead of inlining a big blob, a response can reference it by hash; a
  downstream tool calls `expand_vexp_ref` to fetch the exact stored payload
  (`expandDeferredVexpRef.ts:23`). Retention is bounded — it's an exact lookup of
  something VTRACE actually produced, never a fuzzy reconstruction.

---

## 13. Lifecycle & operations

| Command | What it does |
| --- | --- |
| `vtrace setup <repo>` | Index the repo **and** install the agent's MCP config (`initRepo`, `src/setup/initRepo.ts:25`). The normal first step. |
| `vtrace index` / `vtrace init` | (Re)build the index only. |
| `vtrace status` / `doctor` | Readiness, index freshness, memory usage, recent runs. |
| `vtrace watch` | Watch source files; mark the index stale on change (auto-reindex opt-in). |
| `vtrace daemon` | Optional background process hosting the MCP server. |
| `vtrace workspace` | Multi-repo config in `.vtrace/workspace.json` (alias → repo/db/state). |
| `vtrace claude-config` | Install/preview Claude Code or Codex MCP config. |
| `vtrace mcp-serve` | Run the stdio MCP server directly (agents usually launch this for you). |

All repo-local state lives under `.vtrace/`: `config.json`, `state.json`,
`index.sqlite`, and optional `workspace.json`. Re-running `setup` is safe and
conservative.

---

## 14. What VTRACE deliberately does *not* do

Its conservatism is a feature — it's why the outputs are trustworthy:

- **No runtime tracing / dataflow.** Everything is static, from the indexed AST.
- **No editing or evaluating code.** VTRACE supplies context; the agent makes and the
  human/CI judges the change.
- **No fuzzy architecture guessing.** `search_logic_flow` needs exact FQNs; if call
  evidence isn't there, it reports that instead of inventing a path.
- **No silent staleness.** Freshness is fingerprinted; `watch` is mark-stale by default.
- **No remote indexing.** The index never leaves the repo.

---

## 15. Putting it together — a worked example

You ask (via `get_code_context`): *"Sessions are being created twice on login — fix
the duplicate `createSession` call,"* with the failing test attached.

1. **Intent** → `debug` (phrase + failing test).
2. **Retrieval** → the failing test's imports point at `SessionManager.createSession`
   (test→impl, weight 1.3); lexical also surfaces `LoginController.handleLogin` and a
   popular `BaseController`.
3. **Pivots** → `createSession` clears the bar as the lead pivot. `BaseController` is a
   framework hub with no local evidence → **hub-penalized, discarded**.
   `handleLogin` becomes **support** (it's the caller, worth seeing, not the edit
   site).
4. **Capsule** → within 8k tokens: `createSession` rendered as full source (the edit
   target), `handleLogin` as a signature. A `roleReason` on each explains the choice.
5. **Digest** → a compact map: *EDIT `SessionManager.createSession`; INSPECT
   `LoginController.handleLogin` (caller)*, plus one FYI impact rep for a downstream
   consumer of the session.

The agent gets ~a few thousand tokens pointing straight at the two relevant
functions — instead of reading `session.py`, `login.py`, and grepping "session"
across the repo. That difference, multiplied over every turn, is the product.

---

### Where to look next in the code

- Request entry: `src/mcp/tools.ts` (MCP) · `src/cli/commands/capsuleCommand.ts` (CLI)
- Orchestration: `src/runPipeline/runPipelineOrchestrator.ts:316`
- Retrieval + scoring: `src/retrieval/hybridRetrieval.ts` · `hybridScoring.ts`
- Pivots: `src/capsule/assignCandidateRoles.ts` · `microTargets.ts`
- Capsule + digest: `src/capsuleV2/buildCapsule.ts` · `productAdapter.ts` · `digestDecisionContract.ts`
- Indexing: `src/indexer/indexProject.ts` · `src/parsers/` · `src/db/schema.ts`
- Memory: `src/observations/` · `src/projectRules/`
