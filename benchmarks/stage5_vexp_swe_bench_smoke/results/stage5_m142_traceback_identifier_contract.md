# M142 — Traceback frame identifier contract

Workstream A established that an ordinary query word may not claim to **be** a
symbol's name. That rule is right, and it stays. What it got wrong was treating a
bug report as though every word in it had been chosen by the reporter.

A traceback frame names the function the interpreter was executing. Nobody typed
`unparse` into sphinx-7462's report — CPython printed it. That makes it the
strongest code cue the report carries, and precisely the sort of evidence A
exists to protect. Instead A dropped it, and `sphinx/pycode/ast.py::unparse`
stopped being generated at all. The gold file cannot be edited without it.

This is a query-grammar false negative, not a historical-gold correction.

## What counts as a frame

Two shapes, decided by syntax rather than vocabulary:

| Shape | Admits | Why |
|---|---|---|
| `File "<path>", line <n>, in <name>` | any identifier | The complete construction cannot be a sentence, so a plain lowercase name like `unparse` is safe here — and nowhere else. |
| `line <n>, in <name>` | qualified or snake_case only | Nothing anchors a bare tail, and *"see line 42, in particular the retry loop"* is ordinary English. |

`<module>`, `<listcomp>` and `<genexpr>` are frame labels, not names, and match
neither shape.

## How much of the chain is trusted

**One frame.** A traceback is a *call chain*, and a deep one names a dozen
functions — most of them library plumbing the reporter never chose, and often not
this project's code at all. Admitting all of them was measured on the frozen 50
and it moved the lead onto whichever file happened to own the most frames:

- **xarray-3677** contributed three names that all live in `merge.py`, which then
  outvoted `dataset.py` — the file the request was actually about.
- **pylint-8898** contributed `compile`, `parse`, `_parse_sub` and `_parse`,
  which are CPython's own `sre_parse` and name nothing about pylint.

A dozen exact-name assertions drown the prose they were supposed to support.

## When the frame can be identified at all

Bounding to one frame was not sufficient. Both remaining regressions came from a
*single* admitted name that was generic enough to match by coincidence — which is
the `which()` failure mode arriving by a new route. Two structural conditions
now gate the rule:

**The traceback must be complete.** The exception has to appear after the frame.
Without it, the deepest listed frame is not where execution stopped; it is where
the excerpt was cut. pylint-8898 is truncated mid-`sre_parse`.

**The name must not be a language-protocol dunder.** Every class may define
`__getattr__`; the runtime entered one, but xarray-3677's bug is upstream in
`dataset.py::merge`, not in the accessor that happened to raise.

Both are shape rules over the traceback's own syntax. Neither mentions a project,
file, or symbol, and neither is a vocabulary list.

## Measured outcome

Isolated against the M142 checkpoint (`0c5e544` → `e453366`), frozen 50,
`provenanceValid=true`, with a null control proving the two prepared corpora are
interchangeable (0/50 changed under one implementation):

| Metric | Before | After |
|---|---|---|
| Top-1 gold file | 38 | 38 |
| Top-3 gold file | 44 | 44 |
| Gold file anywhere | 48 | 48 |
| **Gold symbol anywhere** | 30 | **31** |
| Missing gold | 2 | 2 |
| Mean tokens | 1840.22 | 1835.72 |

Two cases move. **sphinx-7462** delivers `sphinx/pycode/ast.py` at rank 2, recovers
the gold symbol `unparse`, and costs 257 fewer tokens. **sympy-13372** is neutral
on all four gold metrics — it narrows to the gold file alone.

No new gold regression. The prose controls A was built for are unchanged: `in` on
its own still names nothing.
