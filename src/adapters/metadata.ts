// @ts-nocheck
import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffSchemaVersion,
} from "../handoff/metadata";

export const PROTOCOL_ADAPTER_SCHEMA_NAME = "vtrace.protocol_adapter" as const;
export const PROTOCOL_ADAPTER_SCHEMA_VERSION = "1.0.0" as const;

export type ProtocolAdapterSchemaName = typeof PROTOCOL_ADAPTER_SCHEMA_NAME;
export type ProtocolAdapterSchemaVersion = typeof PROTOCOL_ADAPTER_SCHEMA_VERSION;

export const ProtocolAdapterId = Object.freeze({
  GenericJsonEnvelope: "generic_json_envelope",
});

export type ProtocolAdapterId =
  | (typeof ProtocolAdapterId)[keyof typeof ProtocolAdapterId]
  | (string & {});

export const ProtocolName = Object.freeze({
  GenericJsonEnvelope: "generic_json_envelope",
});

export type ProtocolName =
  | (typeof ProtocolName)[keyof typeof ProtocolName]
  | (string & {});

export interface ProtocolAdapterSchemaDescriptor {
  readonly name: ProtocolAdapterSchemaName;
  readonly version: ProtocolAdapterSchemaVersion;
}

export interface ProtocolAdapterMetadata {
  readonly adapterId: ProtocolAdapterId;
  readonly protocol: ProtocolName;
  readonly adapterSchema: ProtocolAdapterSchemaDescriptor;
  readonly coreHandoffSchemaVersion: HandoffSchemaVersion;
  readonly description: string | null;
}

export const ProtocolAdapterSelectionReasonKind = Object.freeze({
  ExplicitAdapterId: "explicit_adapter_id",
  ExplicitProtocol: "explicit_protocol",
  DefaultPolicy: "default_policy",
});

export type ProtocolAdapterSelectionReasonKind =
  (typeof ProtocolAdapterSelectionReasonKind)[keyof typeof ProtocolAdapterSelectionReasonKind];

export interface ProtocolAdapterSelectionExplanation {
  readonly reasonKind: ProtocolAdapterSelectionReasonKind;
  readonly fallbackApplied: boolean;
  readonly summary: string;
}

export interface ProtocolAdapterSelectionResult {
  readonly requestedAdapterId: ProtocolAdapterId | null;
  readonly requestedProtocol: ProtocolName | null;
  readonly metadata: ProtocolAdapterMetadata;
  readonly explanation: ProtocolAdapterSelectionExplanation;
}

export interface ProtocolAdaptationMetadata extends ProtocolAdapterMetadata {
  readonly selection: ProtocolAdapterSelectionExplanation;
}

export interface ProtocolAdapterSelectionPolicy {
  readonly defaultAdapterId: ProtocolAdapterId;
  readonly selectionOrder: readonly ["adapter_id", "protocol", "default"];
}

export const PROTOCOL_ADAPTER_SCHEMA = Object.freeze({
  name: PROTOCOL_ADAPTER_SCHEMA_NAME,
  version: PROTOCOL_ADAPTER_SCHEMA_VERSION,
}) satisfies ProtocolAdapterSchemaDescriptor;

export const DEFAULT_PROTOCOL_ADAPTER_ID = ProtocolAdapterId.GenericJsonEnvelope;
export const DEFAULT_PROTOCOL_NAME = ProtocolName.GenericJsonEnvelope;

export const DEFAULT_PROTOCOL_ADAPTER_SELECTION_POLICY = Object.freeze({
  defaultAdapterId: DEFAULT_PROTOCOL_ADAPTER_ID,
  selectionOrder: Object.freeze(["adapter_id", "protocol", "default"]),
}) satisfies ProtocolAdapterSelectionPolicy;

export const DEFAULT_PROTOCOL_ADAPTER_METADATA = Object.freeze({
  adapterId: DEFAULT_PROTOCOL_ADAPTER_ID,
  protocol: DEFAULT_PROTOCOL_NAME,
  adapterSchema: PROTOCOL_ADAPTER_SCHEMA,
  coreHandoffSchemaVersion: HANDOFF_SCHEMA_VERSION,
  description:
    "Wraps the canonical Layer 6 handoff payload in a stable, protocol-neutral JSON envelope.",
}) satisfies ProtocolAdapterMetadata;
