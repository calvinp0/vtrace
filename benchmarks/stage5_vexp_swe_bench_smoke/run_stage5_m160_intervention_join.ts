/**
 * M160-D §58-§60 — join the intervention simulations across both corpora.
 *
 * §59 is the rule this enforces mechanically: a future functional milestone is
 * justified only if the proposed intervention can help BOTH corpora. An
 * intervention that recovers Broad100-A cases and nothing on an unfamiliar corpus
 * is not generalization, it is a fit to evidence we have already read.
 *
 * The same simulation runner produces both sides — M159's, unchanged — so the
 * intervention definitions, the delivery-ceiling measurement and the harm
 * accounting are identical by construction rather than by intent.
 *
 * The delivery ceiling is reported per corpus and not averaged. It is the
 * measurement that refutes the whole family of bound-widening proposals at once:
 * if nothing beyond ordinary rank R is ever delivered, admitting gold at R+k
 * cannot recover the case however large the pool becomes. Averaging two corpora's
 * ceilings would destroy exactly that argument.
 *
 * Reads committed artifacts. NO agent, NO Docker, NO network, NO indexing.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

interface Intervention {
  readonly id: string;
  readonly scope: string;
  readonly describe: string;
  readonly targets: readonly string[];
  readonly targetsAffected: number;
  readonly recovered: number;
  readonly recoveredInstances: readonly string[];
  readonly blockedByDeliveryCeiling: readonly string[];
  readonly repoCount: number;
  readonly verdict: string;
  readonly note: string;
}

interface SimulationDoc {
  readonly deliveryCeiling: Record<string, number>;
  readonly interventions: readonly Intervention[];
}

/**
 * §60 — an intervention is only recommendable when it recovers cases on BOTH
 * corpora. Everything else is named for what it is, so a zero on the unfamiliar
 * corpus cannot be quietly reported as "promising".
 */
export function crossCorpusVerdict(a: Intervention | undefined, b: Intervention | undefined): {
  verdict: string;
  rationale: string;
} {
  const aRecovered = a?.recovered ?? 0;
  const bRecovered = b?.recovered ?? 0;
  const aTargets = a?.targetsAffected ?? 0;
  const bTargets = b?.targetsAffected ?? 0;

  if (aTargets === 0 && bTargets === 0) {
    return { verdict: "NO_POPULATION", rationale: "neither corpus contains a case this intervention could act on" };
  }
  if (aRecovered === 0 && bRecovered === 0) {
    return {
      verdict: "REJECTED_BOTH_CORPORA",
      rationale: `recovers 0 of ${aTargets} on Broad100-A and 0 of ${bTargets} on Broad100-B`,
    };
  }
  if (aRecovered > 0 && bRecovered === 0) {
    return {
      verdict: "REJECTED_CORPUS_SPECIFIC",
      rationale:
        `recovers ${aRecovered}/${aTargets} on the corpus it was derived from and 0 of ${bTargets} on the ` +
        `independent one — §59 calls this a fit, not generalization`,
    };
  }
  if (aRecovered === 0 && bRecovered > 0) {
    return {
      verdict: "NEW_ON_B_ONLY",
      rationale: `recovers ${bRecovered}/${bTargets} on Broad100-B but nothing on Broad100-A; needs its own independent confirmation`,
    };
  }
  return {
    verdict: "RECOVERS_BOTH_CORPORA",
    rationale: `recovers ${aRecovered}/${aTargets} on Broad100-A and ${bRecovered}/${bTargets} on Broad100-B`,
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 ? fallback : (argv[index + 1] ?? fallback);
  };
  const aPath = get("--a", path.join(RESULTS, "stage5_m159_intervention_simulations.json"));
  const bPath = get("--b", path.join(RESULTS, "stage5_m160_broad100b_intervention_simulations.json"));
  const outPath = get("--out", path.join(RESULTS, "stage5_m160_intervention_simulations.json"));

  const a = JSON.parse(await readFile(aPath, "utf8")) as SimulationDoc;
  const b = JSON.parse(await readFile(bPath, "utf8")) as SimulationDoc;

  const ids = [...new Set([...a.interventions.map((i) => i.id), ...b.interventions.map((i) => i.id)])].sort();
  const joined = ids.map((id) => {
    const aRow = a.interventions.find((i) => i.id === id);
    const bRow = b.interventions.find((i) => i.id === id);
    const { verdict, rationale } = crossCorpusVerdict(aRow, bRow);
    return {
      intervention: id,
      scope: aRow?.scope ?? bRow?.scope ?? "unknown",
      describe: aRow?.describe ?? bRow?.describe ?? "",
      broad100a: {
        targets: aRow?.targetsAffected ?? 0,
        recovered: aRow?.recovered ?? 0,
        recoveredInstances: aRow?.recoveredInstances ?? [],
        blockedByDeliveryCeiling: aRow?.blockedByDeliveryCeiling ?? [],
        repoCount: aRow?.repoCount ?? 0,
        verdict: aRow?.verdict ?? "NOT_SIMULATED",
      },
      broad100b: {
        targets: bRow?.targetsAffected ?? 0,
        recovered: bRow?.recovered ?? 0,
        recoveredInstances: bRow?.recoveredInstances ?? [],
        blockedByDeliveryCeiling: bRow?.blockedByDeliveryCeiling ?? [],
        repoCount: bRow?.repoCount ?? 0,
        verdict: bRow?.verdict ?? "NOT_SIMULATED",
      },
      crossCorpusVerdict: verdict,
      rationale,
      recommend: verdict === "RECOVERS_BOTH_CORPORA",
    };
  });

  const doc = {
    schemaVersion: "stage5.m160.intervention-simulations.v1",
    milestone: "M160",
    kind: "cross-corpus intervention simulation (§58-§60)",
    rule:
      "§59 — an intervention is recommendable only if it can help BOTH corpora. Recovery on Broad100-A " +
      "alone is a fit to evidence five milestones have already read.",
    deliveryCeiling: {
      broad100a: a.deliveryCeiling,
      broad100b: b.deliveryCeiling,
      note:
        "Reported per corpus, never averaged. If nothing beyond ordinary rank R is ever delivered, " +
        "admitting gold at R+k recovers nothing however large the pool becomes — this measurement " +
        "refutes the entire bound-widening family at once (M159 standing finding).",
    },
    interventions: joined,
    recommended: joined.filter((row) => row.recommend).map((row) => row.intervention),
  };

  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`intervention join -> ${path.relative(REPO_ROOT, outPath)}`);
  for (const row of joined) {
    console.log(
      `  ${row.intervention.padEnd(30)} A ${row.broad100a.recovered}/${row.broad100a.targets}` +
        `  B ${row.broad100b.recovered}/${row.broad100b.targets}  ${row.crossCorpusVerdict}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
