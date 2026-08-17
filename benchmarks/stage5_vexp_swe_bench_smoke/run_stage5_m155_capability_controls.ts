// Stage 5 M155-B2 — capability observability controls.
//
// WHY THIS EXISTS
// ----------------
// B2's requirement (M155 §22) is not that these lanes must improve a score. It is
// that the benchmark must never report "unchanged" merely because the index it
// read lacks the evidence the lane consumes. The committed baselines did exactly
// that: they scored current code against indexes whose `document_chunks` and
// `symbol_mechanism_facts` tables were empty and whose `<module>` symbols did not
// exist, then labelled the result authoritative.
//
// So each capability gets a KNOWN-NEGATIVE checkpoint (evidence provably absent)
// and a KNOWN-POSITIVE checkpoint (evidence provably present) over the SAME source
// file, and the control passes only when the probe actually separates them. A
// control that cannot tell the two apart is a blind spot, and is reported as one.
//
// No thresholds are invented (§23): the assertion is "the difference is
// observable", never "the difference is an improvement".
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO network.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

/** Counting probes over a stored index. Each returns null when the capability's
 *  table does not exist at all — an era difference, not a zero. */
export type CapabilityProbe = (db: Database) => number | null;

function tableExists(db: Database, table: string): boolean {
  const row = db.query<{ n: number }, []>(
    `select count(*) as n from sqlite_master where type='table' and name='${table}'`,
  ).get();
  return (row?.n ?? 0) > 0;
}

function countOf(table: string): CapabilityProbe {
  return (db) => {
    if (!tableExists(db, table)) return null;
    return db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()?.n ?? 0;
  };
}

export const PROBES: Readonly<Record<string, CapabilityProbe>> = {
  document_chunks: countOf("document_chunks"),
  symbol_mechanism_facts: countOf("symbol_mechanism_facts"),
  /** M140's structural module scope. Deliberately NOT an INDEX_CAPABILITIES flag —
   *  the product documents that no truthful cheap probe distinguishes "index
   *  predates M140" from "repository has no module-scope imports". A BENCHMARK can
   *  still observe it, because it compares two derivations of the SAME source. */
  module_symbols: (db) => {
    if (!tableExists(db, "symbols")) return null;
    return db.query<{ n: number }, []>("select count(*) as n from symbols where kind='module'").get()?.n ?? 0;
  },
};

export interface CapabilityControl {
  readonly capability: string;
  readonly probe: string;
  readonly rationale: string;
  readonly negativeCheckpoint: string;
  readonly positiveCheckpoint: string;
  readonly negativeValue: number | null;
  readonly positiveValue: number | null;
  readonly observable: boolean;
  readonly note: string;
}

export function evaluateControl(args: {
  readonly capability: string;
  readonly probe: string;
  readonly rationale: string;
  readonly negativeCheckpoint: string;
  readonly positiveCheckpoint: string;
  readonly negativeIndex: string;
  readonly positiveIndex: string;
}): CapabilityControl {
  const probe = PROBES[args.probe];
  if (probe === undefined) throw new Error(`unknown probe: ${args.probe}`);
  const read = (indexPath: string): number | null => {
    if (!existsSync(indexPath)) return null;
    const db = new Database(indexPath, { readonly: true });
    try {
      return probe(db);
    } finally {
      db.close();
    }
  };
  const negativeValue = read(args.negativeIndex);
  const positiveValue = read(args.positiveIndex);
  // Observable means the probe SEPARATES the two eras. A missing table on the
  // negative side counts as separation (null vs a count is a real difference);
  // two equal numbers do not.
  const observable = negativeValue !== positiveValue;
  return {
    capability: args.capability,
    probe: args.probe,
    rationale: args.rationale,
    negativeCheckpoint: args.negativeCheckpoint,
    positiveCheckpoint: args.positiveCheckpoint,
    negativeValue,
    positiveValue,
    observable,
    note: observable
      ? `probe separates ${args.negativeCheckpoint} (${negativeValue ?? "table absent"}) from ${args.positiveCheckpoint} (${positiveValue ?? "table absent"})`
      : `BLIND SPOT: probe reports the same value (${negativeValue}) at both checkpoints`,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[i + 1]!;
  };
  const corpora = get("--corpora-root");
  const staleIndex = get("--stale-index");
  const control = get("--control-instance");
  const outFile = get("--out");

  const idx = (checkpoint: string): string =>
    path.join(corpora, checkpoint, control, ".vtrace", "index.sqlite");

  const controls: CapabilityControl[] = [
    evaluateControl({
      capability: "document lane",
      probe: "document_chunks",
      rationale: "M129 document-aware retrieval consumes document_chunks; the committed baselines had 0 rows.",
      negativeCheckpoint: "committed 2026-06-08 baseline index (pre-M129)",
      positiveCheckpoint: "M129",
      negativeIndex: staleIndex,
      positiveIndex: idx("m129"),
    }),
    evaluateControl({
      capability: "structural module / import-owner lane",
      probe: "module_symbols",
      rationale: "M140-A made a module-scope symbol own imports; absent before it.",
      negativeCheckpoint: "M129",
      positiveCheckpoint: "M140",
      negativeIndex: idx("m129"),
      positiveIndex: idx("m140"),
    }),
    evaluateControl({
      capability: "mechanism-fact / operation-fact lane",
      probe: "symbol_mechanism_facts",
      rationale: "M150 decision-bearing mechanism facts; the table does not exist before M150.",
      negativeCheckpoint: "M140",
      positiveCheckpoint: "M150",
      negativeIndex: idx("m140"),
      positiveIndex: idx("m150"),
    }),
  ];

  // Delivery/discard movement is a property of retrieval OUTPUT, not of a stored
  // index, so its control comes from the committed broad checkpoints rather than
  // from a table probe. It is the control that matters most after M150: that
  // transition moved gold from missing into discarded, and a benchmark unable to
  // see the discard bucket would have called it a straight improvement.
  const checkpointsFile = get("--checkpoints");
  const checkpoints = (JSON.parse(await Bun.file(checkpointsFile).text()) as {
    checkpoints: Array<{ label: string; goldDelivered: number; goldDiscarded: number; missingGold: number }>;
  }).checkpoints;
  const at = (label: string) => checkpoints.find((c) => c.label === label);
  const m140 = at("M140");
  const m150 = at("M150");
  const deliveryControl: CapabilityControl = {
    capability: "delivery / discard-state movement",
    probe: "broad100 goldDiscarded rate",
    rationale:
      "M150 moved gold from missing into discarded without delivering it. A benchmark that collapses "
      + "discovered-but-discarded into successful retrieval reports that as an improvement.",
    negativeCheckpoint: "M140",
    positiveCheckpoint: "M150",
    negativeValue: m140?.goldDiscarded ?? null,
    positiveValue: m150?.goldDiscarded ?? null,
    observable: (m140?.goldDiscarded ?? null) !== (m150?.goldDiscarded ?? null),
    note:
      `discarded ${m140?.goldDiscarded ?? "n/a"} -> ${m150?.goldDiscarded ?? "n/a"} while delivered `
      + `${m140?.goldDelivered ?? "n/a"} -> ${m150?.goldDelivered ?? "n/a"} and missing `
      + `${m140?.missingGold ?? "n/a"} -> ${m150?.missingGold ?? "n/a"}`,
  };
  controls.push(deliveryControl);

  const artifact = {
    schemaVersion: "stage5.m155.capability-controls.v1",
    principle:
      "A benchmark may not report 'unchanged' when the index it read lacks the evidence the lane consumes. "
      + "Each capability is separated by a probe across a known-negative and known-positive checkpoint over the same source file.",
    controlInstance: control,
    corporaRoot: corpora,
    staleIndex,
    controls,
    allObservable: controls.every((c) => c.observable),
    blindSpots: controls.filter((c) => !c.observable).map((c) => c.capability),
  };
  await writeFile(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
  for (const c of controls) {
    process.stdout.write(`${c.observable ? "OBSERVABLE" : "BLIND     "}  ${c.capability}: ${c.note}\n`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
