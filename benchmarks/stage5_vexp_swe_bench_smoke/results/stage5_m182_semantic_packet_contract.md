# M182 semantic packet contract

`semanticPacketHash` is SHA-256 (reported as a 16-hex diagnostic prefix) over an
explicit record containing:

- terminal state;
- focus `at`, repository-relative file, lines, form, canonical primary `why`,
  bounded code, and truncation qualifier;
- related entries in delivered semantic-priority order, each with `at`, file,
  lines, and the verbatim authoritative `how` claim;
- interpretation-critical notes/qualifiers; and
- truthful decline state/reason/boundary when no orientation is delivered.

It excludes timing, elapsed duration, process/request ids, load telemetry and
accounting-only values. Array order is never normalized away: related order is
agent-semantic because it expresses priority and prefix admission. A separate
sorted related-set hash localizes membership from order changes.

Upstream localization uses four independent hashes:

1. `authoritativeSupplyHash`: stable candidate identities and roles, unordered;
2. `candidateOrderHash`: the same identities in published order;
3. `rankVectorHash`: published role/order plus exposed scorecard when available;
4. `semanticItemSupplyHash`: ordered product items, roles, reasons and modes.

Controls are in `stage5_m182_detector_controls.json`. Swapping two related entries
must change the semantic hash; changing timing/process telemetry must not; 100
unchanged same-process deliveries must produce one hash.
