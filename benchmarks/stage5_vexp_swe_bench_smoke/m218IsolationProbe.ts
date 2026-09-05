/**
 * M218 §14, §22, §42 — the scratch-aware isolation probe.
 *
 * M217's probe enumerates the substrate and remediates exactly what it listed.
 * M218 wraps it, not to change what is enumerated, but to put OWNERSHIP in
 * front of destruction: the wrapped remediation refuses to remove an arm root
 * the scratch registry does not own, and records the release when it does.
 * `enumerate` is delegated untouched, so isolation is still proven by the
 * substrate's own absence report.
 */

import { existsSync } from "node:fs";

import type {
  IsolationProbe,
  IsolationScope,
  RemediationReport,
  ResidualStateReport,
} from "./m217ContinuationSafety";
import { type ScratchAuthority, measureTree } from "./m218ScratchLifecycle";

export const M218_PROBE_VERSION = "stage5.m218.scratch-aware-isolation-probe.v1" as const;

export class ScratchAwareIsolationProbe implements IsolationProbe {
  constructor(
    private readonly inner: IsolationProbe,
    private readonly scratch: ScratchAuthority,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async enumerate(scope: IsolationScope): Promise<ResidualStateReport> {
    const report = await this.inner.enumerate(scope);
    // The substrate's answer is authoritative; the TS-side measurement is
    // added only when the substrate did not supply one.
    if (report.ownedScratchBytesRemaining === undefined && scope.armRoot !== null) {
      const measured = measureTree(scope.armRoot);
      return { ...report, ownedScratchBytesRemaining: measured.bytes };
    }
    return report;
  }

  async remediate(scope: IsolationScope, residual: ResidualStateReport): Promise<RemediationReport> {
    const errors: string[] = [];
    const actions: string[] = [];
    let armRoot: string | null = scope.armRoot;
    let hostMount: string | null = scope.hostMount;
    let claimId: string | null = null;
    if (armRoot !== null && existsSync(armRoot)) {
      const claims = this.scratch.registry.claimsForPath(armRoot);
      if (claims.length === 0) {
        errors.push(
          `refusing to remediate ${armRoot}: no scratch claim owns it; ownership must be proven before `
          + "destructive cleanup (M218 §14)",
        );
        armRoot = null;
        hostMount = null;
      } else {
        claimId = claims[claims.length - 1]!.claimId;
        actions.push(`ownership of ${armRoot} proven by scratch claim ${claimId}`);
      }
    }
    const inner = await this.inner.remediate({ ...scope, armRoot, hostMount }, residual);
    if (claimId !== null && armRoot === scope.armRoot && scope.armRoot !== null && !existsSync(scope.armRoot)) {
      this.scratch.registry.update(claimId, {
        state: "RELEASED", releasedAt: this.now(), releaseReason: "ISOLATION_RECOVERY: remediated through the predeclared path",
      });
      actions.push(`scratch claim ${claimId} released after recovery`);
    }
    return {
      actions: [...actions, ...inner.actions],
      errors: [...errors, ...inner.errors],
    };
  }
}
