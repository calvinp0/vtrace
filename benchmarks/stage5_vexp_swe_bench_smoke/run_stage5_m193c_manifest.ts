/**
 * M193C §34 — re-freeze the acquisition manifest around the patch-snapshot
 * authority.
 *
 * Derived from the committed M193B manifest rather than regenerated beside it,
 * for the same reason M193B derived from M193A: "the task fixture, model, caps
 * and stopping rule did not change" must be a mechanical fact. This script
 * verifies M193B's own manifest hash, deep-copies it, applies exactly the
 * patch-observation fields, and diffs the two canonical forms so every
 * difference has to appear in the output.
 *
 * If it reports a difference outside the integrity keys, that is a defect in
 * this script or an unauthorised change, and either way the acquisition is not
 * re-frozen.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193c_manifest.ts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY, M193_LIMITS } from "./m193Acquisition";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const M193B_MANIFEST = join(RESULTS, "stage5_m193b_manifest.json");
const OUT = join(RESULTS, "stage5_m193c_manifest.json");
const DIFF_OUT = join(RESULTS, "stage5_m193c_manifest_diff.json");

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function blobHash(relPath: string): string | null {
  try {
    return execFileSync("git", ["hash-object", relPath], { cwd: join(HERE, "..", "..") }).toString().trim();
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

function leaves(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (value === null || typeof value !== "object") {
    out.set(prefix, JSON.stringify(value));
    return out;
  }
  if (Array.isArray(value)) {
    out.set(prefix, canonical(value));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const [p, s] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, s);
  }
  return out;
}

// ── the M193B manifest, verified rather than trusted ─────────────────

const m193b = JSON.parse(readFileSync(M193B_MANIFEST, "utf8")) as Record<string, unknown>;
const declaredHash = m193b.manifestHash as string;
const { manifestHash: _h, manifestHashRule: _r, ...m193bBody } = m193b;
const recomputed = sha256(canonical(m193bBody));
if (recomputed !== declaredHash) {
  console.error(`M193B manifest hash does not verify: declared ${declaredHash}, recomputed ${recomputed}`);
  process.exit(1);
}

const body = JSON.parse(JSON.stringify(m193bBody)) as Record<string, unknown>;

// ── the patch-observation closure, and nothing else ──────────────────

body.schemaVersion = "stage5.m193c.experiment-manifest.v1";
body.milestone = "M193C";
body.derivedFrom = {
  milestone: "M193B",
  manifestPath: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193b_manifest.json",
  manifestHash: declaredHash,
  hashVerifiedAtGeneration: true,
  statement:
    "The task fixture, model, agent, tool set, prompt, caps, concurrency, timeouts, preflight, replacement policy, retry policy, run-validity rule, adequacy thresholds, stopping rule, source-version verdict semantics, changed-source authority, I6 usability rule and treatment-isolation construction are carried over unchanged. M193C replaces the command that captures the interactive patch, so that observing the agent's work no longer writes to the repository being observed.",
};

body.patchSnapshotAuthority = {
  version: "stage5.m193c.patch-snapshot-authority.v1",
  implementation:
    "patch_snapshot_command() and parse_patch_snapshot_output() in m193c_patch_snapshot.py, called through M193Container.capture_patch_snapshot()",
  scope:
    "the working tree's current state relative to the frozen base commit — tracked staged changes, tracked unstaged changes, a file staged and then further edited, untracked agent-created files, deletions and both halves of a rename — excluding the environment's own pre-agent untracked output",
  derivedFrom:
    "git -c core.fileMode=false diff --no-renames HEAD -- . <pre-agent exclusions>, merged in git's own path order with a per-file git -c core.fileMode=false diff --no-index --no-renames -- /dev/null <path> over git -c core.fileMode=false ls-files --others --exclude-standard -- . <pre-agent exclusions>",
  nonMutating:
    "Every command is a reader: diff, ls-files, status, rev-parse. Nothing is staged, reset, restored or checked out, and no object is written, so the invariant is that the snapshot performs no repository mutation rather than that it mutates and rolls back (§8).",
  currentBytesAreAuthoritative:
    "`diff HEAD` compares the base commit to the WORKING TREE, so a file staged as S1 and then edited to S2 is captured as S2 while S1 remains in the index (§14).",
  untrackedRepresentation:
    "git special-cases /dev/null in --no-index and emits the canonical `diff --git a/P b/P` plus `new file mode` header, so an untracked file is represented exactly as staging it would have represented it, at no index or object cost (§10).",
  renameRepresentation:
    "delete-plus-add, via --no-renames. Rename detection has been on by default since git 2.9 and collapses a move to a single R100 whose body carries no content; the permitted delete/add form keeps both paths and the new file's bytes (§19).",
  canonicalisation:
    "one patch, chunked per path and sorted by path bytes, so the byte sequence does not depend on which lane a file arrived through or on filesystem traversal order (§11).",
  fileModePolicy:
    "the executable bit follows core.fileMode=false in both lanes: `add -A` under that setting recorded every new file 100644, and the untracked lane clamps 100755 to match while recording the observed mode as metadata rather than erasing it. Symlink mode 120000 is a different object type and is passed through (§12).",
  binaryPolicy:
    "a binary file is classified in binaryPaths and left as git's own truthful `Binary files ... differ` line rather than being rendered as an invalid textual patch. Such a patch was not applicable before M193C either; the classification makes that visible instead of silent (§11).",
  failsClosed:
    "each section reports its own exit status, and the tracked chunk count is cross-checked against an independently enumerated --name-only -z path list. A snapshot that did not demonstrably complete yields PATCH_SNAPSHOT_UNKNOWN and an empty patch that is flagged as a refusal, never an empty patch that reads as no changes. A state that cannot be represented truthfully is refused, never made representable by writing to the repository (§30).",
  gitStateRecorded:
    "staged, unstaged, untracked, deleted and renamed paths are recorded separately from git status --porcelain=v2 -z as observational metadata. The normalisation of the effective patch does not erase the agent's underlying Git state (§12).",
  supersedes: {
    derivedFrom: "git add -A -- . <exclusions>; git diff --cached; git reset -q",
    defects: [
      "the observation wrote: `git reset` is a mixed reset, so every diff snapshot destroyed whatever the agent had staged, and a staged rename came back as an untracked file",
      "rename detection collapsed a move to an R100 whose body carries `similarity index` and none of the new file's content",
    ],
    reproducedOnRealContainers:
      "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193c_container_control.json",
    finalPatchUnchanged:
      "the five-repository dry run produces byte-identical final-patch hashes to M193, M193A and M193B, so the replacement changed how the patch is obtained and not what the patch is",
  },
  controls: [
    "benchmarks/stage5_vexp_swe_bench_smoke/m193cPatchSnapshot.test.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193c_container_control.py",
  ],
};

body.observationPurity = {
  invariant:
    "Any telemetry operation performed while the coding agent may continue executing must be observationally read-only over the authoritative repository state (§29).",
  appliesTo: [
    "diff snapshot",
    "changed-source enumeration",
    "source-version probe",
    "validation provenance probe",
    "cost/turn accounting",
  ],
  outOfBandAllowance:
    "a probe that must run a command may create out-of-band artefacts — the source-version probe is copied to the container's /tmp, never into the checkout — provided they do not alter the source, index or worktree state visible to the agent.",
  instrument:
    "repository_state_command() / repository_state_differences() in m193c_patch_snapshot.py: HEAD, git status --porcelain=v2 -z, the full index from git ls-files -s -z, and content hashes for every untracked and every changed tracked path.",
  boundary: {
    intermediateObservation:
      "strictly read-only. Enforced by construction (no mutating verb is issued) and measured either side of every snapshot in the dry-run lifecycle.",
    finalPostAgentExtraction:
      "converged onto the SAME read-only authority. The weaker constraint that would have been permissible after the agent stops was not needed: the final patch is taken with capture_patch_snapshot() like every intermediate one, and is index-independent — the dry run's agent leaves a staged blob behind and the final patch is unaffected by it.",
  },
  inventory: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193c_observation_inventory.json",
};

body.frozenSources = [
  ...((body.frozenSources as { path: string }[]) ?? []).map((f) => f.path),
  "benchmarks/stage5_vexp_swe_bench_smoke/m193c_patch_snapshot.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193cPatchSnapshot.test.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193c_container_control.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193c_inventory.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193c_manifest.ts",
]
  .filter((p, i, a) => a.indexOf(p) === i)
  .sort()
  .map((p) => ({ path: p, gitBlobSha1: blobHash(p) }));

// ── the difference, computed rather than described ───────────────────

const before = leaves(m193bBody);
const after = leaves(body);
const changed: string[] = [];
const added: string[] = [];
const removed: string[] = [];
for (const [k, v] of after) {
  if (!before.has(k)) added.push(k);
  else if (before.get(k) !== v) changed.push(k);
}
for (const k of before.keys()) if (!after.has(k)) removed.push(k);

/** Top-level keys the patch-observation closure is allowed to touch (§34). */
const SCOPE_KEYS = new Set([
  "schemaVersion",
  "milestone",
  "derivedFrom",
  "patchSnapshotAuthority",
  "observationPurity",
  "frozenSources",
]);
const outsideScope = [...changed, ...added, ...removed].filter((k) => !SCOPE_KEYS.has(k.split(".")[0] ?? k));

// §32/§33 — the frozen experiment, re-asserted against the code rather than
// against the old manifest, so a drift in either is caught.
const invariants = {
  taskFixtureSha256Unchanged:
    (body.taskFixture as { sha256: string }).sha256 === (m193bBody.taskFixture as { sha256: string }).sha256,
  taskFixtureSha256IsM193A:
    (body.taskFixture as { sha256: string }).sha256 ===
    "e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4",
  armCountUnchanged: (body.taskFixture as { armCount: number }).armCount === 40,
  repositoriesUnchanged: (body.taskFixture as { repositoriesRepresented: number }).repositoriesRepresented === 12,
  modelUnchanged: (body.agent as { model: string }).model === "claude-opus-4-5-20251101",
  cliVersionUnchanged: (body.agent as { version: string }).version === "2.1.251",
  maxTurnsUnchanged: (body.agent as { maxTurns: number }).maxTurns === 250,
  perRunCapUnchanged:
    (body.limits as { perRunCostCapUsd: number }).perRunCostCapUsd === M193_LIMITS.perRunCostCapUsd &&
    M193_LIMITS.perRunCostCapUsd === 3.5,
  totalCapUnchanged:
    (body.limits as { totalSpendCapUsd: number }).totalSpendCapUsd === M193_LIMITS.totalSpendCapUsd &&
    M193_LIMITS.totalSpendCapUsd === 90,
  armBoundsUnchanged: M193_LIMITS.minArms === 20 && M193_LIMITS.maxArms === 40,
  concurrencyUnchanged: M193_LIMITS.maxConcurrentArms === 3,
  adequacyUnchanged:
    M193_ADEQUACY.adequate.i6UsableArms === 12 &&
    M193_ADEQUACY.adequate.repositoriesAmongI6Usable === 6 &&
    M193_ADEQUACY.adequate.validRuns === 30 &&
    M193_ADEQUACY.partial.i6UsableArms === 6 &&
    M193_ADEQUACY.partial.repositoriesAmongI6Usable === 4 &&
    M193_ADEQUACY.partial.validRuns === 15,
  stoppingRuleUnchanged: canonical(body.stoppingRule) === canonical(m193bBody.stoppingRule),
  promptUnchanged:
    canonical((body.agent as { userPrompt: unknown }).userPrompt) ===
    canonical((m193bBody.agent as { userPrompt: unknown }).userPrompt),
  toolsUnchanged:
    canonical((body.agent as { tools: unknown }).tools) === canonical((m193bBody.agent as { tools: unknown }).tools),
  // §31 — the I6 usability rule is not relaxed to preserve episodes.
  i6UsableDefinitionUnchanged: canonical(body.i6UsableDefinition) === canonical(m193bBody.i6UsableDefinition),
  // §24 — treatment isolation is not redesigned.
  treatmentIsolationUnchanged: canonical(body.treatmentIsolation) === canonical(m193bBody.treatmentIsolation),
  // §23 — the source-version authority is untouched by M193C.
  sourceVersionAuthorityUnchanged:
    canonical(body.sourceVersionAuthority) === canonical(m193bBody.sourceVersionAuthority),
  runValidityUnchanged: canonical(body.runValidity) === canonical(m193bBody.runValidity),
  corpusAdequacyUnchanged: canonical(body.corpusAdequacy) === canonical(m193bBody.corpusAdequacy),
  differencesConfinedToIntegrityScope: outsideScope.length === 0,
};

const manifestHash = sha256(canonical(body));
const manifest = {
  ...body,
  manifestHash,
  manifestHashRule:
    "sha256 over the canonical (recursively key-sorted) JSON of every field except manifestHash and manifestHashRule",
};
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);

const diff = {
  schemaVersion: "stage5.m193c.manifest-diff.v1",
  milestone: "M193C",
  oldManifestHash: declaredHash,
  newManifestHash: manifestHash,
  oldManifestHashVerified: true,
  addedLeaves: added.sort(),
  changedLeaves: changed.sort(),
  removedLeaves: removed.sort(),
  leavesOutsideIntegrityScope: outsideScope.sort(),
  invariants,
  allInvariantsHold: Object.values(invariants).every(Boolean),
};
writeFileSync(DIFF_OUT, `${JSON.stringify(diff, null, 2)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  old M193B manifestHash ${declaredHash}`);
console.log(`  new M193C manifestHash ${manifestHash}`);
console.log(`wrote ${DIFF_OUT}`);
console.log(
  `  added ${added.length}  changed ${changed.length}  removed ${removed.length}  outside scope ${outsideScope.length}`,
);
for (const [k, v] of Object.entries(invariants)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
