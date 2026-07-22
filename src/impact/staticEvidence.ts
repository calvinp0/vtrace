import { createHash } from "node:crypto";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { getFileByPath } from "../db/repositories/filesRepository";
import { EdgeType, SymbolKind, type EdgeRecord, type SymbolRecord } from "../domain/types";
import { buildSymbolSourceExcerpt, type SourceExcerpt } from "../source/sourceExcerpt";

export const STATIC_RELATION_KINDS = [
  "contains",
  "defines",
  "imports",
  "re_exports",
  "calls",
  "references",
  "inherits",
  "implements",
  "decorates",
  "registers",
  "routes_to",
  "tests",
  "documents",
  "unknown",
] as const;

export type StaticRelationKind = (typeof STATIC_RELATION_KINDS)[number];

export const STATIC_EVIDENCE_STRENGTHS = [
  "exact",
  "resolved",
  "conservative",
  "lexical",
  "unresolved",
] as const;

export type StaticEvidenceStrength = (typeof STATIC_EVIDENCE_STRENGTHS)[number];
export type StaticRelationDirection = "incoming" | "outgoing";

export interface StaticEvidenceEndpoint {
  readonly nodeId?: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly kind?: SymbolKind;
  readonly lineSpan?: { readonly start: number; readonly end: number };
}

export interface StaticRelationEvidence {
  readonly id: string;
  readonly edgeId: string | null;
  readonly kind: StaticRelationKind;
  readonly persistedKind: EdgeType | null;
  readonly source: StaticEvidenceEndpoint;
  readonly target: StaticEvidenceEndpoint;
  /** Direction relative to the focal symbol, never a reversal of stored edge direction. */
  readonly direction: StaticRelationDirection;
  readonly strength: StaticEvidenceStrength;
  /** Deliberately categorical: the persisted numeric confidence is not calibrated. */
  readonly confidence: null;
  readonly evidence: {
    readonly sourceText?: string;
    readonly importAlias?: string;
    readonly referenceName?: string;
    readonly resolutionMethod: string;
    readonly locationKind: "edge_site" | "source_symbol_span" | "indexed_metadata";
  };
  readonly limitations: readonly string[];
}

export interface StaticRelationBuildOptions {
  readonly direction: StaticRelationDirection;
  readonly repoRoot?: string;
  readonly includeSourceEvidence?: boolean;
}

const STRENGTH_ORDER: Readonly<Record<StaticEvidenceStrength, number>> = {
  exact: 0,
  resolved: 1,
  conservative: 2,
  lexical: 3,
  unresolved: 4,
};

export function compareEvidenceStrength(
  left: StaticEvidenceStrength,
  right: StaticEvidenceStrength,
): number {
  return STRENGTH_ORDER[left] - STRENGTH_ORDER[right];
}

export function minimumEvidenceStrength(
  values: readonly StaticEvidenceStrength[],
): StaticEvidenceStrength {
  return values.reduce<StaticEvidenceStrength>(
    (weakest, value) => STRENGTH_ORDER[value] > STRENGTH_ORDER[weakest] ? value : weakest,
    "exact",
  );
}

/**
 * Convert one persisted graph edge into model-facing static evidence. Parser
 * edges intentionally remain unchanged; syntax-backed subtypes are a query-time
 * view so retrieval and incremental graph identity cannot drift.
 */
export function buildStaticRelationEvidence(
  db: Database,
  edge: EdgeRecord,
  source: SymbolRecord,
  target: SymbolRecord,
  options: StaticRelationBuildOptions,
): StaticRelationEvidence {
  const excerpt = options.repoRoot !== undefined && options.includeSourceEvidence !== false
    ? buildSymbolSourceExcerpt(db, options.repoRoot, source.id, { mode: "span" })
    : null;
  const classification = classifyRelation(edge, source, target, excerpt);
  const occurrence = findGroundedOccurrence(excerpt, target.localName, classification.kind);
  const limitations = [...classification.limitations];

  if (occurrence === null) {
    limitations.push(
      "The persisted edge has no call-site span; provenance identifies the indexed source-symbol span, not an exact edge occurrence.",
    );
  }

  return {
    id: stableEvidenceId(edge.id, classification.kind, options.direction),
    edgeId: edge.id,
    kind: classification.kind,
    persistedKind: edge.edgeType,
    source: endpoint(source, occurrence?.lineSpan),
    target: endpoint(target),
    direction: options.direction,
    strength: classification.strength,
    confidence: null,
    evidence: {
      ...(occurrence?.sourceText === undefined ? {} : { sourceText: occurrence.sourceText }),
      ...(classification.importAlias === undefined ? {} : { importAlias: classification.importAlias }),
      referenceName: target.localName,
      resolutionMethod: classification.resolutionMethod,
      locationKind: occurrence === null ? "source_symbol_span" : "edge_site",
    },
    limitations: unique(limitations),
  };
}

export function staticRelationKindForEdge(edgeType: EdgeType): StaticRelationKind {
  switch (edgeType) {
    case EdgeType.Contains:
      return "contains";
    case EdgeType.Imports:
      return "imports";
    case EdgeType.Calls:
      return "calls";
    case EdgeType.References:
      return "references";
  }
}

export function isTestSymbol(symbol: SymbolRecord): boolean {
  const path = symbol.filePath.toLowerCase();
  return /(^|\/)(tests?|__tests__)(\/|$)/u.test(path)
    || /(^|\/)(test_[^/]+|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/u.test(path)
    || /^(test_|it$|test$|describe$)/u.test(symbol.localName.toLowerCase());
}

export function classifyEntrypoint(symbol: SymbolRecord): {
  readonly kind: "exported_api" | "test";
  readonly strength: StaticEvidenceStrength;
  readonly evidence: string;
  readonly limitations: readonly string[];
} | null {
  if (isTestSymbol(symbol)) {
    return {
      kind: "test",
      strength: "exact",
      evidence: "indexed test path or test-symbol naming",
      limitations: ["Test classification does not prove the test runner collects or executes this symbol."],
    };
  }
  if (symbol.exported) {
    return {
      kind: "exported_api",
      strength: "exact",
      evidence: "indexed exported=true metadata",
      limitations: ["Exported API is an entrypoint-like review surface, not proof of runtime invocation."],
    };
  }
  return null;
}

/**
 * Optional, explicitly lexical documentation evidence. Markdown is not part of
 * the persisted parser graph, so this bounded scan is opt-in (`includeLexical`)
 * and can never become a calls/imports count.
 */
export function findDocumentationEvidence(
  repoRoot: string,
  target: SymbolRecord,
  maxFiles = 200,
  maxMatches = 10,
): StaticRelationEvidence[] {
  const root = path.resolve(repoRoot);
  const candidates: string[] = [];
  const pending = [root];
  while (pending.length > 0 && candidates.length < maxFiles) {
    const directory = pending.shift()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /\.(md|mdx|rst)$/iu.test(entry.name)) candidates.push(absolute);
      if (candidates.length >= maxFiles) break;
    }
  }

  const matches: StaticRelationEvidence[] = [];
  const names = [target.fqName, target.localName, target.filePath];
  for (const absolute of candidates.sort()) {
    let text: string;
    try { text = readFileSync(absolute, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const referenceName = names.find((name) => name.length > 2 && line.includes(name));
      if (referenceName === undefined) continue;
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      const lineNumber = index + 1;
      const id = createHash("sha256")
        .update(`documents\0${relative}\0${lineNumber}\0${target.id}`)
        .digest("hex")
        .slice(0, 20);
      matches.push({
        id,
        edgeId: null,
        kind: "documents",
        persistedKind: null,
        source: { path: relative, symbol: markdownHeading(lines, index), lineSpan: { start: lineNumber, end: lineNumber } },
        target: endpoint(target),
        direction: "incoming",
        strength: "lexical",
        confidence: null,
        evidence: {
          sourceText: line.trim().slice(0, 240),
          referenceName,
          resolutionMethod: referenceName === target.fqName
            ? "exact_documented_fqn"
            : referenceName === target.filePath
              ? "explicit_documented_path"
              : "lexical_documented_symbol_name",
          locationKind: "edge_site",
        },
        limitations: [
          "Documentation evidence is lexical and does not establish a call, import, or runtime dependency.",
          "Markdown/documentation files are scanned within a deterministic file and match cap; they are not persisted graph nodes.",
        ],
      });
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

/** Recover exact import/re-export syntax that the legacy graph may flatten into
 * a later calls/reference edge. Candidate files are limited to already-related
 * source files plus package facade files on the target's own path. */
export function findImportSyntaxEvidence(
  db: Database,
  repoRoot: string,
  target: SymbolRecord,
  relatedSources: readonly SymbolRecord[],
): StaticRelationEvidence[] {
  const root = path.resolve(repoRoot);
  const candidatePaths = new Set(relatedSources.map((symbol) => symbol.filePath));
  const targetSegments = target.filePath.split("/");
  for (let index = 1; index < targetSegments.length; index += 1) {
    const directory = targetSegments.slice(0, index).join("/");
    candidatePaths.add(`${directory}/__init__.py`);
    candidatePaths.add(`${directory}/index.ts`);
    candidatePaths.add(`${directory}/index.tsx`);
  }
  const results: StaticRelationEvidence[] = [];
  for (const sourcePath of [...candidatePaths].sort()) {
    let text: string;
    try { text = readFileSync(path.join(root, sourcePath), "utf8"); } catch { continue; }
    const indexedFile = getFileByPath(db, sourcePath);
    if (
      indexedFile === undefined
      || indexedFile.sizeBytes !== Buffer.byteLength(text)
      || indexedFile.contentHash !== createHash("sha256").update(text).digest("hex")
    ) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = parseImportLine(lines[index]!, sourcePath, target);
      if (parsed === null) continue;
      const sourceSymbol = relatedSources
        .filter((symbol) => symbol.filePath === sourcePath)
        .sort((left, right) => left.startLine - right.startLine)
        .find((symbol) => symbol.startLine <= index + 1 && symbol.endLine >= index + 1);
      const kind: StaticRelationKind = parsed.reExport ? "re_exports" : "imports";
      const id = createHash("sha256")
        .update(`${kind}\0${sourcePath}\0${index + 1}\0${target.id}`)
        .digest("hex")
        .slice(0, 20);
      results.push({
        id,
        edgeId: null,
        kind,
        persistedKind: null,
        source: {
          ...(sourceSymbol === undefined ? {} : { nodeId: sourceSymbol.id, symbol: sourceSymbol.fqName, kind: sourceSymbol.kind }),
          path: sourcePath,
          lineSpan: { start: index + 1, end: index + 1 },
        },
        target: endpoint(target),
        direction: "incoming",
        strength: "resolved",
        confidence: null,
        evidence: {
          sourceText: lines[index]!.trim().slice(0, 240),
          ...(parsed.alias === undefined ? {} : { importAlias: parsed.alias }),
          referenceName: target.localName,
          resolutionMethod: parsed.reExport
            ? "exact_package_reexport_resolution"
            : parsed.relative
              ? "relative_import_resolution"
              : parsed.alias === undefined
                ? "direct_import_resolution"
                : "alias_resolved_import",
          locationKind: "edge_site",
        },
        limitations: [
          "This relation is reconstructed from exact import syntax because the legacy persisted graph may flatten the import into a resolved call/reference edge.",
        ],
      });
    }
  }
  return results;
}

function classifyRelation(
  edge: EdgeRecord,
  source: SymbolRecord,
  target: SymbolRecord,
  excerpt: SourceExcerpt | null,
): {
  kind: StaticRelationKind;
  strength: StaticEvidenceStrength;
  resolutionMethod: string;
  importAlias?: string;
  limitations: string[];
} {
  const text = excerpt?.text ?? source.signature;

  if (edge.edgeType === EdgeType.Contains) {
    return {
      kind: "contains",
      strength: "exact",
      resolutionMethod: "indexed_parent_symbol",
      limitations: [],
    };
  }

  if (edge.edgeType === EdgeType.Imports) {
    const alias = detectAlias(text, target.localName);
    const isReExport = source.filePath.endsWith("/__init__.py")
      || source.filePath === "__init__.py"
      || /\bexport\s*\{[^}]*\bfrom\b|\bexport\s+\*\s+from\b/u.test(text);
    const relative = /\bfrom\s+\.+[\w.]*\s+import\b|\bfrom\s+["']\./u.test(text);
    return {
      kind: isReExport ? "re_exports" : "imports",
      // A persisted import has an unambiguous target, but crossing a module
      // boundary necessarily uses the parser's module/export resolver.
      strength: "resolved",
      resolutionMethod: isReExport
        ? "exact_package_reexport_resolution"
        : alias !== undefined
          ? "alias_resolved_import"
          : relative
            ? "relative_import_resolution"
            : "direct_import_resolution",
      ...(alias === undefined ? {} : { importAlias: alias }),
      limitations: isReExport
        ? ["The persisted imports edge targets the final definition; intermediate re-export hops are reconstructed from source syntax."]
        : [],
    };
  }

  if (edge.edgeType === EdgeType.Calls) {
    const crossFile = source.filePath !== target.filePath;
    const crossClass = source.parentSymbolId !== undefined
      && target.parentSymbolId !== undefined
      && source.parentSymbolId !== target.parentSymbolId;
    return {
      kind: "calls",
      strength: crossClass ? "conservative" : crossFile ? "resolved" : "exact",
      resolutionMethod: crossClass
        ? "conservative_resolved_member_call"
        : crossFile
          ? "import_or_module_qualified_call_resolution"
          : "same_file_or_same_class_call_resolution",
      limitations: [
        "Static call-target resolution does not establish runtime dispatch or execution.",
        ...(crossClass ? ["Cross-class member resolution is conservative and excludes ambiguous receiver types."] : []),
      ],
    };
  }

  const relation = classifyReferenceSyntax(source, target, text);
  return relation ?? {
    kind: "references",
    strength: "conservative",
    resolutionMethod: "exact_name_reference_resolution",
    limitations: ["The parser resolved a structural name use; it is not a confirmed call."],
  };
}

function classifyReferenceSyntax(
  source: SymbolRecord,
  target: SymbolRecord,
  text: string,
): ReturnType<typeof classifyRelation> | null {
  const escaped = escapeRegExp(target.localName);
  const decorators = source.decorators ?? [];
  if (decorators.some((decorator) => new RegExp(`(?:^|\\.)${escaped}(?:\\b|\\()`, "u").test(decorator))) {
    return {
      kind: "decorates",
      strength: "resolved",
      resolutionMethod: "indexed_decorator_name_resolution",
      limitations: ["Decorator application is static syntax evidence, not proof of invocation order or runtime effect."],
    };
  }
  if (source.kind === SymbolKind.Class || source.kind === SymbolKind.Interface) {
    if (new RegExp(`\\bimplements\\s+[^\\n{]*\\b${escaped}\\b`, "u").test(text)) {
      return {
        kind: "implements",
        strength: "exact",
        resolutionMethod: "typescript_implements_clause",
        limitations: ["Only explicit implements syntax is represented; structural protocol satisfaction is not inferred."],
      };
    }
    if (
      new RegExp(`\\bextends\\s+[^\\n{]*\\b${escaped}\\b`, "u").test(text)
      || new RegExp(`(?:class\\s+\\w+\\s*)?\\([^)]*\\b${escaped}\\b[^)]*\\)`, "u").test(text)
    ) {
      return {
        kind: "inherits",
        strength: "exact",
        resolutionMethod: "explicit_base_class_clause",
        limitations: ["Inheritance is syntax-backed; runtime metaclass or prototype mutation is outside this graph."],
      };
    }
  }
  return null;
}

function endpoint(
  symbol: SymbolRecord,
  occurrenceSpan?: { start: number; end: number },
): StaticEvidenceEndpoint {
  return {
    nodeId: symbol.id,
    path: symbol.filePath,
    symbol: symbol.fqName,
    kind: symbol.kind,
    lineSpan: occurrenceSpan ?? { start: symbol.startLine, end: symbol.endLine },
  };
}

function findGroundedOccurrence(
  excerpt: SourceExcerpt | null,
  targetName: string,
  kind: StaticRelationKind,
): { sourceText: string; lineSpan: { start: number; end: number } } | null {
  if (excerpt === null || targetName.length === 0) return null;
  const lines = excerpt.text.split("\n");
  const pattern = new RegExp(`\\b${escapeRegExp(targetName)}\\b`, "u");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!pattern.test(line)) continue;
    if (kind === "calls" && !new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`, "u").test(line)) continue;
    const lineNumber = excerpt.startLine + index;
    return { sourceText: line.trim().slice(0, 240), lineSpan: { start: lineNumber, end: lineNumber } };
  }
  return null;
}

function detectAlias(text: string, targetName: string): string | undefined {
  const escaped = escapeRegExp(targetName);
  return text.match(new RegExp(`\\b${escaped}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "u"))?.[1];
}

function stableEvidenceId(edgeId: string, kind: StaticRelationKind, direction: StaticRelationDirection): string {
  return createHash("sha256").update(`${edgeId}\0${kind}\0${direction}`).digest("hex").slice(0, 20);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function markdownHeading(lines: readonly string[], fromIndex: number): string | undefined {
  for (let index = fromIndex; index >= 0; index -= 1) {
    const heading = lines[index]?.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
    if (heading) return heading;
  }
  return undefined;
}

function parseImportLine(
  line: string,
  sourcePath: string,
  target: SymbolRecord,
): { alias?: string; relative: boolean; reExport: boolean } | null {
  const python = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/u);
  if (python !== null) {
    const imported = python[2]!.split(",").map((part) => part.trim());
    const match = imported.find((part) => new RegExp(`^${escapeRegExp(target.localName)}(?:\\s+as\\s+\\w+)?$`, "u").test(part));
    if (match === undefined || !pythonModuleTargetsFile(sourcePath, python[1]!, target.filePath)) return null;
    return {
      ...(match.match(/\s+as\s+(\w+)$/u)?.[1] === undefined ? {} : { alias: match.match(/\s+as\s+(\w+)$/u)![1] }),
      relative: python[1]!.startsWith("."),
      reExport: sourcePath.endsWith("/__init__.py") || sourcePath === "__init__.py",
    };
  }
  const ts = line.match(/^\s*(export\s+)?(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/u);
  if (ts !== null) {
    const imported = ts[2]!.split(",").map((part) => part.trim());
    const match = imported.find((part) => new RegExp(`^${escapeRegExp(target.localName)}(?:\\s+as\\s+\\w+)?$`, "u").test(part));
    if (match === undefined || !typescriptModuleTargetsFile(sourcePath, ts[3]!, target.filePath)) return null;
    const alias = match.match(/\s+as\s+(\w+)$/u)?.[1];
    return { ...(alias === undefined ? {} : { alias }), relative: ts[3]!.startsWith("."), reExport: ts[1] !== undefined || /^\s*export\b/u.test(line) };
  }
  return null;
}

function pythonModuleTargetsFile(sourcePath: string, moduleName: string, targetPath: string): boolean {
  const dots = moduleName.match(/^\.+/u)?.[0].length ?? 0;
  const bare = moduleName.slice(dots).replace(/\./gu, "/");
  let modulePath: string;
  if (dots > 0) {
    let directory = path.posix.dirname(sourcePath);
    for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
    modulePath = path.posix.join(directory, bare);
  } else {
    modulePath = bare;
  }
  return targetPath === `${modulePath}.py`
    || targetPath === `${modulePath}/__init__.py`
    || targetPath.endsWith(`/${modulePath}.py`)
    || targetPath.endsWith(`/${modulePath}/__init__.py`);
}

function typescriptModuleTargetsFile(sourcePath: string, moduleName: string, targetPath: string): boolean {
  if (!moduleName.startsWith(".")) return targetPath.replace(/\.[^.]+$/u, "").endsWith(moduleName);
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), moduleName));
  const targetBase = targetPath.replace(/\.[^.]+$/u, "");
  return targetBase === base || targetBase === `${base}/index`;
}
