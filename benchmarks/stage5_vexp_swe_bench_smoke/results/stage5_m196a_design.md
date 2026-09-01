# M196A — design and preregistration

Frozen before measurement, at VTRACE `70fed996c7bbb29cfb928c889434435df2ee5955`
(the M196 head). M196A is a **$0, zero-agent readiness closure**. It does not
implement a context compiler, does not restructure the product, and does not
reopen a closed hypothesis.

M196 concluded `CONTEXT_COMPILER_ARCHITECTURE_WORTH_TESTING` and licensed M197 —
then measured two things that make running M197 immediately unsound:

1. M197's own ingestion veto **A8 already fails** (58.3% TypeScript coverage),
   traced to a parser defect. Running the proof now would confound *a known
   parser bug* with *the context-compiler thesis*.
2. The M194 trajectory corpus **already fails B0**, M197's materiality gate, so
   Track B would be run on evidence that cannot establish economic significance
   whichever way it came out.

M196A answers exactly two questions and stops.

---

## Q1 — ingestion authority

> After repairing the measured TypeScript ingestion defect, can VTRACE represent
> ≥ 99% of eligible source files in each frozen M197 corpus, deterministically and
> without silent omission?

## Q2 — material corpus

> Is there a realistic, reproducible workload available to us where repository
> evidence consumption is large enough to satisfy the frozen B0 criterion?

---

## Rules fixed in advance

**Denominators.** Coverage is reported against two denominators at once: every
source file on disk, and the product's own post-exclusion eligibility. A file may
leave the A8 denominator only under a reason the *repository or the product
declared independently of this measurement* — gitignore, the indexer's ignored
directories, or a nested worktree — and every removal is itemised with examples.
Coverage that rises because the denominator fell is a FAIL, not a result.

**The repair must be a repair.** It lives in the authoritative product ingestion
path. No truncation, no chunking that changes what the parser sees, no
benchmark-only allowance, no skipping large files, no special-casing a corpus.
Symbol identity, spans, call sites, imports and exports must survive.

**B0 is not negotiable.** `median repository-evidence tokens ≥ 20,000` OR
`repository evidence ≥ 25% of total model-facing tokens`, over **successful**
arms, with M196's frozen numerator: Read + Grep + Glob *result* bytes at
`floor(chars/4)`. Nothing else becomes repository evidence to make a corpus
qualify — not repository size, not tool schemas, not files that were never read,
not failed arms.

**Denominator for the share arm.** Provider-reported and cache-corrected:
`input + cache_creation + output`, summed per assistant message. `cache_read` is
excluded because it is precisely the re-sent prompt material §22 forbids counting.
A transcript reconstruction is reported alongside it as an explicit *upper bound*,
because it cannot see the system prompt and therefore overstates the share.

**Ordering, to prevent hindsight leakage.** Measure untreated burden → apply B0 →
freeze. Corpus qualification never reads a VTRACE compilation artefact; a control
checks the instrument's own source for that, so a future edit that reaches for a
capsule to decide which corpus qualifies fails the control rather than passing
quietly.

**Contamination.** The primary materiality corpus admits only arms whose
repository behaviour was not altered by treatment. Treated arms are measured and
reported, never pooled into the primary answer.

---

## Falsification controls, fixed in advance

Ingestion: **F1** below-boundary file parses; **F2** boundary-adjacent sizes
straddle the defect exactly; **F3** a real previously-omitted file is represented;
**F4** its spans resolve to the real source; **F5** three parses are identical;
**F6** a genuinely failing file cannot reach an excluded reason.

Materiality: **C1** M194 still fails B0; **C2** an artificial huge-read corpus
*does* clear B0 and is labelled `ARTIFICIAL_MATERIALITY` — without this the gate's
silence would be a fact about the instrument, not the workloads; **C3** one huge
outlier cannot carry a low-median corpus; **C4** the primary corpus holds no
treated arm; **C5** no post-VTRACE selection leakage.

---

## Declared possible outcomes, and what each means

`M197_A8_INGESTION_READY` + `M197_MATERIAL_CORPUS_READY` → M197 is fully ready;
present the frozen corpus to the owner and stop.

A8 ready, corpus not ready → Track A may still test VTRACE against VEXP's
engineering claims, but the **product thesis has no observed workload**. Report
`NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION` and do not restructure.

Neither → M197 is not ready.

A clean "no corpus qualifies" is an acceptable PASS, and may be the most important
result available: it says the problem the compiler exists to solve has not been
observed in any realistic strong-agent workload VTRACE holds. B0 is not to be
lowered to keep the programme alive.

---

## Out of scope, explicitly

No language expansion, no incremental-index tuning, no skeleton or rendering fix,
no budget-semantics change, no tool-surface reduction, no M197 execution. M196's
architectural conclusion (`SUBSTANTIAL_RESTRUCTURE_IN_PLACE`) is not reconsidered
unless the ingestion repair reveals a fundamental blocker.
