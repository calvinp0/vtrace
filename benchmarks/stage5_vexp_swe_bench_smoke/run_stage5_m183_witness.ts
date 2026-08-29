/**
 * M183-B — consolidate the per-instance treatment witnesses into one committed
 * artifact (§81/§139).
 *
 *   bun run_stage5_m183_witness.ts
 *
 * The per-instance packets and sections live under `results/_m183_orientation/`,
 * which is untracked working output by repository convention. What has to
 * SURVIVE in the repository is the compact evidence: for every treatment task,
 * what was delivered, its semantic hash, its focus, its related identities, its
 * model-facing token count, and the transport measurement that says the injected
 * bytes were the delivered bytes.
 *
 * §136 is checked here rather than asserted: every stored packet is re-hashed
 * from disk and compared with the hash its witness recorded at generation time.
 * A packet that changed under the same task, index and product would fail this,
 * and M182's stability qualification says it must not.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { orientationWitness, renderOrientationSection, sha256 } from "./m183Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ORIENTATION_DIR = path.join(RESULTS, "_m183_orientation");

function main(): void {
  const manifest = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_sample_manifest.json"), "utf8")) as {
    executionOrder: { instanceId: string; repo: string; stratum: string }[];
  };

  const rows = manifest.executionOrder.map((target) => {
    const witnessPath = path.join(ORIENTATION_DIR, `${target.instanceId}.witness.json`);
    const packetPath = path.join(ORIENTATION_DIR, `${target.instanceId}.packet.json`);
    const triggerPath = path.join(ORIENTATION_DIR, `${target.instanceId}.trigger.md`);
    if (!existsSync(witnessPath)) {
      return { instanceId: target.instanceId, repo: target.repo, stratum: target.stratum,
        generated: false, deliveryState: "NOT_GENERATED" as const };
    }
    const doc = JSON.parse(readFileSync(witnessPath, "utf8")) as {
      witness: ReturnType<typeof orientationWitness>;
      query: { taskHash: string; characters: number; goldConsulted: boolean };
      transport: Record<string, unknown>;
      indexAuthority: { meta?: Record<string, unknown> };
      call: Record<string, unknown>;
    };
    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as unknown;
    const regenerated = orientationWitness(packet);
    const trigger = existsSync(triggerPath) ? readFileSync(triggerPath, "utf8") : null;

    return {
      instanceId: target.instanceId, repo: target.repo, stratum: target.stratum,
      generated: true,
      deliveryState: doc.witness.deliveryState,
      schemaVersion: doc.witness.schemaVersion,
      semanticHash: doc.witness.semanticHash,
      injectedSectionHash: doc.witness.injectedSectionHash,
      focusAt: doc.witness.focusAt, focusFile: doc.witness.focusFile,
      relatedAt: doc.witness.relatedAt, relatedFiles: doc.witness.relatedFiles,
      orientationTokens: doc.witness.orientationTokens,
      injectedSectionTokens: doc.witness.injectedSectionTokens,
      packetCharacters: doc.witness.packetCharacters,
      taskHash: doc.query.taskHash, taskCharacters: doc.query.characters,
      goldConsulted: doc.query.goldConsulted,
      detailArgument: doc.call.detailArgument,
      indexVtraceCommit: doc.indexAuthority.meta?.vtrace_commit ?? null,
      indexerFingerprint: doc.indexAuthority.meta?.indexer_fingerprint ?? null,
      transport: doc.transport,
      // §136 — re-derived now, from the stored packet.
      reproducibility: {
        semanticHashReproduced: regenerated.semanticHash === doc.witness.semanticHash,
        sectionHashReproduced: trigger === null ? null : sha256(trigger) === doc.witness.injectedSectionHash,
        sectionRerendersIdentically: trigger === null ? null : renderOrientationSection(packet) === trigger,
      },
    };
  });

  const generated = rows.filter((r) => r.generated);
  const delivered = generated.filter((r) => r.deliveryState === "ORIENTATION_DELIVERED");
  const reproduced = generated.filter((r) => r.reproducibility?.semanticHashReproduced === true
    && r.reproducibility?.sectionRerendersIdentically === true);
  const tokens = delivered.map((r) => r.orientationTokens!).sort((a, b) => a - b);
  const at = (q: number): number | null => tokens.length === 0 ? null : tokens[Math.min(tokens.length - 1, Math.floor((tokens.length - 1) * q))]!;

  const doc = {
    schemaVersion: "stage5.m183.treatment-witness.v1",
    milestone: "M183", workstream: "M183-B",
    manifestInstances: manifest.executionOrder.length,
    generated: generated.length,
    delivered: delivered.length,
    declined: generated.filter((r) => r.deliveryState === "ORIENTATION_DECLINED").length,
    absent: generated.filter((r) => r.deliveryState === "ORIENTATION_ABSENT").length,
    notGenerated: rows.length - generated.length,
    reproducibility: {
      checked: generated.length, reproduced: reproduced.length,
      allReproduced: generated.length > 0 && reproduced.length === generated.length,
      meaning: "§136 — every stored packet re-hashes to the value its witness recorded, and every section re-renders byte-identically from the packet. A change here under the same task, index and product would contradict M182's stability qualification.",
    },
    distinctSemanticHashes: new Set(delivered.map((r) => r.semanticHash)).size,
    orientationTokens: { median: at(0.5), p90: at(0.9), max: tokens.at(-1) ?? null, min: tokens[0] ?? null, n: tokens.length },
    m182Offline: { median: 1229, p90: 1527, max: 1576,
      note: "§47/§130 — a different sample legitimately gives a different median; a materially LARGER live packet is what would need investigating." },
    goldLeakage: {
      anyWitnessConsultedGold: generated.some((r) => r.goldConsulted === true),
      note: "§61 — the generator derives its query from the problem statement alone and never opens patch, test_patch, FAIL_TO_PASS or PASS_TO_PASS.",
    },
    detailArgumentAlwaysAbsent: generated.every((r) => r.detailArgument === "ABSENT — the shipped default IS the treatment"),
    rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m183_treatment_witness.json"), `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`M183 treatment witness — ${delivered.length} delivered, ${doc.declined} declined, ${doc.absent} absent, ${doc.notGenerated} not generated`);
  console.log(`  distinct semantic hashes: ${doc.distinctSemanticHashes} of ${delivered.length} delivered`);
  console.log(`  orientation tokens: median ${doc.orientationTokens.median}  p90 ${doc.orientationTokens.p90}  max ${doc.orientationTokens.max}`);
  console.log(`  reproducibility: ${reproduced.length}/${generated.length} re-derived identically`);
}

main();
