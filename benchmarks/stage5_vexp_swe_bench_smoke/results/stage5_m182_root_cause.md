# M182 root-cause classification

## Answer

Ordinary load/concurrency does **not** change current VTRACE's model-facing
semantic orientation for identical authoritative evidence in the measured
regime. No code path turned execution order or timing into related selection.

The M176 historical observation (11/200 arm differences when arms were separated
by minutes under concurrent load, 0/11 when interleaved) is reclassified as an
`ENVIRONMENTAL_ONLY_FALSE_POSITIVE`, not as a current product defect. It was an
unpaired cross-time comparison with no preserved first-divergence stage. M182's
stage hashes now show that neither current upstream generation nor downstream
projection varies under the corresponding controlled conditions.

## First-divergence trace

There is no semantic first divergence:

```text
authoritative supply       identical
candidate order            identical
rank vector                identical
semantic item supply       identical
projection/packer packet   identical
```

Full debug response bytes do vary. The varying leaves are diagnostics/accounting
timings and values derived from their serialization. Those fields do not enter
the default orientation packet, and six real MCP default responses were byte
identical. This is `SERIALIZATION_ONLY_NOISE` locally, but the required single
historical root-cause verdict is `ENVIRONMENTAL_ONLY_FALSE_POSITIVE` because no
current semantic defect exists.

## Tie answer

No equal-ranked final candidate is resolved by completion, query or unstable
insertion order. Primary semantic scores can tie, but material comparators finish
with repo-relative path, FQN and/or stable symbol ID. JavaScript stable sort is
not being asked to turn an unstable producer into semantic authority at these
seams.
