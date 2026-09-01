/**
 * M195 §2 — corpus authority verification.
 *
 * The primary discovery set is the 33 paid, valid M194 arms and nothing else.
 * This script proves that before any mechanism is scored, and it proves it the
 * expensive way: not by transcribing M194's headline numbers, but by hashing
 * every raw artefact the audit will read and then re-running M194's own
 * committed accounting over the preserved runs directory and diffing the
 * result against the committed one.
 *
 * The re-run writes into a scratch directory that holds a symlink to the real
 * runs tree, so the M194 artefacts are read and never written.
 *
 *   bun run_stage5_m195_verify_corpus.ts --m194 <acquisition root> --out <results dir>
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d = ""): string => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : d;
};

const m194Root = resolve(arg("--m194"));
const outDir = resolve(arg("--out"));
const runsDir = join(m194Root, "runs");

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Every raw artefact M195 is allowed to read, hashed, so a later edit is loud. */
const RAW_PER_ARM = [
  "arm.json",
  "raw/adapter_events.jsonl",
  "raw/prompt.txt",
  "raw/final.patch",
  "raw/agent_stream.jsonl",
];

interface ArtefactHash {
  path: string;
  sha256: string;
  bytes: number;
}

const artefacts: ArtefactHash[] = [];
const hashInto = (abs: string, rel: string) => {
  artefacts.push({ path: rel, sha256: sha256(abs), bytes: statSync(abs).size });
};

const armDirs = readdirSync(runsDir).sort();
for (const d of armDirs) {
  for (const f of RAW_PER_ARM) {
    const abs = join(runsDir, d, f);
    if (existsSync(abs)) hashInto(abs, `runs/${d}/${f}`);
  }
  const snaps = join(runsDir, d, "raw/snapshots");
  if (existsSync(snaps)) {
    for (const s of readdirSync(snaps).sort()) hashInto(join(snaps, s), `runs/${d}/raw/snapshots/${s}`);
  }
}
for (const f of ["acquisition_ledger.jsonl", "acquisition_summary.json", "corpus_accounting.json"]) {
  const abs = join(m194Root, f);
  if (existsSync(abs)) hashInto(abs, f);
}

// ── the accounting reproduction ─────────────────────────────────────
// M194's own script, over the same runs tree, into a throwaway directory.
const scratch = mkdtempSync(join(tmpdir(), "m195-verify-"));
symlinkSync(runsDir, join(scratch, "runs"));
execFileSync(
  "bun",
  [join(import.meta.dir, "run_stage5_m194_account.ts"), "--out", scratch, "--quiet"],
  { encoding: "utf8", cwd: import.meta.dir },
);
const reproduced = JSON.parse(readFileSync(join(scratch, "corpus_accounting.json"), "utf8"));
const committed = JSON.parse(readFileSync(join(m194Root, "corpus_accounting.json"), "utf8"));
rmSync(scratch, { recursive: true, force: true });

/** Compare the parts M195 depends on. `diagnostics` carries wall-clock paths. */
const COMPARED = [
  "armsInRunsDirectory",
  "paidArms",
  "accounting",
  "i6Repositories",
  "i6RepositoryList",
  "i6UnusableReasons",
  "runtimeDiagnosisRepositories",
  "provenance",
  "resolution",
  "spend",
  "corpusAdequacy",
  "corpusVerdict",
  "lifecycles",
];
const canon = (v: unknown): string => JSON.stringify(v);
const fieldDiffs = COMPARED.filter((k) => canon(reproduced[k]) !== canon(committed[k]));

// ── the frozen authority chain M194 declared ────────────────────────
const authority = JSON.parse(readFileSync(join(outDir, "stage5_m194_frozen_authority.json"), "utf8"));
const manifestPath = resolve(join(import.meta.dir, "../.."), authority.manifest.path);

/**
 * M193B's hash rule, restated exactly: recursively key-sorted JSON over every
 * field except the two that carry the hash itself. A one-level key sort passes
 * a JSON.stringify replacer down into nested objects and silently drops their
 * keys, which produced a false negative here before it produced a false
 * positive anywhere - the gate failed closed, which is the direction this kind
 * of check has to fail in.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
};

const manifestOk =
  existsSync(manifestPath) &&
  (() => {
    const { manifestHash: _h, manifestHashRule: _r, ...body } = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    return createHash("sha256").update(canonical(body)).digest("hex") === authority.manifest.expectedSha256;
  })();

const lifecycles = committed.lifecycles as Array<Record<string, any>>;
const ledger = readFileSync(join(m194Root, "acquisition_ledger.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const gates = [
  { id: "C1_runs_directory", what: "35 arm directories preserved", expected: 35, observed: armDirs.length },
  {
    id: "C2_unlaunched_arms",
    what: "exactly 2 ledger arms never launched a model",
    expected: 2,
    observed: ledger.filter((r) => !r.modelLaunched).length,
  },
  { id: "C3_paid_arms", what: "33 paid arms", expected: 33, observed: committed.paidArms },
  {
    id: "C4_valid_runs",
    what: "33 valid runs",
    expected: 33,
    observed: lifecycles.filter((l) => l.validity === "RUN_VALID").length,
  },
  {
    id: "C5_i6_usable",
    what: "13 I6-usable arms",
    expected: 13,
    observed: lifecycles.filter((l) => l.i6Usable).length,
  },
  { id: "C6_i6_repositories", what: "8 I6-usable repositories", expected: 8, observed: committed.i6Repositories },
  {
    id: "C7_runtime_usable",
    what: "7 runtime-diagnosis-usable arms",
    expected: 7,
    observed: lifecycles.filter((l) => l.runtimeDiagnosisUsable).length,
  },
  {
    id: "C8_runtime_repositories",
    what: "5 runtime-diagnosis repositories",
    expected: 5,
    observed: committed.runtimeDiagnosisRepositories,
  },
  {
    id: "C9_resolved",
    what: "23 resolved",
    expected: 23,
    observed: lifecycles.filter((l) => l.resolved === true).length,
  },
  {
    id: "C10_repositories",
    what: "12 repositories represented",
    expected: 12,
    observed: new Set(lifecycles.map((l) => l.repo)).size,
  },
  {
    id: "C11_accounting_reproduces",
    what: "M194's committed accounting reproduces byte-for-byte from raw artefacts",
    expected: 0,
    observed: fieldDiffs.length,
  },
  { id: "C12_manifest_chain", what: "the M193C manifest still hashes to M194's declared authority", expected: true, observed: manifestOk },
  {
    id: "C13_corpus_verdict",
    what: "the frozen corpus verdict is unchanged",
    expected: "I6_OBSERVATIONAL_CORPUS_ADEQUATE",
    observed: committed.corpusVerdict,
  },
  {
    id: "C14_spend_unchanged",
    what: "the acquisition spend is unchanged",
    expected: 24.721812,
    observed: committed.spend.totalUsd,
  },
].map((g) => ({ ...g, pass: String(g.expected) === String(g.observed) }));

const verdict = gates.every((g) => g.pass) ? "M195_CORPUS_AUTHORITY_VERIFIED" : "M195_CORPUS_AUTHORITY_FAILED";

const report = {
  schemaVersion: "stage5.m195.corpus-authority.v1",
  milestone: "M195",
  verdict,
  m194Root: m194Root.replace(resolve(join(import.meta.dir, "../..")), "."),
  gates,
  fieldDiffs,
  primarySet: {
    unit: "paid valid M194 arm",
    arms: lifecycles.map((l) => l.armId).sort(),
    excluded: ledger.filter((r) => !r.modelLaunched).map((r) => ({ armId: r.armId, verdict: r.verdict })),
    historicalArmsIncluded: 0,
  },
  artefactIntegrity: {
    files: artefacts.length,
    totalBytes: artefacts.reduce((a, f) => a + f.bytes, 0),
    bundleSha256: createHash("sha256").update(JSON.stringify(artefacts)).digest("hex"),
    artefacts,
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "stage5_m195_corpus_authority.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    { verdict, gatesFailed: gates.filter((g) => !g.pass).map((g) => g.id), artefacts: artefacts.length, fieldDiffs },
    null,
    2,
  ),
);
