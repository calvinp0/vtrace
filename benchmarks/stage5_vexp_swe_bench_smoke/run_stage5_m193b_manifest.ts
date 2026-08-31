/**
 * M193B §18 — re-freeze the acquisition manifest around the changed-source
 * authority.
 *
 * Derived from the committed M193A manifest rather than regenerated beside it,
 * for the same reason M193A derived from M193: "the task fixture, model, caps
 * and stopping rule did not change" must be a mechanical fact. This script
 * verifies M193A's own manifest hash, deep-copies it, applies exactly the
 * changed-source fields, and diffs the two canonical forms so every difference
 * has to appear in the output.
 *
 * If it reports a difference outside the changed-source keys, that is a defect
 * in this script or an unauthorised change, and either way the acquisition is
 * not re-frozen.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193b_manifest.ts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY, M193_LIMITS } from "./m193Acquisition";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const M193A_MANIFEST = join(RESULTS, "stage5_m193a_manifest.json");
const OUT = join(RESULTS, "stage5_m193b_manifest.json");
const DIFF_OUT = join(RESULTS, "stage5_m193b_manifest_diff.json");

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

// ── the M193A manifest, verified rather than trusted ─────────────────

const m193a = JSON.parse(readFileSync(M193A_MANIFEST, "utf8")) as Record<string, unknown>;
const declaredHash = m193a.manifestHash as string;
const { manifestHash: _h, manifestHashRule: _r, ...m193aBody } = m193a;
const recomputed = sha256(canonical(m193aBody));
if (recomputed !== declaredHash) {
  console.error(`M193A manifest hash does not verify: declared ${declaredHash}, recomputed ${recomputed}`);
  process.exit(1);
}

const body = JSON.parse(JSON.stringify(m193aBody)) as Record<string, unknown>;

// ── the changed-source closure, and nothing else ─────────────────────

body.schemaVersion = "stage5.m193b.experiment-manifest.v1";
body.milestone = "M193B";
body.derivedFrom = {
  milestone: "M193A",
  manifestPath: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193a_manifest.json",
  manifestHash: declaredHash,
  hashVerifiedAtGeneration: true,
  statement:
    "The task fixture, model, agent, tool set, prompt, caps, concurrency, timeouts, preflight, replacement policy, retry policy, run-validity rule, adequacy thresholds, stopping rule, source-version verdict semantics, I6 usability rule and treatment-isolation construction are carried over unchanged. M193B replaces the command that enumerates the changed-source set the source-version authority is pointed at.",
};

const sva = body.sourceVersionAuthority as Record<string, unknown>;
sva.changedSourceScope = {
  rule: "every path in the working tree's current state that differs from the frozen base commit — staged, unstaged, both, untracked, deleted, and both sides of a rename — excluding the environment's own pre-agent untracked output",
  rationale:
    "A whole-repository freshness proof is neither necessary nor affordable. What a validation event is evidence ABOUT is the edited program, and the edited program is exactly this set (§16).",
  derivedFrom:
    "git -c core.fileMode=false diff --no-renames --name-only HEAD -- . <pre-agent exclusions>, unioned with git -c core.fileMode=false ls-files --others --exclude-standard -- . <pre-agent exclusions>, read from the checkout rather than from the harness's own bookkeeping",
  implementation: "changed_source_command() and parse_changed_source_output() in m193b_changed_source.py",
  supersedes: {
    derivedFrom: "git add -A -- . <exclusions>; git diff --cached --name-only; git reset -q",
    describedInM193AAs: "git diff --cached --name-only",
    defects: [
      "the observation wrote: `git reset` is a mixed reset, so each enumeration destroyed whatever the agent had staged",
      "rename detection is on by default since git 2.9 and --name-only prints only the destination of an R100, so the vacated path of a move left the changed set and could never reach the probe's sourceless-bytecode branch",
    ],
    reproducedOnRealContainers:
      "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193b_container_control.json",
  },
  nonMutating:
    "The authority reads three regions of Git state — index against base, worktree against index, and untracked — without writing any of them. Staging is never used as a query, so an arm's own index survives every observation (§3).",
  currentBytesAreAuthoritative:
    "The probe stats and reads the filesystem path, never the staged blob. A file staged as S1 and then edited to S2 is hashed as S2 (§8).",
  untrackedScope:
    "git ls-files --others --exclude-standard, so normal gitignore rules apply and files untracked before the agent existed are excluded by the pathspec built from setup()'s frozen pre-agent snapshot (§9, §10).",
  failsClosed:
    "Each half of the enumeration reports its own exit status. An enumeration that did not demonstrably complete yields probeRan=false and therefore UNKNOWN, never an empty changed set that would read as nothing-to-check.",
  changedSourceFileCount:
    "the size of the ENUMERATED set, read from the probe's requestedPaths. M193A took it from len(probe.files), the same array fileVerdicts is built from, which made classifySourceVersion's per-file completeness guard compare a list against itself.",
  controls: "benchmarks/stage5_vexp_swe_bench_smoke/m193bChangedSource.test.ts",
};
sva.implementation =
  "classifySourceVersion() in m193Acquisition.ts, over evidence from m193a_source_version_probe.py, enumerated by m193b_changed_source.py";

body.frozenSources = [
  ...((body.frozenSources as { path: string }[]) ?? []).map((f) => f.path),
  "benchmarks/stage5_vexp_swe_bench_smoke/m193b_changed_source.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193bChangedSource.test.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193b_container_control.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193b_manifest.ts",
]
  .filter((p, i, a) => a.indexOf(p) === i)
  .sort()
  .map((p) => ({ path: p, gitBlobSha1: blobHash(p) }));

// ── the difference, computed rather than described ───────────────────

const before = leaves(m193aBody);
const after = leaves(body);
const changed: string[] = [];
const added: string[] = [];
const removed: string[] = [];
for (const [k, v] of after) {
  if (!before.has(k)) added.push(k);
  else if (before.get(k) !== v) changed.push(k);
}
for (const k of before.keys()) if (!after.has(k)) removed.push(k);

/** Top-level keys the changed-source closure is allowed to touch. */
const SCOPE_KEYS = new Set(["schemaVersion", "milestone", "derivedFrom", "sourceVersionAuthority", "frozenSources"]);
const outsideScope = [...changed, ...added, ...removed].filter((k) => !SCOPE_KEYS.has(k.split(".")[0] ?? k));

// §17 — the frozen experiment, re-asserted against the code rather than
// against the old manifest, so a drift in either is caught.
const invariants = {
  taskFixtureSha256Unchanged:
    (body.taskFixture as { sha256: string }).sha256 === (m193aBody.taskFixture as { sha256: string }).sha256,
  armCountUnchanged: (body.taskFixture as { armCount: number }).armCount === 40,
  repositoriesUnchanged: (body.taskFixture as { repositoriesRepresented: number }).repositoriesRepresented === 12,
  modelUnchanged: (body.agent as { model: string }).model === "claude-opus-4-5-20251101",
  cliVersionUnchanged: (body.agent as { version: string }).version === "2.1.251",
  maxTurnsUnchanged: (body.agent as { maxTurns: number }).maxTurns === 250,
  perRunCapUnchanged: (body.limits as { perRunCostCapUsd: number }).perRunCostCapUsd === M193_LIMITS.perRunCostCapUsd && M193_LIMITS.perRunCostCapUsd === 3.5,
  totalCapUnchanged: (body.limits as { totalSpendCapUsd: number }).totalSpendCapUsd === M193_LIMITS.totalSpendCapUsd && M193_LIMITS.totalSpendCapUsd === 90,
  armBoundsUnchanged: M193_LIMITS.minArms === 20 && M193_LIMITS.maxArms === 40,
  concurrencyUnchanged: M193_LIMITS.maxConcurrentArms === 3,
  adequacyUnchanged:
    M193_ADEQUACY.adequate.i6UsableArms === 12 &&
    M193_ADEQUACY.adequate.repositoriesAmongI6Usable === 6 &&
    M193_ADEQUACY.adequate.validRuns === 30 &&
    M193_ADEQUACY.partial.i6UsableArms === 6 &&
    M193_ADEQUACY.partial.repositoriesAmongI6Usable === 4 &&
    M193_ADEQUACY.partial.validRuns === 15,
  stoppingRuleUnchanged: canonical(body.stoppingRule) === canonical(m193aBody.stoppingRule),
  promptUnchanged: canonical((body.agent as { userPrompt: unknown }).userPrompt) === canonical((m193aBody.agent as { userPrompt: unknown }).userPrompt),
  toolsUnchanged: canonical((body.agent as { tools: unknown }).tools) === canonical((m193aBody.agent as { tools: unknown }).tools),
  // §13 — the I6 usability rule is not touched by M193B.
  i6UsableDefinitionUnchanged: canonical(body.i6UsableDefinition) === canonical(m193aBody.i6UsableDefinition),
  // §16 — treatment isolation is not redesigned.
  treatmentIsolationUnchanged: canonical(body.treatmentIsolation) === canonical(m193aBody.treatmentIsolation),
  // §12 — verdict semantics are unchanged.
  sourceVersionStatesUnchanged:
    canonical((body.sourceVersionAuthority as { states: unknown }).states) ===
    canonical((m193aBody.sourceVersionAuthority as { states: unknown }).states),
  sourceVersionFileStatesUnchanged:
    canonical((body.sourceVersionAuthority as { fileStates: unknown }).fileStates) ===
    canonical((m193aBody.sourceVersionAuthority as { fileStates: unknown }).fileStates),
  differencesConfinedToChangedSourceScope: outsideScope.length === 0,
};

const manifestHash = sha256(canonical(body));
const manifest = {
  ...body,
  manifestHash,
  manifestHashRule: "sha256 over the canonical (recursively key-sorted) JSON of every field except manifestHash and manifestHashRule",
};
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);

const diff = {
  schemaVersion: "stage5.m193b.manifest-diff.v1",
  milestone: "M193B",
  oldManifestHash: declaredHash,
  newManifestHash: manifestHash,
  oldManifestHashVerified: true,
  addedLeaves: added.sort(),
  changedLeaves: changed.sort(),
  removedLeaves: removed.sort(),
  leavesOutsideChangedSourceScope: outsideScope.sort(),
  invariants,
  allInvariantsHold: Object.values(invariants).every(Boolean),
};
writeFileSync(DIFF_OUT, `${JSON.stringify(diff, null, 2)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  old M193A manifestHash ${declaredHash}`);
console.log(`  new M193B manifestHash ${manifestHash}`);
console.log(`wrote ${DIFF_OUT}`);
console.log(`  added ${added.length}  changed ${changed.length}  removed ${removed.length}  outside scope ${outsideScope.length}`);
for (const [k, v] of Object.entries(invariants)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
