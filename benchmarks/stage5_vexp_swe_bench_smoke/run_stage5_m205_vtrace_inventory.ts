/**
 * M205 — the VTRACE representation inventory (§8, §9), traced from code.
 *
 * Every representation an item can arrive in, from the authoritative evidence
 * object to the model-facing packet, with the function that constructs it, the
 * authority its text comes from, its cost rule, its truncation rule and the
 * condition that routes an item into it. Each row names symbols that are
 * VERIFIED to exist in the named file, so the table cannot describe code that
 * is not there; a row whose symbol is missing fails the instrument.
 *
 * `--product-root` selects the tree described (the working tree by default, or
 * the predecessor worktree), so the same instrument records the pre-M205 and
 * post-M205 inventories and the difference between them is mechanical.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m205_vtrace_inventory.ts \
 *     --label post [--product-root <dir>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const source = (file: string): string | null => {
  const p = path.join(PRODUCT_ROOT, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};
const has = (file: string, needle: string): boolean => (source(file) ?? "").includes(needle);

interface Row {
  readonly stage: string;
  readonly classIdentity: string;
  readonly sourceObject: string;
  readonly file: string;
  readonly constructionFunction: string;
  readonly symbols: readonly string[];
  readonly modelFacingFields: string;
  readonly bodyBehaviour: string;
  readonly costRule: string;
  readonly truncationBehaviour: string;
  readonly routingCondition: string;
  /** Only present in the tree after M205. */
  readonly m205?: true;
}

const ROWS: readonly Row[] = [
  { stage: "capsule", classIdentity: "capsule content_mode full / signature / skeleton / document_excerpt / mechanism_slice",
    sourceObject: "CapsuleV2Item", file: "src/capsuleV2/types.ts", constructionFunction: "buildCapsuleV2 → loadFocusedSource / loadSignature / composeDocumentItem",
    symbols: ["enum CapsuleV2ContentMode", "MechanismSlice = \"mechanism_slice\""],
    modelFacingFields: "not model-facing on the default path (authoritative result only)",
    bodyBehaviour: "full: extractFullSymbolSource of the indexed symbol span; signature: symbol.signature; document_excerpt: line-bounded excerpts joined",
    costRule: "estimated_tokens = estimateTokens(itemBlockText(item)) (chars/4)", truncationBehaviour: "none at this stage",
    routingCondition: "tier caps and role: pivots full, support signature/skeleton (budgetAllocator)" },
  { stage: "capsule", classIdentity: "loadFocusedSource", sourceObject: "symbol span", file: "src/capsuleV2/buildCapsuleV2.ts",
    constructionFunction: "loadFocusedSourceById → loadSymbolSource + extractFullSymbolSource",
    symbols: ["function loadFocusedSourceById", "function loadSignature"],
    modelFacingFields: "item.source", bodyBehaviour: "verbatim byte span of the indexed symbol", costRule: "chars/4", truncationBehaviour: "none",
    routingCondition: "role pivot (content_mode full)" },
  { stage: "product context", classIdentity: "ProductContextContentMode focused_source / skeleton / signature / summary / document_excerpt",
    sourceObject: "ProductContextItem", file: "src/productContext/assembleProductContext.ts", constructionFunction: "sourceDraft",
    symbols: ["function sourceDraft", "contentMode = \"focused_source\"", "contentMode = \"skeleton\"", "contentMode = \"signature\"", "contentMode = \"summary\""],
    modelFacingFields: "items[].contentMode, items[].content; rendered into modelVisibleContext as `mode:` + body",
    bodyBehaviour: "focused_source: item.source; skeleton: renderStructuralSkeleton (index signature + member signatures + docstring); signature: item.signature; summary: no content",
    costRule: "estimatedTokens (chars/4) per item; accounting.usedTokensEstimate over the rendering", truncationBehaviour: "skeleton members capped at 12, docstring compacted to 180",
    routingCondition: "capsule content_mode full + source → focused_source; else structural skeleton if the index has the symbol; else signature; else summary" },
  { stage: "product context", classIdentity: "structural skeleton", sourceObject: "index symbols + skeleton file result",
    file: "src/productContext/assembleProductContext.ts", constructionFunction: "renderStructuralSkeleton",
    symbols: ["function renderStructuralSkeleton", "getIndexedSkeletonFileResult(db, filePath, \"detailed\")"],
    modelFacingFields: "items[].content (mode skeleton)", bodyBehaviour: "signature line, class members' signatures (<= 12), `# docstring`",
    costRule: "chars/4", truncationBehaviour: "members.slice(0, 12); compact(docstring, 180)", routingCondition: "item not full and the file is indexed" },
  { stage: "product context", classIdentity: "impact summary (not source)", sourceObject: "impact graph relation", file: "src/productContext/assembleProductContext.ts",
    constructionFunction: "addImpactEvidence", symbols: ["function addImpactEvidence", "contentMode: \"summary\""],
    modelFacingFields: "items[].content = `KIND fqName at path:line [strength]`", bodyBehaviour: "a relation line, not code",
    costRule: "chars/4; MAX_TOTAL_IMPACT_CHARS", truncationBehaviour: "count and character caps", routingCondition: "incoming relations of up to MAX_IMPACT_PIVOTS pivots" },
  { stage: "evidence budget", classIdentity: "excerpt / signature (budget-compacted)", sourceObject: "MutableItem", file: "src/productContext/budgetDelivery.ts",
    constructionFunction: "applyProgressiveContextBudget → boundedExcerpt / minimalContent",
    symbols: ["export function applyProgressiveContextBudget", "function boundedExcerpt", "function minimalContent", "item.contentMode = \"excerpt\"", "item.contentMode = \"signature\""],
    modelFacingFields: "items[].contentMode rewritten in place; modelVisibleContext re-rendered", bodyBehaviour: "excerpt: head of the body plus the marker line; signature: the first defining lines (a head slice, NOT the parser signature)",
    costRule: "estimateTokens(render) <= max_tokens", truncationBehaviour: "boundedExcerpt(content, 900); minimalContent <= 8 lines / 480 chars",
    routingCondition: "only when the rendering exceeds max_tokens; optional support first, then secondary pivots, then everything" },
  { stage: "response envelope", classIdentity: "neighbourhood excerpt text stripped", sourceObject: "pivotNeighborhood[].excerpts[]", file: "src/mcp/responseEnvelope.ts",
    constructionFunction: "compactProductResponse (pivotNeighborhood compaction)", symbols: ["textCharacters: text.length", "pivotNeighborhood[].excerpts[].text"],
    modelFacingFields: "textCharacters only", bodyBehaviour: "text removed before the projector runs", costRule: "n/a", truncationBehaviour: "whole text removed",
    routingCondition: "always on the MCP surface" },
  { stage: "projection", classIdentity: "focus: FOCUS:<form>", sourceObject: "supply item body parsed from modelVisibleContext", file: "src/runPipeline/orientationProjection.ts",
    constructionFunction: "projectRunPipelineOrientation → parseRenderedBodies + headBound", symbols: ["function parseRenderedBodies", "focusCodeCharacters: 1800", "codeTruncated: bounded.truncated"],
    modelFacingFields: "focus.form, focus.code, focus.codeTruncated, focus.tokens", bodyBehaviour: "the item's rendered body, head-bounded to 1800 characters on a line boundary",
    costRule: "packet rule 0.3174 tokens/char (withItemTokens)", truncationBehaviour: "headBound on a line boundary; ORIENTATION_TRUNCATION_NOTE", routingCondition: "leadPivot, else first pivot, else first item" },
  { stage: "projection", classIdentity: "related: RELATIONSHIP_ONLY", sourceObject: "supply items + pivot neighbourhood", file: "src/runPipeline/orientationProjection.ts",
    constructionFunction: "consider → assemble; admission prefix under orientationCeilingTokens", symbols: ["const consider =", "export function orientationCeilingTokens"],
    modelFacingFields: "at, file, lines, how, tokens", bodyBehaviour: "no code", costRule: "packet rule", truncationBehaviour: "none",
    routingCondition: "every admitted related entry (pre-M205: unconditionally)" },
  { stage: "projection", classIdentity: "related: upstream form delivered (focused_source / skeleton / signature / excerpt / document_excerpt)", sourceObject: "supply item body",
    file: "src/runPipeline/orientationRepresentation.ts", constructionFunction: "availableRepresentation + headBound; routed in projectRunPipelineOrientation after admission",
    symbols: ["export const CODE_BEARING_FORMS", "export function availableRepresentation", "export const RELATED_CODE_CHARACTERS = 600", "export const REPRESENTATION_LADDER"],
    modelFacingFields: "related[].form, related[].code, related[].codeTruncated (present together or not at all)", bodyBehaviour: "the item's rendered body, head-bounded to 600 characters on a line boundary; label verbatim from upstream",
    costRule: "packet rule; tested against the caller's ceiling with later entries compact", truncationBehaviour: "headBound; codeTruncated per entry",
    routingCondition: "origin item_supply, form in CODE_BEARING_FORMS, body non-empty, and the packet with it within the ceiling; else relationship-only with a recorded reason", m205: true },
  { stage: "accounting", classIdentity: "per-item ledger", sourceObject: "OrientationItemAccounting", file: "src/runPipeline/orientationAccounting.ts",
    constructionFunction: "publishOrientationAccounting / withItemTokens", symbols: ["export function withItemTokens", "export function publishOrientationAccounting", "readonly representation: string"],
    modelFacingFields: "tokens per item", bodyBehaviour: "n/a", costRule: "measured serialized characters x 0.3174, fixed point on the field", truncationBehaviour: "n/a",
    routingCondition: "every delivered item" },
];

const rows = ROWS.map((r) => {
  const present = r.symbols.map((s) => ({ symbol: s, present: has(r.file, s) }));
  const applicable = r.m205 !== true || present.some((p) => p.present);
  return { ...r, symbolsVerified: present, allPresent: present.every((p) => p.present), applicableToThisTree: applicable };
});
const applicableRows = rows.filter((r) => r.applicableToThisTree);
const verified = applicableRows.every((r) => r.allPresent);
const projectionClasses = rows.filter((r) => r.stage === "projection" && r.applicableToThisTree && r.allPresent).map((r) => r.classIdentity);

const out = {
  milestone: "M205", instrument: "run_stage5_m205_vtrace_inventory.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead },
  pipeline: ["buildCapsuleV2", "assembleProductContext (sourceDraft, renderModelVisibleContext)", "applyProgressiveContextBudget", "compactProductResponse",
    "projectRunPipelineOrientation (admission, then representation routing)", "withItemTokens / publishOrientationAccounting"],
  rows, verified, projectionClasses,
  frozenA12View: {
    countedBy: "FOCUS:<form>, RELATED_WITH_CODE, RELATIONSHIP_ONLY",
    preM205: "related entries never carry code, so C-MED delivers FOCUS:focused_source and RELATIONSHIP_ONLY: 2 classes",
    whyNotMore: "focus vs related does not count separately beyond the focus form; signature vs skeleton is not distinguished on related entries by the frozen rule; the count is by content class (code present, and the focus's form), not by schema shape or production variant",
  },
  verdict: verified ? "M205_VTRACE_INVENTORY_VERIFIED" : "M205_VTRACE_INVENTORY_SYMBOL_MISSING",
};
writeFileSync(path.join(RESULTS, `stage5_m205_vtrace_representation_inventory_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
const md: string[] = [`# M205 — VTRACE representation inventory (${LABEL}, ${productHead.slice(0, 12)})`, "",
  `| stage | class | file | construction | model-facing fields | body | bound | routing | symbols |`, `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`];
for (const r of applicableRows) md.push(`| ${r.stage} | ${r.classIdentity} | \`${r.file}\` | ${r.constructionFunction} | ${r.modelFacingFields} | ${r.bodyBehaviour} | ${r.truncationBehaviour} | ${r.routingCondition} | ${r.allPresent ? "verified" : "MISSING"} |`);
md.push("", `Projection classes in this tree: ${projectionClasses.join("; ")}.`, "", `${out.frozenA12View.preM205}. ${out.frozenA12View.whyNotMore}.`, "");
writeFileSync(path.join(RESULTS, `stage5_m205_vtrace_representation_inventory_${LABEL}.md`), `${md.join("\n")}\n`);
for (const r of rows) console.log(`${r.applicableToThisTree ? (r.allPresent ? "ok     " : "MISSING") : "n/a    "} ${r.stage.padEnd(18)} ${r.classIdentity.slice(0, 70)}`);
console.log(out.verdict);
if (!verified) process.exit(1);
