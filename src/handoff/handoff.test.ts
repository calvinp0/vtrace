import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsule, createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import {
  CapsuleBudgetModel,
  CapsuleContentMode,
  type CapsuleInclusionReason,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type CapsuleSupportingCandidate,
  type Capsule,
} from "../capsule/types";
import { prepareCapsuleAssembly } from "../capsuleProfiles/orchestrator";
import { selectCapsuleProfile } from "../capsuleProfiles/selectProfile";
import { type CapsuleProfileSelectionResult } from "../capsuleProfiles/types";
import {
  getCapsuleStaleness,
  persistCapsuleManifest,
} from "../db/repositories/capsuleManifestsRepository";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import { indexProject } from "../indexer/indexProject";
import { getIntentRoutingProfile } from "../intent/profile";
import type { RoutedQueryResult } from "../intent/routeQuery";
import { routeQuery } from "../intent/routeQuery";
import {
  IntentClassificationReasonKind,
  QueryIntent,
  type IntentClassificationResult,
} from "../intent/types";
import {
  StaleStateStatus,
  type CapsuleStalenessResult,
} from "../memory/types";
import { SymbolSearchMatchField } from "../retrieval/types";
import {
  buildHandoffPayload,
  createHandoffOrchestrator,
  DEFAULT_HANDOFF_BUILDER_DELEGATION,
  deterministicHandoffBuilder,
  HandoffBuilderDelegateTarget,
  prepareHandoffBuild,
} from "./buildHandoff";
import {
  DEFAULT_HANDOFF_GENERATION_CONTEXT,
  HANDOFF_SCHEMA,
  HANDOFF_SCHEMA_NAME,
  HANDOFF_SCHEMA_VERSION,
  HandoffBuilderKind,
  HandoffPayloadSourceKind,
  resolveHandoffMetadata,
} from "./metadata";
import type { IntentAwareCapsulePipelineResult } from "./types";
import {
  applyMixedPyCythonControlledChange,
  withMixedPyCythonRepo,
} from "../testing/mixedPyCythonFixture";

test("handoff schema metadata is explicit and centralized", () => {
  assert.equal(HANDOFF_SCHEMA_NAME, "vtrace.external_handoff");
  assert.equal(HANDOFF_SCHEMA_VERSION, "1.0.0");
  assert.deepEqual(HANDOFF_SCHEMA, {
    name: "vtrace.external_handoff",
    version: "1.0.0",
  });
  assert.deepEqual(DEFAULT_HANDOFF_GENERATION_CONTEXT, {
    sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
    builderKind: HandoffBuilderKind.DeterministicPackager,
    generatedAtMs: null,
  });
});

test("provenance defaults remain explicit and deterministic when optional metadata is missing", () => {
  const pipeline = makePipelineResult();
  const prepared = prepareHandoffBuild({
    pipeline,
  });

  assert.deepEqual(prepared.delegate, DEFAULT_HANDOFF_BUILDER_DELEGATION);
  assert.equal(prepared.delegate.target, HandoffBuilderDelegateTarget.DeterministicPackager);
  assert.deepEqual(prepared.builderInput.metadata, resolveHandoffMetadata());
  assert.deepEqual(prepared.builderInput.metadata.provenance, {
    repoRoot: null,
    repoId: null,
    sourceRunId: null,
    manifestId: null,
    payloadSchemaVersion: HANDOFF_SCHEMA_VERSION,
    generation: {
      sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
      builderKind: HandoffBuilderKind.DeterministicPackager,
      generatedAtMs: null,
    },
  });
  assert.deepEqual(prepared.builderInput.metadata.trust, {
    capsuleStaleness: null,
  });
});

test("builder represents missing optional handoff metadata explicitly", () => {
  const payload = buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline: makePipelineResult("explain optional metadata", {
      includeProfileBudgetUsage: false,
    }),
  });

  assert.deepEqual(payload.provenance, {
    repoRoot: null,
    repoId: null,
    sourceRunId: null,
    manifestId: null,
    payloadSchemaVersion: HANDOFF_SCHEMA_VERSION,
    generation: {
      sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
      builderKind: HandoffBuilderKind.DeterministicPackager,
      generatedAtMs: null,
    },
  });
  assert.deepEqual(payload.trust, {
    capsuleStaleness: null,
  });
  assert.equal(payload.capsule.profileBudgetUsage, null);
});

test("deterministic handoff builder packages the existing pipeline result into an explicit payload", () => {
  const pipeline = makePipelineResult();
  const staleness = makeCapsuleStalenessResult(pipeline.capsule.query);
  const payload = buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline,
    metadata: {
      repoRoot: "/repo/demo",
      repoId: "demo-repo",
      sourceRunId: 7,
      manifestId: "capsule-001",
      generatedAtMs: 1_710_000_000_000,
      capsuleStaleness: staleness,
    },
  });

  assert.deepEqual(payload, {
    schema: HANDOFF_SCHEMA,
    query: pipeline.routedQuery.query,
    selectedIntent: QueryIntent.Explain,
    classification: pipeline.routedQuery.classification,
    routingProfile: {
      id: pipeline.routedQuery.profile.id,
      backend: pipeline.routedQuery.profile.backend,
      candidatePoolSize: pipeline.routedQuery.profile.candidatePoolSize,
      graphWeights: pipeline.routedQuery.profile.graphWeights,
      summary: pipeline.routedQuery.profile.summary,
    },
    capsuleProfile: {
      id: pipeline.capsuleProfileSelection.profile.id,
      targetIntent: pipeline.capsuleProfileSelection.profile.targetIntent,
      description: pipeline.capsuleProfileSelection.profile.description,
      settingsSummary: pipeline.capsuleProfileSelection.settingsSummary,
      explanation: pipeline.capsuleProfileSelection.explanation,
    },
    capsule: {
      query: pipeline.capsule.query,
      items: [...pipeline.capsule.pivots, ...pipeline.capsule.supportingItems],
      budget: pipeline.capsule.budget,
      profileBudgetUsage: pipeline.capsule.profileBudgetUsage,
      truncated: pipeline.capsule.truncated,
      compressed: pipeline.capsule.compressed,
    },
    provenance: {
      repoRoot: "/repo/demo",
      repoId: "demo-repo",
      sourceRunId: 7,
      manifestId: "capsule-001",
      payloadSchemaVersion: HANDOFF_SCHEMA_VERSION,
      generation: {
        sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
        builderKind: HandoffBuilderKind.DeterministicPackager,
        generatedAtMs: 1_710_000_000_000,
      },
    },
    trust: {
      capsuleStaleness: staleness,
    },
  });
});

test("repeated identical input produces identical handoff payload output", () => {
  const input = {
    pipeline: makePipelineResult("explain session flow"),
    metadata: {
      repoRoot: "/repo/demo",
      repoId: "demo-repo",
      sourceRunId: 7,
      manifestId: "capsule-001",
      generatedAtMs: 1_710_000_000_000,
      capsuleStaleness: makeCapsuleStalenessResult("explain session flow"),
    },
  };

  const first = buildHandoffPayload(deterministicHandoffBuilder, input);
  const second = buildHandoffPayload(deterministicHandoffBuilder, input);

  assert.deepEqual(second, first);
});

test("capsule item ordering is preserved deterministically in the handoff payload", () => {
  const payload = buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline: makePipelineResult("explain ordering", {
      pivotNames: ["SessionService", "SessionController"],
      supportNames: ["SessionStore", "SessionView"],
    }),
  });

  assert.deepEqual(
    payload.capsule.items.map((item) => ({
      localName: item.localName,
      role: item.role,
    })),
    [
      { localName: "SessionService", role: CapsuleItemRole.Pivot },
      { localName: "SessionController", role: CapsuleItemRole.Pivot },
      { localName: "SessionStore", role: CapsuleItemRole.Support },
      { localName: "SessionView", role: CapsuleItemRole.Support },
    ],
  );
});

test("built payload remains stable if the source pipeline result is later mutated", () => {
  const pipeline = makePipelineResult("explain builder isolation");
  const staleness = makeCapsuleStalenessResult("explain builder isolation");
  const payload = buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline,
    metadata: {
      capsuleStaleness: staleness,
    },
  });

  pipeline.routedQuery.classification.explanation.summary = "mutated classification";
  pipeline.capsule.pivots[0]!.localName = "MutatedPivot";
  pipeline.capsule.supportingItems[0]!.content = {
    mode: CapsuleContentMode.Stub,
    stub: "mutated stub",
  };
  staleness.items[0]!.status = StaleStateStatus.Stale;

  assert.equal(
    payload.classification.explanation.summary,
    "Selected intent explain from matched rule evidence.",
  );
  assert.equal(payload.capsule.items[0]!.localName, "SessionService");
  assert.deepEqual(payload.capsule.items[1]!.content, {
    mode: CapsuleContentMode.Summary,
    summary: "Stores session state for explainability tests.",
    signature: "class SessionStore",
  });
  assert.equal(payload.trust.capsuleStaleness?.items[0]!.status, StaleStateStatus.Fresh);
});

test("handoff orchestration remains a thin contract over the existing pipeline result", () => {
  const pipeline = makePipelineResult("explain routing flow");
  const orchestrator = createHandoffOrchestrator();
  const prepared = orchestrator.prepare({
    pipeline,
    metadata: {
      repoRoot: "/repo/demo",
    },
  });

  assert.deepEqual(prepared, prepareHandoffBuild({
    pipeline,
    metadata: {
      repoRoot: "/repo/demo",
    },
  }));
  assert.equal(prepared.builderInput.pipeline, pipeline);
  assert.equal(prepared.delegate.target, HandoffBuilderDelegateTarget.DeterministicPackager);
});

test("handoff payload is JSON-safe for later cli and file export integration", () => {
  const payload = buildHandoffPayload(deterministicHandoffBuilder, {
    pipeline: makePipelineResult("explain storage flow"),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("mixed Python/Cython handoff payload stays deterministic and carries real trust metadata", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const sourceRunId = getLatestIndexRun(db)!.id;
      const pipeline = buildMixedFixturePipeline(db, repoRoot, "background");
      const manifest = persistCapsuleManifest(db, {
        sourceRunId,
        capsule: pipeline.capsule,
        createdAtMs: 1,
      });

      await applyMixedPyCythonControlledChange(repoRoot);
      await indexProject({ repoRoot, db });

      const staleness = getCapsuleStaleness(db, manifest.id, getLatestIndexRun(db)!.id);
      const input = {
        pipeline,
        metadata: {
          repoRoot,
          sourceRunId,
          manifestId: manifest.id,
          capsuleStaleness: staleness,
        },
      };
      const first = buildHandoffPayload(deterministicHandoffBuilder, input);
      const second = buildHandoffPayload(deterministicHandoffBuilder, input);

      assert.deepEqual(second, first);
      assert.equal(first.query, "background");
      assert.equal(first.provenance.repoRoot, repoRoot);
      assert.equal(first.provenance.sourceRunId, sourceRunId);
      assert.equal(first.provenance.manifestId, manifest.id);
      assert.equal(first.trust.capsuleStaleness?.status, StaleStateStatus.Stale);
      assert.deepEqual(
        first.capsule.items.map((item) => [item.localName, item.filePath]),
        [
          ["estimate_background", "src/spectra_lab/analysis/background.py"],
          ["run_calibrated_diffusion", "src/spectra_lab/pipeline.py"],
        ],
      );
      assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
    } finally {
      db.close();
    }
  });
});

interface PipelineFixtureOptions {
  includeProfileBudgetUsage?: boolean;
  pivotNames?: readonly string[];
  supportNames?: readonly string[];
}

function makePipelineResult(
  query = "explain indexing flow",
  options: PipelineFixtureOptions = {},
): IntentAwareCapsulePipelineResult {
  const classification = makeClassification(QueryIntent.Explain, query);
  const routedQuery: RoutedQueryResult = {
    query,
    intent: classification.intent,
    classification,
    profile: getIntentRoutingProfile(classification.intent),
    rerankedResults: [],
  };
  const capsuleProfileSelection = selectCapsuleProfile({
    classification,
  });
  const capsule = makeCapsule(query, capsuleProfileSelection, options);

  return {
    routedQuery,
    capsuleProfileSelection,
    capsule,
  };
}

function makeClassification(
  intent: QueryIntent,
  query: string,
): IntentClassificationResult {
  return {
    query,
    intent,
    strength: 3,
    candidates: [
      {
        intent,
        strength: 3,
        matchedRuleIds: [`${intent}-rule`],
      },
    ],
    explanation: {
      reasonKind: IntentClassificationReasonKind.RuleMatch,
      fallbackApplied: false,
      summary: `Selected intent ${intent} from matched rule evidence.`,
      matchedRules: [
        {
          ruleId: `${intent}-rule`,
          targetIntent: intent,
          priority: 1,
          strength: 3,
          explanation: `${intent} rule matched.`,
          matchedTerms: [intent],
        },
      ],
    },
  };
}

function makeCapsule(
  query: string,
  profileSelection: CapsuleProfileSelectionResult,
  options: PipelineFixtureOptions = {},
): Capsule {
  const pivotNames = options.pivotNames ?? ["SessionService"];
  const supportNames = options.supportNames ?? ["SessionStore"];

  return {
    query,
    pivots: pivotNames.map((name, index) => makePivotItem(name, index)),
    supportingItems: supportNames.map((name, index) => makeSupportItem(name, index)),
    budget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters: 2_000,
      usedCharacters: 120 * pivotNames.length + 60 * supportNames.length,
      remainingCharacters: 2_000 - (120 * pivotNames.length + 60 * supportNames.length),
    },
    truncated: false,
    compressed: true,
    profileSelection,
    ...(options.includeProfileBudgetUsage === false
      ? {}
      : {
          profileBudgetUsage: {
            pivotCharactersUsed: 120 * pivotNames.length,
            supportCharactersUsed: 60 * supportNames.length,
            pivotCharactersMax: 1_200,
            supportCharactersMax: 800,
          },
        }),
  };
}

function makeCapsuleStalenessResult(query: string): CapsuleStalenessResult {
  return {
    capsuleId: "capsule-001",
    sourceRunId: 7,
    comparisonRunId: 7,
    query,
    status: StaleStateStatus.Fresh,
    items: [
      {
        capsuleId: "capsule-001",
        itemOrdinal: 0,
        role: CapsuleItemRole.Pivot,
        contentMode: CapsuleContentMode.Full,
        sourceBacked: true,
        filePath: "src/session/service.ts",
        symbol: {
          filePath: "src/session/service.ts",
          fqName: "src/session/service.ts::SessionService",
          kind: SymbolKind.Class,
        },
        status: StaleStateStatus.Fresh,
        reasons: [],
      },
    ],
  };
}

function makePivotItem(name: string, index: number): Capsule["pivots"][number] {
  return {
    symbolId: `symbol:pivot:${index}`,
    filePath: `src/session/${toFileSlug(name)}.ts`,
    fqName: `src/session/${toFileSlug(name)}.ts::${name}`,
    localName: name,
    kind: SymbolKind.Class,
    role: CapsuleItemRole.Pivot,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.LexicalMatch,
        matchedFields: [SymbolSearchMatchField.LocalName],
      },
    ],
    content: {
      mode: CapsuleContentMode.Full,
      source: `class ${name} {}`,
    },
    budgetCost: 120,
    compressed: false,
    sourceBacked: true,
    lexicalScore: 8 - index,
    graphScore: 3,
    finalScore: 11 - index,
  };
}

function makeSupportItem(name: string, index: number): Capsule["supportingItems"][number] {
  return {
    symbolId: `symbol:support:${index}`,
    filePath: `src/session/${toFileSlug(name)}.ts`,
    fqName: `src/session/${toFileSlug(name)}.ts::${name}`,
    localName: name,
    kind: SymbolKind.Class,
    role: CapsuleItemRole.Support,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.LexicalMatch,
        matchedFields: [SymbolSearchMatchField.FQName],
      },
    ],
    content: {
      mode: CapsuleContentMode.Summary,
      summary: "Stores session state for explainability tests.",
      signature: `class ${name}`,
    },
    budgetCost: 60,
    compressed: true,
    lexicalScore: 5 - index,
    graphScore: 2,
    finalScore: 7 - index,
  };
}

function toFileSlug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function buildMixedFixturePipeline(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  query: string,
): IntentAwareCapsulePipelineResult {
  const routedQuery = routeQuery(db, query, { maxResults: 6 });
  const preparedAssembly = prepareCapsuleAssembly({
    classification: routedQuery.classification,
    builderInput: {
      query,
      rerankedCandidates: routedQuery.rerankedResults,
      supportingCandidates: routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
      maxBudget: createCharacterBudget(5_000),
    },
  });
  const capsule = buildCapsule(
    createSourceBackedCapsuleBuilder({ db, repoRoot }),
    preparedAssembly.builderInput,
  );

  return {
    routedQuery,
    capsuleProfileSelection: preparedAssembly.selection,
    capsule,
  };
}

function makeSupportingCandidateFromGraphResult(
  result: IntentAwareCapsulePipelineResult["routedQuery"]["rerankedResults"][number],
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildInclusionReasonsFromGraphResult(result),
  };
}

function buildInclusionReasonsFromGraphResult(
  result: IntentAwareCapsulePipelineResult["routedQuery"]["rerankedResults"][number],
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(result.graphContributions.map((contribution) => contribution.signal));
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
