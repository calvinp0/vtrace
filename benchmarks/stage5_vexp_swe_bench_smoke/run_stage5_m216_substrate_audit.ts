/**
 * M216 §9 — the mandatory substrate reduction audit, written BEFORE any adapter.
 *
 * Its output is a verdict and a table, and its purpose is to make one specific
 * mistake hard: reimplementing M193/M194's audited Python in TypeScript because
 * the executor happens to be TypeScript. Every obligation M215's interfaces
 * impose is matched here to the authority that already satisfies it, or is
 * named as a genuinely missing primitive.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m216_substrate_audit.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M216_SUBSTRATE_REDUCTION, reductionVerdict } from "./m216SubstrateAudit";
import { M216_BRIDGE_SCRIPT, M216_SUBSTRATE_PYTHON } from "./m216SubstrateBridge";

const RESULTS_DIR = join(import.meta.dir, "results");
const JSON_OUT = join(RESULTS_DIR, "stage5_m216_substrate_reduction.json");
const MD_OUT = join(RESULTS_DIR, "stage5_m216_substrate_reduction.md");

/** The Python authorities the audit claims to reuse, checked to be present. */
const CLAIMED_AUTHORITIES: readonly string[] = Object.freeze([
  "m193_container_adapter.py",
  "m193b_changed_source.py",
  "m193c_patch_snapshot.py",
  "m193a_source_version_probe.py",
  "run_stage5_m193_preflight.py",
  "run_stage5_m194_acquire.py",
  "m194_adapter_hooks.py",
  "m193aArmEnvironment.ts",
  M216_BRIDGE_SCRIPT,
]);

function commandVersion(binary: string, args: readonly string[]): string | null {
  try {
    return execFileSync(binary, [...args], { encoding: "utf8", timeout: 60_000 }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const verdict = reductionVerdict();
  const missingAuthorities = CLAIMED_AUTHORITIES
    .filter((name) => !existsSync(join(import.meta.dir, name)));

  const document = {
    schemaVersion: "stage5.m216.substrate-reduction.v1",
    milestone: "M216",
    generatedAt: new Date().toISOString(),
    verdict: missingAuthorities.length === 0
      ? verdict.verdict
      : "M216_SUBSTRATE_REDUCTION_INCOMPLETE",
    counts: {
      rows: verdict.rows,
      directReuse: verdict.directReuse,
      thinAdapter: verdict.thinAdapter,
      missingPrimitive: verdict.missingPrimitive,
    },
    unclassifiedObligations: verdict.unclassified,
    claimedAuthorities: CLAIMED_AUTHORITIES,
    missingAuthorities,
    substrateInterpreter: {
      path: M216_SUBSTRATE_PYTHON,
      present: existsSync(M216_SUBSTRATE_PYTHON),
      version: commandVersion(M216_SUBSTRATE_PYTHON, ["--version"]),
    },
    rows: M216_SUBSTRATE_REDUCTION,
  };

  writeFileSync(JSON_OUT, `${JSON.stringify(document, null, 2)}\n`);

  const lines: string[] = [
    "# M216 — substrate reduction audit",
    "",
    `**${document.verdict}**`,
    "",
    "Before any adapter was written, every obligation M215's three interfaces impose was matched",
    "to the authority that already satisfies it. The point is to make one mistake hard:",
    "reimplementing M193/M194's audited Python in TypeScript because the executor happens to be",
    "TypeScript. That would produce a second implementation of code that M192's workdir finding,",
    "M193's ancestry correction and bytecode-staleness hazard, M193B's rename loss, M193C's",
    "index-destroying snapshot and M194's termination categories were all written against, and",
    "every one of those defects would be re-openable in the copy.",
    "",
    `- DIRECT_REUSE: ${verdict.directReuse}`,
    `- THIN_ADAPTER: ${verdict.thinAdapter}`,
    `- MISSING_PRIMITIVE: ${verdict.missingPrimitive}`,
    "",
    "| obligation | M215 interface | existing authority | strategy |",
    "| --- | --- | --- | --- |",
    ...M216_SUBSTRATE_REDUCTION.map((row) =>
      `| ${row.obligation} | \`${row.m215Interface}\` | ${row.existingAuthority} | ${row.strategy} |`),
    "",
    "## Notes",
    "",
    ...M216_SUBSTRATE_REDUCTION.flatMap((row) => [`### ${row.obligation}`, "", row.note, ""]),
  ];
  writeFileSync(MD_OUT, `${lines.join("\n")}\n`);

  process.stdout.write(`${document.verdict}\n`);
  process.stdout.write(
    `${verdict.directReuse} DIRECT_REUSE, ${verdict.thinAdapter} THIN_ADAPTER, `
    + `${verdict.missingPrimitive} MISSING_PRIMITIVE; missing authorities `
    + `[${missingAuthorities.join(", ") || "none"}]\n`,
  );
  process.stdout.write(`wrote ${JSON_OUT} and ${MD_OUT}\n`);
}

await main();
