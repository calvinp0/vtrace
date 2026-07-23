# VTRACE Internals — How It Works, From Tree-Sitter to Capsule

> A book-length technical explanation of VTRACE: the concepts, the algorithms, the
> data structures, and the exact flow through the code. Each chapter introduces the
> underlying idea or technology first (what a CST is, what FTS5 is, what BM25 does),
> then shows precisely how VTRACE uses it. Code anchors are `path:line`.
>
> Read it front to back and you should be able to say, truthfully: *"I built a
> local, deterministic code-context engine. It parses source with tree-sitter and
> CPython's `ast` into a symbol graph stored in SQLite; it retrieves with a hybrid of
> FTS5/BM25 lexical search and graph traversal; it ranks candidates into pivots; and
> it renders a token-budgeted capsule an agent consumes over MCP."*

---

## Table of contents

1. The problem, and the one idea
2. Foundations — the concepts and technologies
3. Indexing — turning a repository into a graph
4. The query pipeline — a map of the whole flow
5. Intent detection
6. Retrieval — hybrid search (FTS5, BM25, and the graph)
7. Pivot selection — the algorithm at the heart
8. Capsule assembly — fitting evidence into a token budget
9. The digest and the decision contract
10. The structural queries — skeleton, impact, logic-flow
11. Memory — observations, staleness, rules
12. Continuity — handoff and V-REFs
13. The MCP protocol — how an agent actually talks to VTRACE
14. Determinism, and the boundaries we chose
15. End-to-end — one query, traced through every module

---

## Chapter 1 — The problem, and the one idea

A coding agent working on a real repository has a token problem. To fix a bug it
tends to read whole files, grep for strings, and re-read the same code across many
turns. Every turn replays the growing conversation to the model. The cost is
dominated not by *thinking* but by *hauling code around*.

VTRACE's single idea: **precompute the structure of the codebase once, then, for any
task, return the smallest slice of code that is actually relevant** — ideally the one
or two functions where the edit belongs, plus just enough surrounding context to act.
Give the agent that up front and it stops hunting.

Everything in this book is in service of making that slice **accurate** (the right
symbols), **bounded** (a token budget it never blows), **inspectable** (you can see
why each symbol was chosen), and **deterministic** (same repo + query → same answer).

Three design commitments follow from that and recur everywhere:

- **Structural, not runtime.** VTRACE only knows what a parser can see statically —
  symbols and the edges between them. It never executes code.
- **Local, not remote.** The entire index is a SQLite file in `.vtrace/`. Nothing
  leaves the machine.
- **Deterministic, not heuristic-lucky.** No randomness, no clock-dependence in the
  answer. This is what makes the output trustworthy and testable.

---

## Chapter 2 — Foundations: the concepts and technologies

Before the flow makes sense, five building blocks.

### 2.1 Source code as a tree

To a computer, a source file starts life as one long string of characters. A
**parser** reads that string and figures out its grammatical structure — "this is a
function, its name is `foo`, it has two parameters, and here is its body" — and
represents that structure as a **tree**.

Take this tiny Python file:

```python
def greet(name):
    return "hi " + name
```

A parser turns it into a tree roughly like:

```
Module
└── FunctionDef  name="greet"
    ├── arguments  →  arg "name"
    └── Return
        └── BinOp  (+)
            ├── Constant "hi "
            └── Name "name"
```

Now the string isn't just text — it's a structure you can ask questions of: *what
functions are defined here? what does each one call? what does it return?* That tree
is the foundation for everything VTRACE knows.

**One nuance about "flavors" of tree** (this is the bit I stated confusingly before):
computer science distinguishes an **AST** (Abstract Syntax Tree — keeps the meaningful
structure, drops punctuation) from a **CST/parse tree** (keeps every token and byte).
VTRACE does **not** care which flavor it gets. All it needs from a parse is: for each
symbol, *what is it, and where does it start and end in the file* — so it can later cut
out that symbol's exact source text. Both parsers VTRACE uses give it that location,
just packaged differently:

- **tree-sitter** (for TS/JS) hands back **byte offsets** directly on every node
  (`node.startIndex` / `node.endIndex`).
- **Python's `ast`** hands back **line and column** numbers instead; VTRACE's parser
  script converts those to byte offsets itself (`absolute_byte()`,
  `src/parsers/pythonParser.ts:190`).

Either way, each symbol ends up with a `startByte`/`endByte`, and that's all the
downstream code relies on. So there is no contradiction between "we use tree-sitter"
and "we use Python's AST" — they're two parsers that both answer the same question
("what symbols are here and where are they"), each in its language's natural way.

### 2.2 Tree-sitter (for TypeScript and JavaScript)

Writing a correct parser for a real language is a huge job — the grammar is enormous
and full of edge cases. **Tree-sitter** is an off-the-shelf library that does it for
you: you hand it (a) a *grammar* for a language and (b) a source string, and it hands
back the parse tree. It's the same technology many code editors use for syntax
highlighting. Three properties make it a good fit:

- **It's fast** and works file-by-file.
- **It's error-tolerant** — if the file has a syntax error, it still returns a usable
  tree for the parts it *could* understand, instead of giving up. (VTRACE indexes
  real, sometimes-broken repos, so this matters.)
- **It's pluggable** — one library, a separate grammar per language. VTRACE installs
  the `tree-sitter` engine and the `tree-sitter-typescript` grammar (`package.json`).

Concretely, given:

```ts
export class Cart {
  addItem(item) { this.items.push(item); }
}
```

tree-sitter produces a tree whose nodes are typed, e.g.:

```
program
└── export_statement
    └── class_declaration  name: "Cart"          ← VTRACE: a Class symbol
        └── method_definition  name: "addItem"    ← VTRACE: a Method symbol
            └── call_expression  "this.items.push" ← VTRACE: a Calls edge
```

VTRACE walks that tree (`src/parsers/typescriptParser.ts`), and every time it meets a
node type it cares about — `function_declaration`, `class_declaration`,
`interface_declaration`, `type_alias_declaration`, `method_definition` — it records a
**symbol**. When it sees one symbol referring to another (a class holding a method, a
file importing a name, a call site) it records an **edge**. The grammar is selected per
extension (`getTreeSitterLanguage:108` — `.tsx` vs `.ts`). So: `Cart` becomes a Class
symbol that *contains* the Method `addItem`, which *calls* `push`.

### 2.3 CPython's `ast` module (for Python), and a tokenizer for Cython

Python already ships a battle-tested parser: the standard-library `ast` module (the
`ast` in Chapter 2.1's example is literally what it produces). Rather than reimplement
Python's grammar in TypeScript, VTRACE **spawns a small Python process** that imports
`ast`, parses the file, and prints the symbols/edges back as data
(`src/parsers/pythonParser.ts`; `spawnSync` at line 2, the embedded Python at line
176, interpreter candidates `python3`/`python` at line 173). This is the classic
"shell out to the language's own parser" strategy — maximally correct, at the cost of
one subprocess per file (softened by content-caching so unchanged files aren't
re-parsed).

Python's `ast` reports each node's **line and column**, not a byte offset. So the
script first builds a table of where each line begins in the file, then converts
(line, column) → absolute byte with `absolute_byte()` (line 190). That's the small
extra step tree-sitter doesn't need — and the reason both parsers end up producing the
same `startByte`/`endByte` VTRACE stores.

Cython (`.pyx`/`.pxd`) is *not* valid Python, so `ast` can't parse it. Instead
`src/parsers/cythonParser.ts` spawns CPython running the **`tokenize`**-based
`CYTHON_TOKENIZER_SCRIPT` (line ~1041): it lexes the file into tokens and recovers
declarations and `cimport`s from the token stream — a lighter, token-level parse
rather than a full tree. This is why Cython support is "Python-plus-typed" and a bit
more conservative.

### 2.4 The data model: symbols and a typed edge graph

Everything downstream operates on two record types (`src/domain/types.ts`):

- **`SymbolRecord`** — one declaration. Kind ∈ {Function, Class, Method, Interface,
  TypeAlias, ModuleConstant, ModuleVariable, ModuleAlias}, plus its file, byte range,
  fully-qualified name, docstring, decorators, exported flag.
- **`EdgeRecord`** — a directed relationship between two symbols. Type ∈ **Contains**,
  **Imports**, **Calls**, **References**, each carrying a `confidence` in `[0,1]`.
  Structural edges the parser is certain about (a class containing a method) are
  confidence `1` (`typescriptParser.ts:620+`).

Together these form a **code graph**: nodes = symbols, edges = relationships. Almost
every clever thing VTRACE does later is a graph operation over this.

**Identity is content-addressed.** File and symbol IDs are deterministic hashes
(`computeFileId`, `computeSymbolId`, `buildFQName` in `domain/types.ts`, using
`node:crypto`'s `createHash`). Same input → same ID, which is what lets the index be
diffed run-to-run and lets references be stable.

### 2.5 SQLite, and full-text search (FTS5)

The graph is persisted in **SQLite** — a database that is just a single file on disk,
with no server to run (`.vtrace/index.sqlite`; opened in `src/db/sqlite.ts:5`, schema
in `src/db/schema.ts`). Core tables: `files`, `symbols`, `edges` (plus run-history
tables `index_runs`, `file_run_states`, `symbol_run_states` that let VTRACE compute
what changed between two indexings).

**What "FTS" means.** FTS = **Full-Text Search**. The problem it solves: suppose you
have 50,000 symbols and you want the ones whose name or docstring mentions "session".
The naive way is to scan all 50,000 rows and check each for the word — like running
`grep` over everything, every query. That's slow.

Full-text search instead builds an **inverted index** ahead of time: a lookup table
that maps *each word* → *the list of rows that contain it*. Think of the index at the
back of a book — you don't read every page to find "mitochondria", you look the word up
and it tells you the pages. So:

```
word "session"  →  rows [12, 87, 340, 1901, …]
word "create"   →  rows [12, 55, 340, …]
```

Now "find symbols mentioning session" is an instant lookup, and "session AND create"
is just intersecting two lists → rows [12, 340]. No scan.

SQLite ships this as **FTS5**, exposed as a special *virtual table*: you insert rows,
and query them with the `MATCH` keyword. VTRACE declares two such tables
(`schema.ts:331`):

- `symbol_search_fts` — indexes each symbol's `local_name`, `fq_name`, `signature`,
  `docstring`, and `file_path`. (This is what turns a prose query into candidate
  symbols in Chapter 6.)
- `symbol_body_literals_fts` — indexes the distinctive literals pulled from symbol
  bodies (error codes/messages; see 3.4), so a pasted error can be matched back to its
  source.

### 2.6 Tokenizers, and why `unicode61`

Before FTS can build that word → rows table, it has to decide *what counts as a word*.
That job is the **tokenizer**: it chops a string into tokens and normalizes them.
VTRACE uses FTS5's built-in **`unicode61`** tokenizer (named for the Unicode 6.1
character rules). Its two rules are simple:

1. **Split on anything that isn't a letter or digit** — spaces, punctuation, and
   *underscores* all separate words.
2. **Lowercase everything** (case-fold).

Worked example — how these strings tokenize:

| Input string | Tokens produced |
| --- | --- |
| `create_session` | `create`, `session` |
| `Create Session` | `create`, `session` |
| `session.create()` | `session`, `create` |
| `createSession` | `createsession`  ← **one token** |

Note the last row: `unicode61` splits on underscores and punctuation, but **camelCase
is not split** (a capital letter isn't a separator). So `create_session` and
`Create Session` are interchangeable to the index, but `createSession` is a single
different token. That's a real, sometimes-surprising property of the lexical layer —
and part of why retrieval doesn't rely on FTS alone but blends in other signals
(Chapter 6). *(This corrects an earlier draft of this doc that wrongly claimed all
three forms tokenize alike.)*

This tokenizer + inverted index is the lexical substrate the whole retrieval stage
sits on.

---

## Chapter 3 — Indexing: turning a repository into a graph

Indexing is the one-time (then incremental) job that builds the map. Entry point:
`indexProject` (`src/indexer/indexProject.ts:38`). Triggered by `vtrace setup` /
`vtrace index` → `reindexRepoAndRefreshState` (`src/runtime/reindexRepo.ts:51`).

The refresh pipeline is:

```
scan → plan → parse/cache reuse → isolated graph replacement → resolve edges → validate → record run
```

### 3.1 Scan (file discovery)

`scanRepo` (`src/fs/scanRepo.ts:55`) walks the directory tree with `readdir`. It skips
a hardcoded set of noise directories (`.git`, `node_modules`, `dist`, `build`,
`__pycache__`, `.venv`, `venv`, `vendor`, cache dirs, …) and then applies **ignore
rules**: `src/fs/ignoreRules.ts` reads `.gitignore` / `.ignore` / `.vtraceignore`
per directory (`loadIgnoreRulesForDirectory:29`), compiles globs to regexes
(`globToRegExp:113`), and supports negation (`!pattern` re-includes). A file survives
only if its extension is a known language (`detectLanguage`,
`src/fs/languageDetection.ts:10`: `.ts/.tsx/.js/.jsx/.py/.pyx/.pxd/.pxi`).

Output: a sorted list of `FileRecord`s. Manifest v3 persists a canonical per-file
snapshot; clean tracked files also carry Git blob identity, while dirty/untracked
files use their cryptographic working-tree hash.

### 3.2 Parse (per-language, Chapter 2.2–2.3)

Dispatch goes through a small **parser registry** (`createParserRegistry`,
`src/parsers/LanguageParser.ts:23`): the file's language selects the tree-sitter TS/JS
parser, the CPython-`ast` Python parser, or the tokenizer-based Cython parser. Each
returns a `ParseResult` = symbols + edges + diagnostics. Complete results are cached
immutably under the repository's canonical Git common directory. Keys include
content/blob identity, language, parser/config versions, relative path, and a
binding-context hash. Incremental refresh aborts before graph mutation if a changed
file cannot be parsed; an initial full index can still report per-file failures.

### 3.3 Persist

`persistParseResult` writes the file row, symbols, FTS rows, body literals, and local
edges. A mutating refresh replaces the complete live graph inside one SQLite
transaction, then validates edge/FTS integrity before commit. This is deliberately
a full-worktree relink/persist even when parsing is incremental; it prevents stale
cross-file edges while unresolved descriptors remain unpersisted.

### 3.4 Body literals (the bug-report bridge)

`buildSymbolBodyLiterals` (`src/indexer/extractBodyLiterals.ts:127`) scans each
symbol's source for **distinctive strings**: diagnostic codes (`TS2345`,
`ERR_INVALID_ARG_TYPE`, `E015`) and human-readable quoted error messages. These go
into `symbol_body_literals_fts`. The payoff: when a task pastes an error message or
code, VTRACE can jump straight from the *symptom text* to the *symbol that emits it* —
a retrieval strategy no name-based search can match (Chapter 6.2).

### 3.5 Inter-file edges resolve last

An `import`/`call`/`reference` edge often points at a symbol in another file that
hasn't been parsed yet when the edge is discovered. So VTRACE parses everything first,
then resolves cross-file edges only where **both** endpoints exist
(`persistResolvableInterFileEdges`). Unresolvable edges are dropped rather than
guessed — conservatism again.

### 3.6 Incremental planning, rollback, and freshness

An unchanged compatible snapshot is a no-op: zero files parsed and no live graph or
retrieval rows rewritten (an index-run history snapshot is still appended for API
compatibility). A modified-only change parses the changed files and reuses cached
results only if the combined path/symbol binding surface is unchanged. Adds,
deletes, renames, package entrypoint changes, structural symbol/ID changes, legacy
manifests, and incompatible parser/config/schema versions fall back to a clean full
rebuild with a precise reason. The old graph remains valid if parsing, persistence,
or validation fails.

Linked worktrees keep distinct `.vtrace/index.sqlite` databases and manifests, but
read the same repository-scoped immutable cache and reusable snapshot registry.
Exact-commit worktrees can therefore assemble a separate graph with zero parsing.
Graph snapshot cloning, cache pruning, and background watching remain separate work.

Staleness is detected by **fingerprinting**, not guesswork. `checkIndexFreshness`
(`src/indexer/indexMeta.ts:163`) compares six values stored in `.vtrace/index.meta.json`:
index format version, schema (a hash of the DDL), a **parser fingerprint** (hash of
`src/parsers/**`), an **indexer fingerprint**, a scan-config hash, and **git HEAD**.
Change the parser code and every index is correctly considered stale. `vtrace watch`
marks stale on file change; `--auto-reindex` is opt-in so nothing silently churns.

Manifest format v3 adds the per-file cache/snapshot fields and performance
diagnostics. A v2/legacy manifest receives one safe full rebuild. At the end,
`recordIndexRunState` snapshots this run's files/symbols so the *next* run
can compute a precise diff — the basis for memory staleness and rule invalidation
later.

---

## Chapter 4 — The query pipeline: a map of the whole flow

Indexing built the map. Now a task arrives. The authors summarize the query pipeline
at the top of `src/capsuleV2/types.ts`:

```
task signals → intent detection → candidate generators → evidence scorecards
             → pivot / support / discard roles → budget allocator → renderer
```

The concrete orchestrator is `runPipelineOrchestrator`
(`src/runPipeline/runPipelineOrchestrator.ts:316`). It runs these sections in order
and assembles them into one response:

1. **Intent** (`selectRunPipelineIntent`, line 342) — classify the task.
2. **Context retrieval** (`runReliableContextRetrieval`, ~638) — route the query,
   build the capsule of relevant symbols.
3. **Impact** (`runImpactSection`, ~848) — if the task is about blast-radius, attach a
   dependency graph.
4. **Flow** (`runFlowSection`, ~1108) — if two endpoints are named, attach the static
   path between them.
5. **Memory** (`runMemorySection`, ~1318) — fold in relevant session/durable memory.
6. **Rules** (`runRulesSection`, ~1332) — attach any active project rules.
7. **Capsule** (`buildCapsuleSection`) — the bounded, ranked capsule.
8. **Deferred / V-REF** (`buildDeferredPlaceholders`, ~1459) — publish big payloads by
   reference instead of inlining them.

Defaults live in `RUN_PIPELINE_DEFAULTS` (line 131): `maxResults=6`,
`capsuleV2BudgetTokens=8000`, etc. The same engine is reachable from the CLI
(`runCapsuleCommand`, `src/cli/commands/capsuleCommand.ts:95`) and from MCP
(`run_pipeline` / `get_code_context`, `src/mcp/tools.ts`).

Chapters 5–9 zoom into the load-bearing stages.

---

## Chapter 5 — Intent detection

Different tasks want different context. A *debug* task should lean on failing tests
and tracebacks; an *impact* task should turn on the dependency graph; an *explain*
task wants breadth over a single edit site.

`selectRunPipelineIntent` (`src/runPipeline/selectIntent.ts:41`) resolves an intent
from (a) explicit phrase triggers in the query ("refactor", "why does … fail"), and
(b) a lightweight classifier (`src/intent/classifier.ts`), defaulting to a general
"explore". A caller can also *declare* intent (`--intent debug`); `auto` lets VTRACE
choose. The product-facing intent vocabulary is the `CapsuleIntent` enum
(`src/capsuleV2/types.ts:23`): **debug, refactor, modify, explain, impact,
test-failure**. `resolveNormalizedIntent` (`resolveNormalizedIntent.ts:62`) reconciles
the various intent notions and sets `impactEligible` / `flowEligible` flags that gate
the impact and flow sections.

---

## Chapter 6 — Retrieval: hybrid search

This is where a prose query becomes a ranked list of symbols. The governing idea:
**no single search strategy finds everything, so run several and pool them.**
`hybridRetrieve` (`src/retrieval/hybridRetrieval.ts:143`) does exactly that.

### 6.1 The lexical core: FTS5 + BM25

Two lexical signals are computed and blended.

**FTS5 match.** `searchSymbolsFts` (`src/retrieval/searchSymbolsFts.ts`) runs a SQL
`… WHERE symbol_search_fts MATCH ?` (line 34) and joins back to the `symbols` table.
This uses the inverted index from Chapter 2.5–2.6 to find symbols whose
name/signature/docstring contain the query terms, fast.

**BM25.** On top of the candidate pool, VTRACE computes its own **BM25** score
(`computeBm25Scores`, `hybridScoring.ts:688`). BM25 ("Best Match 25") is the standard
information-retrieval ranking function. Intuition: a term is more meaningful when it
appears *often in this document* (term frequency, TF) but *rarely across all documents*
(inverse document frequency, IDF), with diminishing returns for repetition and a
correction so long documents don't win just by being long. The implementation uses the
textbook parameters `k1 = 1.5`, `b = 0.75` (`hybridScoring.ts:679`) and the
+1-smoothed IDF `log(1 + (N − df + 0.5)/(df + 0.5))` that stays non-negative.

The two are combined by `blendLexical` (line 135) as **0.65·FTS + 0.35·TF-IDF**
(`FTS_BLEND`/`TFIDF_BLEND`, line 132) — FTS provides recall, BM25 sharpens
discrimination among the hits.

### 6.2 The six candidate generators

`hybridRetrieve` pools hits from six strategies (each blind to the others):

1. **Lexical** (`lexicalCandidates`, line 183) — the FTS5/BM25 core above.
2. **Symbol / path** (line 212) — symbols and files the query directly names or implies.
3. **Failing-test → implementation** (line 256) — from a named failing test, follow
   its `Imports`/`Calls` edges to the code under test. (Strongest weight; see 6.4.)
4. **Body-literal** (line 298) — match distinctive task strings (error codes/messages)
   against `symbol_body_literals_fts` (Chapter 3.4).
5. **Graph expansion** (line 392) — see 6.3.
6. **Same-module siblings** — bundled into graph expansion.

### 6.3 Graph expansion: bounded BFS

Lexical search finds *seeds*; the real target is often one edge away (the function the
seed calls, the class it lives in). So VTRACE runs a **breadth-first search** over the
edge graph from the seed set — visiting neighbors layer by layer — but **bounded**:
≤2 hops, hard cap ~24 candidates (`src/retrieval/graphExpansion.ts`). The bound is
essential: without it, expanding from a hub symbol would detonate the candidate pool.

### 6.4 Scoring: a weighted sum, then corrective penalties

Every candidate accrues raw signals from the generators; `assemble`
(`hybridRetrieval.ts:422`) normalizes each to `[0,1]` and `combineFinalScore`
(`hybridScoring.ts:162`) takes a **weighted sum**:

```
lexical·1.0 + symbol·1.2 + path·0.8 + domain·0.9 + testToImpl·1.3
            + graph·1.0 + centrality·0.5 + bodyLiteral·1.4
```

Read the weights as a value system: a **body-literal** hit (1.4) or a
**test→implementation** edge (1.3) is the most trustworthy evidence; raw **centrality**
(how connected a symbol is, 0.5) is the *weakest* — being popular never wins alone.

Then two penalties encode failure lessons before ranking:

- **Hub penalty** (`evaluateHub`, line 225). A framework root — e.g. Django's `Model`
  with thousands of dependents — has centrality ≈ 1 and would shadow every query. If a
  high-degree symbol has no *local* evidence it's the target, its graph and centrality
  boosts are stripped.
- **Actionability penalty** (`evaluateActionability`, line 295). A module-level config
  constant is rarely the edit site; non-function/method/class symbols lose their
  graph/domain boost without direct evidence.

Two more guards defuse classic traps:

- **Symptom latch** (`classifyLexicalQueryTokens`, line 462). Exception names tokenize
  into symptom nouns — `IndexError` → "index" — which would then match every symbol
  named `*index*`. Tokens that only occur inside an exception name are folded to
  "generic" so they stop over-anchoring.
- **Generic-word down-weight** (`analyzeLexicalGenericMatch`, line 524). A candidate
  matched *only* by a common word ("multiple", "data") is multiplied by 0.25.

The result is a ranked candidate list — but a ranked list is not yet an answer.

---

## Chapter 7 — Pivot selection: the algorithm at the heart

The product's real intelligence is here: turning a ranked pile into **one or two edit
targets** ("pivots") and demoting everything else. `assignCandidateRoles`
(`src/capsule/assignCandidateRoles.ts:61`) labels each candidate **pivot / support /
discard**, driven by `recoverMicroCapsule` (`src/capsule/microTargets.ts:96`) which
caps the pivot count (default **1**).

### 7.1 The pivot bar

A candidate becomes a *pivot* only if it clears a strict, all-of-these bar
(`classify`, `assignCandidateRoles.ts:120`):

1. **Actionable** — it's a function/method/class you can actually edit, not a module
   variable.
2. **Direct evidence** — a symbol/path/test→impl hit, or lexical ≥ 0.5.
3. **Enough local evidence** — the summed local signals clear a threshold (≥ 0.3).
4. **Not hub-penalized** and **not a framework hub**.

Candidates that miss the bar but are still relevant become **support** (worth seeing —
e.g. the caller); the rest are **discarded** (and recorded with a reason, so the answer
is auditable). If nothing clears the bar, the honest outcome is *no pivot* — VTRACE
returns an empty capsule rather than a confident-looking wrong one.

### 7.2 Ambiguity and confidence

Two honesty mechanisms:

- **Ambiguity** (`detectPivotAmbiguity`, line 95): if the runner-up scores ≥ 85% of the
  leader, that's flagged — "these two are close," rather than silently picking one.
- **Confidence gate** (`classifyDigestPivotConfidence`,
  `src/capsuleV2/digestDecisionContract.ts:291`, optional): a pivot stays **required**
  only with strong evidence — a source-line anchor, exercised by a failing test, a
  direct call/import edge, issue-domain overlap. Weak evidence (name-only,
  facade/wrapper hub, a test file for a non-test issue) is **demoted** to optional. If
  *every* candidate demotes, VTRACE emits an explicit
  `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker (line 42) — "I found no
  high-confidence target" is a real, distinguishable answer.

---

## Chapter 8 — Capsule assembly: fitting evidence into a token budget

Roles in hand, `buildCapsule` (`src/capsuleV2/buildCapsule.ts`) renders the
returned object, a `CapsuleV2Result` with `pivots[]`, `support[]`, `discarded[]`, and
`diagnostics`. Each item carries `path`, `symbol`, a `roleReason`, and an estimated
token cost.

### 8.1 Token budgeting and tiers

The capsule has a token budget (default 8,000). Token counts are estimated with a
shared `chars/4` heuristic (`src/capsuleV2/tokens.ts::estimateTokens`) — an
approximation, deliberately not a real tokenizer, kept identical everywhere so all
surfaces speak one unit. The budget selects a **tier** (`allocateBudget`,
`budgetAllocator.ts:49`):

- **micro** (< 1,500 tok) → 1 pivot, 1 support — forces a single decisive target.
- **standard** (1,500–12,000) → 2 pivots, 4 support.
- **full** (≥ 12,000) → up to 5 pivots, 10 support (still bounded by the token budget).

### 8.2 Laddered rendering (the compression that matters)

Source is expensive, so each pivot is rendered on a **ladder** and VTRACE greedily
picks the richest rung that still fits the remaining budget:

```
full source  →  signature only  →  skeleton (name/shape only)
```

The lead pivot is guaranteed *at least* a skeleton even under budget pressure; support
items are the first to drop. This is how a capsule stays small without losing the one
thing the agent must see.

### 8.3 Section-priority truncation

If the assembled context still exceeds the char budget,
`truncateContextByPriority` (`src/capsuleV2/sectionBudgetAccounting.ts:358`) does *not*
blindly cut from the end. It drops **whole sections by priority** —
`diagnostic → optional → important` — while **preserving the essential pivot source**,
and only falls back to a head-slice if the essential sections alone overflow. It emits
a `VtraceContextBudget` record (`truncationOccurred`, `essentialSectionsEvicted`, …) so
you can always tell whether the pivot neighborhood survived. (This exists because an
earlier naive head-slice could silently evict exactly the code that mattered.)

---

## Chapter 9 — The digest and the decision contract

A capsule is code; agents also benefit from a **plan**. The **compact digest**
(`renderCapsuleV2Digest`, `productAdapter.ts:516`, with `compactDigestHeader:350`)
renders a short action-map: the query trimmed to a head/tail excerpt, each item's
reason collapsed to one line, so a giant issue body can't crowd out the useful part.

Optionally VTRACE attaches a **decision contract**
(`buildDigestDecisionContract`, `digestDecisionContract.ts:589`). For each target it
asks the agent to record a machine-readable decision — **EDIT / RULE_OUT /
INSPECT_ONLY_NO_EDIT**, with a reason and the files touched, wrapped in
`DIGEST_DECISION_CONTRACT_START/END` sentinels. This turns "here's some context" into
"consciously accept or reject each of these" — closing the loop so a pivot can't be
silently ignored. When **bounded** (`selectBoundedDigestDecisionTargets:320`) it's
capped at 4 targets: lead pivot → a hidden co-pivot → up to 2 cross-file **impact
representatives**. Impact reps (cross-file dependents that a change would ripple to)
are always **optional/FYI** — informative, never a reason to edit, because empirically
they almost never are the edit.

---

## Chapter 10 — The structural queries: skeleton, impact, logic-flow

Besides the capsule, VTRACE answers three focused graph questions directly. Each is a
CLI command and an MCP tool.

### 10.1 Skeleton — the outline of a file

`getSkeleton` (`src/skeleton/getSkeleton.ts:102`) returns a file's AST outline purely
from indexed data: its **imports** (`buildImportsSummary:152`), **exports**
(`buildExportsSummary:187`), and **top-level declarations with class members**
(`buildDeclarations:198`), at a chosen detail level (minimal name/kind → standard
+signature → detailed +docstring/decorators/lines). Use it when you already know the
file and want its shape without reading it.

### 10.2 Impact graph — "what breaks if I change this?"

`getImpactGraph` (`src/impact/getImpactGraph.ts:138`) answers blast-radius by walking
the graph **backwards**. From the target symbol, `discoverImpactSymbols` (line 241)
runs a reverse BFS — collecting everything that calls/references/contains the target,
layer by layer, to depth N. `buildImpactNodes` (291) records each dependent with its
distance; `buildImpactEdges` (334) labels the connecting edges (Calls/Imports/
Contains/References). Crucially it reports **coverage notes** (member resolution,
inherited evidence, which edge types were available) rather than pretending the graph
is complete when it isn't.

### 10.3 Logic flow — the static path between two symbols

`searchLogicFlow` (`src/logicFlow/searchLogicFlow.ts:143`) finds the bounded static
path(s) between **two exact FQNs** over Contains/Imports/Calls edges. It resolves both
endpoints (`resolveExactSymbol:245` — errors on ambiguity), builds adjacency maps
(`buildGraph:299`), computes shortest distances by BFS
(`computeForwardDistances:354`), then enumerates up to N shortest paths with a
distance-pruned DFS (`enumerateShortestStepPaths:395`). `buildCoverageNotes:551`
states honestly whether call-flow evidence existed — if `Calls` edges weren't
extractable, it says so instead of implying it traced execution. **This is static
structure, not a runtime trace** — the boundary is deliberate and surfaced.

---

## Chapter 11 — Memory: observations, staleness, rules

VTRACE improves within and across sessions with a small, repo-local memory.

### 11.1 Observations

An **observation** (`src/observations/`) is a timestamped note attached to the repo
(and optionally a session): a decision, insight, warning, dead-end, or auto-captured
tool result, each linked to the files/symbols involved. Agents write them
(`save_observation`); they're recalled by relevance with `searchMemory`
(`searchMemory.ts:36`) and `getSessionContext` (`getSessionContext.ts:21`), and the
pipeline folds the relevant ones into the response. Tool outputs (impact graphs, etc.)
are auto-recorded (`captureVisibleCapsuleObservation`, `autoCapture.ts:24`).

### 11.2 Staleness

Because each index run snapshots symbols/files (Chapter 3.6), VTRACE can compare an
observation's linked targets against later runs. If the code it referred to was
modified or deleted, the observation is flagged **stale**
(`src/observations/staleness.ts`) so old notes don't mislead.

### 11.3 Compression

Inactive sessions are consolidated: repeated tool-call notes are pruned into a single
durable summary (`compressInactiveSessions`, `sessionLifecycle.ts:129`), keeping
memory dense and cheap to search.

### 11.4 Project rules — learned patterns

When the *same kind* of evidence recurs in the *same scope* enough times (default ≥ 3),
`generateProjectRuleCandidates` (`src/projectRules/projectRules.ts:91`) proposes a
**candidate rule** ("before editing X, check Y"). Promote it (`promoteProjectRule:160`)
and `selectRelevantProjectRules:216` surfaces it on matching future queries; a reindex
that moves its scope marks it **stale** (`markProjectRulesStaleForRun:277`). Confidence
tiers (high/medium/low) track how well-grounded each rule is. This is how the tool
accretes project-specific judgment over time — without any model training, just
bookkeeping over observations.

---

## Chapter 12 — Continuity: handoff and V-REFs

Two mechanisms move context between tools/turns without recomputation.

**Handoff** (`src/handoff/buildHandoff.ts:68`) serializes a whole pipeline result —
query, intent, capsule, memories, provenance, trust metadata — into a portable JSON
payload another session/tool can resume from (`createDeterministicHandoffBuilder:77`).

**V-REFs** (`src/runPipeline/deferredVexpStore.ts`) solve a subtler problem: a response
may reference a large payload (a full capsule, an impact graph) without inlining it.
The pipeline publishes the payload into a store and gets back a **12-hex handle** —
`computeDeferredVexpHash` (line 61) is `SHA256(stableId)` truncated to 12 hex chars.
The store is a capacity-bounded FIFO in process memory (`publish:113`) backed by a
persistent DB table for durability. Downstream, `expand_vexp_ref` →
`resolveDeferredVexpRef` (`expandDeferredVexpRef.ts:23`) looks the hash up in the
process store and the DB and returns the **exact** stored payload, or an
expired/unknown error. It is precise lookup with bounded retention — never a fuzzy
reconstruction.

---

## Chapter 13 — The MCP protocol: how an agent actually talks to VTRACE

Agents don't call functions; they speak a protocol. **MCP** (Model Context Protocol)
is a JSON-RPC-based standard for exposing tools/resources to an LLM host like Claude
Code or Codex.

VTRACE runs a **repo-bound stdio MCP server** (`vtrace mcp-serve` →
`startMcpServer`, `src/mcp/startServer.ts:148`; server built in `server.ts:41`). The
transport is **JSON-RPC 2.0 over stdin/stdout** with **LSP-style framing**: each
message is prefixed with a `Content-Length:` header (`startServer.ts:595`) so the
reader knows exactly how many bytes to consume. Requests are dispatched by `method`
(`startServer.ts:371`); responses carry the matching `jsonrpc`/`id`.

The server advertises a **tool registry** (`defaultMcpToolRegistry`,
`src/mcp/tools.ts:8650`). The tools (IDs in `src/mcp/types.ts:11`) split into the
primary surface — `get_code_context` / `run_pipeline` (the full pipeline of Chapters
4–9), `get_context_capsule`, `get_impact_graph`, `get_skeleton`, `search_logic_flow`,
`expand_vexp_ref`, `index_status`, `workspace_setup` — and legacy/narrow tools
(`search_symbols`, `save_observation`, `search_memory`, `get_session_context`). A tool
call lands in its handler, which opens the repo DB and invokes the same orchestrator or
builder the CLI uses. `vtrace setup` installs the MCP config so the host launches this
server automatically; an optional daemon (`src/runtime/daemon.ts`) can keep it warm.

---

## Chapter 14 — Determinism, and the boundaries we chose

VTRACE's conservatism is not timidity; it's what makes the output *trustworthy*.

- **Deterministic by construction.** No randomness, no wall-clock in the answer path.
  IDs are content hashes; ranking is a fixed weighted sum; traversals are ordered.
  Same repo + query → identical bytes. This is directly testable (and tested — a
  `check-capsule` parity command exists precisely to catch non-determinism).
- **Static only.** Everything is from the parsed AST/graph. No runtime tracing, no
  dataflow inference.
- **Exactness over guessing.** `search_logic_flow` demands exact FQNs; unresolved
  edges are dropped, not invented; if `Calls` evidence is absent it's *reported* as
  absent.
- **No silent staleness.** Freshness is fingerprinted; `watch` is mark-stale by
  default; `--auto-reindex` is explicit.
- **Local only.** The index never leaves the repo.

Where a heuristic *is* used (retrieval weights, the pivot bar), it's a fixed,
inspectable rule with a recorded reason — not a black box.

---

## Chapter 15 — End to end: one query, traced through every module

Task (via `get_code_context`): *"Sessions are created twice on login — fix the
duplicate `createSession` call,"* with the failing test attached.

1. **MCP** (`tools.ts`) receives the JSON-RPC `tools/call`, opens `.vtrace/index.sqlite`,
   invokes `runPipelineOrchestrator` (`runPipelineOrchestrator.ts:316`).
2. **Intent** (`selectIntent.ts:41`) → `debug` (phrase + failing test present).
3. **Retrieval** (`hybridRetrieval.ts:143`):
   - the failing test's `Imports`/`Calls` edges resolve to
     `SessionManager.createSession` → **test→impl** signal (weight 1.3);
   - FTS5/BM25 (`searchSymbolsFts.ts` + `hybridScoring.ts:688`, 0.65/0.35 blend) also
     surface `LoginController.handleLogin` and a popular `BaseController`;
   - graph BFS (`graphExpansion.ts`) pulls in `createSession`'s immediate neighbors.
4. **Scoring** (`combineFinalScore:162`): `createSession` leads. `BaseController` is a
   framework hub with no local evidence → **hub penalty** strips its boosts → it will
   be discarded.
5. **Pivots** (`assignCandidateRoles.ts:61`): `createSession` clears the bar →
   **pivot**. `handleLogin` (its caller) → **support**. `BaseController` → **discard**
   (reason recorded).
6. **Capsule** (`buildCapsule.ts`, standard tier): within 8k tokens, render
   `createSession` as **full source** (the edit target) and `handleLogin` as a
   **signature** (laddered down to fit); attach `roleReason`s.
7. **Digest** (`digestDecisionContract.ts:589`): action-map — *EDIT
   `SessionManager.createSession`; INSPECT `LoginController.handleLogin` (caller)* — plus
   one FYI impact rep for a downstream session consumer.
8. **Response** returns over MCP (Chapter 13). Optionally the agent later writes an
   **observation** ("dup call was in `createSession`, fixed") that a future query will
   recall (Chapter 11).

The agent receives a few thousand tokens pointing straight at the two relevant
functions — instead of reading `session.py`, `login.py`, and grepping "session" across
the repo. Multiply that saving over every turn and every task, and that is the whole
product.

---

### One-paragraph recap you can say out loud

*"VTRACE indexes a repo with tree-sitter (for TS/JS) and CPython's `ast` (for Python)
into a symbol-and-edge graph stored in SQLite, with FTS5 full-text indexes over symbol
names and extracted error literals. A query runs a hybrid retrieval — FTS5 + a BM25
blend plus five other generators, expanded by a bounded BFS over the graph — then a
weighted score with hub/actionability penalties ranks candidates. A strict bar selects
one or two 'pivots' (the real edit targets); everything else is support or discarded
with a reason. The pivots are rendered on a full-source→signature→skeleton ladder into
a token-budgeted capsule, plus a compact digest and an EDIT/RULE_OUT decision contract.
It's exposed to agents over a stdio JSON-RPC MCP server, it's fully deterministic, and
it accretes memory (observations and learned project rules) locally over time."*
