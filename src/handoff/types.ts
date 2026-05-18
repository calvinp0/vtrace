import type { Capsule, CapsuleItem } from "../capsule/types";
import type { CapsuleProfileSelectionResult } from "../capsuleProfiles/types";
import type { RoutedQueryResult } from "../intent/routeQuery";
import type {
  HandoffProvenance,
  HandoffSchemaDescriptor,
  HandoffTrustMetadata,
} from "./metadata";

export interface IntentAwareCapsulePipelineResult {
  readonly routedQuery: RoutedQueryResult;
  readonly capsuleProfileSelection: CapsuleProfileSelectionResult;
  readonly capsule: Capsule;
}

export interface HandoffRoutingProfilePayload {
  readonly id: RoutedQueryResult["profile"]["id"];
  readonly backend: RoutedQueryResult["profile"]["backend"];
  readonly candidatePoolSize: RoutedQueryResult["profile"]["candidatePoolSize"];
  readonly graphWeights: RoutedQueryResult["profile"]["graphWeights"];
  readonly summary: RoutedQueryResult["profile"]["summary"];
}

export interface HandoffCapsuleProfilePayload {
  readonly id: CapsuleProfileSelectionResult["profile"]["id"];
  readonly targetIntent: CapsuleProfileSelectionResult["profile"]["targetIntent"];
  readonly description: CapsuleProfileSelectionResult["profile"]["description"];
  readonly settingsSummary: CapsuleProfileSelectionResult["settingsSummary"];
  readonly explanation: CapsuleProfileSelectionResult["explanation"];
}

export interface HandoffCapsulePayload {
  readonly query: Capsule["query"];
  readonly items: readonly CapsuleItem[];
  readonly memories?: Capsule["memories"];
  readonly budget: Capsule["budget"];
  readonly profileBudgetUsage: NonNullable<Capsule["profileBudgetUsage"]> | null;
  readonly truncated: Capsule["truncated"];
  readonly compressed: Capsule["compressed"];
}

export interface HandoffPayload {
  readonly schema: HandoffSchemaDescriptor;
  readonly query: RoutedQueryResult["query"];
  readonly selectedIntent: RoutedQueryResult["intent"];
  readonly classification: RoutedQueryResult["classification"];
  readonly routingProfile: HandoffRoutingProfilePayload;
  readonly capsuleProfile: HandoffCapsuleProfilePayload;
  readonly capsule: HandoffCapsulePayload;
  readonly provenance: HandoffProvenance;
  readonly trust: HandoffTrustMetadata;
}
