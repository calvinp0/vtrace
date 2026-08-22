import { describe, expect, test } from "bun:test";

import {
  NEIGHBOR_RELATION_PHRASES,
  ORIENTATION_BOUNDARY,
  OrientationState,
  projectOrientation,
  rungByName,
  type OrientationPacket,
} from "./m171Projection";
import { ViolationKind, auditPacket } from "./m171Soundness";

const R2000 = rungByName("R2000");

/**
 * A state builder, so each adversarial fixture differs in exactly the one thing
 * it is about.
 */
function state(options: {
  readonly items?: Record<string, unknown>[];
  readonly excerpts?: Record<string, unknown>[];
  readonly skipped?: Record<string, unknown>[];
  readonly rendered?: string;
  readonly productContext?: Record<string, unknown>;
  readonly extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const items = options.items ?? [{
    id: "P1", path: "pkg/a.py", symbol: "Alpha", fqName: "pkg/a.py::Alpha",
    roles: ["pivot"], contentMode: "skeleton", lineSpan: { start: 1, end: 9 },
    selectionReasons: ["actionable class — strong lexical match"], contentCharacters: 20,
  }];
  const rendered = options.rendered ?? [
    "# VTRACE product context",
    "",
    "## [P1] pkg/a.py::Alpha",
    "roles: pivot",
    "mode: skeleton",
    "lines: 1-9",
    "why: actionable class — strong lexical match",
    "",
    "class Alpha:",
    "  def run(self):",
  ].join("\n");

  return {
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false, resultState: "resolved",
      leadPivot: items[0]?.fqName ?? "",
      coverage: { mode: "selective_task_retrieval", absenceClaim: "not_observed", enumerationComplete: false },
      freshness: { status: "fresh", reason: "fresh", action: "none" },
      modelVisibleContext: rendered,
      items,
      ...options.productContext,
    },
    pivotNeighborhood: [{
      pivot: { path: "pkg/a.py", symbol: "Alpha", fqName: "pkg/a.py::Alpha" },
      excerpts: options.excerpts ?? [],
      ...(options.skipped === undefined ? {} : { skipped: options.skipped }),
    }],
    diagnostics: { freshness: { state: "fresh", readiness: { ready: true, state: "ready", reason: "fresh" } } },
    ...options.extra,
  };
}

const clean = (packet: OrientationPacket, source: Record<string, unknown>): void => {
  expect(auditPacket(packet, source)).toEqual([]);
};

// ---- known negative: every adversarial fixture must audit clean -----

describe("known-negative controls: the packet stays truthful under adversarial states", () => {
  test("exact callers are labelled as indexed call edges", () => {
    const source = state({
      excerpts: [{ filePath: "pkg/b.py", fqName: "pkg/b.py::caller", startLine: 3, endLine: 6, reason: "caller", textCharacters: 40 }],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.related[0]?.how).toBe(NEIGHBOR_RELATION_PHRASES.caller);
    expect(packet.related[0]?.how).toContain("indexed call edge");
  });

  test("a potential relationship is never rendered as an exact one", () => {
    const source = state({
      excerpts: [{ filePath: "pkg/c.py", fqName: "pkg/c.py::mentions", startLine: 1, endLine: 4, reason: "reference", textCharacters: 30 }],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.related[0]?.how).toBe(NEIGHBOR_RELATION_PHRASES.reference);
    expect(packet.related[0]?.how).not.toContain("call edge");
  });

  test("a same-file neighbour asserts the ABSENCE of a relationship rather than one", () => {
    const source = state({
      excerpts: [{ filePath: "pkg/a.py", fqName: "pkg/a.py::Beta", startLine: 20, endLine: 24, reason: "fallback_symbol_window", textCharacters: 30 }],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.related[0]?.how).toContain("no indexed relationship");
  });

  test("a bounded caller set is not rendered as the complete set", () => {
    // Two callers delivered out of an unknown total. The packet names the two and
    // says nothing about how many exist.
    const source = state({
      excerpts: [
        { filePath: "pkg/b.py", fqName: "pkg/b.py::one", startLine: 1, endLine: 2, reason: "caller", textCharacters: 10 },
        { filePath: "pkg/c.py", fqName: "pkg/c.py::two", startLine: 1, endLine: 2, reason: "caller", textCharacters: 10 },
      ],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toMatch(/\b(2|two) callers\b/);
    expect(packet.boundary).toBe(ORIENTATION_BOUNDARY);
  });

  test("an authoritative absence is not converted into a claim", () => {
    // Impact ran and found nothing. The packet says nothing about impact at all,
    // which is the only truthful compact option: rendering "no dependents" would
    // claim a bound the packet does not state.
    const source = state({
      extra: { impact: { included: true, skipReason: null, focalSymbol: "pkg/a.py::Alpha", topDependents: [], summary: { dependentCount: 0 } } },
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(JSON.stringify(packet)).not.toMatch(/\bno\b.*\bdependents?\b/i);
  });

  test("not-observed is not converted into absent", () => {
    const source = state({ extra: { impact: { included: false, skipReason: "not_requested_by_intent" } } });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(JSON.stringify(packet)).not.toContain("not_requested_by_intent");
    expect(packet.boundary).toContain("not thereby absent");
  });

  test("a component that is unavailable produces no claim about the repository", () => {
    const source = state({ extra: { flow: { included: false, skipReason: "unsupported_language", claimScope: null } } });
    clean(projectOrientation(source, R2000), source);
  });

  test("a component that errored produces no claim about the repository", () => {
    const source = state({ extra: { impact: { included: false, skipReason: "impact_error" } } });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(JSON.stringify(packet)).not.toContain("impact_error");
  });

  test("omitted support is silent, not denied", () => {
    const source = state({
      items: [
        { id: "P1", path: "pkg/a.py", symbol: "Alpha", fqName: "pkg/a.py::Alpha", roles: ["pivot"], contentMode: "skeleton", lineSpan: { start: 1, end: 9 }, selectionReasons: ["actionable class — strong lexical match"], contentCharacters: 20 },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `S${index}`, path: `pkg/s${index}.py`, symbol: `s${index}`, fqName: `pkg/s${index}.py::s${index}`,
          roles: ["support"], contentMode: "skeleton", lineSpan: { start: 1, end: 2 },
          selectionReasons: [`${index} indexed symbol(s) depend on this`], contentCharacters: 5,
        })),
      ],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.related.length).toBe(R2000.relatedCap);
    expect(packet.boundary).toBe(ORIENTATION_BOUNDARY);
  });

  test("the same item in several semantic roles is named once, with one claim", () => {
    const source = state({
      items: [{
        id: "P1", path: "pkg/a.py", symbol: "Alpha", fqName: "pkg/a.py::Alpha",
        roles: ["pivot", "required", "support"], contentMode: "skeleton", lineSpan: { start: 1, end: 9 },
        selectionReasons: ["actionable class — strong lexical match"], contentCharacters: 20,
      }],
      excerpts: [{ filePath: "pkg/a.py", fqName: "pkg/a.py::Alpha", startLine: 1, endLine: 9, reason: "caller", textCharacters: 20 }],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.focus?.at).toBe("pkg/a.py::Alpha");
    expect(packet.related.some((entry) => entry.at === "pkg/a.py::Alpha")).toBe(false);
  });

  test("the same skip reason at two different scopes leaks neither", () => {
    const source = state({
      skipped: [
        { target: "pkg/x.py::gone", reason: "source_unavailable" },
        { target: "pkg/y.py::<module>", reason: "source_unavailable" },
      ],
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(JSON.stringify(packet)).not.toContain("source_unavailable");
    expect(JSON.stringify(packet)).not.toContain("pkg/x.py");
  });

  test("repo_not_ready keeps its full, unambiguous failure shape", () => {
    const source = state({
      productContext: { resolved: false, retrievalFound: false, resultState: "repo_not_ready", leadPivot: "", items: [], modelVisibleContext: "" },
      extra: {
        diagnostics: {
          freshness: { state: "unknown", readiness: { ready: false, state: "not_ready", reason: "index_missing", recommendedAction: "run index_repo" } },
        },
      },
    });
    const packet = projectOrientation(source, R2000);
    clean(packet, source);
    expect(packet.state).toBe(OrientationState.NotReady);
    expect(packet.problem?.reason).toBe("repo_not_ready");
    expect(packet.problem?.readiness).toMatchObject({ ready: false, reason: "index_missing" });
  });
});

// ---- known positive: the auditor must catch a real violation --------

describe("known-positive controls: the auditor detects each violation it claims to", () => {
  const source = state({
    excerpts: [{ filePath: "pkg/b.py", fqName: "pkg/b.py::caller", startLine: 3, endLine: 6, reason: "reference", textCharacters: 40 }],
  });
  const good = projectOrientation(source, R2000);
  const corrupt = (mutate: (packet: any) => void): OrientationPacket => {
    const copy = JSON.parse(JSON.stringify(good)) as any;
    mutate(copy);
    return copy as OrientationPacket;
  };
  const kinds = (packet: OrientationPacket): string[] => auditPacket(packet, source).map((violation) => violation.kind);

  test("a fabricated location", () => {
    expect(kinds(corrupt((p) => { p.related.push({ at: "pkg/nope.py::ghost", file: "pkg/nope.py", lines: "1-2", how: "calls the focus symbol (indexed call edge)" }); })))
      .toContain(ViolationKind.UnsupportedLocation);
  });

  test("a fabricated file", () => {
    expect(kinds(corrupt((p) => { p.focus.file = "pkg/invented.py"; })))
      .toContain(ViolationKind.UnsupportedFile);
  });

  test("a span that disagrees with the state", () => {
    expect(kinds(corrupt((p) => { p.focus.lines = "999-1000"; })))
      .toContain(ViolationKind.UnsupportedSpan);
  });

  test("strengthening a reference into a call edge", () => {
    expect(kinds(corrupt((p) => { p.related[0].how = NEIGHBOR_RELATION_PHRASES.caller; })))
      .toContain(ViolationKind.UnsupportedRelation);
  });

  test("prose nobody declared", () => {
    expect(kinds(corrupt((p) => { p.notes = ["This is the only place the bug can be."]; })))
      .toContain(ViolationKind.AuthoredProse);
  });

  test("an enumerating note", () => {
    expect(kinds(corrupt((p) => { p.notes = ["There are no other callers in the repository."]; })))
      .toContain(ViolationKind.NegativeOrExhaustiveClaim);
  });

  test("source that is not in the authoritative rendering", () => {
    expect(kinds(corrupt((p) => { p.focus.code = "def something_that_was_never_indexed():"; })))
      .toContain(ViolationKind.FabricatedSource);
  });

  test("a removed boundary", () => {
    expect(kinds(corrupt((p) => { p.boundary = "Here is everything."; })))
      .toContain(ViolationKind.AuthoredProse);
  });
});

// ---- identity control ----------------------------------------------

describe("the boundary itself", () => {
  test("disclaims exhaustiveness rather than asserting it", () => {
    // The scanner cannot judge this sentence — it is the one string whose job is
    // to DENY the claim the scanner looks for — so it is asserted directly.
    expect(ORIENTATION_BOUNDARY).toContain("not an exhaustive repository listing");
    expect(ORIENTATION_BOUNDARY).toContain("not thereby absent");
    expect(ORIENTATION_BOUNDARY).not.toMatch(/\ball (callers|files|symbols)\b/i);
  });
});

describe("identity control (§51)", () => {
  test("the status quo audited against itself reports no violation", () => {
    const source = state({
      excerpts: [{ filePath: "pkg/b.py", fqName: "pkg/b.py::caller", startLine: 3, endLine: 6, reason: "caller", textCharacters: 40 }],
    });
    expect(auditPacket(projectOrientation(source, R2000), source)).toEqual([]);
  });

  test("an auditor that passed everything would fail this suite", () => {
    // The guard against a vacuous auditor: at least one corruption must be caught.
    const source = state();
    const packet = JSON.parse(JSON.stringify(projectOrientation(source, R2000))) as any;
    packet.focus.at = "pkg/fabricated.py::Nothing";
    expect(auditPacket(packet as OrientationPacket, source).length).toBeGreaterThan(0);
  });
});
