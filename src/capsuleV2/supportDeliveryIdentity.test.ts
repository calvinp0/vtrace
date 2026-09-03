// M158-C — one canonical delivered identity may consume at most one support slot.
//
// Support renders signature-only, so two genuinely DISTINCT candidates can
// deliver byte-identical text: a method overridden in four classes of one file,
// a flag assigned in ten. Measured on the M156 broad100, 10 of 99 cases spend a
// scarce slot restating evidence the capsule already delivered — `django-16819`
// spends three of its four slots on the literal text
// `def reduce(self, operation, app_label):`.
//
// The candidates are legitimately different symbols and deduping them upstream
// would be wrong. What repeats is the EVIDENCE the model is shown. So the rule
// keys on the rendered delivery and nothing else: same file is not redundancy,
// same symbol name is not redundancy, and two same-named entries whose bodies
// differ both stay.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import type { Database } from "bun:sqlite";
import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { seedFile, type SymbolSpec } from "./__fixtures__/capsuleV2Fixture";
import { CapsuleIntent } from "./types";

const TASK =
  "value_from_datadict widget returns the wrong value for the datadict name. "
  + "The widget value_from_datadict lookup should read the datadict name and "
  + "return the widget value.";

const REDUNDANT_PREFIX = "redundant support: identical delivered evidence to ";

/** The delivered text of a support item — what the rule keys on. */
const delivered = (item: { source?: string; signature?: string; symbol: string }): string =>
  item.source ?? item.signature ?? item.symbol;

const redundantDiscards = (result: { discarded: Array<{ discard_reason: string }> }) =>
  result.discarded.filter((item) => item.discard_reason.startsWith(REDUNDANT_PREFIX));

/**
 * Six classes in one file overriding the same method (the `django-16819`
 * shape). Two of them win the pivot slots and render full source; the rest
 * compete for support, where they render signature-only and — when
 * `varySignatures` is false — deliver byte-identical text.
 *
 * `varySignatures` is the negative control in the same fixture: the classes,
 * names, file and relation are all unchanged and only the delivered evidence
 * differs, so any rule that collapses BOTH shapes is keying on something other
 * than the delivery.
 */
function seedRepeatedOverride(varySignatures = false) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-m158-dup-"));
  const db = openIndexerDatabase();
  const classes = ["A", "B", "C", "D", "E", "F"];

  const specs: SymbolSpec[] = [];
  for (const name of classes) {
    const signature = varySignatures
      ? `def value_from_datadict(self, data, files, name, strict_${name.toLowerCase()}=True)`
      : "def value_from_datadict(self, data, files, name)";
    specs.push({ localName: `Widget${name}`, kind: SymbolKind.Class, body: `class Widget${name}:\n    pass` });
    specs.push({
      localName: "value_from_datadict",
      kind: SymbolKind.Method,
      parentLocalName: `Widget${name}`,
      signature,
      body: `    ${signature}:\n        # widget value datadict name lookup\n        return data.get(name)`,
    });
  }
  // Weakly-related helpers in the SAME file, so a freed slot has somewhere real
  // to refill from and the refill cannot be read as a file-diversity effect.
  specs.push(
    {
      localName: "widget_registry_reset",
      kind: SymbolKind.Function,
      signature: "def widget_registry_reset(registry)",
      body: "def widget_registry_reset(registry):\n    # widget registry reset\n    return registry",
    },
    {
      localName: "widget_cache_clear",
      kind: SymbolKind.Function,
      signature: "def widget_cache_clear(cache)",
      body: "def widget_cache_clear(cache):\n    # widget cache clear\n    return cache",
    },
  );

  seedFile(db, repoRoot, "pkg/widgets.py", specs);
  return { db, repoRoot };
}

function build(varySignatures = false) {
  const { db, repoRoot } = seedRepeatedOverride(varySignatures);
  try {
    return buildCapsuleV2({ db, repoRoot, task: TASK, intent: CapsuleIntent.Auto, maxTokens: 8_000 });
  } finally {
    db.close();
  }
}

test("byte-identical support evidence occupies at most one slot", () => {
  const result = build();
  const texts = result.support.map((item) => `${item.path}|${item.content_mode}|${delivered(item)}`);
  assert.equal(
    new Set(texts).size,
    texts.length,
    `support restates evidence it already delivered:\n${texts.join("\n")}`,
  );
});

test("the rule never shrinks support: every authorized candidate that fits the budget is still delivered", () => {
  // The restatement is dropped BEFORE any budget is consumed, so the room it
  // would have taken goes to the next authorized candidate. Since M206 the
  // bound on support is the token budget, not a tier count, so what is checked
  // is that the redundant discards are the ONLY exclusions of otherwise-fitting
  // candidates: nothing authorized is left behind while budget remains.
  const result = build();
  assert.ok(redundantDiscards(result).length > 0, "expected the fixture to produce a restatement");
  const otherDiscards = result.discarded.filter(
    (d) => !/^redundant support: /.test(d.discard_reason)
      && !/^over budget: /.test(d.discard_reason)
      && /^support/.test(d.role_reason ?? d.discard_reason),
  );
  assert.equal(otherDiscards.length, 0, `authorized support was excluded for a reason other than redundancy or budget:\n${otherDiscards.map((d) => d.discard_reason).join("\n")}`);
  assert.ok(result.support.length >= 4, `expected the distinct candidates to be delivered, got ${result.support.length}`);
});

test("the rule never grows support past the token budget", () => {
  // Refilling must never create an item the budget cannot hold, and the total
  // the capsule reports is exactly the sum of what it delivered.
  const result = build();
  const summed = [...result.pivots, ...result.support].reduce((sum, item) => sum + item.estimated_tokens, 0);
  assert.equal(result.budget.estimated_tokens, summed);
  assert.ok(summed <= result.budget.max_tokens, `delivered ${summed} tokens against a budget of ${result.budget.max_tokens}`);
});

test("the exclusion reason says redundant, not irrelevant", () => {
  // §133: role truth and delivery truth are separate. The dropped candidate WAS
  // relevant and support-authorized; reporting it as "not relevant" would be a lie.
  const dropped = redundantDiscards(build());
  assert.ok(dropped.length > 0, "expected a restatement to be reported");
  for (const item of dropped) {
    assert.match(item.discard_reason, /identical delivered evidence to \S+::\S+/);
    assert.doesNotMatch(item.discard_reason, /not relevant|no .* relevance/);
  }
});

test("same file and same symbol name with DIFFERENT evidence keeps both slots", () => {
  // The negative control the broad corpus supplies five times over — including
  // `sympy/core/numbers.py::is_finite`, delivered twice because the two say
  // different things. Only the signatures differ from the positive fixture.
  const result = build(true);
  const dropped = redundantDiscards(result);
  assert.equal(
    dropped.length,
    0,
    `distinct evidence was deduped as redundant: ${dropped.map((item) => item.discard_reason).join("; ")}`,
  );
  const sameNamed = result.support.filter((item) => item.symbol === "value_from_datadict");
  assert.ok(sameNamed.length > 1, "expected the control to deliver the same name more than once");
});

test("multiple distinct supports from one file are preserved", () => {
  // §34/§45: same file is never sufficient redundancy. Every support item here
  // shares one file and all must survive on distinct evidence.
  const result = build();
  const texts = new Set(result.support.map((item) => delivered(item)));
  assert.equal(new Set(result.support.map((item) => item.path)).size, 1, "fixture should be single-file");
  assert.equal(texts.size, result.support.length, "distinct same-file support was collapsed");
});

test("support selection is deterministic", () => {
  // §59: same index, query and budget produce byte-identical selection.
  const identity = (result: ReturnType<typeof build>) =>
    result.support.map((item) => `${item.path}::${item.symbol}::${delivered(item)}`);
  assert.deepEqual(identity(build()), identity(build()));
});

test("the rule leaves pivot authority alone", () => {
  // §93: M158 is support packing. Pivot role and count must not move, and a
  // support item is never promoted to survive packing.
  const result = build();
  assert.ok(result.pivots.length <= 2, `expected at most 2 pivots, got ${result.pivots.length}`);
  for (const item of result.support) assert.equal(item.role, "support");
});

test("a capsule with no repeated evidence reports no redundancy", () => {
  // The positive control's mirror: when every delivered support says something
  // different the rule is silent, so the zero above is reachable rather than
  // structural (§131).
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-m158-none-"));
  const db: Database = openIndexerDatabase();
  try {
    seedFile(db, repoRoot, "pkg/lookup.py", [
      {
        localName: "read_datadict_name",
        kind: SymbolKind.Function,
        signature: "def read_datadict_name(data, name)",
        body: "def read_datadict_name(data, name):\n    # widget datadict name value lookup\n    return data.get(name)",
      },
      {
        localName: "normalize_widget_value",
        kind: SymbolKind.Function,
        signature: "def normalize_widget_value(value)",
        body: "def normalize_widget_value(value):\n    # widget value datadict normalize\n    return value",
      },
    ]);
    const result = buildCapsuleV2({
      db, repoRoot, task: TASK, intent: CapsuleIntent.Auto, maxTokens: 8_000,
    });
    assert.equal(redundantDiscards(result).length, 0);
  } finally {
    db.close();
  }
});
