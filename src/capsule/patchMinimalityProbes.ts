// Patch-minimality probes for generated-parser / grammar rewrites.
//
// SCOPE: analysis only. This is a CHEAP, DETERMINISTIC warning signal over a unified
// diff that already exists. It runs NO agents, NO Docker, and calls NO model. It does
// NOT repair patches and is NOT a gate — it inspects a diff and reports whether the
// patch took a structurally large grammar/parser rewrite (deleting generated parser
// tables, relocating grammar productions across parser functions) when a narrower
// grammar-rule edit was likely available.
//
// Motivation (auditable Astropy protocol run, instance astropy__astropy-14369): the
// model deleted `cds_lextab.py` / `cds_parsetab.py` and relocated grammar productions
// out of `p_product_of_units` / `p_division_of_units` into `p_combined_units`, when the
// known-good fix was a one-line reorder of the `division_of_units` production. This
// probe makes that shape a deterministic, explainable signal.
//
// Pure function throughout. Nothing here is Astropy-specific: the PLY conventions
// (`def p_<rule>` parser functions, `*_parsetab.py` / `*_lextab.py` generated tables)
// are detected generically, and the narrow-alternative hint is derived from whichever
// grammar function the patch removed.

import { stripDiffPrefix } from "./sweQueryShaping";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatchMinimalityDefectClass =
  | "generated_parser_broad_rewrite"
  | "generated_parser_table_deletion"
  | "grammar_patch_minimality"
  | "none";

export type RiskLevel = "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export interface PatchMinimalityProbeOptions {
  // Override the patterns that mark a file as a generated parser table. Matched
  // against the file's basename. Defaults to PLY's `*_parsetab.py` / `*_lextab.py`
  // (and bare `parsetab.py` / `lextab.py` / `parser.out`).
  readonly generatedParserFilePatterns?: readonly RegExp[];
  // Override the pattern that identifies a grammar/parser function definition.
  // Matched against the function name. Defaults to PLY's `p_<rule>` convention.
  readonly grammarFunctionPattern?: RegExp;
}

export interface PatchMinimalityProbeResult {
  // True only when the probe rates the patch high-risk: a structurally large
  // generated-parser/grammar rewrite where a narrower edit was likely available.
  // Observation-only — this does NOT trigger repair; it is a risk signal.
  readonly repairRequired: boolean;
  readonly defectClass: PatchMinimalityDefectClass;
  readonly risk: RiskLevel;
  readonly confidence: Confidence;
  // Human-readable explanations (why the probe decided what it did).
  readonly reasons: string[];
  // Short machine-ish tags for the decision (one per fired rule).
  readonly signals: string[];
  readonly affectedFiles: string[];
  readonly generatedFilesDeleted: string[];
  readonly grammarFunctionsChanged: string[];
  readonly grammarFunctionsRemoved: string[];
  readonly sourceGrammarFilesChanged: string[];
  readonly broadRewriteDetected: boolean;
  readonly narrowAlternativeHint?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GENERATED_PARSER_PATTERNS: readonly RegExp[] = [
  /_parsetab\.py$/,
  /_lextab\.py$/,
  /^parsetab\.py$/,
  /^lextab\.py$/,
  /^parser\.out$/,
];

// PLY grammar functions are named `p_<rule>`. Lexer rule functions `t_<token>` are
// not grammar productions and are deliberately not matched here.
const DEFAULT_GRAMMAR_FUNCTION_PATTERN = /^p_[A-Za-z_]\w*$/;

// A docstring production line: `rule : tokens` or an `| tokens` alternative.
const PRODUCTION_LINE = /^\s*(?:[a-z_]\w*\s*:|\|)\s*\S/;

// ---------------------------------------------------------------------------
// Diff parsing (minimal, self-contained)
// ---------------------------------------------------------------------------

interface DiffFile {
  readonly path: string;
  readonly deleted: boolean;
  // Body lines (hunk bodies only), preserving the leading +/-/space marker.
  readonly bodyLines: string[];
}

// Split a unified diff into per-file sections keyed by `diff --git` boundaries.
// Falls back to a single `--- /+++` pair when there is no `diff --git` header.
function parseDiffFiles(diff: string): DiffFile[] {
  const lines = diff.split(/\r?\n/);
  const files: DiffFile[] = [];

  // Indices of `diff --git` headers; if none, treat the whole diff as one section.
  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith("diff --git ")) headerIdx.push(i);
  }
  const sections: string[][] = [];
  if (headerIdx.length === 0) {
    sections.push(lines);
  } else {
    for (let s = 0; s < headerIdx.length; s += 1) {
      const start = headerIdx[s]!;
      const end = s + 1 < headerIdx.length ? headerIdx[s + 1]! : lines.length;
      sections.push(lines.slice(start, end));
    }
  }

  for (const section of sections) {
    let newPath: string | null = null;
    let oldPath: string | null = null;
    let deletedMode = false;
    let inHunk = false;
    const bodyLines: string[] = [];

    for (const line of section) {
      if (line.startsWith("deleted file mode")) {
        deletedMode = true;
        continue;
      }
      if (line.startsWith("--- ")) {
        const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
        oldPath = raw === "/dev/null" ? null : stripDiffPrefix(raw);
        inHunk = false;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
        newPath = raw === "/dev/null" ? null : stripDiffPrefix(raw);
        inHunk = false;
        continue;
      }
      if (line.startsWith("@@")) {
        inHunk = true;
        // Carry a hunk separator so per-hunk scope analysis can reset.
        bodyLines.push("@@");
        continue;
      }
      if (inHunk) bodyLines.push(line);
    }

    // A file is "deleted" when it has `deleted file mode` or its new side is /dev/null.
    const deleted = deletedMode || (oldPath !== null && newPath === null);
    const path = newPath ?? oldPath;
    if (path === null) continue;
    files.push({ path, deleted, bodyLines });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Grammar-function analysis
// ---------------------------------------------------------------------------

interface GrammarChurn {
  readonly changed: Set<string>;
  readonly removed: Set<string>;
  readonly added: Set<string>;
  readonly removedProductionLines: number;
  readonly addedProductionLines: number;
}

const DEF_LINE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

function defName(content: string): string | null {
  return DEF_LINE.exec(content.trim())?.[1] ?? null;
}

// Per-hunk grammar churn for one (non-deleted) file. A function counts as "changed"
// when its def appears on a +/- line, or when its def is in-context within a hunk that
// has any +/- change (its body or docstring was edited).
function analyzeGrammarChurn(bodyLines: readonly string[], isGrammarFn: (name: string) => boolean): GrammarChurn {
  const changed = new Set<string>();
  const removed = new Set<string>();
  const added = new Set<string>();
  let removedProductionLines = 0;
  let addedProductionLines = 0;

  // Split into hunks on the "@@" separators injected by parseDiffFiles.
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of bodyLines) {
    if (line === "@@") {
      if (current.length > 0) hunks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current);

  for (const hunk of hunks) {
    const contextDefs: string[] = [];
    let hunkHasChange = false;
    for (const line of hunk) {
      const marker = line[0] ?? " ";
      const content = line.slice(1);
      if (marker === "+" || marker === "-") {
        hunkHasChange = true;
        const name = defName(content);
        if (name && isGrammarFn(name)) {
          changed.add(name);
          if (marker === "-") removed.add(name);
          else added.add(name);
        }
        if (PRODUCTION_LINE.test(content)) {
          if (marker === "-") removedProductionLines += 1;
          else addedProductionLines += 1;
        }
      } else {
        const name = defName(content);
        if (name && isGrammarFn(name)) contextDefs.push(name);
      }
    }
    if (hunkHasChange) for (const name of contextDefs) changed.add(name);
  }

  return { changed, removed, added, removedProductionLines, addedProductionLines };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function isGeneratedParserFile(path: string, patterns: readonly RegExp[]): boolean {
  const base = basename(path);
  return patterns.some((re) => re.test(base));
}

// Derive the production name a removed grammar function defined (`p_division_of_units`
// -> `division_of_units`), used to phrase a generic narrow-alternative hint.
function productionNameOf(grammarFn: string): string {
  return grammarFn.startsWith("p_") ? grammarFn.slice(2) : grammarFn;
}

export function analyzePatchMinimality(
  diff: string,
  options: PatchMinimalityProbeOptions = {},
): PatchMinimalityProbeResult {
  const generatedPatterns = options.generatedParserFilePatterns ?? DEFAULT_GENERATED_PARSER_PATTERNS;
  const grammarPattern = options.grammarFunctionPattern ?? DEFAULT_GRAMMAR_FUNCTION_PATTERN;
  const isGrammarFn = (name: string): boolean => grammarPattern.test(name);

  const files = parseDiffFiles(diff);
  const affectedFiles = dedupe(files.map((f) => f.path));

  const generatedFilesDeleted = dedupe(
    files.filter((f) => f.deleted && isGeneratedParserFile(f.path, generatedPatterns)).map((f) => f.path),
  );

  // Grammar churn aggregated across all non-deleted, non-generated source files.
  const changed = new Set<string>();
  const removed = new Set<string>();
  const sourceGrammarFiles = new Set<string>();
  let removedProductionLines = 0;
  let addedProductionLines = 0;
  for (const file of files) {
    if (file.deleted) continue;
    if (isGeneratedParserFile(file.path, generatedPatterns)) continue;
    const churn = analyzeGrammarChurn(file.bodyLines, isGrammarFn);
    if (churn.changed.size > 0) sourceGrammarFiles.add(file.path);
    for (const n of churn.changed) changed.add(n);
    for (const n of churn.removed) removed.add(n);
    removedProductionLines += churn.removedProductionLines;
    addedProductionLines += churn.addedProductionLines;
  }

  const grammarFunctionsChanged = [...changed].sort();
  const grammarFunctionsRemoved = [...removed].sort();
  const sourceGrammarFilesChanged = [...sourceGrammarFiles].sort();

  // --- Decision -----------------------------------------------------------
  const signals: string[] = [];
  const reasons: string[] = [];

  const tableDeleted = generatedFilesDeleted.length > 0;
  // A removed parser function, or two+ parser functions changed in one patch, is a
  // broad rewrite — productions were relocated rather than a single rule edited.
  const broadRewriteDetected = removed.size >= 1 || changed.size >= 2;
  const productionsRelocated = removed.size >= 1 && changed.size >= 2;

  if (tableDeleted) {
    signals.push("generated_parser_table_deleted");
    reasons.push(`Patch deletes generated parser table file(s): ${generatedFilesDeleted.join(", ")}.`);
  }
  if (grammarFunctionsRemoved.length > 0) {
    signals.push("grammar_function_removed");
    reasons.push(`Parser function(s) removed entirely: ${grammarFunctionsRemoved.join(", ")}.`);
  }
  if (changed.size >= 2) {
    signals.push("multiple_grammar_functions_changed");
    reasons.push(`Multiple parser functions changed in one patch: ${grammarFunctionsChanged.join(", ")}.`);
  }
  if (productionsRelocated) {
    signals.push("grammar_productions_relocated");
    reasons.push(
      "Grammar productions appear relocated between parser functions (a function was removed while another was rewritten).",
    );
  }
  if (tableDeleted && sourceGrammarFilesChanged.length === 0) {
    signals.push("generated_artifact_deleted_without_source_grammar_edit");
    reasons.push("Generated parser artifact deleted without an accompanying source grammar edit.");
  }

  // grammar_patch_minimality (magnitude) when a single function is rewritten with several
  // production-line edits — a larger structural rewrite where a small reorder may suffice.
  const singleFunctionLargeRewrite =
    changed.size === 1 && removed.size === 0 && removedProductionLines >= 3 && addedProductionLines >= 3;
  if (singleFunctionLargeRewrite) {
    signals.push("grammar_function_broadly_rewritten");
    reasons.push(
      `Single parser function ${grammarFunctionsChanged[0]} rewritten across ${removedProductionLines} removed / ` +
        `${addedProductionLines} added production lines.`,
    );
  }

  // Narrow-alternative hint: a relocation/removal of grammar productions plus (or even
  // without) table deletion suggests a narrower per-production edit was available.
  let narrowAlternativeHint: string | undefined;
  if (productionsRelocated || (broadRewriteDetected && tableDeleted)) {
    const production =
      grammarFunctionsRemoved.length > 0
        ? productionNameOf(grammarFunctionsRemoved[0]!)
        : grammarFunctionsChanged.length > 0
          ? productionNameOf(grammarFunctionsChanged[0]!)
          : "the affected";
    narrowAlternativeHint =
      `Narrower alternative likely exists: reorder the ${production} grammar production within its own parser ` +
      "function rather than relocating productions across parser functions" +
      (tableDeleted ? " or deleting generated parser tables." : ".");
    signals.push("narrow_alternative_available");
    signals.push("grammar_patch_minimality");
    reasons.push(narrowAlternativeHint);
  } else if (singleFunctionLargeRewrite) {
    narrowAlternativeHint =
      `Narrower alternative likely exists: edit only the affected ${productionNameOf(grammarFunctionsChanged[0]!)} ` +
      "production rather than rewriting the whole parser function.";
    signals.push("grammar_patch_minimality");
    reasons.push(narrowAlternativeHint);
  }

  // --- Classification + risk ----------------------------------------------
  let defectClass: PatchMinimalityDefectClass;
  let risk: RiskLevel;
  let confidence: Confidence;

  if (broadRewriteDetected) {
    defectClass = "generated_parser_broad_rewrite";
    // Removing a parser function or relocating productions is a strong, deterministic
    // signal; table deletion on top raises confidence to high.
    risk = removed.size >= 1 || tableDeleted ? "high" : "medium";
    confidence = (removed.size >= 1 && tableDeleted) || productionsRelocated ? "high" : removed.size >= 1 ? "high" : "medium";
  } else if (tableDeleted) {
    defectClass = "generated_parser_table_deletion";
    risk = "high";
    // Deletion detection is deterministic; whether it was the wrong move is less certain
    // without an accompanying grammar edit, so confidence is medium.
    confidence = "medium";
  } else if (singleFunctionLargeRewrite) {
    defectClass = "grammar_patch_minimality";
    risk = "medium";
    confidence = "low";
  } else {
    defectClass = "none";
    risk = "low";
    confidence = grammarFunctionsChanged.length > 0 ? "low" : "high";
    if (grammarFunctionsChanged.length > 0) {
      // A single narrow grammar edit with no relocation / deletion — explicitly NOT flagged.
      reasons.push(
        `Narrow grammar edit: ${grammarFunctionsChanged.join(", ")} changed without function relocation, removal, ` +
          "or generated-table deletion.",
      );
      signals.push("narrow_grammar_edit");
    } else {
      reasons.push("No generated-parser / grammar-minimality risk shapes detected in the diff.");
    }
  }

  const repairRequired = risk === "high";

  return {
    repairRequired,
    defectClass,
    risk,
    confidence,
    reasons,
    signals,
    affectedFiles,
    generatedFilesDeleted,
    grammarFunctionsChanged,
    grammarFunctionsRemoved,
    sourceGrammarFilesChanged,
    broadRewriteDetected,
    ...(narrowAlternativeHint !== undefined ? { narrowAlternativeHint } : {}),
  };
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
