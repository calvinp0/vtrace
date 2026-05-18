import type { HandoffPayload } from "../handoff/types";
import type { HandoffSchemaVersion } from "../handoff/metadata";
import {
  DEFAULT_PROTOCOL_ADAPTER_METADATA,
  type ProtocolAdapterSchemaVersion,
  type ProtocolName,
} from "./metadata";
import type {
  ProtocolAdaptedPayload,
  ProtocolAdapter,
  ProtocolAdapterInput,
} from "./types";

export interface GenericJsonEnvelopePayload {
  readonly protocol: ProtocolName;
  readonly adapterSchemaVersion: ProtocolAdapterSchemaVersion;
  readonly handoffSchemaVersion: HandoffSchemaVersion;
  readonly body: HandoffPayload;
}

export const genericJsonEnvelopeProtocolAdapter =
  createGenericJsonEnvelopeProtocolAdapter();

export function createGenericJsonEnvelopeProtocolAdapter():
  ProtocolAdapter<GenericJsonEnvelopePayload> {
  const metadata = DEFAULT_PROTOCOL_ADAPTER_METADATA;

  return {
    metadata,
    adapt(input: ProtocolAdapterInput): ProtocolAdaptedPayload<GenericJsonEnvelopePayload> {
      return {
        adapter: {
          ...structuredClone(metadata),
          selection: structuredClone(input.selection.explanation),
        },
        payload: {
          protocol: metadata.protocol,
          adapterSchemaVersion: metadata.adapterSchema.version,
          handoffSchemaVersion: metadata.coreHandoffSchemaVersion,
          body: structuredClone(input.handoff),
        },
      };
    },
  };
}
