// Stage 5 M155-B2 — the fast stability gate, on derivation-valid evidence.
//
// LAYERING (M155 §20/§83)
// ------------------------
//   fast gate   (this file)  iteration / stability / regression OBSERVABILITY
//   broad100                 broad retrieval QUALITY at major checkpoints
//   paired30/100             agent UTILITY
//
// Three tools, three questions. This one exists to be run often, so it stays
// small — but "small" never again means "against whatever index happens to be on
// disk". Every case is checked by `gateIndexDerivation` before it is scored, and
// a case whose stored index disagrees with the implementation under evaluation is
// reported as invalid rather than migrated on open.
//
// The gate does not rebuild anything. Rebuilding is `run_stage5_m134_prepare_targets.ts`'s
// job, and keeping the two separate is what makes "the baseline is stale" a
// visible benchmark verdict instead of a silent repair.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO network.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runRetrievalEval, type RetrievalEvalFixtureEntry, type RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import { expectedDerivation, gateIndexDerivation, type DerivationVerdict } from "./indexDerivationGate";

export interface FastGateCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly workspace: string;
  readonly derivationValid: boolean;
  readonly derivationReason: string;
  readonly storedVtraceCommit: string | null;
  readonly storedFormatVersion: number | null;
}

export interface FastGateManifest {
  readonly schemaVersion: "stage5.m155.fast-gate.v1";
  readonly suite: string;
  readonly purpose: string;
  readonly corpusRoot: string;
  readonly expectedIndexerFingerprint: string;
  readonly expectedFormatVersion: number;
  readonly cases: number;
  readonly derivationValidCases: number;
  readonly derivationInvalidCases: number;
  readonly invalidByReason: Readonly<Record<string, number>>;
  readonly gateUsable: boolean;
  readonly caseDetail: readonly FastGateCase[];
}

/** Restrict a prepared fixture to a declared id set, preserving fixture order. */
export function restrictFixture(
  entries: readonly RetrievalEvalFixtureEntry[],
  ids: ReadonlySet<string>,
): RetrievalEvalFixtureEntry[] {
  return entries.filter((entry) => ids.has(entry.instance_id));
}

export async function auditDerivation(
  entries: readonly RetrievalEvalFixtureEntry[],
): Promise<{ verdicts: Map<string, DerivationVerdict>; expectedIndexerFingerprint: string; expectedFormatVersion: number }> {
  const expected = await expectedDerivation();
  const verdicts = new Map<string, DerivationVerdict>();
  for (const entry of entries) {
    verdicts.set(entry.instance_id, await gateIndexDerivation(path.resolve(entry.workspace), expected));
  }
  return {
    verdicts,
    expectedIndexerFingerprint: expected.indexer_fingerprint,
    expectedFormatVersion: expected.index_format_version,
  };
}

export function buildManifest(args: {
  readonly suite: string;
  readonly corpusRoot: string;
  readonly entries: readonly RetrievalEvalFixtureEntry[];
  readonly verdicts: ReadonlyMap<string, DerivationVerdict>;
  readonly expectedIndexerFingerprint: string;
  readonly expectedFormatVersion: number;
}): FastGateManifest {
  const caseDetail: FastGateCase[] = args.entries.map((entry) => {
    const verdict = args.verdicts.get(entry.instance_id)!;
    return {
      instance_id: entry.instance_id,
      repo: entry.repo,
      workspace: entry.workspace,
      derivationValid: verdict.valid,
      derivationReason: verdict.reason,
      storedVtraceCommit: verdict.storedVtraceCommit,
      storedFormatVersion: verdict.storedFormatVersion,
    };
  });
  const invalid = caseDetail.filter((c) => !c.derivationValid);
  const invalidByReason: Record<string, number> = {};
  for (const c of invalid) invalidByReason[c.derivationReason] = (invalidByReason[c.derivationReason] ?? 0) + 1;
  return {
    schemaVersion: "stage5.m155.fast-gate.v1",
    suite: args.suite,
    purpose: "iteration / stability / regression observability — NOT the broad quality authority (M155 §11/§83)",
    corpusRoot: args.corpusRoot,
    expectedIndexerFingerprint: args.expectedIndexerFingerprint,
    expectedFormatVersion: args.expectedFormatVersion,
    cases: caseDetail.length,
    derivationValidCases: caseDetail.length - invalid.length,
    derivationInvalidCases: invalid.length,
    invalidByReason,
    // The gate is only usable as a stability signal when every case's evidence is
    // derivation-valid. A partially valid suite mixes evidence regimes, which is
    // exactly the defect B2 exists to remove.
    gateUsable: invalid.length === 0,
    caseDetail,
  };
}

export interface FastGateSummary {
  readonly suite: string;
  readonly cases: number;
  readonly evaluated: number;
  readonly workspaceErrors: number;
  readonly top1: number;
  readonly top3: number;
  readonly goldDelivered: number;
  readonly goldDiscarded: number;
  readonly goldMissing: number;
  readonly meanTokens: number | null;
}

const rate = (hits: number, total: number): number => (total === 0 ? 0 : Math.round((hits / total) * 10000) / 10000);

export function summarizeFastGate(suite: string, rows: readonly RetrievalEvalRow[]): FastGateSummary {
  const evaluated = rows.filter((r) => r.result !== "workspace_error" && r.result !== "fixture_error");
  const n = evaluated.length;
  const tokens = evaluated.map((r) => r.estimated_tokens).filter((v): v is number => v !== null);
  return {
    suite,
    cases: rows.length,
    evaluated: n,
    workspaceErrors: rows.filter((r) => r.result === "workspace_error").length,
    top1: rate(evaluated.filter((r) => r.contains_expected_file_top1).length, n),
    top3: rate(evaluated.filter((r) => r.contains_expected_file_top3).length, n),
    goldDelivered: rate(
      evaluated.filter((r) => r.expected_file_role === "pivot" || r.expected_file_role === "support").length, n),
    goldDiscarded: rate(evaluated.filter((r) => r.expected_file_role === "discarded").length, n),
    goldMissing: rate(evaluated.filter((r) => r.expected_file_role === "missing").length, n),
    meanTokens: tokens.length > 0
      ? Math.round(tokens.reduce((s, v) => s + v, 0) / tokens.length)
      : null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${flag} is required.`);
    }
    return argv[i + 1]!;
  };
  const preparedFixture = get("--prepared-fixture");
  const idsFile = get("--ids");
  const suite = get("--suite", "frozen50");
  const outDir = get("--out-dir");
  const reportName = get("--report-name", `stage5_m155_fast_gate_${suite}`);

  const prepared = JSON.parse(await Bun.file(preparedFixture).text()) as RetrievalEvalFixtureEntry[];
  const ids = new Set(
    (JSON.parse(await Bun.file(idsFile).text()) as Array<{ instance_id: string }>).map((e) => e.instance_id),
  );
  const entries = restrictFixture(prepared, ids);
  if (entries.length !== ids.size) {
    throw new Error(`prepared fixture covers ${entries.length} of ${ids.size} declared suite ids.`);
  }

  const audit = await auditDerivation(entries);
  const manifest = buildManifest({
    suite,
    corpusRoot: path.dirname(path.resolve(entries[0]!.workspace)),
    entries,
    verdicts: audit.verdicts,
    expectedIndexerFingerprint: audit.expectedIndexerFingerprint,
    expectedFormatVersion: audit.expectedFormatVersion,
  });
  await writeFile(path.join(outDir, "stage5_m155_fast_gate_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${suite}: ${manifest.derivationValidCases}/${manifest.cases} derivation-valid, gateUsable=${manifest.gateUsable}\n`,
  );

  const scratch = await mkdtemp(path.join(tmpdir(), "m155-fast-gate-"));
  const fixturePath = path.join(scratch, `${suite}.json`);
  await writeFile(fixturePath, `${JSON.stringify(entries, null, 1)}\n`);

  const artifact = await runRetrievalEval({
    fixture: fixturePath,
    out: outDir,
    reportName,
    artifactState: manifest.gateUsable ? "authoritative" : "exploratory",
    fixtureIdentityPath: idsFile,
  });
  const summary = summarizeFastGate(suite, artifact.rows);
  await writeFile(
    path.join(outDir, `${reportName}_summary.json`),
    `${JSON.stringify({ schemaVersion: "stage5.m155.fast-gate-summary.v1", manifestUsable: manifest.gateUsable, summary }, null, 2)}\n`,
  );
  process.stdout.write(
    `${suite}: evaluated=${summary.evaluated}/${summary.cases} top1=${summary.top1} `
    + `delivered=${summary.goldDelivered} discarded=${summary.goldDiscarded} missing=${summary.goldMissing}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
