// Stage 5 Django regression fixture.
//
// A single in-memory index seeding the FIVE Stage 5 Django scenarios — each with
// its real implementation file, the failing-test file that exercises it, and the
// import/call edges between them — so the evidence-ranked pivot/support pipeline
// can be exercised end to end without indexing real Django. All five live in one
// index (as they would in a real checkout), so retrieval for one scenario must
// still pivot on the right file despite the others being present.
//
// The instance-id -> expected-file mapping lives ONLY in `STAGE5_SCENARIOS`, as
// regression-ASSERTION data. Production code never sees an instance id or an
// expected path (Requirement 9); it is handed only the paraphrased problem
// statement + failing tests and must recover the target from the index alone.

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

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
import type { SweIssueRecord } from "../sweQueryShaping";

interface SymbolSpec {
  localName: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  signature?: string;
  docstring?: string;
  parentLocalName?: string;
}

/** What Requirement 8 permits for a scenario's expected edited file. */
export type Stage5Expectation =
  // Must be a pivot (a likely edit target).
  | "pivot"
  // Pivot, OR skip — but never buried as support behind an off-target file.
  | "pivot_or_skip"
  // Pivot OR support, as long as it is selected with clear evidence.
  | "pivot_or_support";

export interface Stage5Scenario {
  instanceId: string;
  record: SweIssueRecord;
  /** The real final edited file for this instance (assertion data only). */
  expectedFile: string;
  expectation: Stage5Expectation;
  /** A file that the expected target must NOT rank behind (when set). */
  notBehindFile?: string;
}

// The five scenarios, with the Requirement 8 expectations. Problem statements are
// paraphrased but preserve the real implementation symbol/file and failing test.
export const STAGE5_SCENARIOS: readonly Stage5Scenario[] = [
  {
    instanceId: "django__django-10880",
    expectedFile: "django/db/models/aggregates.py",
    expectation: "pivot_or_skip",
    notBehindFile: "django/db/models/sql/subqueries.py",
    record: {
      repo: "django/django",
      instanceId: "django__django-10880",
      problemStatement:
        "Count annotation with a Case condition and distinct=True produces wrong SQL. "
        + "The Count aggregate in aggregates.py builds the wrong as_sql output.",
      hintsText: null,
      failToPass: [
        "tests/aggregation/tests.py::AggregateTestCase::test_count_distinct_expression",
      ],
    },
  },
  {
    instanceId: "django__django-11095",
    expectedFile: "django/contrib/admin/options.py",
    expectation: "pivot",
    record: {
      repo: "django/django",
      instanceId: "django__django-11095",
      problemStatement:
        "Add a ModelAdmin.get_inlines() hook to set inlines based on the request. "
        + "get_inline_instances() in admin/options.py should call the new hook.",
      hintsText: null,
      failToPass: [
        "tests/admin_inlines/tests.py::GenericInlineModelAdminTest::test_get_inline_instances_override_get_inlines",
      ],
    },
  },
  {
    instanceId: "django__django-11728",
    expectedFile: "django/contrib/admindocs/utils.py",
    expectation: "pivot",
    record: {
      repo: "django/django",
      instanceId: "django__django-11728",
      problemStatement:
        "simplify_regexp() does not replace trailing named groups. replace_named_groups() "
        + "in admindocs/utils.py stops before the final group and must parse to the end.",
      hintsText: null,
      failToPass: [
        "tests/admin_docs/test_utils.py::TestUtils::test_replace_named_groups",
      ],
    },
  },
  {
    instanceId: "django__django-11740",
    expectedFile: "django/db/migrations/autodetector.py",
    expectation: "pivot_or_support",
    record: {
      repo: "django/django",
      instanceId: "django__django-11740",
      problemStatement:
        "Changing a UUIDField to a ForeignKey does not create a migration dependency. "
        + "generate_altered_fields() in migrations/autodetector.py must add the FK dependency.",
      hintsText: null,
      failToPass: [
        "tests/migrations/test_autodetector.py::AutodetectorTests::test_alter_field_to_fk_dependency",
      ],
    },
  },
  {
    instanceId: "django__django-11490",
    expectedFile: "django/db/models/sql/query.py",
    expectation: "pivot_or_support",
    record: {
      repo: "django/django",
      instanceId: "django__django-11490",
      problemStatement:
        "Composed queries cannot change the list of selected columns with values(). "
        + "set_values() on the Query in models/sql/query.py must propagate across each combined query.",
      hintsText: null,
      failToPass: [
        "tests/queries/test_qs_combinators.py::QuerySetSetOperationTests::test_union_with_values",
      ],
    },
  },
] as const;

// Seed the five scenarios into `db`. Returns nothing; tests retrieve by path.
export function seedStage5DjangoFixture(db: Database): void {
  // --- 10880: aggregates.py + a sql/subqueries.py module variable distractor ---
  const aggregates = seedFile(db, "django/db/models/aggregates.py", [
    { localName: "Aggregate", kind: SymbolKind.Class, startByte: 0, endByte: 60, docstring: "Base class for aggregate expressions." },
    { localName: "as_sql", kind: SymbolKind.Method, startByte: 61, endByte: 120, parentLocalName: "Aggregate", signature: "as_sql(self, compiler, connection)" },
    { localName: "Count", kind: SymbolKind.Class, startByte: 121, endByte: 200, docstring: "Count aggregate with optional distinct." },
    { localName: "__init__", kind: SymbolKind.Method, startByte: 201, endByte: 260, parentLocalName: "Count", signature: "__init__(self, expression, distinct=False)" },
  ]);
  const subqueries = seedFile(db, "django/db/models/sql/subqueries.py", [
    { localName: "compiler", kind: SymbolKind.ModuleVariable, startByte: 0, endByte: 40, signature: "compiler = 'SQLAggregateCompiler'" },
  ]);
  const aggTests = seedFile(db, "tests/aggregation/tests.py", [
    { localName: "AggregateTestCase", kind: SymbolKind.Class, startByte: 0, endByte: 80 },
    { localName: "test_count_distinct_expression", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "AggregateTestCase" },
  ]);

  // --- 11095: admin/options.py ---
  const options = seedFile(db, "django/contrib/admin/options.py", [
    { localName: "ModelAdmin", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Encapsulate all admin options for a given model." },
    { localName: "get_inline_instances", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "ModelAdmin", signature: "get_inline_instances(self, request, obj=None)" },
  ]);
  const inlineTests = seedFile(db, "tests/admin_inlines/tests.py", [
    { localName: "GenericInlineModelAdminTest", kind: SymbolKind.Class, startByte: 0, endByte: 80 },
    { localName: "test_get_inline_instances_override_get_inlines", kind: SymbolKind.Method, startByte: 81, endByte: 180, parentLocalName: "GenericInlineModelAdminTest" },
  ]);

  // --- 11728: admindocs/utils.py (module-level functions) ---
  const adminutils = seedFile(db, "django/contrib/admindocs/utils.py", [
    { localName: "replace_named_groups", kind: SymbolKind.Function, startByte: 0, endByte: 80, signature: "replace_named_groups(pattern)" },
    { localName: "replace_unnamed_groups", kind: SymbolKind.Function, startByte: 81, endByte: 160, signature: "replace_unnamed_groups(pattern)" },
  ]);
  const adminDocsTests = seedFile(db, "tests/admin_docs/test_utils.py", [
    { localName: "TestUtils", kind: SymbolKind.Class, startByte: 0, endByte: 80 },
    { localName: "test_replace_named_groups", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "TestUtils" },
  ]);

  // --- 11740: migrations/autodetector.py ---
  const autodetector = seedFile(db, "django/db/migrations/autodetector.py", [
    { localName: "MigrationAutodetector", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "Detect changes and generate migration operations." },
    { localName: "generate_altered_fields", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "MigrationAutodetector", signature: "generate_altered_fields(self)" },
  ]);
  const autodetectorTests = seedFile(db, "tests/migrations/test_autodetector.py", [
    { localName: "AutodetectorTests", kind: SymbolKind.Class, startByte: 0, endByte: 80 },
    { localName: "test_alter_field_to_fk_dependency", kind: SymbolKind.Method, startByte: 81, endByte: 200, parentLocalName: "AutodetectorTests" },
  ]);

  // --- 11490: models/sql/query.py ---
  const query = seedFile(db, "django/db/models/sql/query.py", [
    { localName: "Query", kind: SymbolKind.Class, startByte: 0, endByte: 80, docstring: "A single SQL query under construction." },
    { localName: "set_values", kind: SymbolKind.Method, startByte: 81, endByte: 160, parentLocalName: "Query", signature: "set_values(self, fields)" },
    { localName: "get_combinator_sql", kind: SymbolKind.Method, startByte: 161, endByte: 240, parentLocalName: "Query", signature: "get_combinator_sql(self, combinator, all)" },
  ]);
  const combinatorTests = seedFile(db, "tests/queries/test_qs_combinators.py", [
    { localName: "QuerySetSetOperationTests", kind: SymbolKind.Class, startByte: 0, endByte: 80 },
    { localName: "test_union_with_values", kind: SymbolKind.Method, startByte: 81, endByte: 200, parentLocalName: "QuerySetSetOperationTests" },
  ]);

  insertEdges(db, [
    // Containment within each implementation/test file.
    edge(aggregates.Aggregate!, aggregates.as_sql!, EdgeType.Contains),
    edge(aggregates.Count!, aggregates.__init__!, EdgeType.Contains),
    edge(aggregates.Count!, aggregates.Aggregate!, EdgeType.References),
    edge(aggTests.AggregateTestCase!, aggTests.test_count_distinct_expression!, EdgeType.Contains),
    edge(options.ModelAdmin!, options.get_inline_instances!, EdgeType.Contains),
    edge(inlineTests.GenericInlineModelAdminTest!, inlineTests.test_get_inline_instances_override_get_inlines!, EdgeType.Contains),
    edge(adminDocsTests.TestUtils!, adminDocsTests.test_replace_named_groups!, EdgeType.Contains),
    edge(autodetector.MigrationAutodetector!, autodetector.generate_altered_fields!, EdgeType.Contains),
    edge(autodetectorTests.AutodetectorTests!, autodetectorTests.test_alter_field_to_fk_dependency!, EdgeType.Contains),
    edge(query.Query!, query.set_values!, EdgeType.Contains),
    edge(query.Query!, query.get_combinator_sql!, EdgeType.Contains),
    edge(combinatorTests.QuerySetSetOperationTests!, combinatorTests.test_union_with_values!, EdgeType.Contains),

    // Failing-test FILE imports the implementation it exercises (test_to_impl).
    edge(aggTests.AggregateTestCase!, aggregates.Count!, EdgeType.Imports),
    edge(inlineTests.GenericInlineModelAdminTest!, options.ModelAdmin!, EdgeType.Imports),
    edge(adminDocsTests.TestUtils!, adminutils.replace_named_groups!, EdgeType.Imports),
    edge(autodetectorTests.AutodetectorTests!, autodetector.MigrationAutodetector!, EdgeType.Imports),
    edge(combinatorTests.QuerySetSetOperationTests!, query.Query!, EdgeType.Imports),

    // Failing-test METHOD calls the implementation member (failing_test route).
    edge(aggTests.test_count_distinct_expression!, aggregates.__init__!, EdgeType.Calls),
    edge(inlineTests.test_get_inline_instances_override_get_inlines!, options.get_inline_instances!, EdgeType.Calls),
    edge(adminDocsTests.test_replace_named_groups!, adminutils.replace_named_groups!, EdgeType.Calls),
    edge(autodetectorTests.test_alter_field_to_fk_dependency!, autodetector.generate_altered_fields!, EdgeType.Calls),
    edge(combinatorTests.test_union_with_values!, query.set_values!, EdgeType.Calls),

    // The aggregate classes reference the sql/subqueries config var, so it is
    // graph-reachable from an aggregate seed — and must stay below the target.
    edge(aggregates.Aggregate!, subqueries.compiler!, EdgeType.Calls),
    edge(aggregates.Count!, subqueries.compiler!, EdgeType.Calls),
  ]);
}

function seedFile(
  db: Database,
  filePath: string,
  specs: readonly SymbolSpec[],
): Record<string, string> {
  const file = makeFileRecord(filePath);
  const byLocalName = new Map<string, SymbolRecord>();
  const idsByLocalName: Record<string, string> = {};

  const symbols = specs.map((spec) => {
    const parent = spec.parentLocalName === undefined
      ? undefined
      : byLocalName.get(spec.parentLocalName);
    const symbolPath = parent === undefined ? [spec.localName] : [parent.localName, spec.localName];
    const fqName = buildFQName({ filePath, symbolPath });
    const symbol: SymbolRecord = {
      id: computeSymbolId({ filePath, fqName, kind: spec.kind, startByte: spec.startByte, endByte: spec.endByte }),
      filePath,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: spec.signature ?? `${spec.kind} ${spec.localName}`,
      startLine: 1,
      endLine: 1,
      startByte: spec.startByte,
      endByte: spec.endByte,
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

function makeFileRecord(filePath: string): FileRecord {
  const content = `# ${filePath}\n`;
  return {
    id: computeFileId(filePath),
    path: filePath,
    language: Language.Python,
    contentHash: stableHash([content]),
    sizeBytes: Buffer.byteLength(content),
  };
}

function edge(src: string, dst: string, edgeType: EdgeType): EdgeRecord {
  return { id: stableHash([src, dst, edgeType]), srcSymbolId: src, dstSymbolId: dst, edgeType, confidence: 1 };
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
