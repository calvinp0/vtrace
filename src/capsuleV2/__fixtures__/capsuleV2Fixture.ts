// Capsule v2 test fixture — a small repo materialised ON DISK plus a matching
// in-memory index, so the full v2 pipeline (including source-backed pivot
// extraction, which re-reads and hash-checks the file) runs end to end without
// indexing a real project.
//
// The repo models one task: an admin inlines change. It contains the
// implementation (`ModelAdmin.get_inline_instances`), the failing test that
// exercises it, a supporting helper (`get_inline_formsets`), a high-centrality
// framework hub (`Model`) with no task relevance, and a markdown doc section.
// No instance ids or expected paths are passed to production code — the pipeline
// recovers everything from the index + disk alone.

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

export interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  /** The exact source text for this symbol (its focused body). */
  body: string;
  signature?: string;
  docstring?: string;
  parentLocalName?: string;
}

export interface CapsuleV2Fixture {
  db: Database;
  repoRoot: string;
}

/** The task prose for the inlines scenario (mirrors a real SWE issue shape). */
export const INLINES_TASK =
  "Add a ModelAdmin.get_inlines() hook to set inlines based on the request. "
  + "get_inline_instances() in pkg/options.py should call the new hook. The change is "
  + "broken because get_inline_instances does not consult get_inlines. "
  + "tests/test_inlines.py::InlineAdminTest::test_get_inline_instances_override_get_inlines";

/** Build the on-disk repo + in-memory index. Caller closes `db`. */
export function seedCapsuleV2Fixture(): CapsuleV2Fixture {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-capsulev2-"));
  const db = openIndexerDatabase();

  const options = seedFile(db, repoRoot, "pkg/options.py", [
    {
      localName: "ModelAdmin",
      kind: SymbolKind.Class,
      docstring: "Encapsulate all admin options for a given model.",
      body: 'class ModelAdmin:\n    """Encapsulate all admin options for a given model."""',
    },
    {
      localName: "get_inline_instances",
      kind: SymbolKind.Method,
      parentLocalName: "ModelAdmin",
      signature: "get_inline_instances(self, request, obj=None)",
      body:
        "    def get_inline_instances(self, request, obj=None):\n"
        + "        inline_instances = []\n"
        + "        for inline_class in self.get_inlines(request, obj):\n"
        + "            inline = inline_class(self.model, self.admin_site)\n"
        + "            inline_instances.append(inline)\n"
        + "        return inline_instances",
    },
  ]);

  const forms = seedFile(db, repoRoot, "pkg/forms.py", [
    {
      localName: "get_inline_formsets",
      kind: SymbolKind.Function,
      signature: "get_inline_formsets(request, formsets, inline_instances, obj=None)",
      body:
        "def get_inline_formsets(request, formsets, inline_instances, obj=None):\n"
        + "    return []",
    },
  ]);

  // A high-centrality framework hub with NO lexical/path/symbol/domain overlap
  // with the inlines task — reachable only through the graph. It must never be a
  // pivot at any budget (centrality cannot win alone), only support at most.
  const apps = seedFile(db, repoRoot, "core/apps.py", [
    {
      localName: "AppConfig",
      kind: SymbolKind.Class,
      docstring: "Application configuration registry.",
      body: 'class AppConfig:\n    """Application configuration registry."""',
    },
  ]);

  // Six unrelated consumers import AppConfig, giving it a high global in-degree
  // (a generic framework hub) with zero relevance to the inlines task.
  const consumerSpecs: SymbolSpec[] = [];
  for (let index = 0; index < 6; index += 1) {
    consumerSpecs.push({
      localName: `Consumer${index}`,
      kind: SymbolKind.Class,
      body: `class Consumer${index}:\n    pass`,
    });
  }
  const consumers = seedFile(db, repoRoot, "vendor/consumers.py", consumerSpecs);

  const tests = seedFile(db, repoRoot, "tests/test_inlines.py", [
    {
      localName: "InlineAdminTest",
      kind: SymbolKind.Class,
      body: "class InlineAdminTest:\n    pass",
    },
    {
      localName: "test_get_inline_instances_override_get_inlines",
      kind: SymbolKind.Method,
      parentLocalName: "InlineAdminTest",
      body:
        "    def test_get_inline_instances_override_get_inlines(self):\n"
        + "        admin = ModelAdmin()\n"
        + "        self.assertEqual(admin.get_inline_instances(request), [])",
    },
  ]);

  writeMarkdown(
    repoRoot,
    "docs/inlines.md",
    "# Admin inlines\n\n"
      + "## Overriding inline instances\n\n"
      + "Use get_inlines to control which inline instances ModelAdmin builds for a "
      + "request. get_inline_instances consults this hook.\n\n"
      + "## Unrelated section\n\nThis section is about migrations and should not match.\n",
  );

  const edges: EdgeRecord[] = [
    // Containment.
    edge(options.ModelAdmin!, options.get_inline_instances!, EdgeType.Contains),
    edge(tests.InlineAdminTest!, tests.test_get_inline_instances_override_get_inlines!, EdgeType.Contains),
    // The implementation calls the support helper and references the hub.
    edge(options.get_inline_instances!, forms.get_inline_formsets!, EdgeType.Calls),
    edge(options.get_inline_instances!, apps.AppConfig!, EdgeType.References),
    // Failing-test routes: the test FILE imports the impl class; the test METHOD
    // calls the impl method.
    edge(tests.InlineAdminTest!, options.ModelAdmin!, EdgeType.Imports),
    edge(tests.test_get_inline_instances_override_get_inlines!, options.get_inline_instances!, EdgeType.Calls),
  ];
  // Hub edges: every consumer imports AppConfig.
  for (let index = 0; index < 6; index += 1) {
    edges.push(edge(consumers[`Consumer${index}`]!, apps.AppConfig!, EdgeType.Imports));
  }
  insertEdges(db, edges);

  return { db, repoRoot };
}

// Materialise an ad-hoc repo (on disk + indexed) from a list of files. Used by
// tests that need a custom candidate layout (e.g. a production source file vs a
// doc-data sample file) without the full inlines scenario. Caller closes `db`.
export function seedCustomFixture(
  files: ReadonlyArray<{ relPath: string; specs: readonly SymbolSpec[] }>,
): CapsuleV2Fixture {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "vtrace-capsulev2-custom-"));
  const db = openIndexerDatabase();
  for (const file of files) {
    seedFile(db, repoRoot, file.relPath, file.specs);
  }
  return { db, repoRoot };
}

export function seedFile(
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

  const byLocalName = new Map<string, SymbolRecord>();
  const idsByLocalName: Record<string, string> = {};
  const symbols = specs.map((spec, index) => {
    const span = spans[index]!;
    const parent = spec.parentLocalName === undefined ? undefined : byLocalName.get(spec.parentLocalName);
    const symbolPath = parent === undefined ? [spec.localName] : [parent.localName, spec.localName];
    const fqName = buildFQName({ filePath: relPath, symbolPath });
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
      ...(parent === undefined ? {} : { parentSymbolId: parent.id }),
      exported: false,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
    };
    byLocalName.set(spec.localName, symbol);
    idsByLocalName[spec.localName] = symbol.id;
    return symbol;
  });

  const parseResult: ParseResult = { file, symbols, edges: [], diagnostics: [] };
  persistParseResult(db, parseResult);
  return idsByLocalName;
}

function writeMarkdown(repoRoot: string, relPath: string, content: string): void {
  const absPath = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
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
