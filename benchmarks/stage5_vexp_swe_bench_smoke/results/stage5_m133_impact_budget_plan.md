# M133 impact response budget plan

Invariant: a budget applies to the complete delivered product response, not one
intermediate representation. Traversal work, the retained canonical result, and
the serialized envelope are separate limits.

- `max_edges`: maximum unique canonical impact edges delivered. Traversal may
  examine more; diagnostics name inspected, retained, and omitted counts.
- `max_depth`: maximum retained path depth.
- `max_paths`: maximum retained paths, all backed by canonical edge IDs.
- `max_tokens`: chars/4 estimate for `edges`, `nodes`, `view`,
  `directRelations`, and `paths`. Complete impact delivery adds
  `max(800, 15%)` metadata tokens and has an 80,000-character absolute guard.

Compaction order is deterministic: remove repeated source bodies; select direct
evidence then bounded compatibility edges; derive endpoint nodes and view;
remove paths/secondary classifications; compact accounting/diagnostics; prefer
direct callers over transitive compatibility rows; remeasure the complete JSON.
If no useful valid object fits, return a bounded structured degradation.
