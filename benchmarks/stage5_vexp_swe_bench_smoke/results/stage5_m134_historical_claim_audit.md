# M134 corrective audit of deterministic equivalence claims

This audit does not rewrite old reports. It supersedes only deterministic
retrieval-equivalence assertions whose old proof depended on the stale M103
golden. “Old proof invalid” is not treated as “claim false.”

| Milestone(s) | Original claim class | Old proof | M134 status | Corrective evidence |
|---|---|---|---|---|
| M103 | structured-task baseline promoted | fixture and result regenerated together | `CONFIRMED_BY_RECONSTRUCTION` | last trustworthy baseline: implementation `199769f`, promotion `f14aab8` |
| M104–M120 | retrieval/frozen output unchanged where stated | comparisons ultimately inherited the M103 static golden; implementation binding absent | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` for the two cases responsible for the cumulative delta; other broad 50-case statements remain bounded by their original evidence | isolated replay shows both implicated cases unchanged at M103, M119, and M120 |
| M121–M122 | intentional retrieval changes with no movement in the implicated cases | stale static comparison could not prove predecessor identity | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` for headline attribution | adjacent isolated replay, same targets, hashes identical through M122 |
| M123 | product-v2 Top-1 `0.700` versus legacy `0.733` | aggregate was recorded, but no provenance-bound historical transition | `SUPERSEDED_BY_RECONSTRUCTION` | M122→M123 independent-index replay identifies requests-1724 (Top-1) and sphinx-7462 (support composition) |
| M124 | frozen semantic output unchanged | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M123/M124 full 50 semantic hashes match |
| M125 | optimized product retrieval preserves output | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M124/M125 full 50 semantic hashes match |
| M126 | hybrid optimization preserves output | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M125/M126 full 50 semantic hashes match |
| M127–M128 | legacy delivery removal / mixed document changes preserve frozen suites | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M126/M128 full 50 semantic hashes match; intervening diff does not change Capsule-v2 retrieval |
| M129 | document-aware optimization preserves output | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M128/M129 full 50 semantic hashes match |
| M130–M131 | flow/envelope/scalability changes preserve retrieval | static golden provenance incomplete | `UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED` | M129/M133 full 50 endpoint hashes match and product diff is flow/envelope/index-path scoped |
| M132 | frozen output unchanged by nested-worktree exclusion/project-name correction | same-checkout stash A/B, separate from refreshed stale files | `CONFIRMED_BY_RECONSTRUCTION` | M132's own A/B remains valid; M134 does not attribute the cumulative delta to M132 |
| M133 | M132→M133 0/50 and byte-identical | tracked direct semantic comparison | `CONFIRMED_BY_RECONSTRUCTION` | response/impact-only diff plus full M133 replay |

No audited claim is classified `UNSUPPORTED_AND_CHANGED`: the only cumulative
movement was an intentional retrieval-architecture transition at M123, and its
own report disclosed the aggregate tradeoff. The defect was that later static
golden comparisons could appear authoritative without proving their predecessor.

## Why the previous system could not catch it

- M130 exposed a missing **whole-response** measurement dimension: bounded model
  context did not imply a bounded serialized response.
- M131 exposed a missing **graph-size** dimension: small fixtures did not exercise
  repository-scale traversal failure.
- M134 exposes a missing **baseline-provenance** dimension: identical candidate
  and stored JSON did not prove which implementation produced the stored side.

This was not just a missed refresh. The benchmark accepted an unbound file as an
authoritative predecessor, so an invalid comparison could legitimately print PASS.

## Latency and live-evidence side audit

Historical latency claims often name the benchmark and implementation milestone
but do not consistently bind commit/tree, target corpus, and warm/cold process
protocol. They are `provenance_partial`; M134 does not rerun or invalidate them.
Existing live-agent artifacts generally identify instance and model/protocol but
predate the complete benchmark-provenance block, so they are also
`provenance_partial`. No live agent, paid API, Docker, or VEXP run was repeated.
