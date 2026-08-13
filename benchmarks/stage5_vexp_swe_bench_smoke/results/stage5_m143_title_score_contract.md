# M143 Workstream A — the title lane's score contract

What the title lane is allowed to assert, after `93a34d1`. Companion to
`stage5_m143_title_lane_audit.md`, which measures why the rest is unchanged.

## The two things a title mention can buy

```
ADMISSION   the symbol the title names reaches the candidate pool
PROMOTION   that symbol becomes the LEAD edit target
```

M143 §104 requires these to be separable. They are separable in the code today
only for admission; promotion is still bought by the same act.

## Contract

### 1. A component vtrace did not measure reports 0 — ENFORCED

An injected title candidate exists *because* retrieval did not produce it, so
`lexical` / `fts` / `tfidf` / `bm25` were never computed for it. They are now
`0`, not `1`.

`symbol: 1` is retained and is not a fabrication: the title names the symbol by
exact local name, which is precisely what the `symbol` component means.

The rule generalises past this lane: **a synthesized candidate may assert the
evidence that produced it, and nothing else.** A lane that fabricates the
components of channels it never ran is lying to every downstream consumer that
reads a scorecard — here the role gate and the decoy classifier, which is how
`django-11740` came to show the model a "strong lexical match" that did not
exist.

### 2. Admission is unconditional — ENFORCED (unchanged)

Every resolved title symbol enters the pool, capped at 3 per term and 6 overall.
This is the recall the lane exists for: on `sympy-16766` a body word
(`lambdify`) outranks the edit site 2.428 to 1.291, and without admission the
gold file is never a candidate at all. §18 protects it and M143 does not trade
it away.

### 3. Promotion is still unconditional — NOT YET CONSTRAINED

An admitted title symbol receives `final = 2.5` and `evidenceTier = 2`, and the
pivot comparator sorts on tier *before* score. So a title match leads regardless
of how strong the competing evidence is.

This is the M143-A ceiling. It is documented rather than fixed because eight
measured mechanisms failed to separate the case where promotion is wrong
(`django-11740`) from the four where it is right — see the audit, §4. Measured
on the frozen 50 the lane's promotions are **4 correct : 1 wrong**, so every
mechanism that demotes them as a class is net-negative.

### 4. Constraints any future fix must satisfy

- **Both producers.** Lowering `TITLE_SYMBOL_FINAL` alone changes nothing:
  `evidenceTier` is compared first. `titleSymbolIds` has six consumers.
- **No fitted constant** (§9). Hub in-degree separates the cases only via a
  threshold chosen between 9 and 188, which is benchmark-fitting.
- **Asymmetric error cost.** A wrong suppress destroys a correct lead; a wrong
  abstain leaves a known defect. Abstain on ambiguity (§46).
- **Candidate-local** (§15). Ownership/relevance must derive from the title, the
  candidate, and the candidate's own evidence — not from who else is in the pool.
- **Do not bypass centrality gating** (§72). `ForeignKey` carries 188 dependents
  and M142-B caps its centrality at 56%; a synthesized scorecard skips that cap
  entirely. Scoring a title candidate organically must keep the cap.

### 5. Not attempted, deliberately

Re-running retrieval with title symbols as seeds was considered and dropped:
`DEFAULTS.symbolPoolSize = 6` bounds the seed search so narrowly that seeding
`ForeignKey` did **not** admit the `ForeignKey` class (measured), and widening
it rescales `maxCentrality` for the whole pool — a broad perturbation to fix one
case. Recorded so the next milestone does not re-measure it.
