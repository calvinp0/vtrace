import type { CapsuleStalenessResult } from "../memory/types";

export const HANDOFF_SCHEMA_NAME = "vtrace.external_handoff" as const;
export const HANDOFF_SCHEMA_VERSION = "1.0.0" as const;

export type HandoffSchemaName = typeof HANDOFF_SCHEMA_NAME;
export type HandoffSchemaVersion = typeof HANDOFF_SCHEMA_VERSION;

export enum HandoffPayloadSourceKind {
  IntentAwareCapsulePipeline = "intent_aware_capsule_pipeline",
}

export enum HandoffBuilderKind {
  DeterministicPackager = "deterministic_packager",
}

export interface HandoffSchemaDescriptor {
  readonly name: HandoffSchemaName;
  readonly version: HandoffSchemaVersion;
}

export interface HandoffGenerationContext {
  readonly sourceKind: HandoffPayloadSourceKind;
  readonly builderKind: HandoffBuilderKind;
  readonly generatedAtMs: number | null;
}

export interface HandoffProvenance {
  readonly repoRoot: string | null;
  readonly repoId: string | null;
  readonly sourceRunId: number | null;
  readonly manifestId: string | null;
  readonly payloadSchemaVersion: HandoffSchemaVersion;
  readonly generation: HandoffGenerationContext;
}

export interface HandoffTrustMetadata {
  readonly capsuleStaleness: CapsuleStalenessResult | null;
}

export interface HandoffMetadataInput {
  readonly repoRoot?: string | null;
  readonly repoId?: string | null;
  readonly sourceRunId?: number | null;
  readonly manifestId?: string | null;
  readonly generatedAtMs?: number | null;
  readonly capsuleStaleness?: CapsuleStalenessResult | null;
}

export interface ResolvedHandoffMetadata {
  readonly schema: HandoffSchemaDescriptor;
  readonly provenance: HandoffProvenance;
  readonly trust: HandoffTrustMetadata;
}

export const HANDOFF_SCHEMA = Object.freeze({
  name: HANDOFF_SCHEMA_NAME,
  version: HANDOFF_SCHEMA_VERSION,
}) satisfies HandoffSchemaDescriptor;

export const DEFAULT_HANDOFF_GENERATION_CONTEXT = Object.freeze({
  sourceKind: HandoffPayloadSourceKind.IntentAwareCapsulePipeline,
  builderKind: HandoffBuilderKind.DeterministicPackager,
  generatedAtMs: null,
}) satisfies HandoffGenerationContext;

export function resolveHandoffMetadata(
  input: HandoffMetadataInput = {},
): ResolvedHandoffMetadata {
  const generation: HandoffGenerationContext = {
    ...DEFAULT_HANDOFF_GENERATION_CONTEXT,
    generatedAtMs: input.generatedAtMs ?? null,
  };

  return {
    schema: HANDOFF_SCHEMA,
    provenance: {
      repoRoot: input.repoRoot ?? null,
      repoId: input.repoId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      manifestId: input.manifestId ?? null,
      payloadSchemaVersion: HANDOFF_SCHEMA.version,
      generation,
    },
    trust: {
      capsuleStaleness: input.capsuleStaleness ?? null,
    },
  };
}
