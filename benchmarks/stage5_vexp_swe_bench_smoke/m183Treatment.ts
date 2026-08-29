/**
 * M183 treatment definitions — two arms, and the manipulated variable is the
 * PRODUCT's own orientation packet rather than any policy about it.
 *
 *   A  BASELINE              the ordinary coding agent, ordinary tools, nothing else
 *   B  VTRACE_ORIENTATION    the same agent, same tools, plus one automatically
 *                            delivered current compact orientation packet
 *
 * WHY THIS IS NOT M173's ARM B.
 *
 * M173 delivered orientation through `M168_MANDATE_TEXT`, which says "call
 * `run_pipeline` FIRST" and "ALWAYS FIRST". M183 §7 forbids exactly that
 * sentence, and forbids the tool-denial, the anti-loop reminder and the
 * repeated-use instruction alongside it. So the M173 wiring cannot be reused: a
 * mandate is a prompt-policy bundle, and §7 says the treatment is the product.
 *
 * §6 additionally holds the TOOL ENVIRONMENT fixed across arms. Read with §7
 * that leaves exactly one shape for arm B: identical tools, identical prompt,
 * plus one section carrying the packet the product would have produced. The
 * agent is told nothing about what to do with it.
 *
 * WHY NOT "OFFER THE MCP TOOL AND SEE".
 *
 * M164 measured 0 voluntary reuse across 12 tasks. An uncoerced tool arm would
 * therefore deliver orientation on approximately no task, and §82 requires a
 * validated witness that orientation REACHED the model. That arm measures
 * adoption; M183 asks about utility. The distinction is recorded here rather
 * than resolved silently.
 *
 * WHAT ARM B DELIVERS, EXACTLY.
 *
 * The bytes are not re-derived here. They are the `structuredContent.result.
 * output` of a real default `run_pipeline` call over this run's own indexed
 * workspace — the same surface M167 established the live client consumes and
 * the same one M182 proved deterministic. This module renders that packet into
 * a prompt section and computes its witness; it never computes a packet.
 *
 * THE DELIVERY CHANNEL IS INHERITED, NOT INVENTED.
 *
 * `VTRACE_TASK_TRIGGER_FILE` appends the section last, under the frozen M163
 * heading, and is the same channel M168 and M173 used. Keeping it unchanged is
 * what makes §129's historical comparison a comparison of payloads rather than
 * of transports.
 *
 * PURE. No I/O, no clock, no randomness. The sample draw is a deterministic
 * function of (pool, seed) via SHA-256 ordering, so §19's "reproducible
 * protocol" is a property of the code and not of a saved output.
 */

import { createHash } from "node:crypto";

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export const M183_ARMS = Object.freeze(["baseline", "vtrace_orientation"] as const);
export type M183Arm = (typeof M183_ARMS)[number];

// ── the injected section ────────────────────────────────────────────

/**
 * The only prose arm B carries.
 *
 * Every clause is either provenance or a boundary. There is no imperative verb
 * addressed to the agent anywhere in it, which is the mechanical form of §7:
 * the section cannot instruct because it contains no instruction. It also does
 * not name VTRACE, a tool, or a benchmark arm.
 *
 * "produced before this session began" is load-bearing. Without it the packet
 * reads as something the agent asked for and may be trusted accordingly; with
 * it, the agent knows it is inherited material of unstated reliability.
 */
export const M183_ORIENTATION_PREAMBLE =
  "The block below was generated automatically from a static index of this worktree "
  + "before this session began. It is provided as reference material.";

/**
 * Rendered exactly, so the injected bytes are a pure function of the packet.
 *
 * COMPACT, not pretty-printed. `content[0].text` on a real default MCP reply is
 * `JSON.stringify(packet)` with no indentation, and that is measured rather than
 * assumed — see the transport block in the witness. Pretty-printing the same
 * packet costs 24% more characters, which would make arm B's treatment more
 * expensive than the product's own delivery and would put §47's comparison
 * against M182's measured packet sizes against a payload M182 never measured.
 */
export function renderOrientationSection(packet: unknown): string {
  return `${M183_ORIENTATION_PREAMBLE}\n\n\`\`\`json\n${JSON.stringify(packet)}\n\`\`\`\n`;
}

/**
 * What the baseline arm carries. Not `""` — the ABSENCE is produced by emitting
 * no environment at all, so that a bug which writes an empty trigger file is
 * distinguishable from an arm that was correctly given nothing.
 */
export function triggerContentForArm(arm: M183Arm, packet: unknown): string | null {
  return arm === "baseline" ? null : renderOrientationSection(packet);
}

// ── treatment witness ───────────────────────────────────────────────

export const ORIENTATION_SCHEMA_VERSION = "run_pipeline.orientation/1";

/**
 * M166's measured calibration for serialized tool-result JSON. Imported by
 * value rather than from the product module so the benchmark cannot silently
 * change the product's own token accounting; the equality is asserted in the
 * test.
 */
export const TOKENS_PER_CHARACTER = 0.3174032272551657;

export type DeliveryState =
  /** A resolved compact packet reached the prompt. */
  | "ORIENTATION_DELIVERED"
  /** The projector declined; a bounded truthful decline reached the prompt. */
  | "ORIENTATION_DECLINED"
  /** Generation produced nothing usable; the arm is INVALID, not "empty". */
  | "ORIENTATION_ABSENT";

export interface OrientationWitness {
  readonly deliveryState: DeliveryState;
  readonly schemaVersion: string | null;
  /** SHA-256 of the packet itself — §136's reproducibility check. */
  readonly semanticHash: string | null;
  /** SHA-256 of the exact injected section, including the preamble. */
  readonly injectedSectionHash: string | null;
  readonly focusAt: string | null;
  readonly focusFile: string | null;
  readonly relatedAt: readonly string[];
  readonly relatedFiles: readonly string[];
  /** Model-facing tokens of the packet, by the product's own calibration. */
  readonly orientationTokens: number;
  /** Model-facing tokens of the whole injected section, preamble included. */
  readonly injectedSectionTokens: number;
  readonly packetCharacters: number;
  readonly injectedSectionCharacters: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const tokensOf = (text: string): number =>
  Math.max(0, Math.round(text.length * TOKENS_PER_CHARACTER));

/**
 * Build the witness from the packet the MCP server actually returned.
 *
 * Fails to ABSENT rather than to a zero-valued delivery, for M167's reason: an
 * unobservable is recorded as unobservable, never scored as an absence. A
 * packet without the schema version is not assumed compact.
 */
export function orientationWitness(packet: unknown): OrientationWitness {
  const empty = {
    schemaVersion: null, semanticHash: null, injectedSectionHash: null,
    focusAt: null, focusFile: null, relatedAt: [] as string[], relatedFiles: [] as string[],
    orientationTokens: 0, injectedSectionTokens: 0,
    packetCharacters: 0, injectedSectionCharacters: 0,
  };
  if (!isRecord(packet)) return Object.freeze({ deliveryState: "ORIENTATION_ABSENT", ...empty });

  const packetJson = JSON.stringify(packet);
  const section = renderOrientationSection(packet);
  const schemaVersion = asString(packet.schemaVersion);
  const focus = isRecord(packet.focus) ? packet.focus : null;
  const related = Array.isArray(packet.related) ? packet.related.filter(isRecord) : [];

  const common = {
    schemaVersion,
    semanticHash: sha256(packetJson),
    injectedSectionHash: sha256(section),
    focusAt: focus === null ? null : asString(focus.at),
    focusFile: focus === null ? null : asString(focus.file),
    relatedAt: Object.freeze(related.map((r) => asString(r.at)).filter((v): v is string => v !== null)),
    relatedFiles: Object.freeze(related.map((r) => asString(r.file)).filter((v): v is string => v !== null)),
    orientationTokens: tokensOf(packetJson),
    injectedSectionTokens: tokensOf(section),
    packetCharacters: packetJson.length,
    injectedSectionCharacters: section.length,
  };

  if (schemaVersion === ORIENTATION_SCHEMA_VERSION && focus !== null) {
    return Object.freeze({ deliveryState: "ORIENTATION_DELIVERED", ...common });
  }
  // A resolved:false / reason-bearing envelope is M176's bounded truthful
  // decline. It IS a delivery of the current product; it is simply not a packet.
  if (packet.resolved === false || asString(packet.reason) !== null) {
    return Object.freeze({ deliveryState: "ORIENTATION_DECLINED", ...common });
  }
  return Object.freeze({ deliveryState: "ORIENTATION_ABSENT", ...common });
}

// ── baseline leakage ────────────────────────────────────────────────

/**
 * Checked against everything the BASELINE arm could carry. An empty finding
 * list is the pass. Inherited from M173 with the orientation preamble's own
 * distinctive phrase added, because arm B's section names no product.
 */
export const VTRACE_LEAKAGE_MARKERS: readonly string[] = Object.freeze([
  "mcp__vtrace__",
  "run_pipeline",
  "get_impact_graph",
  "vtrace",
  ".vtrace",
  "run_pipeline.orientation",
  "generated automatically from a static index",
]);

export function findLeakage(text: string): readonly string[] {
  const lower = text.toLowerCase();
  return Object.freeze(VTRACE_LEAKAGE_MARKERS.filter((m) => lower.includes(m.toLowerCase())));
}

// ── sample construction ─────────────────────────────────────────────

/**
 * Largest-remainder proportional allocation.
 *
 * Ties are broken by pool size then by name so the result is a function of the
 * input alone. Floor-only allocation would silently drop the small repositories
 * that carry §128's breadth claim.
 */
export function allocateProportional(
  poolSizes: ReadonlyMap<string, number>,
  total: number,
): ReadonlyMap<string, number> {
  const entries = [...poolSizes.entries()].filter(([, size]) => size > 0);
  const grand = entries.reduce((sum, [, size]) => sum + size, 0);
  if (grand === 0 || total <= 0) return new Map();

  const exact = entries.map(([key, size]) => ({ key, size, want: (size / grand) * total }));
  const alloc = new Map(exact.map((e) => [e.key, Math.min(e.size, Math.floor(e.want))]));
  let placed = [...alloc.values()].reduce((a, b) => a + b, 0);

  const byRemainder = [...exact].sort((a, b) => {
    const ra = a.want - Math.floor(a.want);
    const rb = b.want - Math.floor(b.want);
    if (rb !== ra) return rb - ra;
    if (b.size !== a.size) return b.size - a.size;
    return a.key < b.key ? -1 : 1;
  });
  // Repeated passes: a repository already at its pool ceiling cannot absorb the
  // remainder, and the seat has to go somewhere rather than being lost.
  while (placed < Math.min(total, grand)) {
    let moved = false;
    for (const e of byRemainder) {
      if (placed >= Math.min(total, grand)) break;
      const current = alloc.get(e.key) ?? 0;
      if (current < e.size) { alloc.set(e.key, current + 1); placed += 1; moved = true; }
    }
    if (!moved) break;
  }
  return alloc;
}

/**
 * Deterministic order within a stratum: SHA-256 of `seed:instanceId`.
 *
 * A hash order rather than a seeded PRNG because a PRNG's output depends on how
 * many times it was called, which makes the draw depend on the allocation
 * arithmetic that precedes it. This does not.
 */
export function stratumOrder(seed: string, instanceIds: readonly string[]): readonly string[] {
  return Object.freeze(
    [...instanceIds]
      .map((id) => ({ id, key: sha256(`${seed}:${id}`) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
      .map((e) => e.id),
  );
}

export interface SampleCandidate {
  readonly instanceId: string;
  readonly repo: string;
  readonly difficulty: string;
}

/**
 * Repository-proportional, then difficulty-proportional within repository.
 *
 * §19 asks for stratification by repository AND by difficulty. Doing only the
 * first would let the hash order concentrate a repository's seats in one
 * difficulty tier, which is precisely the imbalance stratification exists to
 * prevent.
 */
export function selectExtensionSample(
  candidates: readonly SampleCandidate[],
  total: number,
  seed: string,
): readonly string[] {
  const byRepo = new Map<string, SampleCandidate[]>();
  for (const c of candidates) {
    const list = byRepo.get(c.repo) ?? [];
    list.push(c);
    byRepo.set(c.repo, list);
  }
  const repoAlloc = allocateProportional(
    new Map([...byRepo].map(([repo, list]) => [repo, list.length])),
    total,
  );

  const picked: string[] = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const want = repoAlloc.get(repo) ?? 0;
    if (want === 0) continue;
    const list = byRepo.get(repo)!;
    const byTier = new Map<string, SampleCandidate[]>();
    for (const c of list) {
      const tier = byTier.get(c.difficulty) ?? [];
      tier.push(c);
      byTier.set(c.difficulty, tier);
    }
    const tierAlloc = allocateProportional(
      new Map([...byTier].map(([tier, l]) => [tier, l.length])),
      want,
    );
    for (const tier of [...byTier.keys()].sort()) {
      const k = tierAlloc.get(tier) ?? 0;
      if (k === 0) continue;
      picked.push(...stratumOrder(seed, byTier.get(tier)!.map((c) => c.instanceId)).slice(0, k));
    }
  }
  return Object.freeze(picked.sort());
}

/**
 * Alternate arm order by task position so neither arm systematically owns the
 * first attempt at a freshly prepared workspace or the earlier half of the
 * execution window. Frozen before execution and never re-derived at run time.
 */
export function buildSchedule(instanceIds: readonly string[]): readonly {
  readonly order: number;
  readonly instanceId: string;
  readonly armOrder: readonly M183Arm[];
}[] {
  const rotations: readonly (readonly M183Arm[])[] = [
    ["baseline", "vtrace_orientation"],
    ["vtrace_orientation", "baseline"],
  ];
  return Object.freeze(
    instanceIds.map((instanceId, index) => ({
      order: index + 1,
      instanceId,
      armOrder: rotations[index % rotations.length]!,
    })),
  );
}

export interface M183ArmDefinition {
  readonly arm: M183Arm;
  readonly label: string;
  readonly orientationInjected: boolean;
  readonly mcpToolsPresent: false;
  readonly mandatesPipelineFirst: false;
  readonly prohibitionText: false;
  readonly searchGuard: false;
  readonly antiLoopDiscipline: false;
  readonly ordinaryToolsDenied: false;
  readonly disclosure: "NONE" | "M172_COMPACT_ORIENTATION_DEFAULT";
}

export function armDefinition(arm: M183Arm): M183ArmDefinition {
  return Object.freeze({
    arm,
    label: arm.toUpperCase(),
    orientationInjected: arm !== "baseline",
    mcpToolsPresent: false,
    mandatesPipelineFirst: false,
    prohibitionText: false,
    searchGuard: false,
    antiLoopDiscipline: false,
    ordinaryToolsDenied: false,
    disclosure: arm === "baseline" ? "NONE" : "M172_COMPACT_ORIENTATION_DEFAULT",
  });
}
