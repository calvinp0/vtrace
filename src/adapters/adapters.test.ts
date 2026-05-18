import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptHandoffPayload,
  createProtocolPayloadOrchestrator,
  DEFAULT_PROTOCOL_ADAPTER_DELEGATION,
  defaultProtocolAdapterRegistry,
  preparePayloadAdaptation,
  ProtocolAdapterDelegateTarget,
} from "./adaptPayload";
import {
  genericJsonEnvelopeProtocolAdapter,
  type GenericJsonEnvelopePayload,
} from "./genericJsonEnvelopeAdapter";
import {
  DEFAULT_PROTOCOL_ADAPTER_ID,
  DEFAULT_PROTOCOL_ADAPTER_METADATA,
  DEFAULT_PROTOCOL_ADAPTER_SELECTION_POLICY,
  PROTOCOL_ADAPTER_SCHEMA,
  PROTOCOL_ADAPTER_SCHEMA_NAME,
  PROTOCOL_ADAPTER_SCHEMA_VERSION,
  ProtocolAdapterId,
  ProtocolAdapterSelectionReasonKind,
  ProtocolName,
} from "./metadata";
import {
  createProtocolAdapterRegistry,
  PROTOCOL_ADAPTER_SELECTION_ORDER,
} from "./registry";
import type {
  ProtocolAdaptedPayload,
  ProtocolAdapter,
} from "./types";
import {
  HANDOFF_SCHEMA,
  HANDOFF_SCHEMA_VERSION,
  HandoffBuilderKind,
  HandoffPayloadSourceKind,
} from "../handoff/metadata";
import type { HandoffPayload } from "../handoff/types";
import {
  CapsuleBudgetModel,
  CapsuleContentMode,
  CapsuleItemRole,
} from "../capsule/types";
import {
  CapsuleBudgetAllocationPolicy,
  CapsulePivotSupportBalancePolicy,
  CapsuleProfileId,
  CapsuleProfileSelectionReasonKind,
  CapsuleSupportSelectionPolicyId,
} from "../capsuleProfiles/types";
import {
  IntentClassificationReasonKind,
  QueryIntent,
} from "../intent/types";
import { SymbolSearchBackend } from "../retrieval/types";
import { SymbolKind } from "../domain/types";

test("adapter vocabulary and default policy are explicit and stable", () => {
  assert.deepEqual(ProtocolAdapterId, {
    GenericJsonEnvelope: "generic_json_envelope",
  });
  assert.deepEqual(ProtocolName, {
    GenericJsonEnvelope: "generic_json_envelope",
  });
  assert.equal(DEFAULT_PROTOCOL_ADAPTER_ID, ProtocolAdapterId.GenericJsonEnvelope);
  assert.deepEqual(PROTOCOL_ADAPTER_SELECTION_ORDER, ["adapter_id", "protocol", "default"]);
  assert.deepEqual(DEFAULT_PROTOCOL_ADAPTER_SELECTION_POLICY, {
    defaultAdapterId: ProtocolAdapterId.GenericJsonEnvelope,
    selectionOrder: ["adapter_id", "protocol", "default"],
  });
});

test("adapter metadata schema fields are explicit and inspectable", () => {
  assert.equal(PROTOCOL_ADAPTER_SCHEMA_NAME, "vexb.protocol_adapter");
  assert.equal(PROTOCOL_ADAPTER_SCHEMA_VERSION, "1.0.0");
  assert.deepEqual(PROTOCOL_ADAPTER_SCHEMA, {
    name: "vexb.protocol_adapter",
    version: "1.0.0",
  });
  assert.deepEqual(DEFAULT_PROTOCOL_ADAPTER_METADATA, {
    adapterId: ProtocolAdapterId.GenericJsonEnvelope,
    protocol: ProtocolName.GenericJsonEnvelope,
    adapterSchema: PROTOCOL_ADAPTER_SCHEMA,
    coreHandoffSchemaVersion: HANDOFF_SCHEMA_VERSION,
    description:
      "Wraps the canonical Layer 6 handoff payload in a stable, protocol-neutral JSON envelope.",
  });
});

test("registry registration and lookup are deterministic", () => {
  const customAdapter = makeCustomAdapter({
    adapterId: "test_custom_adapter",
    protocol: "test_custom_protocol",
    description: "Custom adapter for registry tests.",
  });
  const registry = createProtocolAdapterRegistry({
    adapters: [genericJsonEnvelopeProtocolAdapter, customAdapter],
  });

  assert.equal(
    registry.getByAdapterId(ProtocolAdapterId.GenericJsonEnvelope),
    genericJsonEnvelopeProtocolAdapter,
  );
  assert.equal(registry.getByAdapterId("test_custom_adapter"), customAdapter);
  assert.equal(
    registry.getByProtocol(ProtocolName.GenericJsonEnvelope),
    genericJsonEnvelopeProtocolAdapter,
  );
  assert.equal(registry.getByProtocol("test_custom_protocol"), customAdapter);
  assert.deepEqual(
    registry.select({ protocol: "test_custom_protocol" }),
    registry.select({ protocol: "test_custom_protocol" }),
  );
});

test("fallback and default adapter selection behavior is deterministic", () => {
  assert.deepEqual(defaultProtocolAdapterRegistry.select(), {
    requestedAdapterId: null,
    requestedProtocol: null,
    metadata: DEFAULT_PROTOCOL_ADAPTER_METADATA,
    explanation: {
      reasonKind: ProtocolAdapterSelectionReasonKind.DefaultPolicy,
      fallbackApplied: false,
      summary: "No adapter selection was provided; defaulting to adapter generic_json_envelope.",
    },
  });
  assert.deepEqual(defaultProtocolAdapterRegistry.select({
    adapterId: "missing_adapter",
  }), {
    requestedAdapterId: "missing_adapter",
    requestedProtocol: null,
    metadata: DEFAULT_PROTOCOL_ADAPTER_METADATA,
    explanation: {
      reasonKind: ProtocolAdapterSelectionReasonKind.DefaultPolicy,
      fallbackApplied: true,
      summary:
        "Requested adapter missing_adapter was not registered; defaulting to adapter generic_json_envelope.",
    },
  });
  assert.deepEqual(defaultProtocolAdapterRegistry.select({
    protocol: "missing_protocol",
  }), {
    requestedAdapterId: null,
    requestedProtocol: "missing_protocol",
    metadata: DEFAULT_PROTOCOL_ADAPTER_METADATA,
    explanation: {
      reasonKind: ProtocolAdapterSelectionReasonKind.DefaultPolicy,
      fallbackApplied: true,
      summary:
        "No adapter was registered for protocol missing_protocol; defaulting to adapter generic_json_envelope.",
    },
  });
});

test("the generic_json_envelope adapter produces the expected adapted payload shape", () => {
  const handoff = makeHandoffPayload("explain indexing flow");
  const adapted = adaptHandoffPayload({
    handoff,
    adapterId: ProtocolAdapterId.GenericJsonEnvelope,
  }) as ProtocolAdaptedPayload<GenericJsonEnvelopePayload>;

  assert.deepEqual(adapted, {
    adapter: {
      ...DEFAULT_PROTOCOL_ADAPTER_METADATA,
      selection: {
        reasonKind: ProtocolAdapterSelectionReasonKind.ExplicitAdapterId,
        fallbackApplied: false,
        summary: "Selected adapter generic_json_envelope by explicit adapter id.",
      },
    },
    payload: {
      protocol: ProtocolName.GenericJsonEnvelope,
      adapterSchemaVersion: PROTOCOL_ADAPTER_SCHEMA_VERSION,
      handoffSchemaVersion: HANDOFF_SCHEMA_VERSION,
      body: handoff,
    },
  });
  assert.notEqual(adapted.payload.body, handoff);
  assert.notEqual(adapted.payload.body.capsule.items, handoff.capsule.items);
});

test("repeated identical input produces identical adapted output", () => {
  const handoff = makeHandoffPayload("explain identical input");
  const input = {
    handoff,
    adapterId: ProtocolAdapterId.GenericJsonEnvelope,
  } as const;
  const first = adaptHandoffPayload(input);
  const second = adaptHandoffPayload(input);

  assert.deepEqual(second, first);
});

test("the adapter contract supports later concrete adapters without redesign", () => {
  const customAdapter = makeCustomAdapter({
    adapterId: "future_protocol_adapter",
    protocol: "future_protocol",
    description: "Future concrete protocol adapter.",
  });
  const registry = createProtocolAdapterRegistry({
    adapters: [genericJsonEnvelopeProtocolAdapter, customAdapter],
    defaultAdapterId: "future_protocol_adapter",
  });
  const handoff = makeHandoffPayload("explain future adapter");
  const adapted = adaptHandoffPayload({
    handoff,
    protocol: "future_protocol",
  }, registry) as ProtocolAdaptedPayload<{
    kind: string;
    handoff: HandoffPayload;
  }>;

  assert.deepEqual(adapted, {
    adapter: {
      ...customAdapter.metadata,
      selection: {
        reasonKind: ProtocolAdapterSelectionReasonKind.ExplicitProtocol,
        fallbackApplied: false,
        summary: "Selected adapter future_protocol_adapter for protocol future_protocol.",
      },
    },
    payload: {
      kind: "future_protocol",
      handoff,
    },
  });
});

test("adapter metadata is explicit and stable in the adapted payload", () => {
  const adapted = adaptHandoffPayload({
    handoff: makeHandoffPayload("explain metadata"),
  });

  assert.deepEqual(adapted.adapter, {
    ...DEFAULT_PROTOCOL_ADAPTER_METADATA,
    selection: {
      reasonKind: ProtocolAdapterSelectionReasonKind.DefaultPolicy,
      fallbackApplied: false,
      summary: "No adapter selection was provided; defaulting to adapter generic_json_envelope.",
    },
  });
});

test("registry selection returns the generic_json_envelope adapter deterministically", () => {
  const selection = defaultProtocolAdapterRegistry.select({
    adapterId: ProtocolAdapterId.GenericJsonEnvelope,
  });

  assert.deepEqual(selection, {
    requestedAdapterId: ProtocolAdapterId.GenericJsonEnvelope,
    requestedProtocol: null,
    metadata: DEFAULT_PROTOCOL_ADAPTER_METADATA,
    explanation: {
      reasonKind: ProtocolAdapterSelectionReasonKind.ExplicitAdapterId,
      fallbackApplied: false,
      summary: "Selected adapter generic_json_envelope by explicit adapter id.",
    },
  });
  assert.equal(
    defaultProtocolAdapterRegistry.getByAdapterId(ProtocolAdapterId.GenericJsonEnvelope),
    genericJsonEnvelopeProtocolAdapter,
  );
});

test("adapting a handoff payload does not mutate the canonical core payload", () => {
  const handoff = makeHandoffPayload("explain mutation safety");
  const adapted = adaptHandoffPayload({
    handoff,
  }) as ProtocolAdaptedPayload<GenericJsonEnvelopePayload>;

  handoff.classification.explanation.summary = "mutated";
  handoff.capsule.items[0]!.localName = "MutatedItem";

  assert.equal(
    adapted.payload.body.classification.explanation.summary,
    "Selected intent explain from matched rule evidence.",
  );
  assert.equal(adapted.payload.body.capsule.items[0]!.localName, "SessionService");
});

test("payload adaptation orchestration is a thin contract over the core handoff payload", () => {
  const handoff = makeHandoffPayload("explain routing");
  const orchestrator = createProtocolPayloadOrchestrator();
  const prepared = orchestrator.prepare({
    handoff,
    protocol: ProtocolName.GenericJsonEnvelope,
  });

  assert.deepEqual(prepared, preparePayloadAdaptation({
    handoff,
    protocol: ProtocolName.GenericJsonEnvelope,
  }));
  assert.equal(prepared.adapterInput.handoff, handoff);
  assert.equal(
    prepared.adapterInput.selection.metadata.adapterId,
    ProtocolAdapterId.GenericJsonEnvelope,
  );
  assert.equal(prepared.delegate.target, ProtocolAdapterDelegateTarget.RegisteredProtocolAdapter);
  assert.deepEqual(prepared.delegate, DEFAULT_PROTOCOL_ADAPTER_DELEGATION);
});

function makeCustomAdapter(input: {
  adapterId: string;
  protocol: string;
  description: string;
}): ProtocolAdapter<{
  kind: string;
  handoff: HandoffPayload;
}> {
  const metadata = {
    adapterId: input.adapterId,
    protocol: input.protocol,
    adapterSchema: PROTOCOL_ADAPTER_SCHEMA,
    coreHandoffSchemaVersion: HANDOFF_SCHEMA_VERSION,
    description: input.description,
  } satisfies ProtocolAdapter["metadata"];

  return {
    metadata,
    adapt(adapterInput) {
      return {
        adapter: {
          ...structuredClone(metadata),
          selection: structuredClone(adapterInput.selection.explanation),
        },
        payload: {
          kind: input.protocol,
          handoff: structuredClone(adapterInput.handoff),
        },
      };
    },
  };
}

function makeHandoffPayload(query: string): HandoffPayload {
  return {
    schema: HANDOFF_SCHEMA,
    query,
    selectedIntent: QueryIntent.Explain,
    classification: {
      query,
      intent: QueryIntent.Explain,
      strength: 3,
      candidates: [
        {
          intent: QueryIntent.Explain,
          strength: 3,
          matchedRuleIds: ["explain-rule"],
        },
      ],
      explanation: {
        reasonKind: IntentClassificationReasonKind.RuleMatch,
        fallbackApplied: false,
        summary: "Selected intent explain from matched rule evidence.",
        matchedRules: [
          {
            ruleId: "explain-rule",
            targetIntent: QueryIntent.Explain,
            priority: 1,
            strength: 3,
            explanation: "explain rule matched.",
            matchedTerms: ["explain"],
          },
        ],
      },
    },
    routingProfile: {
      id: QueryIntent.Explain,
      backend: SymbolSearchBackend.Fts,
      candidatePoolSize: 10,
      graphWeights: {
        inDegreePerEdge: 2,
        inDegreeMax: 8,
        outDegreePerEdge: 1,
        outDegreeMax: 4,
        containsNeighbor: 8,
        containsNeighborMax: 16,
        importsNeighbor: 6,
        importsNeighborMax: 12,
        connectedMatchedCandidate: 3,
        connectedMatchedCandidateMax: 6,
      },
      summary: "Balanced routing profile.",
    },
    capsuleProfile: {
      id: CapsuleProfileId.ExplainStable,
      targetIntent: QueryIntent.Explain,
      description: "Conservative explanatory capsule profile.",
      settingsSummary: {
        maxPivotCount: 2,
        maxSupportCount: 3,
        pivotSupportBalancePolicy: CapsulePivotSupportBalancePolicy.Balanced,
        supportSelectionPolicy: CapsuleSupportSelectionPolicyId.LowNoiseStable,
        preferredPivotContentModes: [CapsuleContentMode.Full, CapsuleContentMode.Summary],
        preferredSupportContentModes: [
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
        pivotFallbackLadder: [
          CapsuleContentMode.Full,
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
        supportFallbackLadder: [
          CapsuleContentMode.Summary,
          CapsuleContentMode.SignatureOnly,
          CapsuleContentMode.Stub,
        ],
        budgetAllocationPolicy: CapsuleBudgetAllocationPolicy.BalancedSplit,
        budgetSplit: {
          pivotFraction: 0.6,
          supportFraction: 0.4,
        },
      },
      explanation: {
        reasonKind: CapsuleProfileSelectionReasonKind.IntentProfileMatch,
        fallbackApplied: false,
        summary: "Selected capsule profile explain_stable for intent explain.",
      },
    },
    capsule: {
      query,
      items: [
        {
          symbolId: "symbol:pivot:0",
          filePath: "src/session/service.ts",
          fqName: "src/session/service.ts::SessionService",
          localName: "SessionService",
          kind: SymbolKind.Class,
          role: CapsuleItemRole.Pivot,
          inclusionReasons: [],
          content: {
            mode: CapsuleContentMode.Full,
            source: "class SessionService {}",
          },
          budgetCost: 120,
          compressed: false,
          sourceBacked: true,
          lexicalScore: 8,
          graphScore: 3,
          finalScore: 11,
        },
        {
          symbolId: "symbol:support:0",
          filePath: "src/session/store.ts",
          fqName: "src/session/store.ts::SessionStore",
          localName: "SessionStore",
          kind: SymbolKind.Class,
          role: CapsuleItemRole.Support,
          inclusionReasons: [],
          content: {
            mode: CapsuleContentMode.Summary,
            summary: "Stores session state for explainability tests.",
            signature: "class SessionStore",
          },
          budgetCost: 60,
          compressed: true,
          lexicalScore: 5,
          graphScore: 2,
          finalScore: 7,
        },
      ],
      budget: {
        model: CapsuleBudgetModel.CharacterCount,
        maxCharacters: 2_000,
        usedCharacters: 180,
        remainingCharacters: 1_820,
      },
      profileBudgetUsage: {
        pivotCharactersUsed: 120,
        supportCharactersUsed: 60,
        pivotCharactersMax: 1_200,
        supportCharactersMax: 800,
      },
      truncated: false,
      compressed: true,
    },
    provenance: {
      repoRoot: "/repo/demo",
      repoId: null,
      sourceRunId: 7,
      manifestId: null,
      payloadSchemaVersion: HANDOFF_SCHEMA.version,
      generation: {
        sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
        builderKind: HandoffBuilderKind.DeterministicPackager,
        generatedAtMs: null,
      },
    },
    trust: {
      capsuleStaleness: null,
    },
  };
}
