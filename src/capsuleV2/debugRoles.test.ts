// Capsule v2 debug role-assignment tests.
//
// Locks in the fix for the two direct-product regressions:
//   A) no_context was too conservative — a recoverable implementation helper now
//      becomes a pivot, and a genuine no_context explains WHY per candidate;
//   B) a wrapper/caller and generic infrastructure outranked the local
//      implementation helpers — debug intent now prefers the helpers as pivots.
//
// The admindocs-regex fixture (11728 shape) drives Problem B; the admin-inline
// fixture (11095 shape) guards the recovery the fix must not break.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { persistParseResult } from "../db/persistParseResult";
import {
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
} from "../domain/types";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import type { HybridCandidate } from "../retrieval/hybridRetrieval";
import type { HybridScoreComponents } from "../retrieval/hybridScoring";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { collectIssueTokens, isGenericInfrastructure } from "./debugRoles";
import { renderCapsuleV2Human } from "./renderHuman";
import { CapsuleIntent, CapsuleV2Mode, type CapsuleV2Result } from "./types";
import {
  ADMINDOCS_TASK,
  seedAdmindocsFixture,
} from "./__fixtures__/admindocsFixture";
import { seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";

function admindocs(maxTokens: number): CapsuleV2Result {
  const { db, repoRoot } = seedAdmindocsFixture();
  try {
    return buildCapsuleV2({ db, repoRoot, task: ADMINDOCS_TASK, intent: CapsuleIntent.Debug, maxTokens });
  } finally {
    db.close();
  }
}

const UTILS = "django/contrib/admindocs/utils.py";
const VIEWS = "django/contrib/admindocs/views.py";
const REGEX_HELPER = "django/utils/regex_helper.py";

const pivotKey = (r: CapsuleV2Result, path: string, symbol: string): boolean =>
  r.pivots.some((p) => p.path === path && p.symbol === symbol);
const supportKey = (r: CapsuleV2Result, path: string, symbol: string): boolean =>
  r.support.some((s) => s.path === path && s.symbol === symbol);

test("Problem B: local implementation helper replace_named_groups is a pivot", () => {
  const r = admindocs(8_000);
  assert.ok(pivotKey(r, UTILS, "replace_named_groups"), "replace_named_groups must be a pivot");

  const pivot = r.pivots.find((p) => p.symbol === "replace_named_groups")!;
  assert.equal(pivot.is_implementation_helper, true);
  assert.equal(pivot.is_entry_point, false);
  assert.match(pivot.role_reason, /implementation helper/i);
});

test("Problem B: replace_unnamed_groups is a pivot (standard) or top support (micro)", () => {
  const standard = admindocs(8_000);
  assert.ok(
    pivotKey(standard, UTILS, "replace_unnamed_groups"),
    "at a standard budget replace_unnamed_groups should also be a pivot",
  );

  // Micro budget: only one pivot slot. replace_named_groups wins it;
  // replace_unnamed_groups must be the top SUPPORT helper, not dropped.
  const micro = admindocs(500);
  assert.equal(micro.actual_mode, CapsuleV2Mode.Micro);
  assert.ok(pivotKey(micro, UTILS, "replace_named_groups"));
  assert.ok(
    supportKey(micro, UTILS, "replace_unnamed_groups"),
    "replace_unnamed_groups must survive as support under a micro budget",
  );
  const firstCodeSupport = micro.support.find((s) => s.kind !== "markdown_section")!;
  assert.equal(firstCodeSupport.symbol, "replace_unnamed_groups");
});

test("Problem B: the entry-point wrapper simplify_regex is support, not a pivot", () => {
  const r = admindocs(8_000);
  assert.ok(!pivotKey(r, VIEWS, "simplify_regex"), "simplify_regex must not be a pivot");
  assert.ok(supportKey(r, VIEWS, "simplify_regex"), "simplify_regex should be support");

  const item = r.support.find((s) => s.symbol === "simplify_regex")!;
  assert.equal(item.is_entry_point, true);
  assert.match(item.role_reason, /entry point|caller|delegat/i);
});

test("Problem B: generic regex infrastructure (Group) is support, not a pivot", () => {
  const r = admindocs(8_000);
  assert.ok(!pivotKey(r, REGEX_HELPER, "Group"), "regex_helper.Group must not be a pivot");

  const group = [...r.support, ...r.discarded].find((s) => s.path === REGEX_HELPER && s.symbol === "Group")!;
  assert.ok(group, "Group should be retained as support/discarded, not silently dropped");
  assert.equal(group.is_generic_infrastructure, true);
  assert.match(group.discard_reason ?? group.role_reason ?? "", /infrastructure|subsystem/i);
});

test("Problem B: human output places replace_named_groups under a pivot bullet", () => {
  const r = admindocs(8_000);
  const human = renderCapsuleV2Human(r);
  assert.match(human, /^● pivot django\/contrib\/admindocs\/utils\.py::replace_named_groups$/m);
  // The wrapper appears, but under a support bullet.
  assert.match(human, /^○ support django\/contrib\/admindocs\/views\.py::simplify_regex$/m);
});

test("Problem B: JSON diagnostics expose the structural role signals", () => {
  const r = admindocs(8_000);
  for (const item of [...r.pivots, ...r.support]) {
    assert.equal(typeof item.role_reason, "string");
  }
  for (const item of [...r.pivots, ...r.support, ...r.discarded]) {
    assert.equal(typeof item.is_entry_point, "boolean");
    assert.equal(typeof item.is_implementation_helper, "boolean");
    assert.equal(typeof item.is_generic_infrastructure, "boolean");
  }
  // Exactly the helpers are flagged as implementation helpers among pivots.
  const helperPivots = r.pivots.filter((p) => p.is_implementation_helper).map((p) => p.symbol).sort();
  assert.deepEqual(helperPivots, ["replace_named_groups", "replace_unnamed_groups"]);
});

test("debug role assembly is deterministic", () => {
  assert.deepEqual(admindocs(8_000), admindocs(8_000));
});

test("Problem A: the admin inline case still recovers options.py under debug intent", () => {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "fix ModelAdmin.get_inlines hook for generic inline admin failing test",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    assert.notEqual(r.actual_mode, CapsuleV2Mode.NoContext);
    assert.ok(
      r.pivots.some((p) => p.path === "pkg/options.py"),
      "the admin inline implementation in options.py must be recovered as a pivot",
    );
    assert.ok(r.pivots.some((p) => p.symbol === "get_inline_instances"));
  } finally {
    db.close();
  }
});

test("Problem A: a genuine no_context explains why each candidate failed the gate", () => {
  // A repo whose only query-relevant symbol is a low-actionability module
  // variable: candidates are generated, but none can be an edit target.
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-nc-"));
  const db = openIndexerDatabase();
  try {
    const relPath = "app/config.py";
    const content = "frobnicator_setting = 'x'\n";
    const fqName = buildFQName({ filePath: relPath, symbolPath: ["frobnicator_setting"] });
    persistParseResult(db, {
      file: {
        id: computeFileId(relPath),
        path: relPath,
        language: Language.Python,
        contentHash: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
      },
      symbols: [
        {
          id: computeSymbolId({ filePath: relPath, fqName, kind: SymbolKind.ModuleVariable, startByte: 0, endByte: 20 }),
          filePath: relPath,
          fqName,
          localName: "frobnicator_setting",
          kind: SymbolKind.ModuleVariable,
          signature: "frobnicator_setting = 'x'",
          startLine: 1,
          endLine: 1,
          startByte: 0,
          endByte: 20,
          exported: false,
        },
      ],
      edges: [],
      diagnostics: [],
    });

    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "frobnicator_setting has the wrong value",
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });

    assert.equal(r.actual_mode, CapsuleV2Mode.NoContext);
    assert.ok(r.diagnostics.candidate_count >= 1, "candidates were generated");
    const explanations = r.diagnostics.no_context_explanations ?? [];
    assert.ok(explanations.length >= 1, "no_context must explain why no pivot was found");
    assert.ok(explanations.some((e) => /low-actionability/.test(e.why_not_pivot)));
  } finally {
    db.close();
  }
});

test("generic bug-report tokens do not reach the subsystem issue-token set", () => {
  // "multiple" / "command" are generic noise; only meaningful tokens may steer
  // subsystem selection (which keys entirely off collectIssueTokens).
  const shaped = shapeSweQuery({
    repo: "django/django",
    problemStatement:
      "Running the command produces multiple errors. The bug is in the "
      + "OneToOneField deconstruct() path.",
    failToPass: [],
  });
  const tokens = collectIssueTokens(shaped);

  assert.ok(!tokens.has("multiple"), "generic 'multiple' must not be an issue token");
  assert.ok(!tokens.has("command"), "generic 'command' must not be an issue token");
  assert.ok(!tokens.has("error") && !tokens.has("errors"));
  // A meaningful identifier still survives to drive subsystem selection.
  assert.ok(tokens.has("deconstruct") || tokens.has("onetoonefield"));
});

// M95: a strongly-lexically-matched FUNCTION/METHOD outside the (heuristically
// inferred, often wrong) subsystem is NOT generic infrastructure — it stays an
// eligible edit site. A generic data-structure CLASS riding the same lexical
// coincidence remains demoted, so this never re-promotes broad infra.
function candidate(kind: SymbolKind, lexical: number, extra: Partial<HybridScoreComponents> = {}): HybridCandidate {
  const scores: HybridScoreComponents = {
    lexical, fts: lexical, tfidf: lexical, bm25: lexical, symbol: 0, path: 0,
    testToImpl: 0, bodyLiteral: 0, domain: 0, graph: 0, graphProximity: 0,
    centrality: 0, actionability: 1, inDegree: 0, localEvidence: lexical,
    hubPenalty: 0, actionabilityPenalty: 0, final: lexical, ...extra,
  };
  return {
    symbolId: `s:${kind}:${lexical}`, filePath: "pkg/other/thing.py",
    fqName: "thing", localName: "thing", kind, scores, sources: [], evidence: [], matches: [],
  };
}

test("M95: strong-lexical exemption from generic-infrastructure is function/method only", () => {
  const outside = false; // NOT in local subsystem
  const noNameOverlap = 0;
  // A strong-lexical function/method escapes the generic-infra demotion.
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Function, 0.8), outside, noNameOverlap), false);
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Method, 0.6), outside, noNameOverlap), false);
  // A strong-lexical CLASS does NOT — broad data-structure/util classes stay demoted.
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Class, 0.9), outside, noNameOverlap), true);
  // Weak lexical function is still generic infrastructure (no free pass).
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Function, 0.2), outside, noNameOverlap), true);
  // A real symbol-name / path pointer still exempts any kind (unchanged behaviour).
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Class, 0, { symbol: 1 }), outside, noNameOverlap), false);
  // In-subsystem is never generic infrastructure, regardless of kind.
  assert.equal(isGenericInfrastructure(candidate(SymbolKind.Class, 0), true, noNameOverlap), false);
});

// ---------------------------------------------------------------------------
// M101 anchored-target pivot guard
// ---------------------------------------------------------------------------
//
// Tier-2 anchored targets (title symbol / high-signal literal / STRONG direct
// evidence — the ids buildCapsuleV2 passes as `namedAnchors`) get exactly two
// role-layer defences: (a) a dispatcher demotion never takes an anchored pivot,
// and (b) at most ONE anchored, anchor-actionable, non-test pivot survives the
// `maxPivots` cap as a bounded extra slot. Everything else — weak direct
// evidence, support-only lanes, base-gate support roles, tests, module-level
// kinds, micro tier — is untouched, and these tests pin each boundary.

function m101Candidate(
  id: string,
  localName: string,
  filePath: string,
  kind: SymbolKind,
  final: number,
  extra: Partial<HybridScoreComponents> = {},
): HybridCandidate {
  const scores: HybridScoreComponents = {
    lexical: 0.5, fts: 0.5, tfidf: 0.5, bm25: 0.5, symbol: 1, path: 0,
    testToImpl: 0, bodyLiteral: 0, domain: 0, graph: 0, graphProximity: 0,
    centrality: 0, actionability: 1, inDegree: 0, localEvidence: 0.5,
    hubPenalty: 0, actionabilityPenalty: 0, final, ...extra,
  };
  return {
    symbolId: id, filePath, fqName: `${filePath}::${localName}`, localName,
    kind, scores, sources: [], evidence: [], matches: [],
  };
}

const M101_TASK =
  "fix widgets: parse_widget_groups returns wrong widget names and "
  + "render_widget_list drops entries; simplify_widgets output is stale";
const m101Shaped = () => shapeSweQuery({ problemStatement: M101_TASK, failToPass: [] });

function m101Pivot(candidate: HybridCandidate) {
  return { candidate, role: CandidateRole.Pivot, why: "pivot: synthetic" };
}

import { refineDebugRoles } from "./debugRoles";
import { CandidateRole } from "../capsule/assignCandidateRoles";

test("M101: an anchored pivot beyond the cap keeps the pivot role (bounded to one)", () => {
  const db = openIndexerDatabase();
  const a = m101Candidate("m101:a", "parse_widget_groups", "pkg/widgets/utils.py", SymbolKind.Function, 3.0);
  const b = m101Candidate("m101:b", "render_widget_list", "pkg/widgets/utils2.py", SymbolKind.Function, 2.5);
  const c = m101Candidate("m101:c", "simplify_widgets", "pkg/widgets/entry.py", SymbolKind.Function, 2.0);
  const d = m101Candidate("m101:d", "widget_names", "pkg/widgets/extra.py", SymbolKind.Function, 1.8);

  // Without namedAnchors: cap 2 demotes c and d to support.
  const base = refineDebugRoles(db, [a, b, c, d].map(m101Pivot), m101Shaped(), 2);
  const roleOf = (r: ReturnType<typeof refineDebugRoles>, id: string) =>
    r.refined.find((e) => e.candidate.symbolId === id)!.role;
  assert.equal(roleOf(base, "m101:c"), CandidateRole.Support);
  assert.equal(roleOf(base, "m101:d"), CandidateRole.Support);
  assert.equal(base.anchoredCapExemption, undefined);

  // With BOTH c and d anchored: only the best-ordered one (c) is exempted.
  const guarded = refineDebugRoles(db, [a, b, c, d].map(m101Pivot), m101Shaped(), 2, {
    namedAnchors: { symbolIds: new Set(["m101:c", "m101:d"]) },
  });
  assert.equal(roleOf(guarded, "m101:a"), CandidateRole.Pivot);
  assert.equal(roleOf(guarded, "m101:b"), CandidateRole.Pivot);
  assert.equal(roleOf(guarded, "m101:c"), CandidateRole.Pivot, "anchored cap-evictee must stay a pivot");
  assert.equal(roleOf(guarded, "m101:d"), CandidateRole.Support, "the exemption is bounded to ONE");
  assert.equal(guarded.anchoredCapExemption?.symbol, "simplify_widgets");
  db.close();
});

test("M101: the cap exemption never fires for tests, module-level kinds, micro tier, or base-gate support", () => {
  const db = openIndexerDatabase();
  const a = m101Candidate("m101:a", "parse_widget_groups", "pkg/widgets/utils.py", SymbolKind.Function, 3.0);
  const b = m101Candidate("m101:b", "render_widget_list", "pkg/widgets/utils2.py", SymbolKind.Function, 2.5);

  // A TEST candidate beyond the cap stays demoted even when anchored.
  const testCand = m101Candidate("m101:t", "test_widget_groups", "tests/test_widgets.py", SymbolKind.Function, 2.0);
  const t = refineDebugRoles(db, [a, b, testCand].map(m101Pivot), m101Shaped(), 2, {
    namedAnchors: { symbolIds: new Set(["m101:t"]) },
  });
  assert.notEqual(t.refined.find((e) => e.candidate.symbolId === "m101:t")!.role, CandidateRole.Pivot);
  assert.equal(t.anchoredCapExemption, undefined);

  // A module VARIABLE a literal happened to hit is not anchor-actionable.
  const varCand = m101Candidate("m101:v", "WIDGET_NAMES", "pkg/widgets/consts.py", SymbolKind.ModuleVariable, 2.0);
  const v = refineDebugRoles(db, [a, b, varCand].map(m101Pivot), m101Shaped(), 2, {
    namedAnchors: { symbolIds: new Set(["m101:v"]) },
  });
  assert.equal(v.refined.find((e) => e.candidate.symbolId === "m101:v")!.role, CandidateRole.Support);
  assert.equal(v.anchoredCapExemption, undefined);

  // Micro tier (maxPivots=1) stays single-pivot decisive: no extra slot.
  const c = m101Candidate("m101:c", "simplify_widgets", "pkg/widgets/entry.py", SymbolKind.Function, 2.0);
  const micro = refineDebugRoles(db, [a, c].map(m101Pivot), m101Shaped(), 1, {
    namedAnchors: { symbolIds: new Set(["m101:c"]) },
  });
  assert.equal(micro.refined.filter((e) => e.role === CandidateRole.Pivot).length, 1);
  assert.equal(micro.anchoredCapExemption, undefined);

  // An anchored candidate the base gate marked SUPPORT is never promoted: the
  // exemption defends an earned pivot role, it does not create one. (Named so
  // the helper rule cannot promote it either — zero issue name-overlap.)
  const supCand = m101Candidate("m101:s", "assemble_report", "pkg/widgets/out.py", SymbolKind.Function, 2.0);
  const sup = { candidate: supCand, role: CandidateRole.Support, why: "support: synthetic" };
  const s = refineDebugRoles(db, [m101Pivot(a), m101Pivot(b), sup], m101Shaped(), 2, {
    namedAnchors: { symbolIds: new Set(["m101:s"]) },
  });
  assert.equal(s.refined.find((e) => e.candidate.symbolId === "m101:s")!.role, CandidateRole.Support);
  assert.equal(s.anchoredCapExemption, undefined);
  db.close();
});

test("M101: a weak-direct (non-anchored) cap-evictee still cannot claim a pivot slot", () => {
  const db = openIndexerDatabase();
  const a = m101Candidate("m101:a", "parse_widget_groups", "pkg/widgets/utils.py", SymbolKind.Function, 3.0);
  const b = m101Candidate("m101:b", "render_widget_list", "pkg/widgets/utils2.py", SymbolKind.Function, 2.5);
  // A weak direct-evidence injection: boosted final 1.9, organic final 0. It is
  // NOT in namedAnchors (weak tier is excluded by construction in the builder).
  const weak = m101Candidate("m101:w", "widget_entry", "pkg/widgets/weak.py", SymbolKind.Function, 1.9);
  const r = refineDebugRoles(db, [a, b, weak].map(m101Pivot), m101Shaped(), 2, {
    weakDirectEvidence: { symbolIds: new Set(["m101:w"]), organicFinalById: new Map([["m101:w", 0]]) },
    namedAnchors: { symbolIds: new Set(["m101:a"]) }, // anchor on a KEPT pivot: no exemption needed
  });
  assert.equal(r.refined.find((e) => e.candidate.symbolId === "m101:w")!.role, CandidateRole.Support);
  assert.equal(r.anchoredCapExemption, undefined);
  db.close();
});

test("M101: an anchored pivot is not dispatcher-demoted; an unanchored one still is", () => {
  const db = openIndexerDatabase();
  // Entry point delegating to two issue-relevant local helpers via source-body calls.
  const entry = m101Candidate("m101:e", "simplify_widgets", "pkg/widgets/entry.py", SymbolKind.Function, 3.0);
  const h1 = m101Candidate("m101:h1", "parse_widget_groups", "pkg/widgets/utils.py", SymbolKind.Function, 2.0);
  const h2 = m101Candidate("m101:h2", "render_widget_list", "pkg/widgets/utils.py", SymbolKind.Function, 1.9);
  const sourceTextOf = (id: string) =>
    id === "m101:e" ? "def simplify_widgets():\n  return parse_widget_groups() + render_widget_list()\n" : undefined;

  const base = refineDebugRoles(db, [entry, h1, h2].map(m101Pivot), m101Shaped(), 3, { sourceTextOf });
  const baseEntry = base.refined.find((e) => e.candidate.symbolId === "m101:e")!;
  assert.equal(baseEntry.role, CandidateRole.Support, "unanchored dispatcher is demoted");
  assert.match(baseEntry.roleReason, /entry point\/caller/);
  assert.equal(base.anchoredDispatcherExemptions.length, 0);

  const guarded = refineDebugRoles(db, [entry, h1, h2].map(m101Pivot), m101Shaped(), 3, {
    sourceTextOf,
    namedAnchors: { symbolIds: new Set(["m101:e"]) },
  });
  const guardedEntry = guarded.refined.find((e) => e.candidate.symbolId === "m101:e")!;
  assert.equal(guardedEntry.role, CandidateRole.Pivot, "anchored named target keeps the pivot role");
  assert.match(guardedEntry.roleReason, /task names this symbol directly/);
  assert.deepEqual(guarded.anchoredDispatcherExemptions, [
    { path: "pkg/widgets/entry.py", symbol: "simplify_widgets" },
  ]);
  // The helpers are unaffected either way.
  assert.equal(guarded.refined.find((e) => e.candidate.symbolId === "m101:h1")!.role, CandidateRole.Pivot);
  db.close();
});

test("M101: the guard is inert when no anchor lane fired (admindocs capsule unchanged)", () => {
  const r = admindocs(8_000);
  assert.equal(r.diagnostics.pivot_selection_version, undefined);
  assert.equal(r.diagnostics.anchored_pivot_cap_exemptions, undefined);
  assert.equal(r.diagnostics.anchored_dispatcher_demotions_prevented, undefined);
});
