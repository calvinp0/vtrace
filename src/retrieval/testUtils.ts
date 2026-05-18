import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { persistParseResult } from "../db/persistParseResult";
import {
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type FileRecord,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";

export interface SeedFileSpec {
  path: string;
  symbols: readonly SeedSymbolSpec[];
}

export interface SeedSymbolSpec {
  localName: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  signature?: string;
  docstring?: string;
  exported?: boolean;
  parentLocalName?: string;
}

export function seedSearchFixture(db: Database): void {
  for (const file of SEARCH_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

export function seedWorkflowSearchFixture(db: Database): void {
  for (const file of WORKFLOW_SEARCH_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

export function seedTestAwareWorkflowSearchFixture(db: Database): void {
  for (const file of TEST_AWARE_WORKFLOW_SEARCH_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

export function seedNarrowQuerySearchFixture(db: Database): void {
  for (const file of NARROW_QUERY_SEARCH_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

export function seedConceptDebugSearchFixture(db: Database): void {
  for (const file of CONCEPT_DEBUG_SEARCH_FIXTURE) {
    persistParseResult(db, makeSearchParseResult(file));
  }
}

export function makeSearchParseResult(fileSpec: SeedFileSpec): ParseResult {
  const file = makeFileRecord(fileSpec.path);
  const symbolsByLocalName = new Map<string, SymbolRecord>();
  const symbols = fileSpec.symbols.map((spec) => {
    const parent = spec.parentLocalName === undefined
      ? undefined
      : symbolsByLocalName.get(spec.parentLocalName);
    const symbolPath = parent === undefined
      ? [spec.localName]
      : [parent.localName, spec.localName];
    const fqName = buildFQName({
      filePath: fileSpec.path,
      symbolPath,
    });
    const symbol: SymbolRecord = {
      id: computeSymbolId({
        filePath: fileSpec.path,
        fqName,
        kind: spec.kind,
        startByte: spec.startByte,
        endByte: spec.endByte,
      }),
      filePath: fileSpec.path,
      fqName,
      localName: spec.localName,
      kind: spec.kind,
      signature: spec.signature ?? `${spec.kind} ${spec.localName}`,
      startLine: 1,
      endLine: 1,
      startByte: spec.startByte,
      endByte: spec.endByte,
      ...(parent === undefined ? {} : { parentSymbolId: parent.id }),
      exported: spec.exported ?? false,
      ...(spec.docstring === undefined ? {} : { docstring: spec.docstring }),
    };

    symbolsByLocalName.set(spec.localName, symbol);

    return symbol;
  });

  return {
    file,
    symbols,
    edges: [],
    diagnostics: [],
  };
}

function makeFileRecord(path: string): FileRecord {
  const content = `// ${path}\n`;

  return {
    id: computeFileId(path),
    path,
    language: Language.TypeScript,
    contentHash: stableHash([content]),
    sizeBytes: Buffer.byteLength(content),
  };
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

const SEARCH_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/auth/session.ts",
    symbols: [
      {
        localName: "SessionToken",
        kind: SymbolKind.TypeAlias,
        startByte: 0,
        endByte: 24,
        signature: "type SessionToken = string",
      },
      {
        localName: "buildSessionToken",
        kind: SymbolKind.Function,
        startByte: 25,
        endByte: 78,
        signature: "function buildSessionToken(accountId: string): SessionToken",
      },
      {
        localName: "SessionTokenFactory",
        kind: SymbolKind.Class,
        startByte: 79,
        endByte: 134,
        signature: "class SessionTokenFactory",
      },
    ],
  },
  {
    path: "src/auth/service.ts",
    symbols: [
      {
        localName: "AuthService",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 40,
        signature: "class AuthService",
      },
      {
        localName: "login",
        kind: SymbolKind.Method,
        startByte: 41,
        endByte: 88,
        signature: "login(accountId: string): SessionToken",
        parentLocalName: "AuthService",
      },
    ],
  },
  {
    path: "src/contracts/user.ts",
    symbols: [
      {
        localName: "User",
        kind: SymbolKind.Interface,
        startByte: 0,
        endByte: 28,
        signature: "interface User",
      },
    ],
  },
  {
    path: "src/models/user.ts",
    symbols: [
      {
        localName: "User",
        kind: SymbolKind.TypeAlias,
        startByte: 0,
        endByte: 24,
        signature: "type User = string",
      },
    ],
  },
  {
    path: "src/docs/token.ts",
    symbols: [
      {
        localName: "TokenDocs",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 20,
        signature: "class TokenDocs",
        docstring: "SessionToken lifecycle documentation",
      },
    ],
  },
];

const WORKFLOW_SEARCH_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/workflows/input_loader.ts",
    symbols: [
      {
        localName: "loadSpeciesInput",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 48,
        signature: "function loadSpeciesInput(sourcePath: string): SpeciesRecord[]",
        docstring: "Load species records from input files before scheduling reaction workflows.",
      },
    ],
  },
  {
    path: "src/workflows/transition_states.ts",
    symbols: [
      {
        localName: "generateTransitionStateGuesses",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "function generateTransitionStateGuesses(reactionGraph: ReactionGraph): GuessBatch",
        docstring: "Generate transition state guesses for matched reaction families.",
      },
      {
        localName: "validateTransitionStateJobs",
        kind: SymbolKind.Function,
        startByte: 65,
        endByte: 132,
        signature: "function validateTransitionStateJobs(jobBatch: JobBatch): ValidationSummary",
        docstring: "Validate transition state jobs before scheduler promotion and kinetics updates.",
      },
    ],
  },
  {
    path: "src/workflows/conformers.ts",
    symbols: [
      {
        localName: "filterConformers",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 42,
        signature: "function filterConformers(candidates: Conformer[]): Conformer[]",
        docstring: "Filter conformers after geometry optimization and energy screening.",
      },
    ],
  },
  {
    path: "src/workflows/kinetics.ts",
    symbols: [
      {
        localName: "scheduleKineticsCalculations",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 58,
        signature: "function scheduleKineticsCalculations(queue: SchedulerQueue): void",
        docstring: "Schedule kinetics calculations for validated reaction families.",
      },
    ],
  },
  {
    path: "src/domain/reaction_family.ts",
    symbols: [
      {
        localName: "determineReactionFamily",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 54,
        signature: "function determineReactionFamily(reactants: SpeciesRecord[]): FamilyMatch",
        docstring: "Determine reaction family matches from reactant templates and heuristics.",
      },
    ],
  },
];

const TEST_AWARE_WORKFLOW_SEARCH_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/workflows/transition_state_validation.ts",
    symbols: [
      {
        localName: "checkTransitionStateJobs",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 64,
        signature: "function checkTransitionStateJobs(jobBatch: JobBatch): ValidationSummary",
        docstring: "Validate transition state jobs before scheduler promotion and workflow updates.",
      },
    ],
  },
  {
    path: "src/workflows/transition_state_validation_test.ts",
    symbols: [
      {
        localName: "TestTransitionStateValidation",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 48,
        signature: "class TestTransitionStateValidation",
        docstring: "Transition state jobs validated in workflow regression coverage.",
      },
      {
        localName: "testValidateTransitionStateJobs",
        kind: SymbolKind.Method,
        startByte: 49,
        endByte: 108,
        signature: "testValidateTransitionStateJobs(): ValidationSummary",
        docstring: "Validate transition state jobs in regression coverage.",
        parentLocalName: "TestTransitionStateValidation",
      },
    ],
  },
  {
    path: "src/statmech/arkane.ts",
    symbols: [
      {
        localName: "generateArkaneInput",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 52,
        signature: "function generateArkaneInput(species: SpeciesRecord): string",
        docstring: "Write Arkane input files for validated statmech calculations.",
      },
    ],
  },
  {
    path: "src/statmech/arkane_test.ts",
    symbols: [
      {
        localName: "testGenerateArkaneInput",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 56,
        signature: "function testGenerateArkaneInput(): string",
        docstring: "Write Arkane input files in regression coverage.",
      },
    ],
  },
];

const NARROW_QUERY_SEARCH_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/app/main.py",
    symbols: [
      {
        localName: "AppRuntime",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 40,
        signature: "class AppRuntime",
        docstring: "Main application runtime entrypoint.",
      },
      {
        localName: "execute",
        kind: SymbolKind.Function,
        startByte: 41,
        endByte: 84,
        signature: "function execute(): void",
        docstring: "Run the main application entrypoint.",
      },
    ],
  },
  {
    path: "src/species/species.py",
    symbols: [
      {
        localName: "as_dict",
        kind: SymbolKind.Method,
        startByte: 0,
        endByte: 32,
        signature: "as_dict(): SpeciesDict",
        docstring: "Serialize this species object as a dictionary.",
      },
      {
        localName: "from_dict",
        kind: SymbolKind.Method,
        startByte: 33,
        endByte: 68,
        signature: "from_dict(data: SpeciesDict): SpeciesRecord",
        docstring: "Load this species object from a dictionary.",
      },
    ],
  },
  {
    path: "src/workflows/scheduler.py",
    symbols: [
      {
        localName: "species_has_freq",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 52,
        signature: "species_has_freq(species: SpeciesDict): boolean",
        docstring: "Check whether a species dictionary includes frequencies.",
      },
    ],
  },
  {
    path: "src/parser/adapter.py",
    symbols: [
      {
        localName: "parseOutputFile",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 54,
        signature: "parseOutputFile(path: string): ParsedLog",
        docstring: "Parse ESS output files through the parser adapter.",
      },
    ],
  },
  {
    path: "src/parser/output_test.py",
    symbols: [
      {
        localName: "TestParseOutput",
        kind: SymbolKind.Class,
        startByte: 0,
        endByte: 40,
        signature: "class TestParseOutput",
        docstring: "Regression tests for parsing ESS output files.",
      },
      {
        localName: "testParseOutputFile",
        kind: SymbolKind.Method,
        startByte: 41,
        endByte: 86,
        signature: "testParseOutputFile(): ParsedLog",
        docstring: "Parse ESS output files in regression coverage.",
        parentLocalName: "TestParseOutput",
      },
    ],
  },
  {
    path: "src/core/parser_kernel.pyx",
    symbols: [
      {
        localName: "parse_buffer",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 44,
        signature: "parse_buffer(data: bytes): ParsedBuffer",
        docstring: "Compiled parser kernel for low-level buffer parsing.",
      },
    ],
  },
  {
    path: "src/core/utility_core.pyx",
    symbols: [
      {
        localName: "fast_lookup",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 38,
        signature: "fast_lookup(key: string): LookupResult",
        docstring: "Compiled low-level utility helper for internal lookups.",
      },
    ],
  },
];

const CONCEPT_DEBUG_SEARCH_FIXTURE: readonly SeedFileSpec[] = [
  {
    path: "src/diagnostics/classifier.py",
    symbols: [
      {
        localName: "classifyExceptions",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 52,
        signature: "classifyExceptions(report: FailureReport): ExceptionClass",
        docstring: "Recognize failure categories after parser evaluation and handler review.",
      },
    ],
  },
  {
    path: "src/diagnostics/actions.py",
    symbols: [
      {
        localName: "dispatchRecoveryPlan",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 54,
        signature: "dispatchRecoveryPlan(status: Status): RecoveryPlan",
        docstring: "Dispatch recovery commands from mapped status categories and retry decisions.",
      },
    ],
  },
  {
    path: "src/diagnostics/status.py",
    symbols: [
      {
        localName: "deriveStatusCategory",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 50,
        signature: "deriveStatusCategory(report: FailureReport): Status",
        docstring: "Determine status after handler evaluation before recovery dispatch.",
      },
    ],
  },
  {
    path: "src/diagnostics/patterns.py",
    symbols: [
      {
        localName: "registerFailurePattern",
        kind: SymbolKind.Function,
        startByte: 0,
        endByte: 52,
        signature: "registerFailurePattern(pattern: FailurePattern): void",
        docstring: "Add new failure patterns to the troubleshooting registry.",
      },
    ],
  },
];
