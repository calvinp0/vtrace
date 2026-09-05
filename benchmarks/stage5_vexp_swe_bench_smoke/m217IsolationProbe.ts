/**
 * M217 §8, §22 — the production isolation probe, over the substrate bridge.
 *
 * It asks the substrate two questions and makes no decision about the answers:
 * "what is still there?" and "remove exactly that". The classification lives in
 * `m217ContinuationSafety.ts`, the decision in the executor's P10 gate.
 */

import type { SubstrateBridge } from "./m216SubstrateBridge";
import type {
  IsolationProbe,
  IsolationScope,
  RemediationReport,
  ResidualStateReport,
} from "./m217ContinuationSafety";

export const M217_PROBE_VERSION = "stage5.m217.isolation-probe.v1" as const;

export class M217IsolationProbe implements IsolationProbe {
  constructor(private readonly bridge: SubstrateBridge) {}

  async enumerate(scope: IsolationScope): Promise<ResidualStateReport> {
    return this.bridge.call<ResidualStateReport>("substrate.residualState", {
      workRoot: scope.workRoot,
      armRoot: scope.armRoot,
      hostMount: scope.hostMount,
      instanceId: scope.instanceId,
      runId: scope.runId,
    });
  }

  async remediate(scope: IsolationScope, _residual: ResidualStateReport): Promise<RemediationReport> {
    return this.bridge.call<RemediationReport>("substrate.remediateResidualState", {
      workRoot: scope.workRoot,
      armRoot: scope.armRoot,
      hostMount: scope.hostMount,
    });
  }
}
