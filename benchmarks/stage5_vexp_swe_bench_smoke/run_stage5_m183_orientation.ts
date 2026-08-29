/**
 * M183 — produce ONE task's treatment, and the witness that it is the product's.
 *
 *   bun run_stage5_m183_orientation.ts <instanceId> <repoRoot> <outDir>
 *
 * The bytes arm B carries are not composed here. They are read off a real
 * default `run_pipeline` call over this run's own indexed workspace, framed
 * exactly as the live client frames it — `initialize`, then `tools/call`, over
 * Content-Length stdio — and taken from `structuredContent`, the surface M167
 * established the client consumes (§35). `content[0].text` is captured too, and
 * its identity with the structured payload is RECORDED rather than assumed, so
 * §36's "do not count transport duplication twice" has a measurement behind it.
 *
 * THE QUERY IS THE PRODUCT'S OWN, AND IT CANNOT SEE THE ANSWER.
 *
 * The task text comes from `deriveStructuredTaskFromProblemStatement`, the M103
 * derivation the live Stage 5 path already uses, applied to the SWE-bench
 * problem statement alone. §61: the gold patch, its files and its symbols are
 * not read by this script at all. It does not open the dataset's `patch` field.
 *
 * INDEX AUTHORITY (§12). The workspace's own index metadata is bound into the
 * witness — repo root, head commit, index run, derivation and schema versions,
 * freshness. An orientation generated against a stale or foreign index is not
 * this task's treatment, and the driver refuses to spawn on anything but a
 * DELIVERED or DECLINED verdict over a fresh index.
 *
 * SAVES NOTHING. `saveObservation: false`. A session observation written here
 * would make the treatment a function of how many times it was generated, which
 * is exactly the non-determinism M182 spent a milestone excluding.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { startMcpServer } from "../../src/mcp/startServer";
import {
  orientationWitness,
  renderOrientationSection,
  sha256,
  triggerContentForArm,
} from "./m183Treatment";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

interface Framed { readonly id: number; readonly result?: Record<string, unknown>; readonly error?: unknown }

function decodeFramed(buffer: Buffer): readonly Framed[] {
  const rows: Framed[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1] ?? -1);
    const bodyStart = headerEnd + 4;
    if (length < 0 || bodyStart + length > buffer.length) break;
    rows.push(JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")) as Framed);
    offset = bodyStart + length;
  }
  return rows;
}

/** One real default MCP orientation call, framed as the live client frames it. */
async function callOrientation(repoRoot: string, task: string): Promise<{
  structuredContent: unknown; contentText: string | null; isError: boolean;
}> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const server = startMcpServer({ repoPath: repoRoot, stdin, stdout, visibleToolIds: ["run_pipeline"] });
  const send = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]));
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m183-orientation", version: "1" } } });
  // No `detail`, no `max_tokens`: the SHIPPED DEFAULT is the treatment (§7).
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_pipeline", arguments: { task, repo_root: repoRoot, saveObservation: false } } });
  stdin.end();
  await server;

  const reply = decodeFramed(Buffer.concat(chunks)).find((row) => row.id === 2);
  if (reply === undefined) throw new Error("no MCP reply to the orientation call");
  const result = (reply.result ?? {}) as Record<string, unknown>;
  const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
  const text = typeof content[0]?.text === "string" ? (content[0].text as string) : null;
  return { structuredContent: result.structuredContent ?? null, contentText: text, isError: result.isError === true };
}

function indexAuthority(repoRoot: string): Record<string, unknown> {
  const metaPath = path.join(repoRoot, ".vtrace", "index.meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    return {
      present: true,
      metaPath,
      metaHash: sha256(readFileSync(metaPath, "utf8")),
      // Recorded whole rather than cherry-picked: which fields matter to
      // derivation compatibility is M146's question, not this script's.
      meta,
    };
  } catch (error) {
    return { present: false, metaPath, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const [instanceId, repoRoot, outDir] = process.argv.slice(2);
  if (instanceId === undefined || repoRoot === undefined || outDir === undefined) {
    process.stderr.write("usage: run_stage5_m183_orientation.ts <instanceId> <repoRoot> <outDir>\n");
    process.exit(2);
  }

  let problemStatement: string | null = null;
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement: string };
    if (row.instance_id === instanceId) { problemStatement = row.problem_statement; break; }
  }
  if (problemStatement === null) throw new Error(`instance not in corpus: ${instanceId}`);

  const derived = deriveStructuredTaskFromProblemStatement(problemStatement);
  const task = derived.taskText;

  const startedAt = new Date().toISOString();
  const call = await callOrientation(repoRoot, task);
  const finishedAt = new Date().toISOString();

  // structuredContent -> { schema, requestId, toolId, result: { ok, output } }
  const sc = call.structuredContent as Record<string, unknown> | null;
  const inner = sc !== null && typeof sc.result === "object" && sc.result !== null
    ? (sc.result as Record<string, unknown>) : null;
  const packet = inner === null ? null : inner.output ?? null;

  const witness = orientationWitness(packet);
  const section = witness.deliveryState === "ORIENTATION_ABSENT" ? null : renderOrientationSection(packet);

  mkdirSync(outDir, { recursive: true });
  const packetPath = path.join(outDir, `${instanceId}.packet.json`);
  const sectionPath = path.join(outDir, `${instanceId}.section.md`);
  const witnessPath = path.join(outDir, `${instanceId}.witness.json`);

  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  if (section !== null) writeFileSync(sectionPath, section);

  const contentText = call.contentText;
  const doc = {
    schemaVersion: "stage5.m183.treatment-witness.v1",
    milestone: "M183",
    instanceId,
    repoRoot,
    startedAt,
    finishedAt,
    query: {
      derivation: "deriveStructuredTaskFromProblemStatement (M103 structured derivation, Stage 5 live default)",
      taskText: task,
      taskHash: sha256(task),
      characters: task.length,
      goldConsulted: false,
      note: "§61 — derived from problem_statement alone. This script never reads the dataset's patch, test_patch, FAIL_TO_PASS or PASS_TO_PASS fields.",
    },
    call: {
      transport: "real MCP framed stdio through startMcpServer",
      tool: "run_pipeline",
      arguments: { task: "<taskText>", repo_root: repoRoot, saveObservation: false },
      detailArgument: "ABSENT — the shipped default IS the treatment",
      isError: call.isError,
    },
    transport: {
      // §36: measured, not assumed. If these agree, the duplicate is a transport
      // fact and not a second model-token charge.
      structuredContentPresent: sc !== null,
      contentTextPresent: contentText !== null,
      contentTextCharacters: contentText === null ? 0 : contentText.length,
      contentTextHash: contentText === null ? null : sha256(contentText),
      packetCharacters: witness.packetCharacters,
      // Which serialization the duplicate uses is the measurement §36 needs: if
      // the text channel carries the same bytes the structured channel does,
      // the duplicate is a transport fact and not a second model-token charge.
      contentTextMatchesCompactPacket:
        contentText !== null && packet !== null
        && contentText.trim() === JSON.stringify(packet).trim(),
      contentTextMatchesPrettyPacket:
        contentText !== null && packet !== null
        && contentText.trim() === JSON.stringify(packet, null, 2).trim(),
      injectedSectionCarriesTheDeliveredBytes:
        contentText !== null && packet !== null
        && renderOrientationSection(packet).includes(contentText.trim()),
    },
    indexAuthority: indexAuthority(repoRoot),
    witness,
    artifacts: {
      packet: path.relative(process.cwd(), packetPath),
      section: section === null ? null : path.relative(process.cwd(), sectionPath),
      witness: path.relative(process.cwd(), witnessPath),
    },
    injectedSectionPreview: section === null ? null : section.slice(0, 400),
  };
  writeFileSync(witnessPath, `${JSON.stringify(doc, null, 2)}\n`);

  // The trigger file the driver hands the treatment arm. Written only for a
  // delivery; an ABSENT verdict must not produce an injectable file, so a wiring
  // bug cannot silently ship an empty treatment.
  if (section !== null) {
    const trigger = triggerContentForArm("vtrace_orientation", packet);
    if (trigger === null) throw new Error("unreachable: treatment arm produced no trigger content");
    writeFileSync(path.join(outDir, `${instanceId}.trigger.md`), trigger);
  }

  console.log(`${instanceId}  ${witness.deliveryState}  focus=${witness.focusAt ?? "-"}  related=${witness.relatedAt.length}  tokens=${witness.orientationTokens}  hash=${(witness.semanticHash ?? "").slice(0, 12)}`);
  process.exit(witness.deliveryState === "ORIENTATION_ABSENT" ? 1 : 0);
}

await main();
