import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  CapsuleV2ProductItem,
  CapsuleV2ProductResponse,
} from "../capsuleV2/productAdapter";
import { buildInspectFirst, renderInspectFirstText } from "./inspectFirst";

// Minimal product-item factory: only the fields buildInspectFirst reads matter;
// the rest get honest defaults.
function item(overrides: Partial<CapsuleV2ProductItem> & { role: "pivot" | "support"; path: string; symbol: string }): CapsuleV2ProductItem {
  return {
    role: overrides.role,
    path: overrides.path,
    symbol: overrides.symbol,
    fqName: overrides.fqName ?? `${overrides.path}::${overrides.symbol}`,
    kind: overrides.kind ?? "function",
    roleReason: overrides.roleReason ?? "selected by retrieval",
    contentMode: overrides.contentMode ?? "signature",
    source: overrides.source ?? null,
    signature: overrides.signature ?? null,
    evidence: overrides.evidence ?? [],
    estimatedTokens: overrides.estimatedTokens ?? 10,
    isNonSourceExample: overrides.isNonSourceExample ?? false,
  };
}

function response(
  pivots: CapsuleV2ProductItem[],
  support: CapsuleV2ProductItem[] = [],
): CapsuleV2ProductResponse {
  return { pivots, support } as unknown as CapsuleV2ProductResponse;
}

// A matplotlib-22719-shaped response: both pivots are in the traceback-surface
// file (axis.py), the lead pivot RE-RAISES a wrapped error, and the gold target
// (category.py::convert) sits in support with an explicit-edit-site role reason.
function matplotlibShaped(): CapsuleV2ProductResponse {
  return response(
    [
      item({
        role: "pivot",
        path: "lib/matplotlib/axis.py",
        symbol: "convert_units",
        roleReason: "task diagnostic literal appears in this symbol's body — explicit edit site",
        contentMode: "full",
        source:
          "def convert_units(self, x):\n"
          + "    try:\n"
          + "        ret = self.converter.convert(x, self.units, self)\n"
          + "    except Exception as e:\n"
          + "        raise munits.ConversionError('Failed to convert value(s) to axis') from e\n"
          + "    return ret",
      }),
      item({
        role: "pivot",
        path: "lib/matplotlib/axis.py",
        symbol: "update_units",
        roleReason: "existing method recovered from Class.method expansion — more actionable than containing class",
        contentMode: "full",
        source: "def update_units(self, data):\n    return self._update_axisinfo()",
      }),
    ],
    [
      item({
        role: "support",
        path: "lib/matplotlib/category.py",
        symbol: "convert",
        roleReason: "strong target beyond the pivot budget — task diagnostic literal appears in this symbol's body — explicit edit site",
      }),
      item({
        role: "support",
        path: "lib/matplotlib/_api/deprecation.py",
        symbol: "warn_deprecated",
        roleReason: "strong target beyond the pivot budget — local implementation helper whose name matches the issue — likely edit site",
      }),
    ],
  );
}

test("buildInspectFirst returns null when there is nothing to point at", () => {
  assert.equal(buildInspectFirst(response([], [])), null);
  assert.equal(renderInspectFirstText(null), "");
});

test("buildInspectFirst is deterministic (same input → identical output)", () => {
  const r = matplotlibShaped();
  const a = renderInspectFirstText(buildInspectFirst(r));
  const b = renderInspectFirstText(buildInspectFirst(r));
  assert.equal(a, b);
});

test("buildInspectFirst is bounded: one likely-first, ≤2 related, ≤180-char why", () => {
  const longReason = "explicit edit site ".repeat(40); // ~760 chars
  const r = response([
    item({ role: "pivot", path: "a.py", symbol: "f", roleReason: longReason }),
    item({ role: "support", path: "b.py", symbol: "g" }),
    item({ role: "support", path: "c.py", symbol: "h" }),
    item({ role: "support", path: "d.py", symbol: "i" }),
  ]);
  const inspect = buildInspectFirst(r);
  assert.ok(inspect !== null);
  assert.equal(inspect.related.length <= 2, true, "at most two related items");
  assert.ok(inspect.likelyFirst.why.length <= 180, "why is bounded to 180 chars");
  assert.ok(inspect.likelyFirst.why.endsWith("…"), "over-long why is truncated with an ellipsis");

  const text = renderInspectFirstText(inspect);
  const likelyLines = text.split("\n").filter((line) => line.startsWith("Likely first file:"));
  assert.equal(likelyLines.length, 1, "exactly one likely-first heading");
});

test("a re-raising surface pivot is demoted; the behavior support file leads and the surface is labeled", () => {
  const inspect = buildInspectFirst(matplotlibShaped());
  assert.ok(inspect !== null);

  // The gold behaviour file (category.py::convert) outranks the axis.py
  // traceback-surface pivot and becomes the likely-first target.
  assert.equal(inspect.likelyFirst.path, "lib/matplotlib/category.py");
  assert.equal(inspect.likelyFirst.symbol, "convert");

  // The surface pivot still appears, explicitly labeled as reachability context.
  const surface = inspect.related.find((entry) => entry.path === "lib/matplotlib/axis.py");
  assert.ok(surface !== undefined, "the traceback-surface file is surfaced as related context");
  assert.equal(surface.isSurface, true);
  assert.ok(/surfaces|re-raises/.test(surface.why), "surface item is honestly labeled");
});

test("confidence reflects how specific the lead signal is", () => {
  // edit-site phrase + behaviour vocabulary → high.
  const high = buildInspectFirst(matplotlibShaped());
  assert.equal(high?.confidence, "high");

  // rank-only support item, no edit-site phrase, no behaviour word → low.
  const low = buildInspectFirst(response([], [
    item({ role: "support", path: "x.py", symbol: "thing", roleReason: "related context" }),
  ]));
  assert.equal(low?.confidence, "low");
});

test("rendered block is labeled as bounded guidance and carries its sections", () => {
  const text = renderInspectFirstText(buildInspectFirst(matplotlibShaped()));
  assert.ok(text.includes("VTRACE inspect-first"));
  // M154-D: the header states the coverage contract, because a reader who takes
  // this block as the complete set of relevant code draws false conclusions from
  // what it omits.
  assert.ok(text.includes("bounded, non-exhaustive selection"));
  assert.ok(text.includes("Likely first file:"));
  assert.ok(text.includes("Related context:"));
  // No mandatory-output framing: it must not demand a checklist or block editing.
  assert.ok(!/checklist/i.test(text));
  assert.ok(!/do not edit|must emit|required format/i.test(text));
});

// M154-D. The block used to close with a constant "Avoid first: broad repository
// grep/find before inspecting the targets above". Capsule v2 selects bounded
// evidence and never enumerates a repository, so it cannot support that
// instruction — and on a reuse-before-write question it is the instruction that
// turns a selective miss into a duplicate implementation.
test("no unsupported advice against searching further is ever emitted", () => {
  const shapes = [
    matplotlibShaped(),
    response([], [item({ role: "support", path: "x.py", symbol: "thing", roleReason: "related context" })]),
  ];
  for (const shaped of shapes) {
    const built = buildInspectFirst(shaped);
    const text = renderInspectFirstText(built);
    assert.ok(
      !/grep|ripgrep|\brg\b|find\b|search/i.test(text),
      `advice against further search leaked into the block: ${text}`,
    );
    if (built?.avoidFirst != null) {
      // An avoid-hint may only name a target the evidence marks as a surface.
      assert.match(built.avoidFirst, /surfaces and re-raises/);
    }
  }
});

test("an avoid-hint appears only when the lead is an evidenced failure surface", () => {
  const plain = buildInspectFirst(response([], [
    item({ role: "support", path: "x.py", symbol: "thing", roleReason: "related context" }),
  ]));
  assert.equal(plain?.avoidFirst, null, "no surface evidence means no avoid-hint");
});
