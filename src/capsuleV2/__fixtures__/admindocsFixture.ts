// Capsule v2 admindocs-regex fixture (django__django-11728 shape).
//
// Models the role-assignment trap the debug refinement must solve: an entry-point
// wrapper (`views.py::simplify_regex`) with a strong lexical hit on the issue
// title that DELEGATES to the real edit sites — the local helpers
// (`utils.py::replace_named_groups`, `replace_unnamed_groups`) — plus generic
// regex infrastructure in another subsystem (`utils/regex_helper.py::Group`,
// `NonCapture`, `normalize`) that must not outrank the local helpers.
//
// Materialised on disk so pivots can carry focused source. No instance ids or
// expected paths reach production code — roles are recovered from the index.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../db/sqlite";
import { persistParseResult } from "../../db/persistParseResult";
import { insertEdges } from "../../db/repositories/edgesRepository";
import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type EdgeRecord,
  type FileRecord,
  type ParseResult,
  type SymbolRecord,
} from "../../domain/types";

interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  body: string;
  signature?: string;
  docstring?: string;
}

export interface AdmindocsFixture {
  db: Database;
  repoRoot: string;
}

/** The debug task for the admindocs regex issue (the verification query). */
export const ADMINDOCS_TASK =
  "fix simplify_regexp trailing named groups in admindocs regex helpers";

export function seedAdmindocsFixture(): AdmindocsFixture {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-admindocs-"));
  const db = openIndexerDatabase();

  // The real edit sites: local replacement helpers.
  const utils = seedFile(db, repoRoot, "django/contrib/admindocs/utils.py", [
    {
      localName: "replace_named_groups",
      kind: SymbolKind.Function,
      signature: "replace_named_groups(pattern)",
      body:
        "def replace_named_groups(pattern):\n"
        + "    # Replace named groups, including trailing groups, with their pattern.\n"
        + "    for match in named_group_matcher.finditer(pattern):\n"
        + "        pattern = pattern[:match.start()] + match.group(1) + pattern[match.end():]\n"
        + "    return pattern",
    },
    {
      localName: "replace_unnamed_groups",
      kind: SymbolKind.Function,
      signature: "replace_unnamed_groups(pattern)",
      body:
        "def replace_unnamed_groups(pattern):\n"
        + "    # Replace unnamed groups, including trailing groups, with their pattern.\n"
        + "    for start, end in unnamed_group_indices(pattern):\n"
        + "        pattern = pattern[:start] + pattern[end:]\n"
        + "    return pattern",
    },
    {
      localName: "named_group_matcher",
      kind: SymbolKind.ModuleVariable,
      signature: "named_group_matcher = re.compile(...)",
      body: "named_group_matcher = re.compile(r'\\(\\?P(<\\w+>)')",
    },
  ]);

  // The entry-point wrapper: matches the issue title, but only delegates.
  const views = seedFile(db, repoRoot, "django/contrib/admindocs/views.py", [
    {
      localName: "simplify_regex",
      kind: SymbolKind.Function,
      signature: "simplify_regex(pattern)",
      body:
        "def simplify_regex(pattern):\n"
        + "    pattern = replace_named_groups(pattern)\n"
        + "    pattern = replace_unnamed_groups(pattern)\n"
        + "    pattern = normalize(pattern)\n"
        + "    return pattern.strip('^$')",
    },
  ]);

  // Generic regex infrastructure in a different subsystem (django/utils).
  const regexHelper = seedFile(db, repoRoot, "django/utils/regex_helper.py", [
    {
      localName: "Group",
      kind: SymbolKind.Class,
      docstring: "A group of regex tokens.",
      body: 'class Group:\n    """A group of regex tokens."""',
    },
    {
      localName: "NonCapture",
      kind: SymbolKind.Class,
      docstring: "A non-capturing regex marker.",
      body: 'class NonCapture:\n    """A non-capturing regex marker."""',
    },
    {
      localName: "normalize",
      kind: SymbolKind.Function,
      signature: "normalize(pattern)",
      body: "def normalize(pattern):\n    return pattern",
    },
  ]);

  insertEdges(db, [
    // The wrapper delegates to two local helpers (-> dispatcher) and to generic
    // infrastructure in another subsystem.
    edge(views.simplify_regex!, utils.replace_named_groups!, EdgeType.Calls),
    edge(views.simplify_regex!, utils.replace_unnamed_groups!, EdgeType.Calls),
    edge(views.simplify_regex!, regexHelper.normalize!, EdgeType.Calls),
    // The helpers use the module-level matcher and reference the regex_helper
    // data structures — pulling them into the candidate pool at depth 1.
    edge(utils.replace_named_groups!, utils.named_group_matcher!, EdgeType.References),
    edge(utils.replace_named_groups!, regexHelper.Group!, EdgeType.References),
    edge(utils.replace_unnamed_groups!, regexHelper.NonCapture!, EdgeType.References),
  ]);

  return { db, repoRoot };
}

function seedFile(
  db: Database,
  repoRoot: string,
  relPath: string,
  specs: readonly SymbolSpec[],
): Record<string, string> {
  let content = "";
  const spans: Array<{ startByte: number; endByte: number }> = [];
  for (const spec of specs) {
    const startByte = Buffer.byteLength(content, "utf8");
    content += spec.body;
    const endByte = Buffer.byteLength(content, "utf8");
    content += "\n\n";
    spans.push({ startByte, endByte });
  }

  const absPath = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);

  const bytes = Buffer.from(content, "utf8");
  const file: FileRecord = {
    id: computeFileId(relPath),
    path: relPath,
    language: Language.Python,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };

  const idsByLocalName: Record<string, string> = {};
  const symbols = specs.map((spec, index) => {
    const span = spans[index]!;
    const fqName = buildFQName({ filePath: relPath, symbolPath: [spec.localName] });
    const symbol: SymbolRecord = {
      id: computeSymbolId({ filePath: relPath, fqName, kind: spec.kind, startByte: span.startByte, endByte: span.endByte }),
      filePath: relPath,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: spec.signature ?? `${spec.kind} ${spec.localName}`,
      startLine: 1,
      endLine: 1,
      startByte: span.startByte,
      endByte: span.endByte,
      exported: false,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
    };
    idsByLocalName[spec.localName] = symbol.id;
    return symbol;
  });

  const parseResult: ParseResult = { file, symbols, edges: [], diagnostics: [] };
  persistParseResult(db, parseResult);
  return idsByLocalName;
}

function edge(src: string, dst: string, edgeType: EdgeType): EdgeRecord {
  return {
    id: createHash("sha256").update([src, dst, edgeType].join("\0")).digest("hex"),
    srcSymbolId: src,
    dstSymbolId: dst,
    edgeType,
    confidence: 1,
  };
}
