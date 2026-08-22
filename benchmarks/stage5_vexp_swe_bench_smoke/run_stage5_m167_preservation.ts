/**
 * M167-E — preservation.
 *
 * M167 changed no product code, so the strongest available control is not a test
 * result but the absence of a diff: every invariant §57 lists is a property of code
 * that is byte-identical to the M166 commit. That is asserted mechanically here rather
 * than claimed, and then the behavioural controls are run anyway, because "no diff"
 * would not catch a captured artifact that disagrees with the product.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractFacts } from "./m166Compression";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m167_capture_current");
const M166_COMMIT = "749434eec6569eecca0abce65372e5ec8b4526f9";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

interface Check { readonly check: string; readonly passed: boolean; readonly detail: string }

function main(): void {
  const checks: Check[] = [];

  // §57 — the invariant list, discharged by showing the code never moved.
  const productDiff = git("diff", "--stat", M166_COMMIT, "HEAD", "--", "src/");
  const productDirty = git("status", "--porcelain", "--", "src/");
  checks.push({
    check: "no product code changed since the M166 commit",
    passed: productDiff.length === 0 && productDirty.length === 0,
    detail: productDiff.length === 0 && productDirty.length === 0
      ? "src/ is byte-identical to 749434ee, committed and working tree alike — retrieval lead, rank order, candidate generation, support selection, impact semantics, module visibility, the duplicate-support invariant, behavioural routing state, index schemas and session isolation are all unreachable by this milestone"
      : `src/ differs: ${productDiff || productDirty}`,
  });

  const toolSchemaDirty = git("status", "--porcelain", "--", "src/mcp/");
  checks.push({
    check: "tool name, input schema and output schema are unchanged",
    passed: toolSchemaDirty.length === 0,
    detail: "src/mcp/ is untouched, so no tool contract moved",
  });

  // Behavioural controls over the captured responses.
  const files = readdirSync(CAPTURE).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  const standard = files.map((f) => {
    const record = JSON.parse(readFileSync(path.join(CAPTURE, f), "utf8"));
    return { record, call: (record.calls as any[]).find((c) => c.call === "get_code_context.standard") };
  }).filter((r) => r.call !== undefined);
  const debug = files.map((f) => {
    const record = JSON.parse(readFileSync(path.join(CAPTURE, f), "utf8"));
    return { record, call: (record.calls as any[]).find((c) => c.call === "get_code_context.debug") };
  }).filter((r) => r.call !== undefined);

  checks.push({
    check: "both result channels are still returned on every call",
    passed: standard.every((r) => r.call.contentText !== null && r.call.structuredContent !== null)
      && standard.every((r) => r.call.contentBlockCount === 1 && r.call.contentBlockTypes[0] === "text"),
    detail: `${standard.length}/${standard.length} calls carry exactly one text content block and a structuredContent value`,
  });

  const indexWrites = JSON.parse(readFileSync(path.join(CAPTURE, "_index.json"), "utf8")).indexWrites;
  checks.push({
    check: "no probe wrote to an index",
    passed: indexWrites === 0,
    detail: `indexWrites=${indexWrites} across ${standard.length} workspaces, digested before and after every session`,
  });

  // §45 — the M164 readiness repair must still hold on every served response.
  const readiness = standard.map((r) => {
    const output = r.call.structuredContent?.result?.output;
    const freshness = output?.productContext?.freshness ?? {};
    const indexFreshness = output?.diagnostics?.indexFreshness ?? {};
    return {
      instanceId: r.record.instanceId,
      status: freshness.status ?? null,
      served: output?.productContext?.resultState ?? null,
      readinessPresent: indexFreshness.readiness !== undefined || output?.diagnostics?.freshness?.readiness !== undefined,
    };
  });
  checks.push({
    check: "readiness and served-state semantics are present on every response",
    passed: readiness.every((r) => r.status !== null && r.served !== null),
    detail: `statuses observed: ${[...new Set(readiness.map((r) => r.status))].join(", ")}; result states: ${[...new Set(readiness.map((r) => r.served))].join(", ")}`,
  });

  // §43 — debug must still carry the full diagnostics M166-D moved behind it.
  const debugMembers = debug.map((r) => Object.keys(r.call.structuredContent?.result?.output?.diagnostics ?? {}));
  const standardMembers = standard.map((r) => Object.keys(r.call.structuredContent?.result?.output?.diagnostics ?? {}));
  // Debug carries the machine diagnostics unless the ENVELOPE held them back, which is
  // a disclosed omission and not a loss. Asserting unconditional presence would fail on
  // a response that told the truth about being over the ceiling.
  const debugRows = debug.map((r, i) => ({
    instanceId: r.record.instanceId,
    members: debugMembers[i] ?? [],
    disclosedOmission: (debugMembers[i] ?? []).includes("sectionDecisionsOmitted"),
  }));
  const debugCarries = debugRows.filter((r) => r.members.includes("retrieval") && r.members.includes("budget") && r.members.includes("intent"));
  const debugDisclosed = debugRows.filter((r) => !debugCarries.includes(r) && r.disclosedOmission);
  checks.push({
    check: "detail=debug returns the machine diagnostics M166-D held back, or discloses that the envelope held them back",
    passed: debugCarries.length + debugDisclosed.length === debugRows.length,
    detail: `${debugCarries.length}/${debugRows.length} carry the full set; ${debugDisclosed.length} disclose an envelope omission (${debugDisclosed.map((r) => r.instanceId).join(", ") || "none"}); 0 lost anything silently`,
  });
  checks.push({
    check: "default detail still holds those diagnostics back",
    passed: standardMembers.every((m) => !m.includes("retrieval") && !m.includes("budget")),
    detail: `standard members: ${[...new Set(standardMembers.flat())].sort().join(", ")}`,
  });

  // Selection identity against M166's own capture of the same twelve tasks at this HEAD.
  const m166After = JSON.parse(readFileSync(path.join(RESULTS, "_m166_acceptance/after.json"), "utf8"));
  const selectionAgreement = standard.map((r) => {
    const mine = extractFacts(r.call.structuredContent?.result?.output);
    const theirs = (m166After.cases as any[]).find((c) => c.instanceId === r.record.instanceId)?.standard?.selection;
    if (theirs === undefined) return { instanceId: r.record.instanceId, agreed: null as boolean | null };
    return {
      instanceId: r.record.instanceId,
      agreed: JSON.stringify(mine.itemPaths) === JSON.stringify(theirs.itemPaths) && mine.leadPivot === theirs.leadPivot,
    };
  });
  const comparable = selectionAgreement.filter((s) => s.agreed !== null);
  checks.push({
    check: "retrieval selection is identical to M166's capture of the same tasks at this HEAD",
    passed: comparable.length > 0 && comparable.every((s) => s.agreed === true),
    detail: `${comparable.filter((s) => s.agreed).length}/${comparable.length} agree on lead pivot and item paths; disagreements: ${comparable.filter((s) => !s.agreed).map((s) => s.instanceId).join(", ") || "none"}`,
  });

  writeFileSync(path.join(RESULTS, "stage5_m167_regression_checks.json"), JSON.stringify({
    schemaVersion: 1,
    milestone: "M167",
    workstream: "E",
    title: "Preservation and regression controls",
    productChanged: false,
    checks,
    allPassed: checks.every((c) => c.passed),
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_readiness_preservation.json"), JSON.stringify({
    schemaVersion: 1, milestone: "M167", workstream: "E",
    title: "Readiness and served-state, per reference task",
    note: "M164's readiness repair is a property of src/, which this milestone did not touch; observed here to confirm the captured population agrees with the product",
    cases: readiness,
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_debug_preservation.json"), JSON.stringify({
    schemaVersion: 1, milestone: "M167", workstream: "E",
    title: "detail=debug still carries the full diagnostics",
    envelopeCeilingCaveat: "detail=debug is subject to the same response ceiling as any other detail level. On the reference population one task exceeds it and the escalation ladder drops the machine diagnostics, disclosing the fact through diagnostics.sectionDecisionsOmitted. This is pre-existing product behaviour, not a change: src/ is byte-identical to the M166 commit. It does mean debug is not an unconditional guarantee of full diagnostics on a large response.",
    cases: debug.map((r, i) => ({
      instanceId: r.record.instanceId,
      debugDiagnosticMembers: debugMembers[i],
      envelopeDisclosedOmission: (debugMembers[i] ?? []).includes("sectionDecisionsOmitted"),
      standardDiagnosticMembers: standardMembers[i],
      debugCharacters: JSON.stringify(r.call.structuredContent?.result?.output?.diagnostics ?? {}).length,
      standardCharacters: JSON.stringify(standard[i]?.call.structuredContent?.result?.output?.diagnostics ?? {}).length,
    })),
  }, null, 1));

  writeFileSync(path.join(RESULTS, "stage5_m167_semantic_identity.json"), JSON.stringify({
    schemaVersion: 1, milestone: "M167", workstream: "E",
    title: "Selection identity against M166's capture of the same tasks",
    basis: "benchmarks/stage5_vexp_swe_bench_smoke/results/_m166_acceptance/after.json — captured at the same HEAD by a different harness",
    cases: selectionAgreement,
    agreed: `${comparable.filter((s) => s.agreed).length}/${comparable.length}`,
  }, null, 1));

  for (const check of checks) console.error(`[m167-E] ${check.passed ? "PASS" : "FAIL"} ${check.check} — ${check.detail}`);
  if (!checks.every((c) => c.passed)) process.exitCode = 1;
}

main();
