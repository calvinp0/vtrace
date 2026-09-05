/**
 * M217 — synthetic fixtures for the continuation-safety and retry-reserve
 * controls that need no container.
 *
 * The synthetic probe holds an explicit bag of residue that a control can
 * fill or empty. Every M217 pure control moves exactly one thing in that bag
 * and asks the real `CohortOperations`, the real classifier and the real
 * executor gate what they do about it.
 */

import { join } from "node:path";

import type {
  IsolationProbe,
  IsolationScope,
  RemediationReport,
  ResidualContainer,
  ResidualProcess,
  ResidualStateReport,
} from "./m217ContinuationSafety";
import { CohortOperations, CohortOperationsLedger, M217_CONTINUATION_VERSION } from "./m217ContinuationSafety";

export interface SyntheticResidue {
  harnessContainers: ResidualContainer[];
  evaluatorContainers: ResidualContainer[];
  liveProcesses: ResidualProcess[];
  armRoots: Set<string>;
  hostMounts: Set<string>;
  openBridgeHandles: string[];
  probeErrors: string[];
}

export function emptyResidue(): SyntheticResidue {
  return {
    harnessContainers: [], evaluatorContainers: [], liveProcesses: [],
    armRoots: new Set(), hostMounts: new Set(), openBridgeHandles: [], probeErrors: [],
  };
}

export class SyntheticIsolationProbe implements IsolationProbe {
  readonly enumerations: IsolationScope[] = [];
  readonly remediations: IsolationScope[] = [];
  /** When true, `enumerate` throws, modelling a probe that cannot look. */
  enumerateThrows = false;
  /** When true, `remediate` reports success but removes nothing. */
  remediationIneffective = false;

  constructor(readonly residue: SyntheticResidue = emptyResidue(), private tick = 0) {}

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 8, 5, 0, 0, this.tick)).toISOString();
  }

  async enumerate(scope: IsolationScope): Promise<ResidualStateReport> {
    this.enumerations.push(scope);
    if (this.enumerateThrows) throw new Error("synthetic probe cannot reach the substrate");
    return {
      probeVersion: `${M217_CONTINUATION_VERSION}:synthetic`,
      probedAt: this.stamp(),
      scope,
      harnessContainers: [...this.residue.harnessContainers],
      evaluatorContainers: [...this.residue.evaluatorContainers],
      liveProcesses: [...this.residue.liveProcesses],
      armRootPresent: scope.armRoot !== null && this.residue.armRoots.has(scope.armRoot),
      hostMountPresent: scope.hostMount !== null && this.residue.hostMounts.has(scope.hostMount),
      openBridgeHandles: [...this.residue.openBridgeHandles],
      probeErrors: [...this.residue.probeErrors],
    };
  }

  async remediate(scope: IsolationScope, residual: ResidualStateReport): Promise<RemediationReport> {
    this.remediations.push(scope);
    if (this.remediationIneffective) {
      return { actions: ["(synthetic) remediation claimed success"], errors: [] };
    }
    const actions: string[] = [];
    for (const box of residual.harnessContainers) actions.push(`removed container ${box.name}`);
    for (const box of residual.evaluatorContainers) actions.push(`removed container ${box.name}`);
    for (const proc of residual.liveProcesses) actions.push(`killed pid ${proc.pid}`);
    if (residual.armRootPresent) actions.push(`removed arm root ${scope.armRoot}`);
    if (residual.hostMountPresent) actions.push(`removed host mount ${scope.hostMount}`);
    this.residue.harnessContainers.length = 0;
    this.residue.evaluatorContainers.length = 0;
    this.residue.liveProcesses.length = 0;
    if (scope.armRoot !== null) this.residue.armRoots.delete(scope.armRoot);
    if (scope.hostMount !== null) this.residue.hostMounts.delete(scope.hostMount);
    this.residue.openBridgeHandles.length = 0;
    return { actions, errors: [] };
  }
}

export const SYNTHETIC_WORK_ROOT = "/synthetic/cohort/_work" as const;

export function syntheticArmRoot(instanceId: string, arm: string): string {
  return join(SYNTHETIC_WORK_ROOT, `${instanceId}--${arm}`);
}

export interface SyntheticOperations {
  readonly operations: CohortOperations;
  readonly probe: SyntheticIsolationProbe;
  readonly ledger: CohortOperationsLedger;
}

export function syntheticOperations(
  now: () => string = syntheticOperationsClock(),
  residue: SyntheticResidue = emptyResidue(),
): SyntheticOperations {
  const probe = new SyntheticIsolationProbe(residue);
  const ledger = new CohortOperationsLedger();
  return { operations: new CohortOperations(ledger, probe, SYNTHETIC_WORK_ROOT, now), probe, ledger };
}

export function syntheticOperationsClock(start = Date.UTC(2026, 8, 5, 0, 0, 0)): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start + tick * 1000).toISOString();
  };
}

export function staleHarnessContainer(instanceId: string): ResidualContainer {
  return {
    name: `m193-${instanceId}`, id: "deadbeef0001", status: "running",
    image: `swebench/sweb.eval.x86_64.${instanceId}:latest`,
  };
}

export function staleEvaluatorContainer(instanceId: string): ResidualContainer {
  return {
    name: `sweb.eval.${instanceId}.m217-stale`, id: "deadbeef0002", status: "exited",
    image: `swebench/sweb.eval.x86_64.${instanceId}:latest`,
  };
}

export function staleProcess(workRoot: string, what: string): ResidualProcess {
  return { pid: 424242, cmdline: `${what} --repo ${workRoot}/stale` };
}
