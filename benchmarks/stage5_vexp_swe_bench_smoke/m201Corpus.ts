/**
 * M201 — controlled corpus materialisation for pre/post comparison.
 *
 * The frozen A5 instrument copies each corpus into a scratch directory and
 * indexes it ONCE, so every frozen measurement runs against an index with
 * exactly one run in `index_runs`. Reusing a scratch across invocations breaks
 * that: `index_repo` appends a run each time, and observation staleness then has
 * a real run chain to walk instead of the empty one the frozen measurement sees.
 * A profile taken on a reused scratch measures a code path the benchmark never
 * executes.
 *
 * Two properties are therefore required of every M201 measurement, and neither
 * is optional:
 *
 *   - exactly one index run, which means a working copy with no `.vtrace`;
 *   - byte-identical corpus content between the pre and post runs, which the
 *     frozen instrument cannot give because C-MED is this repository's own
 *     `src/` and a repair to the query path changes it.
 *
 * A snapshot taken once satisfies both: the working copy is re-materialised from
 * it for every run, so the corpus is frozen and the index is always new.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { SKIP_DIRS, prepareCorpus, type CorpusSpec } from "./m197aFixtures";

/**
 * Materialise the immutable snapshot if it is absent. Taken with the SAME copy
 * rule the frozen instrument uses, so the snapshot is what a frozen run would
 * have copied at the moment it was taken.
 */
export function ensureSnapshot(spec: CorpusSpec, snapshotRoot: string): string | null {
  return prepareCorpus(spec, snapshotRoot);
}

/**
 * A fresh working copy of the snapshot. Removed first: a leftover `.vtrace` is
 * the whole failure this exists to prevent, and reusing one silently would make
 * every later measurement disagree with the frozen instrument.
 */
export function materializeWorkingCopy(
  spec: CorpusSpec,
  snapshotRoot: string,
  workRoot: string,
): string | null {
  const snapshot = path.join(snapshotRoot, spec.id);
  if (!existsSync(snapshot)) return null;
  const work = path.join(workRoot, spec.id);
  rmSync(work, { recursive: true, force: true });
  cpSync(snapshot, work, {
    recursive: true, dereference: false,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)),
  });
  return work;
}

/**
 * A content fingerprint of a snapshot: the corpus identity a pre/post comparison
 * asserts is unchanged. Sorted relative paths with their sizes and a hash of the
 * concatenated bytes — enough that a corpus edited between the two runs cannot
 * be mistaken for the same one.
 */
export function snapshotFingerprint(spec: CorpusSpec, snapshotRoot: string): {
  files: number; bytes: number; sha256: string;
} | null {
  const root = path.join(snapshotRoot, spec.id);
  if (!existsSync(root)) return null;
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const content = readFileSync(full);
      hash.update(path.relative(root, full)).update("\0").update(content).update("\0");
      files += 1;
      bytes += content.byteLength;
    }
  };
  walk(root);
  return { files, bytes, sha256: hash.digest("hex") };
}
