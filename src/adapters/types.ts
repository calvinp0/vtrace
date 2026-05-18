import type { HandoffPayload } from "../handoff/types";
import type {
  ProtocolAdaptationMetadata,
  ProtocolAdapterMetadata,
  ProtocolAdapterSelectionResult,
} from "./metadata";

export interface ProtocolAdapterInput {
  readonly handoff: HandoffPayload;
  readonly selection: ProtocolAdapterSelectionResult;
}

export interface ProtocolAdaptedPayload<TPayload = unknown> {
  readonly adapter: ProtocolAdaptationMetadata;
  readonly payload: TPayload;
}

export interface ProtocolAdapter<TPayload = unknown> {
  readonly metadata: ProtocolAdapterMetadata;
  adapt(input: ProtocolAdapterInput): ProtocolAdaptedPayload<TPayload>;
}
