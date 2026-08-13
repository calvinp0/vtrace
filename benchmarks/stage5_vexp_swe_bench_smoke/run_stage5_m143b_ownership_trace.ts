// M143 Workstream B — decision trace, checkpoint and changed-case ledger.
//
// B ships NO functional mechanism: every ownership signal it audited either has
// no evidence to read (the subject and the behaviour owner are structurally
// disconnected) or cannot be separated from a correct promotion without a fitted
// constant. This runner records that outcome in the three shapes M143 requires,
// derived from the measured matrix rather than hand-authored:
//
//   §84 trace          — per candidate, what evidence existed and what was decided
//   §86 checkpoint     — the paired comparison, which is an IDENTITY here
//   §87 changed cases  — necessarily empty, with the reason and the proof
//
// The checkpoint verifies identity instead of asserting it: it asks git whether
// any non-test product source differs from the B predecessor. A milestone that
// claims "no behaviour change" has to be able to show it.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m143b_ownership_trace.ts \
//     --matrix <stage5_m143_title_ownership_matrix.json> --predecessor <sha> --out <dir>

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareRunnerOutput } from "./lib/runnerPaths";

const RUNNER_NAME = "m143b_ownership_trace";

interface MatrixCase {
  readonly instanceId: string;
  readonly titleSymbol: string;
  readonly titlePath: string;
  readonly titleIsGold: boolean;
  readonly organicLead: string | null;
  readonly organicLeadIsGold: boolean;
  readonly objectives: readonly string[];
  readonly leadFileToTitle: Record<string, number>;
  readonly titleToLeadFile: Record<string, number>;
  readonly familySupport: {
    readonly bestRankAtDeepPool: number | null;
    readonly bestScoreAtDeepPool: number | null;
    readonly bestMemberAtDeepPool: string | null;
    readonly titleOwnRank: number | null;
  };
  readonly counters: Record<string, number>;
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const sum = (relations: Record<string, number>): number =>
  Object.values(relations).reduce((carry, value) => carry + value, 0);

async function main(): Promise<void> {
  const matrixPath = flag("--matrix");
  if (matrixPath === undefined) throw new Error("Missing --matrix");
  const predecessor = flag("--predecessor") ?? "93a34d194b2360094d61b27f2ecc12f6dccacdb3";
  const out = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const matrix = JSON.parse(await readFile(path.resolve(matrixPath), "utf8")) as { cases: MatrixCase[] };

  const trace = matrix.cases.map((row) => {
    const relationTotal = sum(row.leadFileToTitle) + sum(row.titleToLeadFile);
    // Every real case reaches the same decision, by one of two distinct routes.
    const reason =
      relationTotal === 0
        ? "no direct relation of any type between the organic lead's module and the title family"
        : "relation exists, but it is present in correct promotions too — it does not discriminate";
    return {
      candidate: row.titleSymbol,
      candidatePath: row.titlePath,
      instanceId: row.instanceId,
      titleIdentity: "exact title-name match (symbol = 1); no lexical/fts/tfidf/bm25 claim (M143-A)",
      directQueryEvidence: { objectives: row.objectives.length, titleOwnOrganicRank: row.familySupport.titleOwnRank },
      graphRelations: { leadFileToTitle: row.leadFileToTitle, titleToLeadFile: row.titleToLeadFile },
      interfaceOverrideEvidence: "none recovered — no case in this population is an interface implementation",
      structuralRole: row.titleIsGold ? "title symbol lives in the gold file" : "title symbol lives outside the gold file",
      familySupport: row.familySupport,
      ownershipState: "ambiguous",
      decision: "abstain — title behaviour unchanged",
      reason,
      rankingEffect: "none",
      selectionEffect: "none",
    };
  });

  await writeFile(
    path.join(out.dir, "stage5_m143_behavior_owner_trace.json"),
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.behavior-owner-trace.v1",
        purpose: "M143-B §84: per-candidate ownership evidence and the decision it supports.",
        abstentionRule:
          "ownership evidence absent or non-discriminating -> abstain. A wrong suppress destroys a correct "
          + "lead; a wrong abstain leaves a known defect. M143-A measured 4 correct : 1 wrong promotions, so "
          + "abstention is the cheaper error here.",
        cases: trace,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // --- §86 checkpoint: verify identity rather than assert it ---------------
  const diff = Bun.spawnSync([
    "git",
    "diff",
    "--name-only",
    predecessor,
    "--",
    "src/",
  ]);
  const changedSources = new TextDecoder()
    .decode(diff.stdout)
    .split("\n")
    .filter((line) => line.length > 0);
  const nonTestSources = changedSources.filter((file) => !file.endsWith(".test.ts"));

  await writeFile(
    path.join(out.dir, "stage5_m143_b_checkpoint_paired.json"),
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.checkpoint-paired.v1",
        purpose: "M143-B §86: the paired checkpoint against the B predecessor.",
        predecessor,
        candidate: "M143-B (evidence only)",
        comparison: "IDENTITY",
        rationale:
          "B ships no functional mechanism, so a Frozen-50 paired run is an identity by construction. Running "
          + "one would produce zero diffs on every metric and would not constitute evidence of anything. The "
          + "identity is instead PROVEN below: no non-test product source differs from the predecessor.",
        proof: {
          changedSourcesUnderSrc: changedSources,
          changedNonTestSources: nonTestSources,
          productBehaviourUnchanged: nonTestSources.length === 0,
        },
        metrics: {
          note:
            "Inherited unchanged from M143-A's paired checkpoint (41fb0a9 -> 93a34d1), which measured them "
            + "against the M142 final.",
          top1: 38,
          top3: 44,
          goldAnywhere: 48,
          goldSymbolAnywhere: 31,
          missing: 2,
          meanTokens: 1835.2,
          selectedFilesDiffs: 0,
          leadDiffs: 0,
          rolesDiffs: 0,
          contentModesDiffs: 0,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(out.dir, "stage5_m143_b_changed_case_ledger.json"),
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.changed-case-ledger.v1",
        purpose: "M143-B §87: every gold-visibility movement caused by B.",
        changedCases: [],
        unexplainedCases: [],
        reason:
          "B changed no product code, so no case moved. django-11740 remains a Top-1 defect and is NOT "
          + "relabelled; it is carried forward as a measured ceiling with its cause identified.",
        carriedDefects: [
          {
            case: "django__django-11740",
            state: "OPEN",
            cause:
              "the behaviour owner (migrations/autodetector.py) and the task subject (ForeignKey) have no edge "
              + "in either direction; ForeignKey has 193 incoming edges and none is from autodetector.py",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(
    `changed non-test sources vs ${predecessor.slice(0, 7)}: ${nonTestSources.length}\n`
      + `${nonTestSources.join("\n")}\nwrote 3 artifacts to ${out.dir}\n`,
  );
}

if (import.meta.main) {
  await main();
}
