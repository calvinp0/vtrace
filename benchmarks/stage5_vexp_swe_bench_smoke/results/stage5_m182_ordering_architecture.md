# M182 related-ordering architecture

## End-to-end order

```text
deterministic generator union (Map by symbol id)
  -> hybrid final score DESC, fqName ASC, symbolId ASC
  -> role refinement and bounded expansion
  -> pivot/support semantic tiers and scores, then FQN/symbol/path identity
  -> product drafts in pivot/support/actionability/impact/memory/rule order
  -> roleOrder ASC, identity ASC before first-wins dedupe
  -> budget keepPriority (includes authoritative index), then display id
  -> semantic-item supply published in retained authoritative order
  -> declared lead focus
  -> related items, then neighborhoods, first FQN wins
  -> prefix admission under the fixed orientation ceiling
```

The final order is not “alphabetical everything.” Lexical identity appears only
after semantic score/tier/role priority. No timing or system-load value enters a
score, comparator, dedupe key, or packer decision.

## Collections and dedupe

The raw hybrid union uses `Map<symbolId,...>` and evidence uses sets, but final
candidate ranking sorts by score/FQN/symbol ID. Assembly's `Map` is fed an
explicit `roleOrder, identity` sort. The orientation's first-FQN-wins `Set` is fed
the published semantic item order. Thus first-wins behavior exists, but its input
is not completion/query order.

## Async, database and filesystem

The four-way `Promise.all` in `assembleProductContext` destructures by input
position; it cannot publish completion order. Retrieval/packing is synchronous.
Material symbol, edge and file list queries either have `ORDER BY` or are mapped
by stable ID before a total comparator. Document traversal sorts directory names
and final paths. Source-file read latency happens after selection.

## Timing and cache

Timing is written to `productContext.timing`, `accounting`, and the response
budget's derived serialized-size fields. It changes authoritative debug bytes.
Those blocks are absent from the default orientation contract, and the explicit
semantic hash excludes them. Cache state can change those values, not evidence
priority.

## `<module>` invariant

`graphExpansion.ts` continues to traverse structural nodes but filters them
before candidate delivery. M182 adds no sort/filter and therefore preserves:
graph-visible, delivery-invisible, never focus/related/content.
