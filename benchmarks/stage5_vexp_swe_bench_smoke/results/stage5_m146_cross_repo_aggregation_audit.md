# M146-B — Cross-repository aggregation audit

## Strategies considered

| Strategy | Assessment |
| --- | --- |
| A. quota per selected repository | Rejected as the default: guaranteeing every selected repository a slot is diversity theatre when one repository holds the direct answer, and §35/§62 forbid support evicting it. |
| B. common-evidence re-ranking | Rejected for now: it requires converting each repository's candidates into comparable features, which is precisely the cross-repository calibration nothing has established. |
| C. lead repository + bounded support | **Shipped.** Matches the one-global-lead shape productContext already expresses, and needs no cross-repository score comparison. |

## What is never compared

Raw local scores. Each repository's ranking was calibrated against its own
corpus by M122–M145; nothing establishes that A's 1.9 outranks B's 1.8, or even
that rank 1 in A is worth rank 1 in B. Aggregation consumes only **local rank**,
which is meaningful within a repository by construction, and repository order
comes from routing evidence rather than any number.

## Admission

Rounds of local rank: every selected repository offers its rank 1, then its
rank 2. The primary repository's best candidate therefore takes the lead slot
before any support is considered, which satisfies "cross-repository mode must
not evict a direct answer" without a special case for it.

## Identity

`(worktreeId, relativePath, symbol)` — never any part alone. Two repositories
may hold the same relative path, the same fully-qualified name, and
byte-identical contents; collapsing those would be authority loss wearing
deduplication's clothes. A genuine repeat inside one repository still collapses,
because the rule targets lost provenance rather than dedupe as such.

## Budget

One request, one budget. Measured: three repositories offering 1000 tokens
against a 300-token budget deliver 200. Per-repository accounting reports
selected tokens and omissions so the split is auditable.

## Model-visible provenance

Rendered only when more than one repository contributed. Labelling every line of
an ordinary single-repository answer spends budget to tell the reader something
they already know, and §24 prefers no gratuitous output churn.
