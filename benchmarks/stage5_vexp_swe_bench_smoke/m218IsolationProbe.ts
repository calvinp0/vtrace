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
      return { ...report, ownedScratchBytesRemaining: measured.bytes, ownedScratchInodesRemaining: measured.inodes };
    }
    return report;
  }

  async remediate(scope: IsolationScope, residual: ResidualStateReport): Promise<RemediationReport> {
    const errors: string[] = [];
    const actions: string[] = [];
    let claimId: string | null = null;
    if (scope.armRoot !== null && existsSync(scope.armRoot)) {
      const claims = this.scratch.registry.claimsForPath(scope.armRoot);
      if (claims.length === 0) {
        errors.push(
          `refusing to remediate ${scope.armRoot}: no scratch claim owns it; ownership must be proven before `
          + "destructive cleanup (M218 §14)",
        );
      } else {
        claimId = claims[claims.length - 1]!.claimId;
        actions.push(`ownership of ${scope.armRoot} proven by scratch claim ${claimId}`);
      }
    }
    // The substrate removes containers and processes first (§19 order); the
    // owned tree is then removed by the scratch authority's own cleanup,
    // which re-checks ownership and live references and verifies by
    // measurement. The substrate's own rmtree is a no-op once this has run.
    const inner = await this.inner.remediate({ ...scope, armRoot: null, hostMount: null }, residual);
    if (claimId !== null && scope.armRoot !== null && existsSync(scope.armRoot)) {
      const claim = this.scratch.registry.read(claimId);
      if (claim !== null) {
        const cleanup = this.scratch.cleanup(claim, { containerRemoved: null });
        if (cleanup.verified) {
          actions.push(`removed owned scratch ${scope.armRoot} (${cleanup.bytesRemoved} bytes, claim ${claimId} released)`);
        } else {
          errors.push(`owned scratch ${scope.armRoot} could not be removed: ${cleanup.status} ${cleanup.errors.join("; ")} ${cleanup.liveReferences.map((r) => r.detail).join("; ")}`);
        }
      }
    } else if (claimId !== null && scope.armRoot !== null && !existsSync(scope.armRoot)) {
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
