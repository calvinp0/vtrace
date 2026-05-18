import assert from "node:assert/strict";
import { test } from "bun:test";

import { persistParseResult } from "../db/persistParseResult";
import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";
import { searchSymbols, searchSymbolsPlainSql } from "./searchSymbols";
import { searchSymbolsFts } from "./searchSymbolsFts";
import {
  makeSearchParseResult,
  seedConceptDebugSearchFixture,
  seedNarrowQuerySearchFixture,
  seedSearchFixture,
  seedTestAwareWorkflowSearchFixture,
  seedWorkflowSearchFixture,
} from "./testUtils";
import {
  SymbolSearchBackend,
  SymbolSearchMatchField,
} from "./types";

test("FTS backend can be selected explicitly and returns relevant exact name hits", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const direct = searchSymbolsFts(db, {
      query: "SessionToken",
      maxResults: 5,
    });
    const dispatched = searchSymbols(db, {
      query: "SessionToken",
      maxResults: 5,
      backend: SymbolSearchBackend.Fts,
    });

    assert.deepEqual(dispatched, direct);
    assert.equal(direct[0]?.localName, "SessionToken");
  } finally {
    db.close();
  }
});

test("FTS returns fq_name, signature, and docstring matches where supported", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const fqNameResults = searchSymbolsFts(db, {
      query: "AuthService.login",
      maxResults: 5,
    });
    const signatureResults = searchSymbolsFts(db, {
      query: "accountId: string",
      maxResults: 5,
    });
    const docstringResults = searchSymbolsFts(db, {
      query: "lifecycle documentation",
      maxResults: 5,
    });

    assert.equal(fqNameResults[0]?.localName, "login");
    assert.equal(
      fqNameResults[0]?.matches.some((match) => match.field === SymbolSearchMatchField.FQName),
      true,
    );
    assert.equal(
      signatureResults.some((result) =>
        result.matches.some((match) => match.field === SymbolSearchMatchField.Signature)
      ),
      true,
    );
    assert.deepEqual(docstringResults.map((result) => result.localName), ["TokenDocs"]);
    assert.equal(
      docstringResults[0]?.matches.some((match) => match.field === SymbolSearchMatchField.Docstring),
      true,
    );
  } finally {
    db.close();
  }
});

test("FTS repeated identical queries produce identical ordering", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const first = searchSymbolsFts(db, { query: "User", maxResults: 5 });
    const second = searchSymbolsFts(db, { query: "User", maxResults: 5 });

    assert.deepEqual(second, first);
  } finally {
    db.close();
  }
});

test("FTS tie-breaking remains deterministic", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbolsFts(db, { query: "User", maxResults: 5 });

    assert.deepEqual(
      results.map((result) => result.fqName),
      [
        "src/contracts/user.ts::User",
        "src/models/user.ts::User",
      ],
    );
    assert.equal(results[0]!.score, results[1]!.score);
  } finally {
    db.close();
  }
});

test("FTS empty-query and no-match behavior is deterministic", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    assert.deepEqual(searchSymbolsFts(db, { query: "   ", maxResults: 5 }), []);
    assert.deepEqual(searchSymbolsFts(db, { query: "definitely-missing", maxResults: 5 }), []);
  } finally {
    db.close();
  }
});

test("plain SQL backend still works unchanged when selected explicitly", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const explicitSql = searchSymbols(db, {
      query: "User",
      maxResults: 5,
      backend: SymbolSearchBackend.PlainSql,
    });
    const directSql = searchSymbolsPlainSql(db, {
      query: "User",
      maxResults: 5,
    });

    assert.deepEqual(explicitSql, directSql);
  } finally {
    db.close();
  }
});

test("FTS index stays consistent after reindex and symbol replacement", () => {
  const db = openIndexerDatabase();

  try {
    persistParseResult(db, makeSearchParseResult({
      path: "src/temp.ts",
      symbols: [
        {
          localName: "OldToken",
          kind: SymbolKind.TypeAlias,
          startByte: 0,
          endByte: 20,
          signature: "type OldToken = string",
        },
      ],
    }));

    assert.deepEqual(
      searchSymbolsFts(db, { query: "OldToken", maxResults: 5 }).map((result) => result.localName),
      ["OldToken"],
    );

    persistParseResult(db, makeSearchParseResult({
      path: "src/temp.ts",
      symbols: [
        {
          localName: "NewToken",
          kind: SymbolKind.TypeAlias,
          startByte: 0,
          endByte: 20,
          signature: "type NewToken = string",
        },
      ],
    }));

    assert.deepEqual(searchSymbolsFts(db, { query: "OldToken", maxResults: 5 }), []);
    assert.deepEqual(
      searchSymbolsFts(db, { query: "NewToken", maxResults: 5 }).map((result) => result.localName),
      ["NewToken"],
    );
  } finally {
    db.close();
  }
});

test("FTS boundary-query boosts surface Cython candidates more reliably than the no-boost baseline", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      for (const query of ["cython", "compiled helper", "cimport", "extension module"]) {
        const boosted = searchSymbolsFts(db, {
          query,
          maxResults: 6,
        });
        const baseline = searchSymbolsFts(db, {
          query,
          maxResults: 6,
          enableBoundaryBoosts: false,
        });
        const firstBoostedCython = boosted.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));
        const firstBaselineCython = baseline.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));

        assert.equal(firstBoostedCython !== -1, true);
        assert.equal(firstBaselineCython === -1 || firstBoostedCython < firstBaselineCython, true);
      }
    } finally {
      db.close();
    }
  });
});

test("FTS exact Python lookup behavior does not regress when boundary boosts are enabled", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const boosted = searchSymbolsFts(db, {
        query: "CalibrationRun",
        maxResults: 6,
      });
      const baseline = searchSymbolsFts(db, {
        query: "CalibrationRun",
        maxResults: 6,
        enableBoundaryBoosts: false,
      });

      assert.deepEqual(boosted, baseline);
      assert.equal(boosted[0]?.localName, "CalibrationRun");
    } finally {
      db.close();
    }
  });
});

test("FTS broad-query boosts surface workflow and concept candidates more reliably than the no-boost baseline", () => {
  const db = openIndexerDatabase();

  try {
    seedWorkflowSearchFixture(db);

    const expectations = [
      ["how are transition state jobs validated", "validateTransitionStateJobs"],
      ["conformer filtering", "filterConformers"],
      ["kinetics calculation", "scheduleKineticsCalculations"],
      ["reaction family matching", "determineReactionFamily"],
      ["where is species loaded from input", "loadSpeciesInput"],
    ] as const;

    for (const [query, expectedLocalName] of expectations) {
      const boosted = searchSymbolsFts(db, {
        query,
        maxResults: 6,
      });
      const baseline = searchSymbolsFts(db, {
        query,
        maxResults: 6,
        enableBroadQueryBoosts: false,
      });
      const boostedIndex = boosted.findIndex((result) => result.localName === expectedLocalName);
      const baselineIndex = baseline.findIndex((result) => result.localName === expectedLocalName);
      const boostedScore = boosted[boostedIndex]?.score ?? -1;
      const baselineScore = baseline[baselineIndex]?.score ?? -1;

      assert.equal(boosted.some((result) => result.localName === expectedLocalName), true);
      assert.equal(
        baseline.length === 0
          || baselineIndex === -1
          || boostedIndex < baselineIndex
          || (boostedIndex === baselineIndex && boostedScore > baselineScore),
        true,
      );
    }
  } finally {
    db.close();
  }
});

test("FTS concept-heavy troubleshooting queries recover from empty multi-term admission with bounded single-term fallback", () => {
  const db = openIndexerDatabase();

  try {
    seedConceptDebugSearchFixture(db);

    const expectations = [
      [
        "where are errors recognized and mapped to actions",
        ["classifyExceptions", "dispatchRecoveryPlan"],
      ],
      [
        "how does troubleshooting work for errors",
        ["classifyExceptions", "registerFailurePattern"],
      ],
      [
        "where does status get determined and acted on",
        ["deriveStatusCategory", "dispatchRecoveryPlan"],
      ],
      [
        "how does a new error pattern get added end to end",
        ["registerFailurePattern"],
      ],
    ] as const;

    for (const [query, expectedLocalNames] of expectations) {
      const current = searchSymbolsFts(db, {
        query,
        maxResults: 6,
      });
      const baseline = searchSymbolsFts(db, {
        query,
        maxResults: 6,
        enableBroadQueryBoosts: false,
        enableTechnicalQueryBoosts: false,
      });

      assert.equal(current.length > 0, true);
      assert.equal(
        expectedLocalNames.every((expectedLocalName) => (
          current.some((result) => result.localName === expectedLocalName)
        )),
        true,
      );
      assert.equal(baseline.length, 0);
    }
  } finally {
    db.close();
  }
});

test("FTS exact symbol lookup does not regress when concept fallback logic is available", () => {
  const db = openIndexerDatabase();

  try {
    seedConceptDebugSearchFixture(db);

    const results = searchSymbolsFts(db, {
      query: "dispatchRecoveryPlan",
      maxResults: 6,
    });

    assert.equal(results[0]?.localName, "dispatchRecoveryPlan");
    assert.equal(results[0]?.filePath, "src/diagnostics/actions.py");
    assert.equal(
      results[0]?.matches.some((match) => match.field === SymbolSearchMatchField.LocalName),
      true,
    );
  } finally {
    db.close();
  }
});

test("FTS broad workflow queries downweight likely test candidates when production matches are available", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareWorkflowSearchFixture(db);

    const current = searchSymbolsFts(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
    });
    const baseline = searchSymbolsFts(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
      enableTestAwareDownweighting: false,
    });

    assert.equal(current[0]?.localName, "checkTransitionStateJobs");
    assert.equal(current[0]?.filePath, "src/workflows/transition_state_validation.ts");
    assert.equal(baseline[0]?.filePath, "src/workflows/transition_state_validation_test.ts");
    assert.equal(
      current.some((result) => {
        return result.filePath.endsWith("_test.ts")
          && result.matches.some((match) => match.field === SymbolSearchMatchField.LikelyTestPenalty);
      }),
      true,
    );
  } finally {
    db.close();
  }
});

test("FTS exact identifier lookup stays strong with nearby likely test candidates", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareWorkflowSearchFixture(db);

    const results = searchSymbolsFts(db, {
      query: "generateArkaneInput",
      maxResults: 6,
    });

    assert.equal(results[0]?.localName, "generateArkaneInput");
    assert.equal(results[0]?.filePath, "src/statmech/arkane.ts");
  } finally {
    db.close();
  }
});

test("FTS technical serialization variants surface dictionary conversion helpers above adjacent species predicates", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    const current = searchSymbolsFts(db, {
      query: "species_to_dict",
      maxResults: 6,
    });
    const baseline = searchSymbolsFts(db, {
      query: "species_to_dict",
      maxResults: 6,
      enableBroadQueryBoosts: false,
      enableTechnicalQueryBoosts: false,
    });

    assert.equal(current[0]?.localName, "as_dict");
    assert.equal(current[0]?.filePath, "src/species/species.py");
    assert.equal(current[0]?.matches.some((match) => match.field === SymbolSearchMatchField.TechnicalHint), true);
    assert.equal(baseline.length, 0);
  } finally {
    db.close();
  }
});

test("FTS technical boundary queries surface Cython parser and utility candidates deterministically", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    for (const query of ["fast parser", "low level utility"]) {
      const current = searchSymbolsFts(db, {
        query,
        maxResults: 6,
      });
      const second = searchSymbolsFts(db, {
        query,
        maxResults: 6,
      });
      const baseline = searchSymbolsFts(db, {
        query,
        maxResults: 6,
        enableBoundaryBoosts: false,
        enableTechnicalQueryBoosts: false,
      });

      assert.deepEqual(second, current);
      assert.equal(current.some((result) => result.filePath.endsWith(".pyx")), true);
      assert.equal(
        current.some((result) => {
          return result.matches.some((match) => {
            return match.field === SymbolSearchMatchField.BoundaryHint
              || match.field === SymbolSearchMatchField.TechnicalHint;
          });
        }),
        true,
      );
      assert.equal(
        baseline.every((result) => {
          return result.matches.every((match) => {
            return match.field !== SymbolSearchMatchField.BoundaryHint
              && match.field !== SymbolSearchMatchField.TechnicalHint;
          });
        }),
        true,
      );
    }
  } finally {
    db.close();
  }
});

test("FTS technical parser phrasing variants surface production parser code ahead of tests", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    const current = searchSymbolsFts(db, {
      query: "where is the output parsed",
      maxResults: 6,
    });
    const baseline = searchSymbolsFts(db, {
      query: "where is the output parsed",
      maxResults: 6,
      enableBroadQueryBoosts: false,
      enableTechnicalQueryBoosts: false,
    });

    assert.equal(current[0]?.localName, "parseOutputFile");
    assert.equal(current[0]?.filePath, "src/parser/adapter.py");
    assert.equal(current[0]?.matches.some((match) => match.field === SymbolSearchMatchField.TechnicalHint), true);
    assert.equal(baseline.length, 0);
  } finally {
    db.close();
  }
});
