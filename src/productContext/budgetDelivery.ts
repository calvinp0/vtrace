import { estimateTokens } from "../capsuleV2/tokens";

export const DeliveryResultState = Object.freeze({
  Resolved: "resolved",
  NoResult: "no_result",
  DeliveryFailure: "delivery_failure",
});

export type DeliveryResultState =
  (typeof DeliveryResultState)[keyof typeof DeliveryResultState];

export const DeliveryStatus = Object.freeze({
  Complete: "complete",
  Compacted: "compacted",
  Failed: "failed",
  NoResult: "no_result",
});

export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const CompactionStage = Object.freeze({
  SelectionReasonsCompacted: "selection_reasons_compacted",
  SupportExcerptShortened: "support_excerpt_shortened",
  SupportSkeletonized: "support_skeletonized",
  SupportDropped: "support_dropped",
  SecondaryPivotSkeletonized: "secondary_pivot_skeletonized",
  SecondaryPivotDropped: "secondary_pivot_dropped",
  LeadExcerptShortened: "lead_excerpt_shortened",
  MinimalRepresentation: "minimal_representation",
});

export type CompactionStage = (typeof CompactionStage)[keyof typeof CompactionStage];

type JsonRecord = Record<string, unknown>;

export interface DeliveryAccounting {
  readonly status: DeliveryStatus;
  readonly selectedItemsBeforeBudget: number;
  readonly deliveredItems: number;
  readonly droppedForBudget: number;
  readonly initialModelTokens: number;
  readonly finalModelTokens: number;
  readonly compactionPasses: number;
  readonly compactionStages: readonly CompactionStage[];
  readonly excerptsShortened: number;
  readonly skeletonizedItems: number;
  readonly supportDropped: number;
}

export interface BudgetDeliveryResult {
  readonly resultState: DeliveryResultState;
  readonly retrievalFound: boolean;
  readonly resolved: boolean;
  readonly deliveryFailed: boolean;
  readonly accounting: DeliveryAccounting;
}

interface MutableItem {
  original: JsonRecord;
  id: string;
  path?: string;
  symbol?: string;
  roles: string[];
  contentMode: string;
  lineSpan?: { start: number; end: number };
  selectionReasons: string[];
  content?: string;
  answerBearing: boolean;
  priority: number;
}

const FAILURE_CONTEXT = [
  "# VTRACE delivery failure",
  "Relevant evidence was found, but its minimum truthful representation exceeded max_tokens.",
  "Increase max_tokens or narrow the request.",
].join("\n");

/**
 * Fit an already-selected product context to the model-visible budget without
 * rerunning retrieval. Mutates only the cloned MCP draft supplied by the
 * response-envelope boundary.
 */
export function applyProgressiveContextBudget(
  draft: JsonRecord,
  requestedTokens: number,
): BudgetDeliveryResult | undefined {
  const product = asRecord(draft.productContext);
  if (product === undefined) return undefined;
  const sourceItems = asRecordArray(product.items) ?? [];
  const initialContext = typeof product.modelVisibleContext === "string"
    ? product.modelVisibleContext
    : "";
  const initialModelTokens = estimateTokens(initialContext);
  const retrievalFound = product.resolved === true || sourceItems.length > 0;

  if (!retrievalFound) {
    return finish(product, [], {
      resultState: DeliveryResultState.NoResult,
      retrievalFound: false,
      resolved: false,
      deliveryFailed: false,
      status: DeliveryStatus.NoResult,
      selectedCount: 0,
      initialModelTokens,
      stages: [],
      excerptsShortened: 0,
      skeletonizedItems: 0,
      supportDropped: 0,
    });
  }

  const budget = Math.max(0, Math.floor(requestedTokens));
  if (initialModelTokens <= budget) {
    return finish(product, sourceItems, {
      resultState: DeliveryResultState.Resolved,
      retrievalFound: true,
      resolved: true,
      deliveryFailed: false,
      status: DeliveryStatus.Complete,
      selectedCount: sourceItems.length,
      initialModelTokens,
      stages: [],
      excerptsShortened: 0,
      skeletonizedItems: 0,
      supportDropped: 0,
    });
  }

  let items = sourceItems.map((item, index) => mutableItem(item, index));
  const selectedCount = items.length;
  const stages: CompactionStage[] = [];
  let excerptsShortened = 0;
  let skeletonizedItems = 0;
  let supportDropped = 0;

  const fits = (): boolean => estimateTokens(render(product, items)) <= budget;
  const record = (stage: CompactionStage): void => {
    if (!stages.includes(stage)) stages.push(stage);
  };
  const publishIfFit = (): BudgetDeliveryResult | undefined => {
    if (!fits()) return undefined;
    return finish(product, items.map(materialize), {
      resultState: DeliveryResultState.Resolved,
      retrievalFound: true,
      resolved: true,
      deliveryFailed: false,
      status: DeliveryStatus.Compacted,
      selectedCount,
      initialModelTokens,
      stages,
      excerptsShortened,
      skeletonizedItems,
      supportDropped,
    });
  };

  // Model-visible metadata is compacted before any source body is damaged.
  for (const item of items) item.selectionReasons = compactReasons(item.selectionReasons);
  record(CompactionStage.SelectionReasonsCompacted);
  let result = publishIfFit();
  if (result !== undefined) return result;

  // Preserve direct-answer and higher-ranked evidence; work backwards through
  // optional support so object iteration order cannot affect the outcome.
  for (const item of optionalSupport(items)) {
    if (item.content === undefined || item.content.length <= 900) continue;
    item.content = boundedExcerpt(item.content, 900);
    item.contentMode = "excerpt";
    excerptsShortened += 1;
    record(CompactionStage.SupportExcerptShortened);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  for (const item of optionalSupport(items)) {
    if (item.content === undefined) continue;
    const minimal = minimalContent(item.content);
    if (minimal === item.content) continue;
    item.content = minimal;
    item.contentMode = "signature";
    skeletonizedItems += 1;
    record(CompactionStage.SupportSkeletonized);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  for (const item of optionalSupport(items).filter((item) => !item.answerBearing)) {
    items = items.filter((candidate) => candidate !== item);
    supportDropped += 1;
    record(CompactionStage.SupportDropped);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  const pivots = items.filter((item) => item.roles.includes("pivot"));
  for (const item of [...pivots.slice(1)].reverse()) {
    if (item.content !== undefined) {
      item.content = minimalContent(item.content);
      item.contentMode = "signature";
      skeletonizedItems += 1;
      record(CompactionStage.SecondaryPivotSkeletonized);
      result = publishIfFit();
      if (result !== undefined) return result;
    }
  }
  for (const item of [...pivots.slice(1)].reverse().filter((item) => !item.answerBearing)) {
    items = items.filter((candidate) => candidate !== item);
    record(CompactionStage.SecondaryPivotDropped);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  // If direct-answer support remains, discard weaker context before touching it.
  for (const item of [...items].reverse().filter((item) => !item.answerBearing && !item.roles.includes("required"))) {
    if (items.length <= 1) break;
    items = items.filter((candidate) => candidate !== item);
    supportDropped += 1;
    record(CompactionStage.SupportDropped);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  for (const item of [...items].sort(compareKeepPriority).reverse()) {
    if (item.content === undefined) continue;
    item.content = minimalContent(item.content);
    item.contentMode = "signature";
    item.selectionReasons = [];
    record(item === items[0] ? CompactionStage.LeadExcerptShortened : CompactionStage.MinimalRepresentation);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  // Keep only the strongest answer-bearing item (or strongest selected item) and
  // try its minimal truthful representation before admitting delivery failure.
  const best = [...items].sort(compareKeepPriority)[0];
  if (best !== undefined) {
    best.content = best.content === undefined ? undefined : minimalContent(best.content);
    best.contentMode = "signature";
    best.selectionReasons = [];
    items = [best];
    record(CompactionStage.MinimalRepresentation);
    result = publishIfFit();
    if (result !== undefined) return result;
  }

  const topMatchReference = best === undefined
    ? undefined
    : `${best.path ?? "unknown"}${best.symbol ? `::${best.symbol}` : ""}`;
  product.modelVisibleContext = estimateTokens(FAILURE_CONTEXT) <= budget ? FAILURE_CONTEXT : "";
  if (topMatchReference !== undefined) product.topMatchReference = topMatchReference;
  return finish(product, [], {
    resultState: DeliveryResultState.DeliveryFailure,
    retrievalFound: true,
    resolved: false,
    deliveryFailed: true,
    status: DeliveryStatus.Failed,
    selectedCount,
    initialModelTokens,
    stages,
    excerptsShortened,
    skeletonizedItems,
    supportDropped,
  }, false);
}

function finish(
  product: JsonRecord,
  delivered: JsonRecord[],
  input: {
    resultState: DeliveryResultState;
    retrievalFound: boolean;
    resolved: boolean;
    deliveryFailed: boolean;
    status: DeliveryStatus;
    selectedCount: number;
    initialModelTokens: number;
    stages: CompactionStage[];
    excerptsShortened: number;
    skeletonizedItems: number;
    supportDropped: number;
  },
  renderContext = true,
): BudgetDeliveryResult {
  product.resolved = input.resolved;
  product.resultState = input.resultState;
  product.retrievalFound = input.retrievalFound;
  product.deliveryFailed = input.deliveryFailed;
  product.items = delivered;
  if (renderContext && input.status === DeliveryStatus.Compacted) {
    product.modelVisibleContext = render(product, delivered.map((item, index) => mutableItem(item, index)));
  }
  const finalContext = typeof product.modelVisibleContext === "string" ? product.modelVisibleContext : "";
  const finalTokens = estimateTokens(finalContext);
  const productAccounting = asRecord(product.accounting);
  if (productAccounting !== undefined) {
    product.accounting = {
      ...productAccounting,
      renderedCharacters: finalContext.length,
      usedTokensEstimate: finalTokens,
      remainingTokensEstimate: Math.max(0, (typeof productAccounting.budgetTokens === "number" ? productAccounting.budgetTokens : 0) - finalTokens),
      initialSelectedTokensEstimate: input.initialModelTokens,
    };
  }
  const accounting: DeliveryAccounting = {
    status: input.status,
    selectedItemsBeforeBudget: input.selectedCount,
    deliveredItems: delivered.length,
    droppedForBudget: Math.max(0, input.selectedCount - delivered.length),
    initialModelTokens: input.initialModelTokens,
    finalModelTokens: finalTokens,
    compactionPasses: input.stages.length,
    compactionStages: [...input.stages],
    excerptsShortened: input.excerptsShortened,
    skeletonizedItems: input.skeletonizedItems,
    supportDropped: input.supportDropped,
  };
  product.delivery = accounting;
  return {
    resultState: input.resultState,
    retrievalFound: input.retrievalFound,
    resolved: input.resolved,
    deliveryFailed: input.deliveryFailed,
    accounting,
  };
}

function mutableItem(item: JsonRecord, index: number): MutableItem {
  const roles = asStringArray(item.roles) ?? [];
  const reasons = asStringArray(item.selectionReasons) ?? [];
  const directEvidence = reasons.join(" ").toLowerCase();
  const answerBearing = roles.includes("required")
    || directEvidence.includes("symbol-name match")
    || directEvidence.includes("preferred contrast")
    || directEvidence.includes("direct evidence")
    || directEvidence.includes("exact");
  return {
    original: item,
    id: typeof item.id === "string" ? item.id : `D${index + 1}`,
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(typeof item.symbol === "string" ? { symbol: item.symbol } : {}),
    roles,
    contentMode: typeof item.contentMode === "string" ? item.contentMode : "summary",
    ...(isLineSpan(item.lineSpan) ? { lineSpan: item.lineSpan } : {}),
    selectionReasons: reasons,
    ...(typeof item.content === "string" ? { content: item.content } : {}),
    answerBearing,
    priority: keepPriority(roles, answerBearing, index),
  };
}

function materialize(item: MutableItem): JsonRecord {
  return {
    ...item.original,
    roles: item.roles,
    contentMode: item.contentMode,
    selectionReasons: item.selectionReasons,
    ...(item.content === undefined ? {} : {
      content: item.content,
      estimatedTokens: estimateTokens(item.content),
    }),
  };
}

/**
 * Mirror of the assembly-layer header rule: prefer the canonical indexed
 * identity so the header is a valid `get_impact_graph` argument. This path
 * re-renders after budget compaction, so it must agree with the assembly layer
 * or a compacted response would disagree with an uncompacted one.
 */
function headerIdentifier(item: MutableItem): string {
  const fqName = typeof item.original.fqName === "string" ? item.original.fqName : undefined;
  if (fqName) return fqName;
  const base = item.path ?? "context";
  return item.symbol ? `${base}::${item.symbol}` : base;
}

function render(product: JsonRecord, items: MutableItem[]): string {
  if (items.length === 0) return "";
  const repository = asRecord(product.repository);
  const task = typeof product.task === "string" ? product.task : "@request.task";
  const intent = typeof product.intent === "string" ? product.intent : "auto";
  const worktree = typeof repository?.worktreeId === "string" ? repository.worktreeId : "unknown";
  const mode = typeof product.capsuleMode === "string" ? product.capsuleMode : "standard";
  const lines = ["# VTRACE product context", `task: ${task}`, `intent: ${intent}`, `worktree: ${worktree}`, `capsule_mode: ${mode}`];
  for (const item of items) {
    lines.push("", `## [${item.id}] ${headerIdentifier(item)}`);
    lines.push(`roles: ${item.roles.join(", ")}`, `mode: ${item.contentMode}`);
    if (item.lineSpan !== undefined) lines.push(`lines: ${item.lineSpan.start}-${item.lineSpan.end}`);
    for (const reason of item.selectionReasons) lines.push(`why: ${reason}`);
    if (item.content !== undefined) lines.push("", item.content);
  }
  lines.push("", "Impact entries above are bounded static structural evidence; they are not dynamic execution flow.");
  return lines.join("\n");
}

function optionalSupport(items: MutableItem[]): MutableItem[] {
  return [...items]
    .filter((item) => item.roles.includes("support") && !item.roles.includes("required"))
    .sort(compareKeepPriority)
    .reverse();
}

function compareKeepPriority(a: MutableItem, b: MutableItem): number {
  return b.priority - a.priority || a.id.localeCompare(b.id);
}

function keepPriority(roles: string[], answerBearing: boolean, index: number): number {
  return (roles.includes("required") ? 10_000 : 0)
    + (answerBearing ? 5_000 : 0)
    + (roles.includes("pivot") ? 2_000 : 0)
    + (roles.includes("support") ? 1_000 : 0)
    - index;
}

function compactReasons(reasons: string[]): string[] {
  const preferred = reasons.find((reason) => /preferred contrast|symbol-name match|direct evidence|exact/iu.test(reason));
  const first = preferred ?? reasons[0];
  return first === undefined ? [] : [first.length <= 160 ? first : `${first.slice(0, 159)}…`];
}

function boundedExcerpt(content: string, maximumCharacters: number): string {
  if (content.length <= maximumCharacters) return content;
  const head = content.slice(0, maximumCharacters - 80).trimEnd();
  return `${head}\n# … excerpt compacted for budget …`;
}

function minimalContent(content: string): string {
  const lines = content.split("\n");
  const definingIndex = lines.findIndex((line) => /^\s*(?:async\s+def|def|class|function|export\s+(?:async\s+)?function|(?:export\s+)?(?:const|let|var)\s+\w+)/u.test(line));
  const start = definingIndex < 0 ? 0 : definingIndex;
  const selected: string[] = [];
  let characters = 0;
  for (const line of lines.slice(start, start + 8)) {
    if (characters + line.length > 480 && selected.length > 0) break;
    selected.push(line);
    characters += line.length + 1;
    if (/^\s*(?:async\s+def|def|class|function)/u.test(line) && /[:{]\s*$/u.test(line) && selected.length >= 4) break;
  }
  return selected.join("\n").trim() || content.slice(0, 240).trim();
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asRecordArray(value: unknown): JsonRecord[] | undefined {
  return Array.isArray(value) && value.every((item) => asRecord(item) !== undefined)
    ? value as JsonRecord[]
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : undefined;
}

function isLineSpan(value: unknown): value is { start: number; end: number } {
  const record = asRecord(value);
  return typeof record?.start === "number" && typeof record.end === "number";
}
