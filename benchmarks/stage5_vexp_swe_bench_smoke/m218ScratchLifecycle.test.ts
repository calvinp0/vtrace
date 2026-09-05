import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  M218_NAMESPACE_MARKER,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  ScratchSafetyError,
  SyntheticLivenessProbe,
  assertDeletableOwnedPath,
  auditArmTmpEquivalence,
  capacityGate,
  establishNamespace,
  forbiddenRootReason,
  imageAvailability,
  measureTree,
  openNamespace,
  removeTreeNoFollow,
  sweepNamespace,
} from "./m218ScratchLifecycle";

const RESULTS = join(import.meta.dir, "results");
const manifest = (JSON.parse(readFileSync(join(RESULTS, "stage5_m214_run_manifest.json"), "utf8")) as {
  rows: RunManifestRow[];
}).rows;
const row = manifest[0]!;

function scratchBase(): string {
  const base = mkdtempSync(join(tmpdir(), "m218-unit-"));
  return base;
}

function authorityIn(base: string, liveness = new SyntheticLivenessProbe()): ScratchAuthority {
  const namespace = establishNamespace(join(base, "cohort", "_work"), { experiment: "M218_UNIT", cohortDir: join(base, "cohort") });
  return new ScratchAuthority({
    namespace,
    registry: new ScratchRegistry(join(base, "cohort", "_scratch_registry")),
    evidenceDir: join(base, "cohort", "evidence"),
    liveness,
    experiment: "M218_UNIT",
    executorVersion: "unit",
    sharedTmpPath: null,
  });
}

describe("forbidden roots (§47)", () => {
  test("the root, /tmp, the home directory, empty and relative paths are refused structurally", () => {
    for (const path of ["/", "/tmp", tmpdir(), "/var/tmp", homedir(), "", "   ", "relative/path", "/usr", "/proc/self"]) {
      expect(forbiddenRootReason(path)).not.toBeNull();
    }
    expect(forbiddenRootReason(join(tmpdir(), "vtrace-stage5-x"))).toBeNull();
  });
});

describe("namespace", () => {
  test("establishing writes a marker and reopening requires the same experiment", () => {
    const base = scratchBase();
    try {
      const ns = establishNamespace(join(base, "_work"), { experiment: "E1", cohortDir: base });
      expect(existsSync(join(ns.canonicalRoot, M218_NAMESPACE_MARKER))).toBe(true);
      expect(openNamespace(join(base, "_work"), "E1").canonicalRoot).toBe(ns.canonicalRoot);
      expect(() => openNamespace(join(base, "_work"), "E2")).toThrow(ScratchSafetyError);
      expect(() => openNamespace(join(base, "unmarked"), "E1")).toThrow(ScratchSafetyError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a registry or evidence directory inside the namespace is refused", () => {
    const base = scratchBase();
    try {
      const namespace = establishNamespace(join(base, "_work"), { experiment: "E1", cohortDir: base });
      expect(() => new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(namespace.canonicalRoot, "reg")), evidenceDir: join(base, "ev"),
        liveness: new SyntheticLivenessProbe(), experiment: "E1", executorVersion: "unit", sharedTmpPath: null,
      })).toThrow(ScratchSafetyError);
      expect(() => new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(base, "reg")), evidenceDir: join(namespace.canonicalRoot, "ev"),
        liveness: new SyntheticLivenessProbe(), experiment: "E1", executorVersion: "unit", sharedTmpPath: null,
      })).toThrow(ScratchSafetyError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("path safety (§46, T20–T22)", () => {
  test("only a strict descendant of the marked root is deletable; the root, a sibling and a symlink are refused", () => {
    const base = scratchBase();
    try {
      const ns = establishNamespace(join(base, "_work"), { experiment: "E1", cohortDir: base });
      const owned = join(ns.canonicalRoot, "row--baseline");
      mkdirSync(owned);
      expect(assertDeletableOwnedPath(ns, owned).canonical).toBe(owned);
      expect(() => assertDeletableOwnedPath(ns, ns.canonicalRoot)).toThrow(/namespace root itself/);
      const sibling = join(base, "_work2");
      mkdirSync(sibling);
      expect(() => assertDeletableOwnedPath(ns, sibling)).toThrow(/not a strict descendant/);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "precious.txt"), "keep");
      const link = join(ns.canonicalRoot, "link");
      symlinkSync(outside, link);
      expect(() => assertDeletableOwnedPath(ns, link)).toThrow(/through a symlink/);
      expect(() => removeTreeNoFollow(ns, link)).toThrow(ScratchSafetyError);
      expect(existsSync(join(outside, "precious.txt"))).toBe(true);
      for (const bad of ["/", "/tmp", homedir(), ""]) {
        expect(() => removeTreeNoFollow(ns, bad)).toThrow(ScratchSafetyError);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a symlink INSIDE an owned tree is unlinked, never followed (T21)", () => {
    const base = scratchBase();
    try {
      const ns = establishNamespace(join(base, "_work"), { experiment: "E1", cohortDir: base });
      const owned = join(ns.canonicalRoot, "row--vtrace");
      mkdirSync(join(owned, "deep", "deeper"), { recursive: true });
      writeFileSync(join(owned, "deep", "deeper", "f.bin"), Buffer.alloc(8192, 1));
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "precious.txt"), "keep");
      symlinkSync(outside, join(owned, "deep", "escape"));
      symlinkSync(join(outside, "precious.txt"), join(owned, "file-link"));
      const removal = removeTreeNoFollow(ns, owned);
      expect(removal.errors).toEqual([]);
      expect(removal.symlinksUnlinked).toBe(2);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(join(outside, "precious.txt"))).toBe(true);
      expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("claims and cleanup (T1, T4, T6, T10, T15, T23)", () => {
  test("a claim is registered outside the namespace before the directory exists, and cleanup verifies 0 bytes", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      const claim = authority.claim(row, `${row.runId}#a1#unit`, 1);
      expect(existsSync(claim.path)).toBe(true);
      expect(existsSync(claim.agentTmp)).toBe(true);
      expect(authority.registry.read(claim.claimId)?.state).toBe("CLAIMED");
      expect(authority.registry.dir.startsWith(authority.namespace.canonicalRoot)).toBe(false);
      writeFileSync(join(claim.agentTmp, "agent-created-file"), Buffer.alloc(65536, 7));
      mkdirSync(join(claim.path, "testbed", "pkg"), { recursive: true });
      writeFileSync(join(claim.path, "testbed", "pkg", "a.py"), "x = 1\n");
      authority.checkpoint(claim, "AFTER_AGENT_COMPLETION");
      const report = authority.cleanup(claim, { containerRemoved: true });
      expect(report.status).toBe("CLEANED");
      expect(report.verified).toBe(true);
      expect(report.scratchBytesAfterCleanup).toBe(0);
      expect(report.scratchHighWaterBytes).toBeGreaterThan(0);
      expect(existsSync(claim.path)).toBe(false);
      expect(authority.registry.read(claim.claimId)?.state).toBe("RELEASED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a large nested tree is removed completely (T3)", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      const claim = authority.claim(row, `${row.runId}#a1#t3`, 1);
      for (let index = 0; index < 40; index += 1) {
        const dir = join(claim.path, "testbed", `d${index % 5}`, `e${index % 7}`, `f${index}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "blob"), Buffer.alloc(4096 * (index + 1), index));
      }
      const before = measureTree(claim.path);
      expect(before.inodes).toBeGreaterThan(60);
      const report = authority.cleanup(claim, { containerRemoved: true });
      expect(report.verified).toBe(true);
      expect(measureTree(claim.path).exists).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("cleanup refuses while the container is not removed or a live reference exists (T6, T7)", () => {
    const base = scratchBase();
    try {
      const liveness = new SyntheticLivenessProbe();
      const authority = authorityIn(base, liveness);
      const claim = authority.claim(row, `${row.runId}#a1#t6`, 1);
      writeFileSync(join(claim.path, "raw", "stream.jsonl"), "{}\n");
      const container = authority.cleanup(claim, { containerRemoved: false });
      expect(container.status).toBe("REFUSED_LIVE_OWNER");
      expect(existsSync(claim.path)).toBe(true);
      liveness.references.set(claim.path, [{ kind: "PROCESS", detail: "pid 4242 bwrap --bind ..." }]);
      const process = authority.cleanup(claim, { containerRemoved: true });
      expect(process.status).toBe("REFUSED_LIVE_OWNER");
      expect(process.liveReferences[0]?.kind).toBe("PROCESS");
      expect(existsSync(claim.path)).toBe(true);
      expect(authority.registry.read(claim.claimId)?.state).toBe("CLAIMED");
      liveness.references.delete(claim.path);
      expect(authority.cleanup(claim, { containerRemoved: true }).verified).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a path without a registered claim is never deleted (T4)", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      const claim = authority.claim(row, `${row.runId}#a1#t4`, 1);
      const forged = { ...claim, claimId: "not-registered" };
      const report = authority.cleanup(forged, { containerRemoved: true });
      expect(report.status).toBe("REFUSED_NOT_OWNED");
      expect(existsSync(claim.path)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("cleanup of run A cannot touch run B (T23)", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      const other = manifest.find((candidate) => candidate.instanceId !== row.instanceId)!;
      const a = authority.claim(row, `${row.runId}#a1#t23`, 1);
      const b = authority.claim(other, `${other.runId}#a1#t23`, 1);
      writeFileSync(join(b.path, "raw", "keep"), "b");
      expect(authority.cleanup(a, { containerRemoved: true }).verified).toBe(true);
      expect(existsSync(join(b.path, "raw", "keep"))).toBe(true);
      expect(authority.registry.read(b.claimId)?.state).toBe("CLAIMED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("evidence is persisted outside scratch, digest-verified, and survives cleanup (T15)", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      const claim = authority.claim(row, `${row.runId}#a1#t15`, 1);
      writeFileSync(join(claim.rawDir, "a.agent_stream.jsonl"), "{\"type\":\"system\"}\n{\"type\":\"result\"}\n");
      const manifestOut = authority.persistEvidence(claim, {
        patch: "diff --git a/x b/x\n", evaluation: { resolved: false, rawResult: "{}" }, extra: { "note.txt": "hi" },
      });
      expect(manifestOut.verifiedByDigest).toBe(true);
      expect(manifestOut.dir.startsWith(authority.namespace.canonicalRoot)).toBe(false);
      expect(authority.cleanup(claim, { containerRemoved: true }).verified).toBe(true);
      const verification = authority.verifyEvidence(claim);
      expect(verification.present).toBe(true);
      expect(verification.issues).toEqual([]);
      // An attempt to clean the evidence directory itself through the safety gate is refused.
      expect(() => removeTreeNoFollow(authority.namespace, manifestOut.dir)).toThrow(ScratchSafetyError);
      expect(existsSync(join(manifestOut.dir, "captured.patch"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an attempt never inherits an existing path", () => {
    const base = scratchBase();
    try {
      const authority = authorityIn(base);
      authority.claim(row, `${row.runId}#a1#inherit`, 1);
      expect(() => authority.claim(row, `${row.runId}#a2#inherit`, 2)).toThrow(/already exists/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("stale sweep (T8, T9, T20, T25)", () => {
  test("stale owned scratch with a dead creator and no references is cleaned; live, unsafe and unknown paths block", () => {
    const base = scratchBase();
    try {
      const liveness = new SyntheticLivenessProbe();
      const authority = authorityIn(base, liveness);
      const rows = manifest.slice(0, 4);
      const stale = authority.claim(rows[0]!, `${rows[0]!.runId}#a1#stale`, 1);
      writeFileSync(join(stale.agentTmp, "junk"), Buffer.alloc(1024, 1));
      const active = authority.claim(rows[1]!, `${rows[1]!.runId}#a1#active`, 1);
      liveness.alivePids.add(active.creator.pid);
      // Make the stale claim's creator look dead by giving it a pid nobody has.
      authority.registry.update(stale.claimId, { creator: { ...stale.creator, pid: 999_999_999 } });
      const unsafe = authority.claim(rows[2]!, `${rows[2]!.runId}#a1#unsafe`, 1);
      authority.registry.update(unsafe.claimId, { creator: { ...unsafe.creator, pid: 999_999_998 } });
      liveness.references.set(unsafe.path, [{ kind: "CONTAINER", detail: "m193-x binds testbed" }]);
      const unknown = join(authority.namespace.canonicalRoot, "random-leftover");
      mkdirSync(unknown);
      writeFileSync(join(unknown, "x"), "x");
      // Keep `active` alive: its creator pid is this process only when alivePids says so;
      // the registry recorded process.pid, which the synthetic probe reports alive.
      const report = sweepNamespace(authority.namespace, authority.registry, liveness);
      const byPath = new Map(report.entries.map((entry) => [entry.path, entry]));
      expect(byPath.get(stale.path)?.classification).toBe("STALE_CLEANABLE");
      expect(byPath.get(stale.path)?.cleaned).toBe(true);
      expect(existsSync(stale.path)).toBe(false);
      expect(authority.registry.read(stale.claimId)?.state).toBe("RELEASED");
      expect(byPath.get(active.path)?.classification).toBe("ACTIVE");
      expect(existsSync(active.path)).toBe(true);
      expect(byPath.get(unsafe.path)?.classification).toBe("STALE_UNSAFE");
      expect(existsSync(unsafe.path)).toBe(true);
      expect(byPath.get(unknown)?.classification).toBe("UNKNOWN");
      expect(existsSync(join(unknown, "x"))).toBe(true);
      expect(report.pass).toBe(false);
      expect([...report.blocking].sort()).toEqual([active.path, unsafe.path, unknown].sort());
      expect(byPath.get(stale.path)?.ownershipEvidence.length).toBeGreaterThan(0);
      expect(byPath.get(stale.path)?.ageSeconds).not.toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("capacity gate (T12–T14)", () => {
  test("below the derived threshold the gate refuses; above it passes; low inodes fire", () => {
    const base = scratchBase();
    try {
      const ns = establishNamespace(join(base, "_work"), { experiment: "E1", cohortDir: base });
      const required = M218_SCRATCH_POLICY.hostSafetyReserveBytes + M218_SCRATCH_POLICY.projectedAttemptScratchBytes;
      const reader = (free: number, inodes: number) => () => ({
        path: "x", totalBytes: 10 * required, freeBytes: free, freeFraction: free / (10 * required),
        totalInodes: 100_000_000, freeInodes: inodes, measuredAt: "t",
      });
      expect(capacityGate(ns, M218_SCRATCH_POLICY, reader(required - 1, 50_000_000), () => "t", null).pass).toBe(false);
      expect(capacityGate(ns, M218_SCRATCH_POLICY, reader(required, 50_000_000), () => "t", null).pass).toBe(true);
      const inodes = capacityGate(ns, M218_SCRATCH_POLICY, reader(required * 2, 1_000), () => "t", null);
      expect(inodes.pass).toBe(false);
      expect(inodes.issues.some((issue) => issue.includes("inodes"))).toBe(true);
      expect(capacityGate(ns, M218_SCRATCH_POLICY, reader(required * 2, 50_000_000), () => "t", null).freeAfterProjectedAttemptBytes)
        .toBe(required * 2 - M218_SCRATCH_POLICY.projectedAttemptScratchBytes);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the policy's derivation is arithmetic over its recorded inputs", () => {
    const p = M218_SCRATCH_POLICY;
    const inputs = p.observedInputs;
    const attempt = inputs.largestFrozenRepositoryCheckoutBytes + inputs.treatmentIndexBytesObserved + inputs.agentStreamBytesMax;
    expect(Number(p.projectedAttemptScratchBytes)).toBe(Math.max(p.safetyFactor * attempt, 2 * 1024 ** 3));
    expect(Number(p.projectedAttemptInodes)).toBe(Math.max(p.safetyFactor * inputs.largestFrozenRepositoryCheckoutInodes, 250_000));
    expect(Number(p.hostSafetyReserveBytes)).toBe(2 * inputs.largestFrozenImageBytes + 10 * 1024 ** 3);
    expect(Number(p.hardAttemptScratchBytes)).toBe(4 * p.warningAttemptScratchBytes);
    expect(Number(p.warningAttemptScratchBytes)).toBe(p.projectedAttemptScratchBytes);
  });
});

describe("images and arm equivalence (T17)", () => {
  test("image availability names what is absent and never prunes", () => {
    const report = imageAvailability(["a:latest", "b:latest", "a:latest"], () => ["a:latest"]);
    expect(report.required).toBe(2);
    expect(report.present).toBe(1);
    expect(report.missing).toEqual(["b:latest"]);
  });

  test("two arms with the same sandbox modulo their attempt path are equivalent; a differing tmp bind is not", () => {
    const left = { sandboxArgv: ["bwrap", "--bind", "/w/i--baseline/tmp", "/tmp", "--bind", "/w/i--baseline", "/w/i--baseline"], attemptPath: "/w/i--baseline", envNames: ["PATH", "TMPDIR"] };
    const right = { sandboxArgv: ["bwrap", "--bind", "/w/i--vtrace/tmp", "/tmp", "--bind", "/w/i--vtrace", "/w/i--vtrace"], attemptPath: "/w/i--vtrace", envNames: ["PATH", "TMPDIR"] };
    expect(auditArmTmpEquivalence(left, right)).toEqual([]);
    const hostTmp = { ...right, sandboxArgv: ["bwrap", "--tmpfs", "/tmp", "--bind", "/w/i--vtrace", "/w/i--vtrace"] };
    expect(auditArmTmpEquivalence(left, hostTmp).length).toBe(1);
  });
});
