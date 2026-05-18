import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { withMixedPyCythonRepo } from "../testing/mixedPyCythonFixture";
import { searchSymbols } from "./searchSymbols";
import {
  seedNarrowQuerySearchFixture,
  seedSearchFixture,
  seedTestAwareWorkflowSearchFixture,
  seedWorkflowSearchFixture,
} from "./testUtils";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
} from "./types";

test("exact local_name matches rank above weaker substring matches", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, {
      query: "SessionToken",
      maxResults: 5,
    });

    assert.equal(results[0]?.localName, "SessionToken");
    assert.equal(
      results.some((result) => result.localName === "buildSessionToken"),
      true,
    );
    assert.equal(
      results.some((result) => result.localName === "SessionTokenFactory"),
      true,
    );
    assert.equal(results[0]?.matches[0]?.field, SymbolSearchMatchField.LocalName);
    assert.equal(results[0]?.matches[0]?.matchType, SymbolSearchMatchType.Exact);
    assert.equal(
      (results[0]?.score ?? 0)
        > (results.find((result) => result.localName === "buildSessionToken")?.score ?? 0),
      true,
    );
    assert.equal(
      (results[0]?.score ?? 0)
        > (results.find((result) => result.localName === "SessionTokenFactory")?.score ?? 0),
      true,
    );
  } finally {
    db.close();
  }
});

test("fq_name matches are returned", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, {
      query: "AuthService.login",
      maxResults: 5,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.localName, "login");
    assert.equal(
      results[0]?.matches.some((match) => match.field === SymbolSearchMatchField.FQName),
      true,
    );
  } finally {
    db.close();
  }
});

test("signature and docstring matches are returned with lower score than exact local_name matches", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, {
      query: "SessionToken",
      maxResults: 5,
    });

    const exact = results.find((result) => result.localName === "SessionToken");
    const signatureMatch = results.find((result) => result.localName === "buildSessionToken");
    const docstringMatch = results.find((result) => result.localName === "TokenDocs");

    assert.notEqual(exact, undefined);
    assert.notEqual(signatureMatch, undefined);
    assert.notEqual(docstringMatch, undefined);
    assert.equal(exact!.score > signatureMatch!.score, true);
    assert.equal(signatureMatch!.score > docstringMatch!.score, true);
    assert.equal(
      signatureMatch!.matches.some((match) => match.field === SymbolSearchMatchField.Signature),
      true,
    );
    assert.equal(
      docstringMatch!.matches.some((match) => match.field === SymbolSearchMatchField.Docstring),
      true,
    );
  } finally {
    db.close();
  }
});

test("optional SymbolKind filter works", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, {
      query: "User",
      maxResults: 5,
      kind: SymbolKind.Interface,
    });

    assert.deepEqual(
      results.map((result) => [result.localName, result.kind]),
      [["User", SymbolKind.Interface]],
    );
  } finally {
    db.close();
  }
});

test("repeated queries produce identical ordering", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const first = searchSymbols(db, { query: "User", maxResults: 5 });
    const second = searchSymbols(db, { query: "User", maxResults: 5 });

    assert.deepEqual(second, first);
  } finally {
    db.close();
  }
});

test("tie-breaking is deterministic", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, { query: "User", maxResults: 5 });

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

test("empty query handling is deterministic", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    assert.deepEqual(searchSymbols(db, { query: "   ", maxResults: 5 }), []);
  } finally {
    db.close();
  }
});

test("no-match behavior is deterministic", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    assert.deepEqual(searchSymbols(db, { query: "definitely-missing", maxResults: 5 }), []);
  } finally {
    db.close();
  }
});

test("result set size respects maxResults", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, { query: "SessionToken", maxResults: 2 });

    assert.equal(results.length, 2);
    assert.equal(results[0]?.localName, "SessionToken");
  } finally {
    db.close();
  }
});

test("file path matches are returned as a weak signal", () => {
  const db = openIndexerDatabase();

  try {
    seedSearchFixture(db);

    const results = searchSymbols(db, { query: "docs/token.ts", maxResults: 5 });

    assert.deepEqual(results.map((result) => result.localName), ["TokenDocs"]);
    assert.equal(
      results[0]?.matches.some((match) => match.field === SymbolSearchMatchField.FilePath),
      true,
    );
  } finally {
    db.close();
  }
});

test("mixed Python/Cython fixture queries return useful Python, Cython, and package-path matches", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const calibrationResults = searchSymbols(db, {
        query: "CalibrationRun",
        maxResults: 5,
      });
      const docstringResults = searchSymbols(db, {
        query: "dark current corrected baselines",
        maxResults: 5,
      });
      const cythonResults = searchSymbols(db, {
        query: "diffuse_profile",
        maxResults: 5,
      });
      const signatureResults = searchSymbols(db, {
        query: "concentration",
        maxResults: 6,
      });
      const packageResults = searchSymbols(db, {
        query: "spectra_lab/analysis",
        maxResults: 6,
      });

      assert.equal(calibrationResults[0]?.localName, "CalibrationRun");
      assert.equal(calibrationResults[0]?.filePath, "src/spectra_lab/analysis/calibration.py");
      assert.equal(docstringResults[0]?.localName, "CalibrationRun");
      assert.equal(
        docstringResults[0]?.matches.some((match) => match.field === SymbolSearchMatchField.Docstring),
        true,
      );
      assert.equal(cythonResults[0]?.localName, "diffuse_profile");
      assert.equal(cythonResults[0]?.filePath, "src/spectra_lab/kernels/diffusion_kernels.pyx");
      assert.equal(
        signatureResults.some((result) => result.localName === "diffuse_profile"),
        true,
      );
      assert.equal(
        signatureResults.some((result) => result.localName === "declared_step"),
        true,
      );
      assert.equal(
        signatureResults.some((result) => {
          return result.localName === "stencil_smooth"
            && result.matches.some((match) => match.field === SymbolSearchMatchField.Signature);
        }),
        true,
      );
      assert.equal(packageResults.length > 0, true);
      assert.equal(
        packageResults.every((result) => result.filePath.startsWith("src/spectra_lab/analysis/")),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("mixed Python/Cython fixture lexical retrieval remains deterministic across repeated queries", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const first = searchSymbols(db, { query: "concentration", maxResults: 6 });
      const second = searchSymbols(db, { query: "concentration", maxResults: 6 });

      assert.deepEqual(second, first);
    } finally {
      db.close();
    }
  });
});

test("explicit boundary-query boosts surface Cython lexical candidates more reliably than the no-boost baseline", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      for (const query of ["cython", "compiled helper", "cimport", "extension module"]) {
        const boosted = searchSymbols(db, {
          query,
          maxResults: 6,
        });
        const baseline = searchSymbols(db, {
          query,
          maxResults: 6,
          enableBoundaryBoosts: false,
        });
        const firstBoostedCython = boosted.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));
        const firstBaselineCython = baseline.findIndex((result) => /\.(pyx|pxd|pxi)$/.test(result.filePath));

        assert.equal(firstBoostedCython !== -1, true);
        assert.equal(firstBaselineCython === -1 || firstBoostedCython < firstBaselineCython, true);
        assert.equal(
          boosted.some((result) => {
            return result.matches.some((match) => match.field === SymbolSearchMatchField.BoundaryHint);
          }),
          true,
        );
      }
    } finally {
      db.close();
    }
  });
});

test("broad-query boosts surface workflow and concept candidates more reliably than the no-boost baseline", () => {
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
      const boosted = searchSymbols(db, {
        query,
        maxResults: 6,
      });
      const baseline = searchSymbols(db, {
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
      assert.equal(
        boosted.some((result) => {
          return result.matches.some((match) => match.field === SymbolSearchMatchField.QueryCoverage);
        }),
        true,
      );
    }
  } finally {
    db.close();
  }
});

test("broad workflow queries downweight likely test candidates when production matches are available", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareWorkflowSearchFixture(db);

    const current = searchSymbols(db, {
      query: "how are transition state jobs validated",
      maxResults: 6,
    });
    const baseline = searchSymbols(db, {
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

test("test-oriented workflow queries do not downweight likely test candidates", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareWorkflowSearchFixture(db);

    const current = searchSymbols(db, {
      query: "transition state validation tests",
      maxResults: 6,
    });
    const baseline = searchSymbols(db, {
      query: "transition state validation tests",
      maxResults: 6,
      enableTestAwareDownweighting: false,
    });

    assert.deepEqual(current, baseline);
    assert.equal(current[0]?.filePath, "src/workflows/transition_state_validation_test.ts");
    assert.equal(
      current.some((result) => {
        return result.matches.some((match) => match.field === SymbolSearchMatchField.LikelyTestPenalty);
      }),
      false,
    );
  } finally {
    db.close();
  }
});

test("exact identifier lookups remain stable when nearby likely test candidates exist", () => {
  const db = openIndexerDatabase();

  try {
    seedTestAwareWorkflowSearchFixture(db);

    const results = searchSymbols(db, {
      query: "generateArkaneInput",
      maxResults: 6,
    });

    assert.equal(results[0]?.localName, "generateArkaneInput");
    assert.equal(results[0]?.filePath, "src/statmech/arkane.ts");
    assert.equal(results[0]?.matches[0]?.field, SymbolSearchMatchField.LocalName);
    assert.equal(results[0]?.matches[0]?.matchType, SymbolSearchMatchType.Exact);
  } finally {
    db.close();
  }
});

test("technical serialization variants surface dictionary conversion helpers above adjacent species predicates", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    const current = searchSymbols(db, {
      query: "species_to_dict",
      maxResults: 6,
    });
    const baseline = searchSymbols(db, {
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

test("technical boundary queries surface Cython parser and utility candidates deterministically", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    for (const query of ["fast parser", "low level utility"]) {
      const current = searchSymbols(db, {
        query,
        maxResults: 6,
      });
      const second = searchSymbols(db, {
        query,
        maxResults: 6,
      });
      const baseline = searchSymbols(db, {
        query,
        maxResults: 6,
        enableBoundaryBoosts: false,
        enableTechnicalQueryBoosts: false,
      });

      assert.deepEqual(second, current);
      assert.equal(current.some((result) => result.filePath.endsWith(".pyx")), true);
      assert.equal(
        current.some((result) => result.matches.some((match) => match.field === SymbolSearchMatchField.BoundaryHint)),
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

test("technical parser phrasing variants surface production parser code ahead of tests", () => {
  const db = openIndexerDatabase();

  try {
    seedNarrowQuerySearchFixture(db);

    const current = searchSymbols(db, {
      query: "where is the output parsed",
      maxResults: 6,
    });
    const baseline = searchSymbols(db, {
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
