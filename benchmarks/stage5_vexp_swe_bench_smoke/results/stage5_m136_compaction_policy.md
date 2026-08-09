# M136 deterministic compaction policy

Retrieval runs once. Delivery operates on the already selected, ordered item set.

The model-visible ladder is:

1. Compact repeated selection reasons to the strongest bounded reason.
2. Shorten low-priority support excerpts, lowest value and latest rank first.
3. Convert optional support to signature/minimal form.
4. Drop non-answer-bearing optional support one item at a time.
5. Skeletonize, then if necessary drop, secondary non-answer-bearing pivots.
6. Remove remaining weaker context before direct-answer or required evidence.
7. Reduce retained evidence to signature/defining lines.
8. Try one strongest minimal truthful item.
9. Emit explicit `delivery_failure` only if that representation cannot fit.

An item is narrowly answer-bearing when it is required or its existing M135 evidence contains a symbol-name, preferred-contrast, direct, or exact-match signal. This is a delivery priority only; it does not alter retrieval scores or ranks.

Minimal code representation is the repo-relative path, symbol/FQN identity, roles, content mode, line span when known, and up to eight defining/signature/doc lines (bounded to 480 characters). Metadata pressure is handled separately by removing compatibility manifests and verbose diagnostics while preserving repository/worktree identity, freshness, delivery state/accounting, and at least one structured item reference for successful responses.

The ladder is finite and deterministic. Every applied item transform reduces text or removes one item; final measurement still uses the shared chars/4 estimator and the M133 complete-response guard.
