# M137 exact-answer plan

Starting point: `main` at evidence HEAD `3c786e27a76f159c3dfd62e9d58fa5bdba31406e`; functional predecessor `f48f8c11f0cf76805943e98baa4fc3f566400d39`; 10 ahead, 0 behind, with unrelated dirt preserved.

1. Extend the existing request-local `DerivedQueryIntent` with a conservative `capability_lookup` kind, structured symbol hypotheses, and project-reference metadata.
2. Make structured eligible hypotheses the only prose-derived source for `likelySymbols`; retain ordinary words in semantic/FTS terms.
3. Add one bounded definition-local `directAnswerScore` over indexed name, kind, signature, docstring, and conservative parameter shape.
4. Reuse the derived intent in organic and synthetic candidate scoring, preserving explicit symbols, comparisons, behavior, callers, contrast, graph, path, and document lanes.
5. Validate generic fixtures, the exact ARC query, budget/flow/impact/worktree controls, TCKDB read-only evidence, scale/performance, and M134 paired provenance.
6. Commit functional code locally, then commit named evidence/report artifacts separately; do not push.

Out of scope: stale observations, workspace/multi-repository aggregation, embeddings, model rewriting, broad weight retuning, new MCP tools, agents, Docker, VEXP, and network services.
