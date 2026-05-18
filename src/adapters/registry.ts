import {
  DEFAULT_PROTOCOL_ADAPTER_ID,
  DEFAULT_PROTOCOL_ADAPTER_SELECTION_POLICY,
  ProtocolAdapterSelectionReasonKind,
  type ProtocolAdapterId,
  type ProtocolAdapterMetadata,
  type ProtocolAdapterSelectionExplanation,
  type ProtocolAdapterSelectionResult,
  type ProtocolName,
} from "./metadata";
import type { ProtocolAdapter } from "./types";

export interface SelectProtocolAdapterInput {
  readonly adapterId?: ProtocolAdapterId | null;
  readonly protocol?: ProtocolName | null;
}

export interface CreateProtocolAdapterRegistryInput {
  readonly adapters: readonly ProtocolAdapter[];
  readonly defaultAdapterId?: ProtocolAdapterId;
}

export interface ProtocolAdapterRegistry {
  readonly adapters: readonly ProtocolAdapter[];
  readonly defaultAdapterId: ProtocolAdapterId;
  getByAdapterId(adapterId: ProtocolAdapterId): ProtocolAdapter | undefined;
  getByProtocol(protocol: ProtocolName): ProtocolAdapter | undefined;
  select(input?: SelectProtocolAdapterInput): ProtocolAdapterSelectionResult;
}

export function createProtocolAdapterRegistry(
  input: CreateProtocolAdapterRegistryInput,
): ProtocolAdapterRegistry {
  if (input.adapters.length === 0) {
    throw new Error("At least one protocol adapter must be registered.");
  }

  const adapters = [...input.adapters];
  const adaptersById = new Map<ProtocolAdapterId, ProtocolAdapter>();
  const adaptersByProtocol = new Map<ProtocolName, ProtocolAdapter>();

  for (const adapter of adapters) {
    if (adaptersById.has(adapter.metadata.adapterId)) {
      throw new Error(`Duplicate protocol adapter id: ${adapter.metadata.adapterId}`);
    }

    if (adaptersByProtocol.has(adapter.metadata.protocol)) {
      throw new Error(`Duplicate protocol adapter protocol: ${adapter.metadata.protocol}`);
    }

    adaptersById.set(adapter.metadata.adapterId, adapter);
    adaptersByProtocol.set(adapter.metadata.protocol, adapter);
  }

  const defaultAdapterId = input.defaultAdapterId ?? DEFAULT_PROTOCOL_ADAPTER_ID;
  const defaultAdapter = adaptersById.get(defaultAdapterId);

  if (defaultAdapter === undefined) {
    throw new Error(`Default protocol adapter not registered: ${defaultAdapterId}`);
  }

  return {
    adapters: Object.freeze(adapters),
    defaultAdapterId,
    getByAdapterId(adapterId) {
      return adaptersById.get(adapterId);
    },
    getByProtocol(protocol) {
      return adaptersByProtocol.get(protocol);
    },
    select(selectionInput = {}) {
      const requestedAdapterId = selectionInput.adapterId ?? null;
      const requestedProtocol = selectionInput.protocol ?? null;

      const adapterById = requestedAdapterId === null
        ? undefined
        : adaptersById.get(requestedAdapterId);

      if (adapterById !== undefined) {
        return {
          requestedAdapterId,
          requestedProtocol,
          metadata: adapterById.metadata,
          explanation: makeSelectionExplanation(
            ProtocolAdapterSelectionReasonKind.ExplicitAdapterId,
            false,
            `Selected adapter ${adapterById.metadata.adapterId} by explicit adapter id.`,
          ),
        };
      }

      const adapterByProtocol = requestedProtocol === null
        ? undefined
        : adaptersByProtocol.get(requestedProtocol);

      if (adapterByProtocol !== undefined) {
        const fallbackApplied = requestedAdapterId !== null;

        return {
          requestedAdapterId,
          requestedProtocol,
          metadata: adapterByProtocol.metadata,
          explanation: makeSelectionExplanation(
            ProtocolAdapterSelectionReasonKind.ExplicitProtocol,
            fallbackApplied,
            requestedAdapterId === null
              ? `Selected adapter ${adapterByProtocol.metadata.adapterId} for protocol ${requestedProtocol}.`
              : `Requested adapter ${requestedAdapterId} was not registered; selected adapter ${adapterByProtocol.metadata.adapterId} for protocol ${requestedProtocol}.`,
          ),
        };
      }

      return {
        requestedAdapterId,
        requestedProtocol,
        metadata: defaultAdapter.metadata,
        explanation: makeSelectionExplanation(
          ProtocolAdapterSelectionReasonKind.DefaultPolicy,
          requestedAdapterId !== null || requestedProtocol !== null,
          requestedAdapterId !== null
            ? `Requested adapter ${requestedAdapterId} was not registered; defaulting to adapter ${defaultAdapter.metadata.adapterId}.`
            : requestedProtocol !== null
              ? `No adapter was registered for protocol ${requestedProtocol}; defaulting to adapter ${defaultAdapter.metadata.adapterId}.`
              : `No adapter selection was provided; defaulting to adapter ${defaultAdapter.metadata.adapterId}.`,
        ),
      };
    },
  };
}

function makeSelectionExplanation(
  reasonKind: ProtocolAdapterSelectionExplanation["reasonKind"],
  fallbackApplied: boolean,
  summary: string,
): ProtocolAdapterSelectionExplanation {
  return {
    reasonKind,
    fallbackApplied,
    summary,
  };
}

export const PROTOCOL_ADAPTER_SELECTION_ORDER =
  DEFAULT_PROTOCOL_ADAPTER_SELECTION_POLICY.selectionOrder;
