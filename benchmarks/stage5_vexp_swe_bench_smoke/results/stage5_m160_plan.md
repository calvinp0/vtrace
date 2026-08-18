# M160 plan — independent broad retrieval generalization

**Replication-first.** M160 proposes no retrieval change and may legitimately end
with the M159 theory retired. The product is frozen for the whole milestone.

## The question

Do the residual retrieval failure mechanisms M159 localized on broad100 reproduce
on a **new, disjoint, unfamiliar** SWE-bench corpus — or were they properties of a
corpus that five milestones have now read?

## Why this shape

Broad100-A has been used for historical checkpointing, delivery analysis,
availability analysis, support-packing analysis, first-divergence localization and
several intervention simulations. It is consumed development evidence. A causal
distribution measured on it can no longer distinguish "how VTRACE fails" from "how
these hundred tasks fail". Only an independently frozen corpus can.

M159's own standing findings make the risk concrete: its largest residual class is
8 cases across 4 repositories and is sympy-weighted, exactly as M153's evidence was
sphinx-weighted. §68 forbade building on it there; §56 forbids building on it here
until the weighting is measured on unfamiliar tasks.

## Workstreams

| | scope | may be skipped |
| --- | --- | --- |
| A | reconstruct Broad100-A identity; build, integrity-gate and freeze Broad100-B | no |
| B | run the frozen product across Broad100-B; broad metrics + gold fate | no |
| C | localize every useful residual to a first divergence, with detector controls | no |
| D | subtype repeated causal populations; cross-corpus intervention simulation | **yes — only if C finds a repeated population** |
| E | cross-corpus comparison, preservation, functional decision | no |

## Method commitments

- **Select before measuring.** Membership is fixed and hashed before a single
  retrieval runs, from metadata that never mentions VTRACE.
- **Integrity before retrieval.** M159 discovered two Broad100-A instances whose
  gold file was never checked out — after they had counted as retrieval failures
  for two milestones. Broad100-B gates every instance on the source tree first.
- **Corpus-invalid is not a product failure.** Gold file absent from the checkout
  is `CORPUS_INVALID`; gold file present but absent from the index is
  `INDEX_FILE_MISSING`. These are never merged.
- **Detectors carry known positives.** M159's reach detector reported a clean zero
  on `sympy-13480` while the product was delivering the symbol through a
  post-hybrid lane. A zero without a control is not evidence.
- **First divergence means earliest causal loss**, inherited verbatim from M159 so
  the two distributions are comparable.
- **No product code changes.** Not in A, not in B, not in C, not in D. If strong
  replication appears, M160 still stops at a recommendation — the moment the
  product moves because of Broad100-B, Broad100-B becomes calibration data.

## Success

M160 succeeds if a disjoint corpus is frozen and evaluated under the unchanged
product, its residuals are localized with the M159 framework, and the prior
ceilings are either independently replicated or rejected. A clean falsification is
a PASS. Manufacturing a replication is a FAIL.
