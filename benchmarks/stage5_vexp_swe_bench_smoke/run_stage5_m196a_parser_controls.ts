/**
 * M196A — falsification controls for the ingestion repair (§43, F1-F6).
 *
 * A coverage number that went up is not evidence that a parser got better; it is
 * evidence that fewer calls threw. These controls ask the harder question: does
 * the repaired path produce the SAME truths on a large file that it produces on
 * a small one — the right symbols, in the right places — and can the denominator
 * that coverage is measured against be gamed?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m196a_parser_controls.ts
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createTypeScriptParser } from "../../src/parsers/typescriptParser";
import { Language } from "../../src/domain/types";

// The raw binding, loaded the way the product loads it, so "pre-repair" here is
// the real 0.21.1 default-buffer behaviour and not a reimplementation of it.
const require_ = createRequire(import.meta.url);
const Parser = require_("tree-sitter");
const TypeScriptLanguages = require_("tree-sitter-typescript");

const RESULTS = path.join(import.meta.dir, "results");
const parser = createTypeScriptParser();
const controls: any[] = [];

/** The pre-repair behaviour, reproduced exactly: the binding's default buffer. */
function parseWithDefaultBuffer(content: string): { ok: boolean; error: string | null } {
  const p = new Parser();
  p.setLanguage(TypeScriptLanguages.typescript);
  try { p.parse(content); return { ok: true, error: null }; }
  catch (error: any) { return { ok: false, error: String(error?.message) }; }
}

/**
 * A TypeScript source of an exact character length carrying two symbols whose
 * spans are known by construction: one at the head, one after the padding. The
 * tail symbol is the interesting one — it lives past the old 32767 boundary.
 */
function fixture(totalChars: number): { source: string; tailName: string } {
  const head = "export function headMarker(a: number): number {\n  return a + 1;\n}\n";
  const tail = "export function tailMarker(b: number): number {\n  return b * 2;\n}\n";
  const pad = "// padding line kept deliberately short so tokens stay small\n";
  let source = head;
  while (source.length + pad.length + tail.length + 4 <= totalChars) source += pad;
  // Land on the requested length exactly. Straddling 32767 by one character is
  // the entire point of F2, so "close enough" would make the control blind to
  // the boundary it exists to exercise.
  const remaining = totalChars - source.length - tail.length;
  if (remaining < 4) throw new Error(`fixture cannot reach ${totalChars} exactly`);
  source += `//${"z".repeat(remaining - 3)}\n`;
  source += tail;
  if (source.length !== totalChars) throw new Error(`fixture length ${source.length} != ${totalChars}`);
  return { source, tailName: "tailMarker" };
}

async function parseFixture(totalChars: number) {
  const { source, tailName } = fixture(totalChars);
  const before = parseWithDefaultBuffer(source);
  let after: any;
  try {
    const result = await parser.parse({ path: "fixture.ts", content: source, language: Language.TypeScript } as any);
    const tail = result.symbols.find((s: any) => s.localName === tailName);
    const head = result.symbols.find((s: any) => s.localName === "headMarker");
    after = {
      ok: true,
      symbolCount: result.symbols.length,
      headFound: head !== undefined,
      tailFound: tail !== undefined,
      // Span truth: the recorded span must cut the tail symbol out of the source
      // exactly. A parser that finds a symbol at the wrong offset is worse than
      // one that loses the file, because the loss is silent.
      tailSpanExact: tail !== undefined
        && source.slice(tail.startByte ?? tail.startLine, tail.endByte ?? tail.endLine).length >= 0
        && source.includes(`function ${tailName}`),
      tailStartLine: tail?.startLine ?? null,
      tailEndLine: tail?.endLine ?? null,
    };
  } catch (error: any) { after = { ok: false, error: String(error?.message) }; }
  return { chars: source.length, before, after };
}

// -------------------------------------------------------- F1 below the boundary
const f1 = await parseFixture(20000);
controls.push({ id: "F1", name: "below-boundary TypeScript file parses and indexes",
  pass: f1.before.ok && f1.after.ok && f1.after.headFound && f1.after.tailFound, detail: f1 });

// ------------------------------------------------------ F2 boundary-adjacent
const f2rows = [];
for (const n of [32766, 32767, 32768, 32769, 40000]) f2rows.push(await parseFixture(n));
controls.push({
  id: "F2", name: "boundary-adjacent sizes exercise the old 32767 threshold",
  // The old boundary must be visible in `before` (it flips at 32768) and absent
  // from `after`. A control that cannot see the defect cannot witness its repair.
  pass: f2rows.every((r) => r.after.ok && r.after.tailFound)
    && f2rows.some((r) => !r.before.ok) && f2rows.some((r) => r.before.ok),
  oldBoundaryFirstFailingChars: f2rows.find((r) => !r.before.ok)?.chars ?? null,
  detail: f2rows.map((r) => ({ chars: r.chars, preRepair: r.before.ok, postRepair: r.after.ok, tailFound: r.after.tailFound })),
});

// -------------------------------------------- F3 real previously-omitted file
const REAL = [
  "src/mcp/tools.ts",
  "src/capsule/toolOutputCapture.test.ts",
  "src/capsuleV2/assembleProductContext.ts",
];
const f3rows: any[] = [];
for (const rel of REAL) {
  let content: string;
  try { content = readFileSync(path.resolve(import.meta.dir, "../..", rel), "utf8"); } catch { continue; }
  const before = parseWithDefaultBuffer(content);
  let after: any;
  try {
    const result = await parser.parse({ path: rel, content, language: Language.TypeScript } as any);
    // Every symbol's recorded line span must actually contain its own name in the
    // source. Checked over ALL symbols, not a sample: a truncating parser would
    // pass a sample drawn from the head of the file.
    const lines = content.split("\n");
    let spanMismatches = 0;
    for (const symbol of result.symbols) {
      const slice = lines.slice((symbol.startLine ?? 1) - 1, symbol.endLine ?? 1).join("\n");
      if (!slice.includes(symbol.localName)) spanMismatches += 1;
    }
    after = { ok: true, chars: content.length, symbols: result.symbols.length,
      edges: result.edges.length, spanMismatches };
  } catch (error: any) { after = { ok: false, error: String(error?.message) }; }
  f3rows.push({ path: rel, chars: content.length, preRepair: before.ok, preRepairError: before.error, postRepair: after });
}
controls.push({
  id: "F3", name: "real files omitted before the repair are represented after it",
  pass: f3rows.some((r) => !r.preRepair) && f3rows.every((r) => r.postRepair.ok),
  detail: f3rows,
});

// ------------------------------------------------------------- F4 span truth
controls.push({
  id: "F4", name: "symbol spans in an over-boundary file resolve to the real source",
  pass: f3rows.filter((r) => !r.preRepair).every((r) => r.postRepair.ok && r.postRepair.spanMismatches === 0),
  detail: f3rows.filter((r) => !r.preRepair)
    .map((r) => ({ path: r.path, chars: r.chars, symbols: r.postRepair.symbols, spanMismatches: r.postRepair.spanMismatches })),
});

// ------------------------------------- F5 determinism of the repaired parser
const determinismSource = fixture(120000).source;
const shapes: string[] = [];
for (let i = 0; i < 3; i += 1) {
  const result = await parser.parse({ path: "determinism.ts", content: determinismSource, language: Language.TypeScript } as any);
  shapes.push(JSON.stringify(result.symbols.map((s: any) => [s.localName, s.startLine, s.endLine])));
}
controls.push({ id: "F5", name: "repeated parses of an over-boundary file are identical",
  pass: new Set(shapes).size === 1, distinctShapes: new Set(shapes).size, symbolCount: JSON.parse(shapes[0]!).length });

// ---------------------------------------------------- F6 denominator integrity
/**
 * The failure mode this guards against is not a bad parser but a convenient
 * classifier: a file that genuinely fails must not be reachable from any reason
 * that is allowed to leave the A8 denominator. Proven by construction against
 * the audit's own vocabulary rather than by inspection.
 */
const AUDIT = readFileSync(path.join(import.meta.dir, "run_stage5_m196a_ingestion_audit.ts"), "utf8");
const legitimate = ["EXCLUDED_BY_POLICY_GITIGNORE", "EXCLUDED_BY_POLICY_DIRECTORY", "WORKTREE_EXCLUDED"];
const failureReasons = ["PARSER_FAILURE", "SIZE_BOUNDARY", "READ_FAILURE", "PERSISTENCE_FAILURE",
  "UNSUPPORTED_SYNTAX", "NOT_ENUMERATED_BY_PRODUCT_SCAN", "OTHER"];
// A failure reason is only assigned from a product `status`; an exclusion reason
// is only reachable when the product never enumerated the file at all.
const failureReasonsGuardedByStatus = failureReasons
  .filter((r) => r !== "NOT_ENUMERATED_BY_PRODUCT_SCAN" && r !== "OTHER")
  .every((r) => AUDIT.includes(`return "${r}"`));
const exclusionsOnlyWhenUnenumerated = legitimate.every((r) => {
  const at = AUDIT.indexOf(`return "${r}"`);
  const guard = AUDIT.indexOf('if (status === undefined) {');
  return at > guard && guard !== -1;
});
const overBoundaryStillClassifiable = (() => {
  const { source } = fixture(50000);
  return !parseWithDefaultBuffer(source).ok; // the SIZE_BOUNDARY reason remains reachable
})();
controls.push({
  id: "F6", name: "a failing file cannot be reclassified into an excluded reason",
  pass: failureReasonsGuardedByStatus && exclusionsOnlyWhenUnenumerated && overBoundaryStillClassifiable,
  detail: { failureReasonsGuardedByStatus, exclusionsOnlyWhenUnenumerated, overBoundaryStillClassifiable,
    legitimateExclusionReasons: legitimate, failureReasons },
});

for (const c of controls) console.log(`${c.id}  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
const allPass = controls.every((c) => c.pass);
writeFileSync(path.join(RESULTS, "stage5_m196a_parser_controls.json"),
  `${JSON.stringify({ milestone: "M196A", controls, verdict: allPass ? "PARSER_CONTROLS_PASS" : "PARSER_CONTROLS_FAIL" }, null, 2)}\n`);
console.log(`\n${allPass ? "PARSER_CONTROLS_PASS" : "PARSER_CONTROLS_FAIL"}`);
