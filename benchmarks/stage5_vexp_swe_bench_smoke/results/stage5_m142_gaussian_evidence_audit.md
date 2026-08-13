# M142 §29/§36/§37/§42 — Gaussian concept-evidence audit

**Finding: the file is identifiable from evidence already in the index, but the
definition that answers the question is not — and no representation change
proposed so far closes that second gap.**

Measured against `arc-m141.sqlite` (ARC @`2f3fd462`), read-only.

## The query and its objectives

> *"How does ARC decide which Gaussian route keywords to emit?"*

Five objectives after project-name exclusion (`arc` is correctly excluded as a
project reference): `decide, gaussian, route, keyword, emit`.

## Where each objective's evidence lives, for `arc/job/adapters/gaussian.py`

| evidence class | objectives | count |
|---|---|---|
| indexed today | `gaussian` (basename + path), `keyword` | **2** |
| recoverable from body identifiers | — | **0** |
| recoverable only from developer comments | `route`, `emit` | **2** |
| absent from the file entirely | `decide` | **1** |

This is the one case in the four where a representation change would recover
anything at all — and what it would have to index is **developer comments**.
`route` occurs exactly twice in the whole file, both inside comments in
`write_input_file`; `emit` occurs once, in the same comment. An
identifier-and-literal body index — the safe, precision-friendly option —
recovers **nothing**.

## Why the file loses owner election today

```
arc/job/trsh.py                  ownerScore 0.8256   idfCoverage 0.8027  defs 18/25   [decide, gaussian, keyword×1.5, route]
arc/tckdb/adapter.py             ownerScore 0.7343
arc/output.py                    ownerScore 0.6130
...
arc/job/adapters/gaussian.py     ownerScore 0.4040   idfCoverage 0.3770  defs 2/9     [gaussian×2, keyword]
```

`gaussian.py` clears the 0.35 floor — it is a scored owner, just not a top-three
one. And it **cannot** climb, because `idfCoverage` is a fraction of the total
objective IDF: covering 2 of 5 objectives caps it at 0.377 even with the ×2
basename multiplier already applied. The three objectives it is missing are
exactly the three that live in comments or nowhere.

Meanwhile `arc/job/trsh.py` genuinely covers four of five objectives in indexed
metadata (`trsh_keyword_opt_maxcycles`, `trsh_keyword_inaccurate_quadrature`, …).
It is not junk — troubleshooting really does rewrite Gaussian route keywords —
but it is not the module that owns the decision either.

## §36/§37 — entity ownership is available and is not being used

The file's basename is exactly `gaussian`, and `gaussian` is a domain entity in
the query. That is strong, deterministic, already-indexed ownership evidence,
and it is categorically different from the coverage-aggregation the lane scores
today: *this module is the one named after the thing you asked about*.

Today that evidence is worth a ×2 multiplier on one objective's IDF inside a
coverage fraction — which is why it is swamped. §37's distinction matters here:
"Gaussian" is **not** a request for a symbol named `Gaussian` (that would be the
`which()` failure mode Workstream A exists to prevent); it is an entity whose
implementation a specifically-named module owns.

Precision controls this needs, per §38: basename must **equal** the entity token
(not contain it); the entity must not be the project name (`arc` is already
excluded, and ARC must never become entity ARC); an unrelated file that merely
*mentions* the entity in a comment or string must not be nominated — which
basename equality gives for free.

## The second gap, which entity ownership does not close

Even with `gaussian.py` elected as owner, the definition that answers the
question would not be admitted:

```
write_input_file   objectivesCarried: []   (none of decide, gaussian, route, keyword, emit)
```

Its entire indexed representation is eleven tokens — `file input write adapter
adapters arc gaussian gaussianadapter input job py execute server to` — and the
lane admits definitions *ranked by the objectives they carry*. A definition
carrying zero objectives is never in the candidate set for its own file, no
matter how the file scored. Only 2 of the file's 9 answer-bearing definitions
carry any objective at all.

So Gaussian decomposes into two independent problems:

1. **identifying the file** — solvable now, from entity/basename evidence
   already in the index;
2. **choosing the definition inside it** — not solvable from indexed metadata,
   because the 268-line method that builds the route line is represented by
   eleven tokens, none of them the concept.

## Bearing on §31 and §43

A comment/prose index would close (2) for this case. It would close nothing for
NMD, nothing for reactant-index, nothing for TS-order — measured, in
`stage5_m142_concept_evidence_matrix.json`. That is one case out of four, bought
with a new persistent evidence class carrying its own extraction rules,
staleness behaviour, precision controls, size accounting, and M141
capability/schema consequences.

§31 requires a general capability, not one hard case. This does not meet that
bar, and it is recorded as an explicit architectural ceiling rather than
implemented.
