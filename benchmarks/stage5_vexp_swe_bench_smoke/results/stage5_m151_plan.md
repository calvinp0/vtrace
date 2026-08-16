# M151 — Wire Workspace Routing into Real Product Surfaces (plan)

Predecessor (M150 final functional): `2d3010e4e5eb28d5febf78c6014cd394817cb7ec`
M150 evidence commit / M151 base: `6117f5f2dfa49ab0511db904100ed0b05c7b30fe`
Branch `main`, 33 ahead of `origin/main`, nothing pushed, 14 pre-existing worktrees.

M151 is wiring, not retrieval work. M150's chain is a preservation invariant (§2, §3):
no operation parsing, mechanism fact, subject alignment, implementer/consumer relation,
answer-role pivot eligibility or direct-evidence gate is touched.

---

## What the audit established

See `stage5_m151_product_call_path_audit.md` and `stage5_m151_authoritative_product_seam.md`.

1. `get_code_context` is a freshness wrapper that delegates to `run_pipeline`.
   `assembleProductContext` is the single-repository product producer, shared by
   3 MCP tools and 2 CLI commands.
2. 7 of 9 workspace capabilities — all routing, path/symbol membership, evidence
   claims and cross-repo composition — have **no** product caller
   (`stage5_m151_workspace_reachability_before_after.json`, `before`). Identity and
   readiness are reachable, but only from the `workspace` CLI status command.
3. The gap is **active, not passive**: with a `workspace.json` present, every
   `get_code_context` / `run_pipeline` / `get_context_capsule` call returns
   `invalid_request`, and the remediation the error names cannot be performed.
4. `index_status` emits an unbounded per-member status list in a workspace.

## Seam

Route **before** the database binding, never at the product producer, because the v1
orchestration and the product context share one binding and must describe one
repository (§42). Routing is inserted only into M132's lowest precedence branch, so
an explicit `repo_root` or `repos` is never overridden (§73, §11).

---

## Workstreams

### M151-A — Product call-path and authority audit — **complete**

Artifacts: `stage5_m151_plan.md`, `stage5_m151_product_call_path_audit.md`,
`stage5_m151_authoritative_product_seam.md`,
`stage5_m151_workspace_reachability_before_after.json` (`before`).

### M151-B — Wire workspace routing into the authoritative product context

- New resolver composing `resolveWorkspaceRegistry` → `evaluateWorkspaceReadiness` →
  `nominateRepositories`, returning a lead root, bounded routing summary and the
  supporting set.
- Replace the `hasMultiRepoRequest` refusal in `run_pipeline` and
  `get_context_capsule` with the resolver.
- Single-member fast path ends at the existing producer; `assembleWorkspaceProductContext`
  is used only when more than one repository contributes.
- Hard gates: refused members never opened for retrieval; no read-path index
  mutation; lead bound to correct repository/worktree/index identity.

### M151-C — Bounded routing/coverage metadata

- Routing summary and M149 coverage survive MCP serialization, bounded and additive.
- `index_status`: bounded workspace coverage; the unbounded member list is the
  defect to remove. Readiness truth per member is unchanged and stays separate from
  routing completeness (§18, §81).

### M151-D — Real product-path corpus + single-repo parity

Every case runs through the real MCP surface, not `nominateRepositories` directly (§100).
16-scenario corpus (§99) plus real ARC/TCKDB acceptance and the §102 parity comparison.

### M151-E — Preservation, paired benchmarks, performance, evidence

M150/M149/M148/M147/M146/M142/M141/M140/M139 gates; paired Frozen50 / Django /
cross_repo_30 against `2d3010e4` via the M134 framework; latency, response-scale and
index-open tables; ARC + TCKDB authoritative index verification; full suite,
both typechecks, `git diff --check`.

---

## Standing constraints

- No live agents, VEXP, Docker, paid APIs or network evaluation (§126).
- No index schema or derivation fingerprint change (§117).
- Commit locally on `main`, no push, no co-author trailers, coherent commits (§147).
- Pre-existing worktrees and unrelated dirt untouched; any M151-created worktree or
  synthetic member directory removed before close.
