/**
 * M156 §11/§12 — neutral proof that one file failure is not a repository failure.
 *
 * The three SWE cases are real but they are also three. If containment were only
 * ever exercised against them, the milestone would be indistinguishable from
 * special-casing the syntax they happen to contain — which §5 explicitly forbids.
 *
 * So this builds synthetic repositories from scratch: many valid files plus one
 * that cannot be indexed, across several failure shapes and across every position
 * the bad file can occupy in enumeration order. The question is never "can the
 * parser handle this dialect" — it is "does the repository survive".
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { listFileIndexFailures } from "../../src/db/repositories/fileIndexFailuresRepository";
import { indexProject } from "../../src/indexer/indexProject";

/** How many valid files each fixture carries alongside the bad one. */
const VALID_FILE_COUNT = 12;

interface BadFile {
  readonly id: string;
  readonly basename: string;
  readonly content: string;
  readonly why: string;
  readonly expectedClass: string;
}

const BAD_FILES: readonly BadFile[] = [
  {
    id: "malformed_python",
    basename: "broken.py",
    content: "def broken(:\n    return 1\n",
    why: "Ordinary syntax error — the baseline shape.",
    expectedClass: "SYNTAX_ERROR",
  },
  {
    id: "legacy_python_syntax",
    basename: "legacy.py",
    content: "try:\n    pass\nexcept ValueError, error:\n    pass\n",
    why: "Valid Python 2, rejected by Python 3. The pytest-5262 shape, reproduced neutrally.",
    expectedClass: "SYNTAX_ERROR",
  },
  {
    id: "starred_expression",
    basename: "starred.py",
    // The construct pylint-4551 actually fails on. A first attempt used
    // `return *[1, 2]`, which CPython accepts — the positive control caught it,
    // which is exactly what §78 asks that control to be for.
    content: "UNPACK_IN_COMP = {elem for elem in (*range(10))}\n",
    why: "Starred expression in a position the grammar rejects. The pylint-4551 shape, verbatim.",
    expectedClass: "SYNTAX_ERROR",
  },
  {
    id: "truncated_unicode_escape",
    basename: "escape.py",
    content: 'VALUE = "\\uZZ"\nOTHER = "\\u12"\n',
    why: "Decoding refusal rather than a grammar refusal. The requests-1142 shape.",
    expectedClass: "ENCODING_ERROR",
  },
  {
    id: "malformed_cython",
    basename: "kernel.pyx",
    content: "cdef int broken(\n    return 1\n",
    why: "A second language, so containment is not a Python-only property.",
    expectedClass: "SYNTAX_ERROR",
  },
  {
    id: "malformed_typescript",
    basename: "broken_ts.ts",
    content: "export function broken( { return 1 }\n",
    why: "A third language — and a NEGATIVE result worth recording. tree-sitter is "
      + "error-tolerant by design: it recovers from malformed TypeScript and returns a "
      + "partial tree rather than failing, so this file is indexed rather than refused. "
      + "Per-file containment is therefore exercised by Python and Cython, whose parsers "
      + "run CPython/tokenize subprocesses that do reject. Recorded rather than forced, "
      + "because inventing a TypeScript failure would test the fixture, not the product.",
    expectedClass: "NONE_PARSER_IS_ERROR_TOLERANT",
  },
];

/** Enumeration is alphabetical, so a prefix decides the bad file's position. */
const POSITIONS = [
  { id: "first", prefix: "aaa_" },
  { id: "middle", prefix: "mmm_" },
  { id: "last", prefix: "zzz_" },
] as const;

interface FixtureOutcome {
  readonly fixture: string;
  readonly badFile: string;
  readonly position: string;
  readonly why: string;
  readonly repositoryIndexed: boolean;
  readonly filesEligible: number;
  readonly filesIndexed: number;
  readonly filesFailed: number;
  readonly filesSkipped: number;
  readonly coverageComplete: boolean;
  readonly failedPaths: readonly string[];
  readonly failureClasses: readonly string[];
  readonly expectedClass: string;
  readonly classMatched: boolean;
  readonly arithmeticHolds: boolean;
  readonly validFilesSurvived: boolean;
}

async function buildFixture(root: string, bad: BadFile, prefix: string): Promise<string> {
  await mkdir(path.join(root, "src"), { recursive: true });
  // Valid files spread across the alphabet so the bad one is genuinely
  // surrounded rather than merely present.
  for (let index = 0; index < VALID_FILE_COUNT; index += 1) {
    const letter = String.fromCharCode("c".charCodeAt(0) + (index % 20));
    await writeFile(
      path.join(root, "src", `${letter}${index}_module.py`),
      `def function_${index}():\n    return ${index}\n`,
    );
  }
  const badPath = `src/${prefix}${bad.basename}`;
  await writeFile(path.join(root, badPath), bad.content);
  return badPath;
}

async function runFixture(bad: BadFile, position: (typeof POSITIONS)[number]): Promise<FixtureOutcome> {
  const root = await mkdtemp(path.join(tmpdir(), "m156-neutral-"));
  const db = openIndexerDatabase();
  try {
    const badPath = await buildFixture(root, bad, position.prefix);
    const result = await indexProject({ repoRoot: root, db });
    const failures = listFileIndexFailures(db);
    const indexedPaths = new Set(
      result.files.filter((file) => file.status === "indexed").map((file) => file.path),
    );

    return {
      fixture: `${bad.id}__${position.id}`,
      badFile: badPath,
      position: position.id,
      why: bad.why,
      repositoryIndexed: true,
      filesEligible: result.coverage.filesEligible,
      filesIndexed: result.coverage.filesIndexed,
      filesFailed: result.coverage.filesFailed,
      filesSkipped: result.coverage.filesSkipped,
      coverageComplete: result.coverage.complete,
      failedPaths: failures.map((failure) => failure.path),
      failureClasses: [...new Set(failures.map((failure) => failure.failureClass))],
      expectedClass: bad.expectedClass,
      classMatched: failures.some((failure) => failure.failureClass === bad.expectedClass),
      arithmeticHolds:
        result.coverage.filesIndexed + result.coverage.filesFailed + result.coverage.filesSkipped
        === result.coverage.filesEligible,
      // Every valid Python module must still be indexed. This is the assertion
      // that makes "the repository survived" mean something.
      validFilesSurvived: Array.from({ length: VALID_FILE_COUNT }).every((_unused, index) => {
        const letter = String.fromCharCode("c".charCodeAt(0) + (index % 20));
        return indexedPaths.has(`src/${letter}${index}_module.py`);
      }),
    };
  } catch (error) {
    return {
      fixture: `${bad.id}__${position.id}`,
      badFile: `src/${position.prefix}${bad.basename}`,
      position: position.id,
      why: bad.why,
      repositoryIndexed: false,
      filesEligible: 0,
      filesIndexed: 0,
      filesFailed: 0,
      filesSkipped: 0,
      coverageComplete: false,
      failedPaths: [],
      failureClasses: [`ABORTED: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`],
      expectedClass: bad.expectedClass,
      classMatched: false,
      arithmeticHolds: false,
      validFilesSurvived: false,
    };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const outcomes: FixtureOutcome[] = [];
  for (const bad of BAD_FILES) {
    for (const position of POSITIONS) {
      outcomes.push(await runFixture(bad, position));
    }
  }

  // §12: the repository outcome must not depend on enumeration order. Compare
  // the position variants of each bad file on everything except the path itself.
  const orderIndependent = BAD_FILES.every((bad) => {
    const variants = outcomes.filter((outcome) => outcome.fixture.startsWith(`${bad.id}__`));
    const shape = (outcome: FixtureOutcome): string => JSON.stringify([
      outcome.repositoryIndexed, outcome.filesIndexed, outcome.filesFailed,
      outcome.filesSkipped, outcome.coverageComplete, outcome.failureClasses,
    ]);
    return variants.every((variant) => shape(variant) === shape(variants[0]!));
  });

  // §78 known-positive control. Every fixture that is SUPPOSED to fail must
  // actually have failed; a fixture whose "bad" file quietly parses proves
  // nothing about containment. The TypeScript case is excluded by declaration,
  // not by convenience — its parser is error-tolerant, and that is recorded as a
  // limitation rather than papered over.
  const shouldFail = outcomes.filter(
    (outcome) => outcome.expectedClass !== "NONE_PARSER_IS_ERROR_TOLERANT",
  );
  const positiveControlHolds = shouldFail.length > 0
    && shouldFail.every((outcome) => outcome.filesFailed >= 1);
  const declaredNonFailing = outcomes.filter(
    (outcome) => outcome.expectedClass === "NONE_PARSER_IS_ERROR_TOLERANT",
  );
  // A declared-non-failing fixture that suddenly DOES fail is also a finding —
  // it would mean the parser stopped being error-tolerant.
  const declaredNonFailingHeld = declaredNonFailing.every((outcome) => outcome.filesFailed === 0);
  const negativeControl = await runCleanControl();

  const report = {
    schemaVersion: "stage5.m156.neutral-failure-fixtures.v1",
    milestone: "M156",
    purpose: "Prove one file failure is not a repository failure, independently of the three SWE cases.",
    validFilesPerFixture: VALID_FILE_COUNT,
    fixtures: outcomes.length,
    repositoriesIndexed: outcomes.filter((outcome) => outcome.repositoryIndexed).length,
    repositoriesAborted: outcomes.filter((outcome) => !outcome.repositoryIndexed).length,
    allValidFilesSurvived: outcomes.every((outcome) => outcome.validFilesSurvived),
    allArithmeticHolds: outcomes.every((outcome) => outcome.arithmeticHolds),
    orderIndependent,
    positiveControlHolds,
    declaredNonFailingHeld,
    languagesExercised: ["python", "cython"],
    languagesNotExercised: [{
      language: "typescript",
      reason: "tree-sitter recovers from malformed input and returns a partial tree, so a "
        + "TypeScript file does not produce a parse failure to contain.",
    }],
    negativeControl,
    classificationMismatches: shouldFail
      .filter((outcome) => !outcome.classMatched)
      .map((outcome) => ({
        fixture: outcome.fixture,
        expected: outcome.expectedClass,
        observed: outcome.failureClasses,
      })),
    outcomes,
  };

  const out = path.join(
    import.meta.dir,
    "results",
    "stage5_m156_neutral_failure_fixtures.json",
  );
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `${report.repositoriesIndexed}/${report.fixtures} repositories survived a local failure; `
    + `orderIndependent=${orderIndependent} positiveControl=${positiveControlHolds} `
    + `cleanControlDegraded=${negativeControl.reportedDegraded} -> ${out}`,
  );
}

/** The control that must NOT be degraded. Without it, a bug marking every index
 *  degraded would satisfy every assertion above. */
async function runCleanControl(): Promise<{
  readonly filesIndexed: number;
  readonly filesFailed: number;
  readonly reportedDegraded: boolean;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "m156-neutral-clean-"));
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < VALID_FILE_COUNT; index += 1) {
      await writeFile(
        path.join(root, "src", `m${index}_module.py`),
        `def function_${index}():\n    return ${index}\n`,
      );
    }
    const result = await indexProject({ repoRoot: root, db });
    return {
      filesIndexed: result.coverage.filesIndexed,
      filesFailed: result.coverage.filesFailed,
      reportedDegraded: !result.coverage.complete,
    };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
