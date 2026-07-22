# Stage 5 M123 Product Retrieval Ranking and Selection Convergence

## Summary

M122 product v1 lost 23 cases because a closed symbol-level FTS/graph set and independent capsule packing displaced direct evidence. M123 selects Design D: the proven Capsule v2 hybrid core is authoritative, while M121 routed FTS remains bounded diagnostics/rescue. Corrected product v2 passes the frozen thresholds. The actual TCKDB checkout is unavailable, so its required acceptance cannot be rerun. Decision C; verdict MIXED. Recommendation: use legacy-quality shared core as product authority pending TCKDB confirmation.

## Retrieval Architecture

Legacy: buildCapsuleV2 → hybridRetrieve. M122: routeQuery → FTS → closed-set graph rerank → v1 capsule. M123: routed diagnostics plus authoritative buildCapsuleV2 selection projected into every historical product response.

## Candidate Lifecycle

The stage trace records raw lexical rank, graph rank/contributions, Capsule v2 score components, selection role, and exclusion reason for each frozen expected file.

## M122 Loss Taxonomy

- exact candidate generated but underweighted: 3 cases
- final file-cap / role-assignment loss: 12 cases
- generation miss: 7 cases
- graph-centrality crowd-out: 1 cases

## Architecture Decision

Design D was selected because the established hybrid core already supplies BM25, shaped path/symbol lanes, test/import/body-literal/graph expansion, bounded hub penalties, role refinement, co-edit recovery, and compressed-cost packing. Rebuilding those signals in product v1 would preserve two selectors.

## Ranking and Fusion Policy

Direct task evidence remains stronger than bounded graph centrality. Duplicate symbols merge inside the hybrid union; hub and low-actionability penalties are explicit. Role diversity and compressed cost are applied only after relevance.

## Product/Legacy/V2 Metrics

```json
{
  "legacy": {
    "cases": 50,
    "top_1_file_recall": 0.8,
    "top_5_file_recall": 0.92,
    "any_gold_recall": 0.92,
    "all_gold_visible_recall": 0.9,
    "lead_pivot_recall": 0.8,
    "hidden_coedit_all_visible_recall": "not available",
    "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
    "required_target_recall": "not available",
    "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
    "support_file_recall": "not available",
    "support_file_reason": "Frozen fixtures do not label support-role files.",
    "missing_count": 4,
    "wrong_pivot_count": 10,
    "overpacked_count": 0,
    "no_candidates_count": 0,
    "median_model_visible_tokens": 1208,
    "p90_model_visible_tokens": 4046,
    "median_selected_file_count": 4,
    "p90_selected_file_count": 6,
    "median_retrieval_latency_ms": null,
    "p90_retrieval_latency_ms": null
  },
  "product_v1": {
    "cases": 50,
    "top_1_file_recall": 0.3,
    "top_5_file_recall": 0.5,
    "any_gold_recall": 0.5,
    "all_gold_visible_recall": 0.46,
    "lead_pivot_recall": 0.3,
    "hidden_coedit_all_visible_recall": "not available",
    "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
    "required_target_recall": "not available",
    "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
    "support_file_recall": "not available",
    "support_file_reason": "Frozen fixtures do not label support-role files.",
    "missing_count": 25,
    "wrong_pivot_count": 35,
    "overpacked_count": 0,
    "no_candidates_count": 0,
    "median_model_visible_tokens": 3192,
    "p90_model_visible_tokens": 5955,
    "median_selected_file_count": 3,
    "p90_selected_file_count": 4,
    "median_retrieval_latency_ms": 14.934,
    "p90_retrieval_latency_ms": 48.24
  },
  "product_v2": {
    "cases": 50,
    "top_1_file_recall": 0.78,
    "top_5_file_recall": 0.92,
    "any_gold_recall": 0.92,
    "all_gold_visible_recall": 0.9,
    "lead_pivot_recall": 0.78,
    "hidden_coedit_all_visible_recall": "not available",
    "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
    "required_target_recall": "not available",
    "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
    "support_file_recall": "not available",
    "support_file_reason": "Frozen fixtures do not label support-role files.",
    "missing_count": 4,
    "wrong_pivot_count": 11,
    "overpacked_count": 0,
    "no_candidates_count": 0,
    "median_model_visible_tokens": 1208,
    "p90_model_visible_tokens": 4046,
    "median_selected_file_count": 4,
    "p90_selected_file_count": 6,
    "median_retrieval_latency_ms": 2629.906,
    "p90_retrieval_latency_ms": 10501.043
  },
  "byCorpus": {
    "django-expanded-20": {
      "legacy": {
        "cases": 20,
        "top_1_file_recall": 0.9,
        "top_5_file_recall": 1,
        "any_gold_recall": 1,
        "all_gold_visible_recall": 0.95,
        "lead_pivot_recall": 0.9,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 0,
        "wrong_pivot_count": 2,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 1185,
        "p90_model_visible_tokens": 2484,
        "median_selected_file_count": 3,
        "p90_selected_file_count": 6,
        "median_retrieval_latency_ms": null,
        "p90_retrieval_latency_ms": null
      },
      "product_v1": {
        "cases": 20,
        "top_1_file_recall": 0.35,
        "top_5_file_recall": 0.65,
        "any_gold_recall": 0.65,
        "all_gold_visible_recall": 0.6,
        "lead_pivot_recall": 0.35,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 7,
        "wrong_pivot_count": 13,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 2549,
        "p90_model_visible_tokens": 4668,
        "median_selected_file_count": 3,
        "p90_selected_file_count": 4,
        "median_retrieval_latency_ms": 12.056,
        "p90_retrieval_latency_ms": 28.221
      },
      "product_v2": {
        "cases": 20,
        "top_1_file_recall": 0.9,
        "top_5_file_recall": 1,
        "any_gold_recall": 1,
        "all_gold_visible_recall": 0.95,
        "lead_pivot_recall": 0.9,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 0,
        "wrong_pivot_count": 2,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 1185,
        "p90_model_visible_tokens": 2484,
        "median_selected_file_count": 3,
        "p90_selected_file_count": 6,
        "median_retrieval_latency_ms": 3377.073,
        "p90_retrieval_latency_ms": 10501.043
      }
    },
    "cross-repository-30": {
      "legacy": {
        "cases": 30,
        "top_1_file_recall": 0.733,
        "top_5_file_recall": 0.867,
        "any_gold_recall": 0.867,
        "all_gold_visible_recall": 0.867,
        "lead_pivot_recall": 0.733,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 4,
        "wrong_pivot_count": 8,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 1217,
        "p90_model_visible_tokens": 5377,
        "median_selected_file_count": 4,
        "p90_selected_file_count": 6,
        "median_retrieval_latency_ms": null,
        "p90_retrieval_latency_ms": null
      },
      "product_v1": {
        "cases": 30,
        "top_1_file_recall": 0.267,
        "top_5_file_recall": 0.4,
        "any_gold_recall": 0.4,
        "all_gold_visible_recall": 0.367,
        "lead_pivot_recall": 0.267,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 18,
        "wrong_pivot_count": 22,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 4051,
        "p90_model_visible_tokens": 6161,
        "median_selected_file_count": 3,
        "p90_selected_file_count": 4,
        "median_retrieval_latency_ms": 15.037,
        "p90_retrieval_latency_ms": 48.24
      },
      "product_v2": {
        "cases": 30,
        "top_1_file_recall": 0.7,
        "top_5_file_recall": 0.867,
        "any_gold_recall": 0.867,
        "all_gold_visible_recall": 0.867,
        "lead_pivot_recall": 0.7,
        "hidden_coedit_all_visible_recall": "not available",
        "hidden_coedit_reason": "Frozen fixtures label expected files but do not distinguish hidden/co-edit files.",
        "required_target_recall": "not available",
        "required_target_reason": "Frozen fixtures do not label required versus optional target roles.",
        "support_file_recall": "not available",
        "support_file_reason": "Frozen fixtures do not label support-role files.",
        "missing_count": 4,
        "wrong_pivot_count": 9,
        "overpacked_count": 0,
        "no_candidates_count": 0,
        "median_model_visible_tokens": 1217,
        "p90_model_visible_tokens": 5377,
        "median_selected_file_count": 4,
        "p90_selected_file_count": 6,
        "median_retrieval_latency_ms": 1610.275,
        "p90_retrieval_latency_ms": 9797.667
      }
    }
  }
}
```

Authoritative-core latency (ms): {"median":2629.906,"p90":10501.043,"maximum":25517.549}. Product v1 remains the low-latency historical baseline; v2 pays for the quality core without increasing context budgets.

## TCKDB Acceptance

See `stage5_m123_tckdb_acceptance.json`.

## Generic Distractor and Graph Controls

Focused tests cover central irrelevant hubs, exact targets, package/support behavior, score determinism, and authority projection.

## Cross-Tool Convergence

`get_code_context`, default `get_context_capsule`, and `run_pipeline` now obtain the same authoritative selected capsule; M119 `productContext` uses the same Capsule v2 core.

## Compound-Query Regression

M121 routed compound/path diagnostics remain unchanged. A post-freeze attempt to inject full raw-task decomposition into every hybrid lexical pass was reverted after it degraded top-1 to 58%; normal hybrid ordering is intentionally preserved.

## Product Baseline

`product-retrieval-v2`; decision C, legacy-quality shared core is product authority.

## Invariants

Worktree/indexing, M119 accounting, M120 static impact truthfulness, M121 routing diagnostics, and no-live behavior remain unchanged. No gold/outcome fields enter runtime scoring.

## Limitations

Retrospective frozen-corpus correction; no untouched holdout or live-agent-effect claim. Markdown and tokenizer-exact coverage remain deferred.

## Deferred Work

Prospective validation, 100-case seam, M124 cross-repository workspace intelligence, tokenizer-exact accounting.

## Success Criteria Check

Frozen quality thresholds pass when all required recall/count gates are applied; TCKDB and full verification are separate required gates.

## Verdict

MIXED

## Recommendation

use legacy-quality shared core as product authority
