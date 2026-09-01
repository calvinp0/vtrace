# M196A — ingestion authority and material-corpus qualification

**M196A — PASS.**

```
M197_A8_INGESTION_READY
M197_MATERIAL_CORPUS_NOT_READY
NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION
M197_CONTEXT_COMPRESSION_PROOF_NOT_READY
M197_TRACK_A_ENGINEERING_REPRODUCTION_ONLY
```

The parser defect is real, fully repaired, and was never what M196 said it was.
The corpus problem is real, was measured across every trajectory VTRACE owns
rather than the one M196 sampled, and is worse than M196 estimated.

Live-agent runs: **0**. Live model spend: **$0**.

---

## 1. What M196 got right, and the one thing it did not

M196's headline numbers all reproduce exactly. C-MED is 492 TypeScript files;
36 fail a bare parse; 287 survive the parse the product actually performs, giving
**58.3%**. Every digit matches.

The **attribution** does not. M196 wrote the cause down as a *"32,767-character
boundary, tree-sitter 0.21.1"* — inferred from a coincidence, because its probe
was written as

```ts
try { await p.parse(...); ok++; } catch { /* counted as loss */ }
```

It counted 36 losses and observed 36 files over 32,767 characters, and named the
second as the cause of the first. It never read an exception. The exception says
`Invalid argument`, and it comes from `node_modules/tree-sitter/index.js:361` —
the **binding**, not the grammar, and not a size policy anyone chose:

```js
Parser.prototype.parse = function(input, oldTree, {bufferSize, includedRanges}={}) {
  if (typeof input === 'string') {
    const inputString = input;
    input = (offset, _position) => inputString.slice(offset)   // ← whole remainder, one chunk
  }
  return parse.call(this, input, oldTree, bufferSize, includedRanges);   // ← bufferSize undefined
}
```

The binding converts a string into a chunk callback that returns the *entire*
remaining source, and the native side writes that chunk into a buffer whose
default size is **32,768 UTF-16 code units**. One unit over and it throws instead
of reading in chunks. `node-tree-sitter` fixed this by 0.25.1; VTRACE pins 0.21.1.

The unit matters and was measured, not assumed: 32,767 two-byte characters
(65,522 bytes) parse fine, so the limit is on JavaScript string length, not bytes.
Boundary control **F2** now straddles it exactly — pre-repair passes at 32,767 and
fails at 32,768.

**Python was never measured at all.** M196's prose reports "Python 100%"; its own
`stage5_m196_capability_audit.json` has no Python coverage field, because
`ingestionProbe` only parses when `ext === ".ts"`. The claim happened to be right,
for a reason M196 did not state: `pythonParser` shells out to CPython's `ast`
module and never touches tree-sitter, so the binding's buffer cannot reach it.
An unmeasured claim that turns out true is still an unmeasured claim.

### The blast radius is not the big files

36 files exceed the limit. **205** fail when the product parses the corpus the way
it really does, with `knownFiles` populated. The extra 169 are between 1,597 and
32,726 characters — all comfortably under the boundary. They fail because
`getExportIndex` re-parses each *imported* file to resolve its exports, so one
oversized module takes down every module that imports it. In VTRACE's own source
that meant `src/mcp/tools.ts` (441,752 chars) poisoned most of the product path.

An index that silently drops 42% of a repository was not dropping a random 42%.

---

## 2. The repair

One file, `src/parsers/typescriptParser.ts`, at both `tree-sitter` entry points
(the file parse, and `getExportIndex`'s import resolution):

```ts
const TREE_SITTER_DEFAULT_BUFFER_UNITS = 32768;

function parseSource(parser: Parser, content: string) {
  return parser.parse(content, undefined, {
    bufferSize: Math.max(TREE_SITTER_DEFAULT_BUFFER_UNITS, content.length + 1),
  });
}
```

Why this repairs authority rather than hiding the defect: the parser sees the
**whole file, unmodified**. Nothing is truncated, chunked, sampled, skipped or
special-cased; no benchmark path is treated differently; the grammar and the
resulting AST are untouched. The only thing that changes is how much room the
binding is given to hand the source across.

The alternative — upgrading `tree-sitter` to ≥ 0.25 — was rejected for this
milestone: a grammar/ABI change would alter parse output across every language at
once, which is exactly the retrieval side effect the repo's own rules forbid as a
by-product of an unrelated fix.

**Retrieval impact.** The Python index is *byte-identical* before and after:
`sha256 829d67a0…` over all `files`, `symbols` and `edges` rows of C-LARGE, both
sides. The retrieval-eval fixtures are entirely Python; a paired pre/post run over
`retrieval_eval.django.json` and `retrieval_eval.m155_broad_100.json` changed **0
verdicts** in 105 rows. Seven rows changed a diagnostic *string*
(`derivation_incompatible` → `parser_incompatible`), which is correct: the parser
genuinely did change. TypeScript retrieval changes on purpose — that is the repair.

---

## 3. A8 after the repair

Measured through the authoritative product path (`indexProject`), not a parser
loop, three times per corpus.

| corpus | on disk | legitimately excluded | eligible | represented | coverage | unexplained missing | non-deterministic runs |
|---|---|---|---|---|---|---|---|
| C-SMALL | 21 | 0 | 21 | 21 | **100%** | 0 | 0 |
| C-MED | 492 | 0 | 492 | 492 | **100%** | 0 | 0 |
| C-LARGE | 975 | 699 | 276 | 276 | **100%** | 0 | 0 |

The product's own coverage summary agrees and is complete on every corpus:
21/21, 492/492, **346/346** (C-LARGE eligibility includes `.pyx`, `.pxd`, `.yml`,
`.toml` — the indexer enumerates more languages than the corpus is declared in, a
gap in the safe direction). `filesFailed = 0` and `filesSkipped = 0` throughout.

### The 699, and why the denominator moved

Every excluded file sits under `.claude/worktrees/agent-*`: nested git worktrees
that `git worktree list` reports and ARC's own `.gitignore` excludes with
`.claude/*`. They are **duplicate copies of the same repository**, left by agent
sessions.

This is a correction to the frozen corpus, not a convenience. M196's manifest
records C-LARGE as *975 Python files*; it is 276. M196's "cold index, 975 Python
files ≈ 55 s" timed 276 files while labelling them 975. The M197 preregistration
now carries the correction with its evidence, and **no threshold, gate, veto or
VEXP claim was touched**.

Because a shrinking denominator is the obvious way to fake this gate, coverage is
published against both denominators, every removal is itemised with examples, and
control **F6** proves by construction that a genuinely failing file cannot reach
an excluded reason: failure reasons are assigned only from a product `status`,
exclusion reasons only when the product never enumerated the file at all.

### Parser truth controls

```
F1  PASS  below-boundary file parses and indexes
F2  PASS  32,766 / 32,767 pass and 32,768 / 32,769 / 40,000 fail pre-repair; all pass after
F3  PASS  src/mcp/tools.ts (441,752 chars) and toolOutputCapture.test.ts (51,479) go from THROW to indexed
F4  PASS  160 symbols / 179 edges recovered from tools.ts with 0 span mismatches
F5  PASS  three parses of a 120,000-char file are identical
F6  PASS  a failing file cannot be reclassified into an excluded reason
```

F4 is the one that matters. Recovering a file is worthless if its symbols land at
the wrong offsets — a silently mislocated symbol is worse than a missing one. Over
every symbol in both previously-lost files, zero spans disagree with the source.

### Index timing, descriptive only (§14)

| corpus | files | cold | files/s | no-op | k=1 | k=3 | ratio |
|---|---|---|---|---|---|---|---|
| C-MED | 492 | 8,745 ms | 56.3 | 80 ms | 2,681 ms | 2,709 ms | 0.307 / 0.310 |
| C-LARGE | 346 | 22,675 ms | 15.3 | 160 ms | *crash* | 32,807 ms | — / 1.447 |

A3 still fails, now with a mechanism rather than a number: **"incremental"
re-parses the entire corpus** — 492 of 492 files for a one-file change on C-MED,
346 of 346 on C-LARGE. Two defects surfaced and were deliberately **not** fixed
here (§14, §15):

- a single-file Python incremental refresh aborts with
  `UNIQUE constraint failed: edges.id`;
- incremental refresh has no incremental path.

Both were **reproduced with the M196A repair reverted** and are pre-existing.
M196's own numbers (~55 s cold, 112–163 s incremental, ~1 s no-op) do not
reproduce, but they were taken against the inflated 975-file corpus.

---

## 4. B0 — is there a Ferrari-sized workload?

M196 answered this from 33 M194 arms. M196A answered it from **every preserved
trajectory VTRACE holds**: 1,078 arms, 619 successful, 44 repositories, 40
milestone corpora, plus M194's Claude Code transcripts.

**M194 reproduces to the digit** — 33 arms, 23 successful, median 2,619, p90
8,302, max 19,122 — and remains the negative control.

```
TRACK_B_M194_MATERIALITY = FAIL
```

| corpus | arms | successful | repos | median evidence | p90 | max | median share | B0 |
|---|---|---|---|---|---|---|---|---|
| M194 (control) | 33 | 23 | 33 | 2,619 | 8,302 | 19,122 | 4.0% | INADEQUATE |
| **All untreated (§19 primary)** | 402 | 253 | 44 | **2,605** | 9,178 | 21,986 | **5.7%** | **INADEQUATE** |
| All arms pooled | 1,078 | 619 | 44 | 1,919 | 7,255 | 21,986 | 3.4% | INADEQUATE |
| M163 (best ≥10 successful) | 36 | 23 | 5 | 3,580 | 9,417 | 21,858 | 7.7% | INADEQUATE |
| M162 | 36 | 23 | 5 | 3,398 | 9,115 | 18,348 | 7.6% | INADEQUATE |
| M183 | 60 | 38 | 8 | 3,506 | 9,590 | 21,173 | 6.6% | INADEQUATE |

**No corpus clears B0.** Not one of the 40. The median untreated successful arm
reads 2,605 tokens of repository — one file — against a 20,000-token bar, and its
repository evidence is 5.7% of what the model was shown against a 25% bar. The
single largest observed arm anywhere is 21,986 tokens; the bar is a *median*.

### The denominator that decides it

Four corpora (M183, M162, M65C, M68B) *appear* to clear the 25% arm at 26–54%.
They do so only against a transcript reconstruction, which cannot see the system
prompt or the task prompt and therefore **overstates the share**. Measured against
the cache-corrected provider denominator §22 requires — `input + cache_creation +
output` summed per assistant message, `cache_read` excluded as the re-sent prompt
material the preregistration rules out — they fall to 14.1%, 15.9%, 41.0% and
22.4%, and the last two rest on **two successful arms each**. Both denominators
are published; the honest one governs.

That gap is the finding, not a footnote: the same corpus reads as 26.6% or 14.1%
depending on whether the prompt the agent was given counts as something the model
saw. It does.

### The gate is live

`TRACK_B_CORPUS_INADEQUATE` on all 40 corpora would be worthless if the gate
could not fire. Control **C2** builds twelve arms that each read 400,000
characters; they clear B0 comfortably and are labelled `ARTIFICIAL_MATERIALITY`,
which is a label, not a qualification. **C3** confirms one 400,000-character
outlier cannot carry nine ordinary arms. **C4** confirms the primary corpus holds
0 treated and 0 unknown-treatment arms. **C5** checks the instrument's own source
for any reference to a VTRACE compilation artefact — the §34 ordering rule
enforced mechanically, so a future edit that selects a corpus by how well VTRACE
compresses it fails the control instead of passing quietly.

```
C1  PASS  M194 still fails B0
C2  PASS  an artificial huge-read corpus clears B0, and is flagged artificial
C3  PASS  one huge outlier does not carry a low-median corpus
C4  PASS  the primary materiality corpus contains no treated arm
C5  PASS  corpus qualification never reads a VTRACE compilation artefact
```

### VEXP

`VEXP_CORPUS_B0_NOT_MEASURABLE`. The local checkout holds 1,372
`vexp-swebench-*.json` files, and every one is a SWE-bench *evaluation summary* —
resolved/unresolved instance ids. There is no trajectory, no tool result, no
repository-consumption evidence of any kind. VEXP was not executed.

### SWE-bench

```
SWEBENCH_CONTEXT_COMPILER_MATERIALITY_NOT_SUPPORTED
```

Across 44 repositories and 619 successful arms, the median SWE-bench task under a
strong unrestricted agent reads **one file**. This is a statement about context
*burden*, not about SWE-bench's usefulness: the tasks are localised by
construction, and a localised task has little repository reading to compress.

---

## 5. What this means

M197 Track B has no workload. That is not "we need more benchmark data" — it is
1,078 arms across 44 repositories agreeing, with a control proving the instrument
would have said yes to a workload that qualified.

The arithmetic was already visible in M196 and is now general. Seventy percent of
2,605 tokens is 1,824 tokens. VTRACE's tool schemas cost 5,521 prompt-prefix
tokens before the compiler emits anything. On the workloads VTRACE can observe, a
context compiler that worked perfectly would be **net negative**.

```
CONTEXT_COMPILER_PRODUCT_PROBLEM_NOT_YET_OBSERVED
```

Track A survives this intact and should not be conflated with it. Ingestion is now
100% on three corpora with proven determinism and span truth; latency claims A5–A7
already pass. Track A can honestly establish *VTRACE matches or exceeds VEXP's
deterministic engine claims* — an engineering fact about a repository index. It
cannot establish *VTRACE materially benefits strong coding-agent economics*, and
M196A found no evidence that the second claim has a workload to be true on.

The M196 architectural conclusion (`SUBSTANTIAL_RESTRUCTURE_IN_PLACE`) is not
reconsidered; nothing in the repair revealed an architectural blocker. But its
precondition — that the thesis passes its proof — is further away than M196
thought, and the reason is the workload, not the engine.

---

## 6. Authorization

```
NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
I6_VALIDATION_SELECTION_REMAINS_CLOSED
```

M196A implemented no compiler behaviour, weakened no threshold, and reopened no
hypothesis. The M197 preregistration changed only in the two ways §45 permits: a
documented corpus-identity correction and Track B materiality evidence.

```
preregistration before   4c46df38a4d832b804efea6cb44507b61aeab3c8e7b152acfcca925b99907488
preregistration after    736e8a9b5beba4a26d29ca068bafa2f4aede973ec50dab53bba6673f6697d8f0
semantic leaf changes    C-LARGE file count; A2/A3/A4/A8 declared priors; §4.3 materiality evidence
out-of-scope changes     0
```

---

## 7. Remaining issues

- **Incremental indexing has no incremental path.** A one-file change re-parses
  every file in the corpus (492/492, 346/346). Pre-existing; A3 fails honestly.
- **A single-file Python incremental refresh crashes** with
  `UNIQUE constraint failed: edges.id`. Pre-existing, reproduced with the repair
  reverted. This is a correctness defect, not a performance one.
- **The retrieval eval is currently index-blind.** All 105 fixture rows return
  `workspace_error` — stored index derivation `ce3463c2cdcd` against expected
  `6513050b8bdf` — before and after M196A. The suite fails closed as designed, so
  it can neither confirm nor refute a retrieval change; the byte-identical
  C-LARGE index hash carries that claim instead.
- **`tree-sitter` remains pinned at 0.21.1.** The buffer bug is worked around
  correctly, not removed. An upgrade is a separate, grammar-affecting change.
- **B0 measures only what VTRACE preserved.** Every corpus here is SWE-bench-shaped
  agent work. A genuinely different workload — architecture-scale refactors,
  cross-repository tasks, codebase-comprehension sessions — has never been
  observed by this project and would have to be acquired to test the thesis. That
  acquisition would cost money and is not authorized here.
