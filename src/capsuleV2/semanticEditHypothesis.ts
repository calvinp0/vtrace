// Semantic edit hypothesis for the capsule v2 injected context (M39).
//
// SCOPE: rendering / advisory only, and DEFAULT-OFF (gated behind
// `VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS`). It runs NO agents, NO Docker, calls
// NO model, and NEVER touches retrieval: it does not generate candidates, re-rank,
// re-score, or change role assignment. It is a pure, deterministic projection over
// evidence the capsule ALREADY computed: the selected pivots/support and their
// already-rendered source bodies.
//
// Motivation (M38, sphinx-doc__sphinx-7462): the genuine failure is
// `seen_but_deemed_unnecessary`. The gold fix spans two same-named `unparse`
// implementations in different modules; the secondary is surfaced as a pivot in
// 24/24 runs, the agent reads it, then RULES IT OUT with a confident-but-wrong
// reason — "it uses `', '.join()` so it does not crash, no fix needed". The agent
// frames the bug as the crash symptom (`IndexError` from `result.pop()`) rather
// than the required behavior (an empty tuple must RENDER as `()`). `', '.join([])`
// does not crash but returns `''` — wrong output. Five overlapping obligation
// blocks already demand "edit or rule out", and the agent satisfies them by ruling
// out, so MORE obligation text does not help (M35 had zero marginal effect).
//
// This section adds a NON-ORACLE semantic hypothesis aimed squarely at that faulty
// inference: when two surfaced candidates define the SAME operation-like name in
// DIFFERENT files, it names them as paired implementations and warns that the
// second may avoid the crash yet still produce wrong output — verify output
// correctness, not crash avoidance. The evidence is derived purely from candidate
// symbols + their inlined source bodies. It uses NO gold files, NO FAIL_TO_PASS /
// PASS_TO_PASS, NO benchmark labels, and NO test names.
//
// NOTHING HERE IS PROJECT-SPECIFIC. It keys off the capsule's own pivot/support
// items and a generic operation-name lexicon. No instance ids, no repo names, no
// hardcoded filenames, no gold-patch data.

import type { CapsuleV2Item } from "./types";

/** Heading marker — exported so the runner and the M34 accounting split can detect
 *  and attribute this section without re-parsing the body. */
export const SEMANTIC_EDIT_HYPOTHESIS_HEADING = "## Semantic Edit Hypothesis";

/** Env var that gates this section (M39). DEFAULT OFF — it renders only when the
 *  flag is an explicit truthy value. Rendering-only; changes no retrieval/ranking. */
export const SEMANTIC_EDIT_HYPOTHESIS_ENV = "VTRACE_ENABLE_SEMANTIC_EDIT_HYPOTHESIS";

// Bounds (M39 requirement): keep the whole section to a handful of lines.
const MAX_GROUPS = 2; // at most 2 same-name symbol groups
const MAX_FILES_PER_GROUP = 3; // at most 3 file::symbol targets per group

/**
 * Whether the semantic-edit-hypothesis section should render. DEFAULT OFF: only an
 * explicit truthy value (`1`, `true`, `on`, `yes`, case-insensitive, trimmed)
 * enables it; unset or anything else keeps default behavior unchanged. This gates
 * RENDERING ONLY — it changes no retrieval, ranking, pivot selection, co-edit
 * detection, or scoring.
 *
 * Env is read via an injectable map so tests stay isolated (no process.env mutation).
 */
export function semanticEditHypothesisEnabled(
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  const raw = env[SEMANTIC_EDIT_HYPOTHESIS_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/** A group of same-named implementations across files — the core trigger evidence. */
export interface SemanticSymbolGroup {
  /** The shared operation-like symbol/function name. */
  name: string;
  /** `file::name` targets, lead/pivot files first, bounded to MAX_FILES_PER_GROUP. */
  targets: string[];
}

export interface SemanticEditHypothesis {
  /** 1..MAX_GROUPS same-name multi-module groups, strongest (most files) first. */
  groups: SemanticSymbolGroup[];
  /** True when an empty-container / output-shape risk is evidenced (adds one line). */
  emptyContainerSignal: boolean;
}

/** Options for {@link buildSemanticEditHypothesis}. */
export interface SemanticEditHypothesisOptions {
  /** Optional issue/query text. Used ONLY for the relevance gate and the
   *  empty-container sentence — never for symbol detection. Non-oracle: callers must
   *  pass problem/query text, NOT gold/test/benchmark strings. */
  contextText?: string;
}

// Operation-name lexicon: roots that mark a transformation / serialization /
// round-trip operation — the class of symbol where a paired second implementation
// must stay behaviorally consistent. Kept deliberately focused to bound false
// positives; dunders and generic verbs (get/set/run/handle) are NOT operation-like.
const OPERATION_ROOTS = [
  "parse",
  "unparse",
  "render",
  "format",
  "serial", // serialize / serialization / deserialize
  "deserial",
  "encode",
  "decode",
  "marshal", // marshal / unmarshal
  "stringify",
  "repr",
  "dump",
  "load",
  "compile",
  "transform",
  "convert",
  "normalize",
  "emit",
];

/**
 * Whether a symbol name denotes an operation/transformation — the relevance signal
 * for a paired implementation. Excludes dunders (`__repr__` is defined everywhere
 * and would over-trigger) and requires a lexicon-root or a `to_/from_/as_` shape.
 */
export function isOperationLikeName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith("__")) return false; // skip dunders — too common across files
  const n = name.toLowerCase();
  if (n.startsWith("to_") || n.startsWith("from_") || n.startsWith("as_")) return true;
  return OPERATION_ROOTS.some((root) => n.includes(root));
}

// Context tokens that independently satisfy the relevance gate (rule #5): the task
// is about output/render/parse/serialization/round-trip consistency.
const CONTEXT_RELEVANCE = /\b(output|render|parse|unparse|serial|deserial|round[\s-]?trip|format|encode|decode|stringif)/i;

const DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gm;
const CLASS_RE = /^[ \t]*class[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

/** Names defined in a candidate: its own symbol plus any `def`/`class` declared in
 *  its inlined source body (this is how a NESTED `def unparse` inside one pivot is
 *  matched against a same-named module-level pivot in another file). */
function definedNames(item: CapsuleV2Item): Set<string> {
  const names = new Set<string>();
  if (item.symbol && item.symbol.length > 0) names.add(item.symbol);
  const src = item.source ?? "";
  if (src.length > 0) {
    for (const m of src.matchAll(DEF_RE)) names.add(m[1]!);
    for (const m of src.matchAll(CLASS_RE)) names.add(m[1]!);
  }
  return names;
}

interface NameFileInfo {
  /** File path → whether any defining candidate in that file was a pivot. */
  files: Map<string, boolean>;
  /** Insertion-ordered files, so lead/pivot-first ordering is stable. */
  order: string[];
}

/** Detect the empty-container / output-shape risk that makes "no crash ≠ correct"
 *  concrete. Non-oracle: derived from the already-surfaced source bodies (a
 *  loop-then-`.pop()` or a `join()` over container elements is the classic
 *  empty-collection trap) or from explicit "empty <container>" wording in the
 *  provided context text. */
function hasEmptyContainerSignal(
  items: readonly CapsuleV2Item[],
  contextText: string | undefined,
): boolean {
  if (contextText && /\bempty\s+(tuple|list|dict|set|sequence|collection|container|string|array|map)/i.test(contextText)) {
    return true;
  }
  return items.some((it) => {
    const src = it.source ?? "";
    return src.includes(".pop(") || /\.join\(/.test(src);
  });
}

/**
 * Build the semantic edit hypothesis from the capsule's pivots and support. Returns
 * `null` unless STRONG, non-oracle evidence exists:
 *
 *   1. an operation-like name (see {@link isOperationLikeName}) is defined in
 *   2. two or more DIFFERENT files among the surfaced candidates, with
 *   3. at least one defining file being a PIVOT (a primary edit target), and
 *   4. a second distinct file (another pivot or support co-edit candidate), and
 *   5. the relevance gate satisfied — the matched name is operation-like (always
 *      true here by construction) OR the context text mentions output/parse/render
 *      /serialization/round-trip consistency.
 *
 * Same-file same-name matches do NOT count (≥2 DISTINCT files required), so a single
 * file with a nested helper of the same name never triggers. Single-pivot capsules
 * and support-only lexical matches with no pivot file never trigger.
 *
 * Pure and deterministic. Bounded to MAX_GROUPS groups × MAX_FILES_PER_GROUP files.
 */
export function buildSemanticEditHypothesis(
  pivots: readonly CapsuleV2Item[],
  support: readonly CapsuleV2Item[],
  options?: SemanticEditHypothesisOptions,
): SemanticEditHypothesis | null {
  // Pivots first so pivot files take priority in per-name file ordering.
  const items: CapsuleV2Item[] = [...pivots, ...support];
  if (items.length < 2) return null;

  const byName = new Map<string, NameFileInfo>();
  for (const item of items) {
    const isPivot = item.role === "pivot";
    const file = item.path;
    for (const name of definedNames(item)) {
      let info = byName.get(name);
      if (info === undefined) {
        info = { files: new Map(), order: [] };
        byName.set(name, info);
      }
      if (!info.files.has(file)) info.order.push(file);
      info.files.set(file, (info.files.get(file) ?? false) || isPivot);
    }
  }

  const contextRelevant =
    options?.contextText !== undefined && CONTEXT_RELEVANCE.test(options.contextText);

  const candidates: SemanticSymbolGroup[] = [];
  for (const [name, info] of byName) {
    if (info.order.length < 2) continue; // need ≥2 DISTINCT files
    const hasPivotFile = [...info.files.values()].some((isPivot) => isPivot);
    if (!hasPivotFile) continue; // rule #3: at least one primary/lead pivot file
    if (!(isOperationLikeName(name) || contextRelevant)) continue; // rule #5
    // Order: pivot files first (preserving discovery order), then non-pivot files.
    const pivotFiles = info.order.filter((f) => info.files.get(f) === true);
    const otherFiles = info.order.filter((f) => info.files.get(f) !== true);
    const orderedFiles = [...pivotFiles, ...otherFiles].slice(0, MAX_FILES_PER_GROUP);
    candidates.push({
      name,
      targets: orderedFiles.map((f) => `${f}::${name}`),
    });
  }

  if (candidates.length === 0) return null;

  // Strongest groups first: more files (stronger pairing), then name for stability.
  candidates.sort((a, b) => b.targets.length - a.targets.length || a.name.localeCompare(b.name));
  const groups = candidates.slice(0, MAX_GROUPS);

  return {
    groups,
    emptyContainerSignal: hasEmptyContainerSignal(items, options?.contextText),
  };
}

/**
 * Render the semantic edit hypothesis to a compact Markdown block, placed in the
 * top advisory cluster (near the co-edit guidance, BEFORE the bulky pivot bodies)
 * so it survives char-budget truncation. Returns an empty array when `hyp` is null.
 *
 * Compact by construction: bounded same-name target lists, one hypothesis paragraph,
 * and at most one extra empty-container sentence. No source excerpts are duplicated.
 */
export function renderSemanticEditHypothesisText(
  hyp: SemanticEditHypothesis | null,
): string[] {
  if (hyp === null) return [];

  const lines: string[] = [];
  lines.push("");
  lines.push(SEMANTIC_EDIT_HYPOTHESIS_HEADING);
  lines.push("");
  lines.push("The surfaced pivots include same-name implementations across files:");
  lines.push("");
  for (const group of hyp.groups) {
    for (const target of group.targets) {
      lines.push(`- ${target}`);
    }
  }
  lines.push("");
  lines.push("Hypothesis:");
  lines.push(
    "These may be paired implementations of one operation. If the fix changes how the "
    + "operation handles an edge case, verify both implementations for output "
    + "correctness, not just crash avoidance.",
  );
  if (hyp.emptyContainerSignal) {
    lines.push(
      "For empty-container cases, a path can avoid crashing but still render the wrong text.",
    );
  }
  return lines;
}
