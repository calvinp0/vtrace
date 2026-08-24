# M182 architecture decision — stability is a measured property, not a new sort

Keep the compact orientation unchanged.

The stable contract is:

```text
semantic score / declared role priority
then existing stable semantic identity
then prefix packing in that published order
```

The audit found that contract already implemented at every material related-item
selection seam. The experiment found no counterexample. Therefore M182 does not
add a global sort, does not alphabetize packets, does not alter dedupe winners and
does not freeze an extra array after generation. Any of those would create a
second ordering owner without a first divergence to justify it.

Timing remains diagnostic. Full authoritative debug responses may differ in
timing/accounting bytes, but the default agent packet omits that telemetry and is
stable. Cache state may change latency, never priority. `<module>` remains
graph-visible and delivery-invisible because M182 changes no candidate filter.

Formal decisions:

```text
stability    SEMANTIC_PACKET_STABILITY_VALIDATED
root cause   ENVIRONMENTAL_ONLY_FALSE_POSITIVE
repair       NO_PRODUCT_CHANGE_REQUIRED
product      KEEP_COMPACT_ORIENTATION_UNCHANGED
```
