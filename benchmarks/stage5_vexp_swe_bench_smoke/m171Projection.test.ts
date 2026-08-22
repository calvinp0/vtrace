import { describe, expect, test } from "bun:test";

import {
  FROZEN_PHRASES,
  NEIGHBOR_RELATION_PHRASES,
  ORIENTATION_BOUNDARY,
  OrientationState,
  RUNGS,
  parseRenderedBodies,
  projectOrientation,
  readPacketClaims,
  renderOrientationText,
  rungByName,
  type OrientationPacket,
} from "./m171Projection";

/**
 * A minimal authoritative response in the real shape. Everything the projector
 * reads is present; everything it must ignore is present too, so that a test
 * asserting "this did not reach the packet" is asserting something.
 */
function authoritative(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const rendered = [
    "# VTRACE product context",
    "task: fix the parser",
    "intent: debug",
    "",
    "## [P1] pkg/parse.py::Parser",
    "roles: pivot, required",
    "mode: skeleton",
    "lines: 10-40",
    "why: actionable class — strong lexical match",
    "",
    "class Parser:",
    "  def parse(self, text):",
    "  def reset(self):",
    "",
    "## [S1] pkg/util.py::normalize",
    "roles: support",
    "mode: skeleton",
    "lines: 5-9",
    "why: 2 indexed symbol(s) depend on this",
    "",
    "def normalize(text):",
  ].join("\n");

  return {
    schemaVersion: "run_pipeline.vnext/1",
    productContext: {
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      resultState: "resolved",
      leadPivot: "pkg/parse.py::Parser",
      task: "fix the parser",
      coverage: { mode: "selective_task_retrieval", absenceClaim: "not_observed", enumerationComplete: false },
      freshness: { status: "fresh", reason: "fresh", action: "none" },
      modelVisibleContext: rendered,
      items: [
        {
          id: "P1", path: "pkg/parse.py", symbol: "Parser", fqName: "pkg/parse.py::Parser",
          roles: ["pivot", "required"], contentMode: "skeleton", lineSpan: { start: 10, end: 40 },
          selectionReasons: ["actionable class — strong lexical match"],
          stableId: "aaa", contentHash: "bbb", contentCharacters: 60,
        },
        {
          id: "S1", path: "pkg/util.py", symbol: "normalize", fqName: "pkg/util.py::normalize",
          roles: ["support"], contentMode: "skeleton", lineSpan: { start: 5, end: 9 },
          selectionReasons: ["2 indexed symbol(s) depend on this"],
          stableId: "ccc", contentHash: "ddd", contentCharacters: 20,
        },
      ],
      timing: { totalMs: 12.5 },
      accounting: { budgetTokens: 8000, claimBoundary: "Compression relative to uniquely selected full files." },
    },
    pivotNeighborhood: [{
      pivot: { path: "pkg/parse.py", symbol: "Parser", fqName: "pkg/parse.py::Parser" },
      excerpts: [
        { filePath: "pkg/cli.py", symbol: "main", fqName: "pkg/cli.py::main", startLine: 1, endLine: 8, reason: "caller", textCharacters: 120 },
        { filePath: "pkg/parse.py", symbol: "Token", fqName: "pkg/parse.py::Token", startLine: 42, endLine: 50, reason: "fallback_symbol_window", textCharacters: 90 },
      ],
      skipped: [{ target: "pkg/gone.py::vanished", reason: "source_unavailable" }],
    }],
    diagnostics: { freshness: { state: "fresh", readiness: { ready: true, state: "ready", reason: "fresh" } } },
    capsuleResult: { digest: "…", warnings: ["pivot_source_bounded_to_signatures"], diagnostics: { candidateCount: 30 } },
    memory: { durable: { included: true, topObservations: [{ summary: "Built context capsule" }] } },
    responseBudget: { serialized_response_characters: 19000 },
    workspaceRouting: { isWorkspace: false, outcome: "single_repository" },
    ...overrides,
  };
}

const R2000 = rungByName("R2000");

describe("parseRenderedBodies", () => {
  test("recovers each item body by its rendered id", () => {
    const bodies = parseRenderedBodies(authoritative().productContext instanceof Object
      ? String((authoritative().productContext as Record<string, unknown>).modelVisibleContext) : "");
    expect(bodies.get("P1")).toContain("class Parser:");
    expect(bodies.get("P1")).not.toContain("why:");
    expect(bodies.get("S1")).toBe("def normalize(text):");
  });
});

describe("the packet is sound and selective", () => {
  test("the focus is the authoritative lead pivot", () => {
    const packet = projectOrientation(authoritative(), R2000);
    expect(packet.state).toBe(OrientationState.Resolved);
    expect(packet.focus?.at).toBe("pkg/parse.py::Parser");
    expect(packet.focus?.form).toBe("skeleton");
  });

  test("every authored string is verbatim authoritative or a frozen phrase", () => {
    const source = authoritative();
    const packet = projectOrientation(source, R2000);
    const claims = readPacketClaims(packet);
    const serializedSource = JSON.stringify(source);
    for (const authored of claims.authoredStrings) {
      expect(FROZEN_PHRASES.includes(authored) || serializedSource.includes(authored)).toBe(true);
    }
    for (const relation of claims.relationClaims) {
      const frozen = Object.values(NEIGHBOR_RELATION_PHRASES).includes(relation.how);
      expect(frozen || serializedSource.includes(relation.how)).toBe(true);
    }
  });

  test("the global boundary is on every resolved packet", () => {
    for (const rung of RUNGS) {
      expect(projectOrientation(authoritative(), rung).boundary).toBe(ORIENTATION_BOUNDARY);
    }
  });

  test("debug-only material never reaches the packet", () => {
    const serialized = JSON.stringify(projectOrientation(authoritative(), R2000));
    for (const leak of ["candidateCount", "responseBudget", "Built context capsule", "stableId", "claimBoundary", "timing", "budgetTokens"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  test("a bounded absence is neither asserted nor denied", () => {
    const serialized = JSON.stringify(projectOrientation(authoritative(), R2000));
    expect(serialized).not.toContain("source_unavailable");
    expect(serialized).not.toContain("pkg/gone.py");
  });
});

describe("relationship strength is preserved, never raised", () => {
  test("an indexed call edge says so", () => {
    const packet = projectOrientation(authoritative(), R2000);
    const caller = packet.related.find((entry) => entry.at === "pkg/cli.py::main");
    expect(caller?.how).toBe(NEIGHBOR_RELATION_PHRASES.caller);
  });

  test("a same-file neighbour states that it has no indexed relationship", () => {
    const packet = projectOrientation(authoritative(), R2000);
    const sameFile = packet.related.find((entry) => entry.at === "pkg/parse.py::Token");
    expect(sameFile?.how).toBe(NEIGHBOR_RELATION_PHRASES.fallback_symbol_window);
    expect(sameFile?.how).toContain("no indexed relationship");
  });

  test("an unknown internal reason fails closed rather than leaking", () => {
    const source = authoritative();
    (source.pivotNeighborhood as Record<string, any>[])[0]!.excerpts[0].reason = "newly_invented_edge_kind";
    const packet = projectOrientation(source, R2000);
    expect(packet.related.some((entry) => entry.at === "pkg/cli.py::main")).toBe(false);
    expect(JSON.stringify(packet)).not.toContain("newly_invented_edge_kind");
  });
});

describe("dose behaviour", () => {
  test("rungs are nested: nothing named at a smaller rung is lost at a larger one", () => {
    const source = authoritative();
    let previous: ReadonlySet<string> | null = null;
    for (const rung of RUNGS) {
      const claims = readPacketClaims(projectOrientation(source, rung));
      if (previous !== null) {
        for (const location of previous) expect(claims.locations.has(location)).toBe(true);
      }
      previous = claims.locations;
    }
  });

  test("the focus excerpt grows monotonically and stays a prefix", () => {
    const source = authoritative();
    let previous: string | null = null;
    for (const rung of RUNGS) {
      const code = projectOrientation(source, rung).focus?.code ?? "";
      if (previous !== null) expect(code.startsWith(previous)).toBe(true);
      previous = code;
    }
  });

  test("a truncated excerpt says so", () => {
    const tiny = { ...rungByName("R1000"), focusCodeCharacters: 20 };
    const packet = projectOrientation(authoritative(), tiny);
    expect(packet.focus?.codeTruncated).toBe(true);
    expect(packet.notes ?? []).toContain("The excerpt above is the head of a longer span.");
  });

  test("a complete packet is not padded when the ceiling rises", () => {
    // §17/§46. Two rungs whose caps both exceed the available material must
    // produce byte-identical packets: there is nothing for spare room to attract.
    const source = authoritative();
    const wide = { ...rungByName("R2500"), relatedCap: 50, focusCodeCharacters: 100_000 };
    const wider = { ...wide, name: "R9000", ceilingTokens: 9000, relatedCap: 500, focusCodeCharacters: 1_000_000 };
    expect(JSON.stringify(projectOrientation(source, wide)))
      .toBe(JSON.stringify(projectOrientation(source, wider)));
  });

  test("freeing unrelated internal bytes does not move the evidence (§53)", () => {
    // M166's failure mode: removing diagnostics let the packer refill the envelope.
    const withDiagnostics = authoritative();
    const withoutDiagnostics = authoritative({ capsuleResult: { digest: "…" }, responseBudget: {}, memory: {} });
    expect(JSON.stringify(projectOrientation(withoutDiagnostics, R2000)))
      .toBe(JSON.stringify(projectOrientation(withDiagnostics, R2000)));
  });
});

describe("failure is not compressed", () => {
  const notReady = authoritative({
    productContext: {
      resolved: false, retrievalFound: false, deliveryFailed: false, resultState: "repo_not_ready",
      leadPivot: "", items: [], modelVisibleContext: "", freshness: { status: "stale", reason: "source_changed", action: "reindex" },
    },
    diagnostics: {
      freshness: {
        state: "stale",
        readiness: { ready: false, state: "not_ready", reason: "index_stale", recommendedAction: "run index_repo" },
      },
    },
  });

  test("a not-ready response keeps its reason, action and readiness record", () => {
    const packet = projectOrientation(notReady, R2000);
    expect(packet.state).toBe(OrientationState.NotReady);
    expect(packet.problem?.reason).toBe("repo_not_ready");
    expect(packet.problem?.recommendedAction).toBe("run index_repo");
    expect(packet.problem?.readiness).not.toBeNull();
    expect(packet.focus).toBeNull();
  });

  test("a not-fresh index is stated, not implied", () => {
    expect(projectOrientation(notReady, R2000).notes ?? []).toContain("Index freshness: stale (source_changed).");
  });

  test("the text mirror of a failure is unambiguous", () => {
    const rendered = renderOrientationText(projectOrientation(notReady, R2000));
    expect(rendered).toContain("orientation unavailable");
    expect(rendered).toContain("repo_not_ready");
    expect(rendered).toContain("run index_repo");
  });

  test("retrieval that found nothing is no_evidence, not a fabricated focus", () => {
    const empty = authoritative({
      productContext: {
        resolved: true, retrievalFound: false, deliveryFailed: false, resultState: "no_context",
        leadPivot: "", items: [], modelVisibleContext: "",
      },
    });
    const packet = projectOrientation(empty, R2000);
    expect(packet.state).toBe(OrientationState.NoEvidence);
    expect(packet.focus).toBeNull();
    expect(packet.boundary).toBe(ORIENTATION_BOUNDARY);
  });
});

describe("both transports carry the same packet", () => {
  test("the text mirror asserts nothing the structured packet does not", () => {
    const packet: OrientationPacket = projectOrientation(authoritative(), R2000);
    const rendered = renderOrientationText(packet);
    const claims = readPacketClaims(packet);
    for (const location of claims.locations) expect(rendered).toContain(location);
    expect(rendered).toContain(ORIENTATION_BOUNDARY);
    // and nothing beyond it
    for (const leak of ["stableId", "candidateCount", "Built context capsule"]) {
      expect(rendered).not.toContain(leak);
    }
  });
});
