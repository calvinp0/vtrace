import { genericJsonEnvelopeProtocolAdapter } from "./genericJsonEnvelopeAdapter";
import {
  createProtocolAdapterRegistry,
  type ProtocolAdapterRegistry,
  type SelectProtocolAdapterInput,
} from "./registry";
import type {
  ProtocolAdaptedPayload,
  ProtocolAdapter,
  ProtocolAdapterInput,
} from "./types";
import type { HandoffPayload } from "../handoff/types";

export interface AdaptPayloadInput extends SelectProtocolAdapterInput {
  readonly handoff: HandoffPayload;
}

export interface ResolvedAdaptPayloadInput extends ProtocolAdapterInput {}

export enum ProtocolAdapterDelegateTarget {
  RegisteredProtocolAdapter = "registered_protocol_adapter",
}

export interface ProtocolAdapterDelegationPlan {
  readonly target: ProtocolAdapterDelegateTarget;
  readonly summary: string;
}

export interface PreparedPayloadAdaptation {
  readonly adapterInput: ResolvedAdaptPayloadInput;
  readonly delegate: ProtocolAdapterDelegationPlan;
}

export interface ProtocolPayloadOrchestrator {
  prepare(input: AdaptPayloadInput): PreparedPayloadAdaptation;
}

export interface ProtocolPayloadOrchestratorOptions {
  readonly registry?: ProtocolAdapterRegistry;
}

export const DEFAULT_PROTOCOL_ADAPTER_DELEGATION = Object.freeze({
  target: ProtocolAdapterDelegateTarget.RegisteredProtocolAdapter,
  summary:
    "Adapter selection complete; delegate the canonical handoff payload to the selected protocol adapter.",
}) satisfies ProtocolAdapterDelegationPlan;

export const defaultProtocolAdapterRegistry = createProtocolAdapterRegistry({
  adapters: [genericJsonEnvelopeProtocolAdapter],
});
export const defaultProtocolPayloadOrchestrator = createProtocolPayloadOrchestrator();

export function createProtocolPayloadOrchestrator(
  options: ProtocolPayloadOrchestratorOptions = {},
): ProtocolPayloadOrchestrator {
  const registry = options.registry ?? defaultProtocolAdapterRegistry;

  return {
    prepare(input) {
      return preparePayloadAdaptation(input, registry);
    },
  };
}

export function preparePayloadAdaptation(
  input: AdaptPayloadInput,
  registry: ProtocolAdapterRegistry = defaultProtocolAdapterRegistry,
): PreparedPayloadAdaptation {
  const selection = registry.select({
    adapterId: input.adapterId,
    protocol: input.protocol,
  });

  return {
    adapterInput: {
      handoff: input.handoff,
      selection,
    },
    delegate: DEFAULT_PROTOCOL_ADAPTER_DELEGATION,
  };
}

export function adaptHandoffPayload(
  input: AdaptPayloadInput,
  registry: ProtocolAdapterRegistry = defaultProtocolAdapterRegistry,
): ProtocolAdaptedPayload {
  const prepared = preparePayloadAdaptation(input, registry);
  const adapter = registry.getByAdapterId(prepared.adapterInput.selection.metadata.adapterId);

  if (adapter === undefined) {
    throw new Error(
      `Protocol adapter not found: ${prepared.adapterInput.selection.metadata.adapterId}`,
    );
  }

  return adapter.adapt(prepared.adapterInput);
}
