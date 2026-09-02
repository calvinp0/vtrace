/**
 * M204 — the budget stack, audited from the code that enforces it.
 *
 * Every budget, cap and ceiling between the caller's `max_tokens` and the
 * delivered orientation packet, read from the production module that owns it.
 * Exported values are imported; unexported constants are read from the source
 * text by a pattern that must match exactly once, so a renamed or removed
 * constant fails the audit rather than being transcribed from memory. For every
 * budget the flow is computed with the product's own functions.
 *
 * `--product-root` selects the tree audited, so the predecessor's stack and the
 * repaired stack can be printed side by side by the report.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m204_budget_stack.ts \
 *     --label post [--product-root <dir>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A11_BUDGETS } from "./m204Utilization";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const BUDGETS = argOf("--budgets", `${A11_BUDGETS.join(",")},1575,3000,6000,12000`).split(",").map((b) => Number.parseInt(b, 10));

const source = (rel: string): string => {
  const p = path.join(PRODUCT_ROOT, rel);
  if (!existsSync(p)) throw new Error(`M204_BUDGET_STACK_FILE_MISSING: ${rel}`);
  return readFileSync(p, "utf8");
};
/** A constant read from source text; the pattern must match exactly once. */
const constant = (rel: string, name: string, pattern: RegExp): number => {
  const text = source(rel);
  const matches = [...text.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1) throw new Error(`M204_BUDGET_STACK_CONSTANT_AMBIGUOUS: ${name} in ${rel} matched ${matches.length}x`);
  return Number(matches[0]![1]!.replace(/_/g, ""));
};
const symbolPresent = (rel: string, symbol: string): boolean => source(rel).includes(symbol);

const projection = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const accounting = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationAccounting.ts"));
const allocator = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const envelope = await import(path.join(PRODUCT_ROOT, "src/mcp/responseEnvelope.ts"));
const retrieval = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/authoritativeProductRetrieval.ts"));
const neighborhood = await import(path.join(PRODUCT_ROOT, "src/runPipeline/pivotNeighborhood.ts"));
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const ORIENTATION_POLICY = projection.ORIENTATION_POLICY;
const ceilingRule: ((requested: number | string) => number) | null =
  typeof projection.orientationCeilingTokens === "function" ? projection.orientationCeilingTokens : null;
const tokensPerCharacter: number = accounting.ORIENTATION_TOKENS_PER_CHARACTER;

const productDefaultBudget = constant("src/mcp/tools.ts", "CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS",
  /const CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS = ([0-9_]+);/);
const capsuleCharsPerToken = constant("src/capsuleV2/tokens.ts", "CHARS_PER_TOKEN", /const CHARS_PER_TOKEN = ([0-9]+);/);
const tierCapsSource = source("src/capsuleV2/budgetAllocator.ts");
const tierCaps = Object.fromEntries(["Micro", "Standard", "Full"].map((tier) => {
  const m = new RegExp(`\\[CapsuleV2Mode\\.${tier}\\]: \\{ maxPivots: (\\d+), maxSupport: (\\d+) \\}`).exec(tierCapsSource);
  if (m === null) throw new Error(`M204_BUDGET_STACK_TIER_MISSING: ${tier}`);
  return [tier.toLowerCase(), { maxPivots: Number(m[1]), maxSupport: Number(m[2]) }];
}));
const envelopeNeighborhoodEntries = constant("src/mcp/responseEnvelope.ts", "MAX_PIVOT_NEIGHBORHOOD_ENTRIES", /const MAX_PIVOT_NEIGHBORHOOD_ENTRIES = (\d+);/);
const envelopeNeighborRelations = constant("src/mcp/responseEnvelope.ts", "MAX_NEIGHBOR_RELATIONS_PER_PIVOT", /const MAX_NEIGHBOR_RELATIONS_PER_PIVOT = (\d+);/);
const supportExcerptCharacters = constant("src/productContext/budgetDelivery.ts", "support excerpt bound", /boundedExcerpt\(item\.content, (\d+)\)/);
const minimalContentCharacters = constant("src/productContext/budgetDelivery.ts", "minimal content bound", /characters \+ line\.length > (\d+) &&/);
const evidenceBudgetRetries = constant("src/mcp/responseEnvelope.ts", "MAX_EVIDENCE_BUDGET_RETRIES", /const MAX_EVIDENCE_BUDGET_RETRIES = (\d+);/);

// Symbols the table names must exist where it says they do.
const required: [string, string][] = [
  ["src/mcp/tools.ts", "parseOptionalInteger(McpToolId.RunPipeline, input, \"max_tokens\")"],
  ["src/mcp/tools.ts", "maxTokens * 4"],
  ["src/mcp/tools.ts", "capsuleBudgetTokens ?? maxTokens ?? CAPSULE_V2_PRODUCT_DEFAULT_BUDGET_TOKENS"],
  ["src/mcp/tools.ts", "compactProductResponse("],
  ["src/mcp/tools.ts", "projectRunPipelineOrientation(authoritativeResult)"],
  ["src/productContext/assembleProductContext.ts", "budgetTokens * PRODUCT_RETRIEVAL_CHARS_PER_TOKEN"],
  ["src/capsuleV2/authoritativeProductRetrieval.ts", "Math.floor(input.maxBudgetCharacters / PRODUCT_RETRIEVAL_CHARS_PER_TOKEN)"],
  ["src/capsuleV2/buildCapsuleV2.ts", "allocateBudget(input.maxTokens)"],
  ["src/capsuleV2/budgetAllocator.ts", "export function allocateBudget"],
  ["src/mcp/responseEnvelope.ts", "export function responseTokenCeiling"],
  ["src/mcp/responseEnvelope.ts", "applyProgressiveContextBudget(draft, evidenceBudgetTokens)"],
  ["src/productContext/budgetDelivery.ts", "export function applyProgressiveContextBudget"],
  ["src/productContext/budgetDelivery.ts", "estimateTokens(render(product, items)) <= budget"],
  ["src/runPipeline/pivotNeighborhood.ts", "export const PIVOT_NEIGHBORHOOD_DEFAULTS"],
  ["src/mcp/responseEnvelope.ts", "function compactPivotNeighborhood"],
  ["src/runPipeline/orientationProjection.ts", "export const ORIENTATION_POLICY"],
  ["src/runPipeline/orientationProjection.ts", "function headBound"],
  ["src/runPipeline/orientationProjection.ts", "orientationTokens(assemble(focus, next, notes))"],
  ["src/runPipeline/orientationAccounting.ts", "export const ORIENTATION_TOKENS_PER_CHARACTER"],
  ["src/runPipeline/orientationAccounting.ts", "export function withItemTokens"],
];
const missing = required.filter(([rel, sym]) => !symbolPresent(rel, sym));
if (missing.length > 0) throw new Error(`M204_BUDGET_STACK_SYMBOL_MISSING: ${missing.map(([r, s]) => `${r}:${s}`).join("; ")}`);

const packetTokens = (chars: number) => Math.max(0, Math.round(chars * tokensPerCharacter));

const layers = [
  { name: "caller max_tokens", file: "src/mcp/tools.ts", function: "run_pipeline / get_code_context handler (parseOptionalInteger)",
    units: "tokens (caller's own; product reads as chars/4)", default: productDefaultBudget, bound: "soft: validated as a non-negative integer; no upper bound on this path",
    callerDerived: true, fixed: false, scaled: "identity", reason: "the caller's model-visible context budget (M130)" },
  { name: "capsule retrieval budget", file: "src/mcp/tools.ts -> src/productContext/assembleProductContext.ts -> src/capsuleV2/authoritativeProductRetrieval.ts",
    function: "maxBudgetCharacters = max_tokens x 4; buildAuthoritativeProductRetrieval floors it back to tokens", units: "characters (x4) then tokens (/4)",
    default: productDefaultBudget * capsuleCharsPerToken, bound: "soft", callerDerived: true, fixed: false, scaled: "linear x4 then /4",
    reason: "the capsule builder budgets in characters by design (src/capsuleV2/tokens.ts)" },
  { name: "capsule sizing tier", file: "src/capsuleV2/budgetAllocator.ts", function: "allocateBudget(maxTokens)", units: "item counts per tier",
    default: `micro < ${allocator.MICRO_MAX_TOKENS} < standard < ${allocator.STANDARD_MAX_TOKENS} <= full`, bound: "HARD item-count caps per tier (product policy: precision/coverage lever)",
    callerDerived: true, fixed: true, scaled: "step function of the budget", reason: "a tiny budget must be decisive; caps are the product's declared coverage lever, chosen from the budget alone",
    values: tierCaps },
  { name: "evidence budget (progressive context)", file: "src/productContext/budgetDelivery.ts", function: "applyProgressiveContextBudget(draft, requestedTokens)",
    units: "tokens = ceil(chars/4) of modelVisibleContext", default: productDefaultBudget, bound: "HARD on the rendered context: compaction ladder then delivery failure",
    callerDerived: true, fixed: false, scaled: "identity", reason: "max_tokens bounds the model-visible context (M130); support excerpts shortened to "
      + `${supportExcerptCharacters} chars, minimal representation ${minimalContentCharacters} chars` },
  { name: "complete-response ceiling", file: "src/mcp/responseEnvelope.ts", function: "responseTokenCeiling(requested) = requested + max(floor, ratio x requested)",
    units: "tokens = ceil(chars/4) of the serialized authoritative response", default: envelope.responseTokenCeiling(productDefaultBudget),
    bound: "HARD on the serialized authoritative response; the evidence budget may be lowered up to " + `${evidenceBudgetRetries}x to fit it`,
    callerDerived: true, fixed: false, scaled: `requested + max(${envelope.RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS}, ${envelope.RESPONSE_METADATA_ALLOWANCE_RATIO} x requested)`,
    reason: "the delivery constraint (M178): what may cross the wire" },
  { name: "pivot-neighbourhood supply", file: "src/runPipeline/pivotNeighborhood.ts", function: "buildPivotNeighborhoods (PIVOT_NEIGHBORHOOD_DEFAULTS)",
    units: "item counts", default: `${neighborhood.PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots} pivots x ${neighborhood.PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot} excerpts`,
    bound: "HARD count cap, fixed", callerDerived: false, fixed: true, scaled: "none", reason: "bounded neighbourhood evidence per pivot; the envelope's own cap "
      + `(${envelopeNeighborhoodEntries} x ${envelopeNeighborRelations}, compactPivotNeighborhood) is looser and never binds` },
  { name: "orientation evidence ceiling", file: "src/runPipeline/orientationProjection.ts",
    function: ceilingRule ? "orientationCeilingTokens(requested_context_tokens); ORIENTATION_POLICY.ceilingTokens when the budget is unavailable" : "ORIENTATION_POLICY.ceilingTokens (fixed)",
    units: `packet tokens = chars x ${tokensPerCharacter.toFixed(4)}, nearest`, default: ORIENTATION_POLICY.ceilingTokens,
    bound: ceilingRule ? "soft default (2000, M172's R2000 rung) when no budget reached the projector; the caller's budget in the packet's unit otherwise; governs `related` only, never the focus or notes"
      : "fixed 2000 on every budget (M172's R2000 rung, frozen as a product default); governs `related` only",
    callerDerived: ceilingRule !== null, fixed: ceilingRule === null, scaled: ceilingRule ? "requested x 4 chars x tokens-per-character" : "none",
    reason: ceilingRule ? "the packet is the model-visible output of the default path, so its evidence ceiling is the caller's model-visible budget stated in the packet's own unit"
      : "M171's declared-but-unwired ceiling made real in M172 at the R2000 rung; sized on agent economics, never on the caller's budget" },
  { name: "focus head bound", file: "src/runPipeline/orientationProjection.ts", function: "headBound(body, ORIENTATION_POLICY.focusCodeCharacters)",
    units: "characters, cut on a line boundary", default: ORIENTATION_POLICY.focusCodeCharacters, bound: "HARD, fixed", callerDerived: false, fixed: true, scaled: "none",
    reason: "M172 frozen policy: the one body the packet carries is head-bounded so a packet never ships an unbounded excerpt" },
  { name: "wrapper", file: "src/runPipeline/orientationProjection.ts", function: "assemble(): schemaVersion, boundary, notes, keys",
    units: "packet tokens", default: "measured per packet (ledger.wrapper)", bound: "inside the evidence packet the ceiling tests", callerDerived: false, fixed: false, scaled: "with notes",
    reason: "the global claim boundary appears on every packet unconditionally" },
  { name: "accounting overhead", file: "src/runPipeline/orientationAccounting.ts", function: "withItemTokens(): the per-item `tokens` field",
    units: "packet tokens", default: "measured per packet (ledger.accountingOverhead)", bound: "rides ABOVE the ceiling by a stated amount (M203)", callerDerived: false, fixed: false, scaled: "one integer per item",
    reason: "charging the description of the evidence inside admission would evict evidence (M203)" },
  { name: "tool schema", file: "src/mcp/tools.ts", function: "defaultMcpToolRegistry.listMetadata()", units: "tokens, per session not per call",
    default: "measured by the frozen engine (toolSchemaTokens)", bound: "not part of any response", callerDerived: false, fixed: true, scaled: "none",
    reason: "not counted by the frozen A11 numerator, which is the response alone" },
];

const flow = BUDGETS.map((b) => {
  const allocation = allocator.allocateBudget(b);
  return {
    budget: b,
    capsuleCharacters: b * capsuleCharsPerToken,
    capsuleTier: allocation.tier, maxPivots: allocation.maxPivots, maxSupport: allocation.maxSupport,
    evidenceBudgetTokens: b,
    completeResponseCeilingTokens: envelope.responseTokenCeiling(b),
    orientationCeilingTokens: ceilingRule ? ceilingRule(b) : ORIENTATION_POLICY.ceilingTokens,
    /** The frozen A11 MATCH line for this budget, and what it is in the packet's unit. */
    frozenMatchTokens: Math.ceil(0.6 * b), frozenMatchCharacters: Math.ceil(0.6 * b) * 4,
    frozenMatchPacketTokens: packetTokens(Math.ceil(0.6 * b) * 4),
    focusHeadBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters,
  };
});

const out = {
  milestone: "M204", instrument: "run_stage5_m204_budget_stack.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead },
  tokenRules: {
    caller: "ceil(characters / 4) (src/capsuleV2/tokens.ts, the frozen fixture's rule)",
    packet: `characters x ${tokensPerCharacter} nearest (orientationAccounting.ts)`,
    conversion: `one caller token = ${capsuleCharsPerToken} characters = ${(capsuleCharsPerToken * tokensPerCharacter).toFixed(4)} packet tokens`,
  },
  diagram: [
    "caller max_tokens (chars/4)",
    "-> capsule retrieval budget: max_tokens x 4 characters -> allocateBudget tier caps (micro/standard/full)",
    "-> evidence budget: applyProgressiveContextBudget bounds modelVisibleContext to max_tokens (chars/4)",
    "-> complete-response ceiling: responseTokenCeiling(max_tokens) on the serialized authoritative response",
    `-> orientation projection: ${ceilingRule ? "ceiling = orientationCeilingTokens(requested_context_tokens)" : "ceiling = 2000 fixed"}; focus head bound ${ORIENTATION_POLICY.focusCodeCharacters} chars; related = relationship-only`,
    "-> delivered packet (+ per-item tokens fields above the ceiling)",
  ],
  layers, flow,
  symbolsVerified: required.length,
};
writeFileSync(path.join(RESULTS, `stage5_m204_budget_stack_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`[${LABEL}] ${layers.length} layers, ${required.length} symbols verified @ ${productHead.slice(0, 12)}`);
for (const f of flow) console.log(`  ${String(f.budget).padStart(6)}  tier ${f.capsuleTier.padEnd(8)} caps ${f.maxPivots}/${f.maxSupport}  evidence ${f.evidenceBudgetTokens}  response ceiling ${f.completeResponseCeilingTokens}  orientation ceiling ${f.orientationCeilingTokens}  A11 match line ${f.frozenMatchTokens} tok = ${f.frozenMatchPacketTokens} packet tok`);
