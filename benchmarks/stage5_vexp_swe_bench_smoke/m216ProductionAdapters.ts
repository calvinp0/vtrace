/**
 * M216 §12, §19, §27 — the three production adapters.
 *
 * M215 left `ContainerAdapter`, `AgentAdapter` and `EvaluatorAdapter` as
 * interfaces with exactly one implementation, and that one was synthetic. These
 * are the real ones. They add no orchestration: the executor still chooses the
 * row, the arm, the order, the retry and the validity, and every method below is
 * a substrate operation performed on an already-authorised request.
 *
 * The division of labour with `m216_substrate_bridge.py` is deliberate and
 * one-directional. Anything that needs Docker, swebench or a long-lived process
 * lives in Python, where five milestones of controls were written against it.
 * Anything that decides what the experiment IS — the argv, the environment, the
 * arm's tool surface, the frozen budgets, the model target — lives here, in the
 * same language as the executor that enforces them, because a value the
 * substrate could choose is a value that can differ between arms.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_BUDGET,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type RunManifestRow,
  armDefinition,
  mcpToolName,
} from "./m214Preregistration";
import type {
  AgentAdapter,
  AgentRunHooks,
  AgentRunOutcome,
  AgentRunSpec,
  ArmSurfaceObservation,
  CapturedPatch,
  ContainerAdapter,
  ContainerHandle,
  EvaluationOutcome,
  EvaluatorAdapter,
  TreatmentInitialisation,
} from "./m215LaunchExecutor";
import { treatmentCatalogSha256 } from "./m215LaunchExecutor";
import type { TelemetryEvent, TerminationReason } from "./m215CohortLedger";
import { constructArmEnvironment } from "./m193aArmEnvironment";
import {
  type ProviderBoundary,
  type SubstrateBridge,
  type SubstrateMode,
  SubstrateError,
} from "./m216SubstrateBridge";

export const M216_ADAPTER_VERSION = "stage5.m216.production-adapters.v1" as const;

/** The pinned versioned binary, never the `claude` symlink, which follows whatever installed last. */
export function pinnedAgentBinary(version: string = M214_AGENT.version): string {
  return `/home/calvin/.local/share/claude/versions/${version}`;
}

export interface AgentBinaryResolution {
  /** The executable actually spawned. */
  readonly binary: string;
  readonly declaredBinary: string;
  readonly declaredBinaryVersion: string;
  readonly pinnedBinaryVersion: string;
  readonly issues: readonly string[];
}

/**
 * §19, §21 — which executable the frozen invocation actually names.
 *
 * M214 froze two things that can disagree: `binary`, which is the `claude`
 * SYMLINK, and `version`, which is 2.1.260. M194 recorded why that matters — the
 * symlink follows whatever was installed last — and M214's own note says the
 * harness must assert the version before every run. Asserting it and then
 * launching the symlink leaves a window between the two.
 *
 * So the adapter spawns the VERSIONED binary and requires the frozen symlink to
 * report the same version. That satisfies both frozen fields, is strictly
 * stronger than either alone, and changes nothing about the agent: on a
 * compliant host the two paths are the same program.
 */
export function resolveAgentBinary(
  declaredBinary: string = M214_AGENT.binary, version: string = M214_AGENT.version,
): AgentBinaryResolution {
  const pinned = pinnedAgentBinary(version);
  const pinnedVersion = observedAgentVersion(pinned);
  const declaredVersion = observedAgentVersion(declaredBinary);
  const issues: string[] = [];
  if (pinnedVersion !== version) {
    issues.push(
      `the pinned binary ${pinned} reports ${pinnedVersion || "(nothing)"}, frozen authority is `
      + version,
    );
  }
  if (declaredVersion !== version) {
    issues.push(
      `M214's declared binary ${declaredBinary} reports ${declaredVersion || "(nothing)"}, frozen `
      + `authority is ${version}; the symlink no longer points at the pinned version`,
    );
  }
  return {
    binary: pinned,
    declaredBinary,
    declaredBinaryVersion: declaredVersion,
    pinnedBinaryVersion: pinnedVersion,
    issues: Object.freeze(issues),
  };
}

export const VTRACE_BINARY = "/home/calvin/code/vtrace/bin/vtrace" as const;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Container ───────────────────────────────────────────────────────

export interface M216ContainerHandle extends ContainerHandle {
  readonly bridgeHandle: string;
  readonly hostMount: string;
  readonly armRoot: string;
  readonly instanceId: string;
  readonly runId: string;
}

interface ContainerFailure {
  readonly failureCategory: string;
  readonly errors: readonly string[];
}

export class ContainerSubstrateError extends Error {
  readonly failureCategory: string;
  constructor(category: string, message: string) {
    super(message);
    this.name = "ContainerSubstrateError";
    this.failureCategory = category;
  }
}

/**
 * One arm environment per run, constructed once and observed by both adapters.
 *
 * The first version of this binding built the environment twice — once when the
 * container adapter inspected the arm surface, once when the agent adapter
 * launched — and the real-substrate suite caught it immediately, because
 * M193A's constructor refuses a configuration directory it did not create. The
 * refusal was the smaller half of the problem. The larger half is that a second
 * construction would have made the surface R5 audits a DIFFERENT object from the
 * environment the agent is handed, so the isolation proof would have been about
 * a directory nothing ran in.
 */
export class ArmEnvironmentRegistry {
  private readonly built = new Map<string, ArmAgentEnvironment>();

  for(row: RunManifestRow, armRoot: string, vtraceBinary: string): ArmAgentEnvironment {
    const existing = this.built.get(row.runId);
    if (existing !== undefined) return existing;
    const environment = buildArmEnvironment(row, armRoot, vtraceBinary);
    this.built.set(row.runId, environment);
    return environment;
  }

  /** Forget a run's environment, so a retry constructs a fresh directory. */
  release(runId: string): void {
    this.built.delete(runId);
  }
}

export interface M216ContainerOptions {
  readonly bridge: SubstrateBridge;
  readonly mode: SubstrateMode;
  readonly workRoot: string;
  readonly armEnvironments: ArmEnvironmentRegistry;
  /** Where the instance's repo/base-commit/eval-script facts come from. */
  readonly instanceFacts: (instanceId: string) => {
    readonly repo: string;
    readonly baseCommit: string;
    readonly image: string;
    readonly evalScript?: string;
  };
  readonly vtraceBinary?: string;
}

/**
 * The real container, over M193's authority.
 *
 * Two facts this class owns rather than delegates, because both are pair-level
 * and the substrate only ever sees one run at a time:
 *
 * * the canonical tracked-source digest for a task, recorded by whichever arm
 *   runs first and compared by the second. That is the only form in which
 *   "both arms started from the same source" is a checkable claim rather than a
 *   tautology about one run's own digest.
 * * the treatment state observed at reset, which is how COLD_UNIFORM is
 *   measured instead of asserted.
 */
export class M216ContainerAdapter implements ContainerAdapter {
  private readonly options: M216ContainerOptions;
  private readonly canonicalDigests = new Map<string, string>();
  private readonly inherited = new Map<string, readonly string[]>();
  private readonly hostMounts = new Map<string, string>();
  readonly treatmentSetup = new Map<string, { seconds: number; bytes: number }>();

  constructor(options: M216ContainerOptions) {
    this.options = options;
  }

  private get bridge(): SubstrateBridge {
    return this.options.bridge;
  }

  /** Exposed so a control can assert the pair invariant directly. */
  canonicalDigestFor(instanceId: string): string | undefined {
    return this.canonicalDigests.get(instanceId);
  }

  /**
   * The host side of a run's single tree.
   *
   * The container adapter is the only thing that knows it, and the agent adapter
   * needs it to bind /testbed. Reading it back from here rather than letting the
   * agent derive it keeps one authority for the path both sides address.
   */
  hostMountFor(runId: string): string {
    const mount = this.hostMounts.get(runId);
    if (mount === undefined) throw new Error(`no container has been started for ${runId}`);
    return mount;
  }

  async start(row: RunManifestRow): Promise<ContainerHandle> {
    const facts = this.options.instanceFacts(row.instanceId);
    const armRoot = join(this.options.workRoot, `${row.instanceId}--${row.arm}`);
    mkdirSync(armRoot, { recursive: true });
    const result = await this.bridge.call<Record<string, unknown> & ContainerFailure>(
      "container.start",
      {
        mode: this.options.mode,
        instanceId: row.instanceId,
        repo: facts.repo,
        baseCommit: facts.baseCommit,
        image: facts.image,
        evalScript: facts.evalScript ?? "",
        hostRoot: armRoot,
      },
    );
    if (result.started !== true) {
      throw new ContainerSubstrateError(
        "CONTAINER_CANNOT_START",
        `container did not start for ${row.instanceId}: ${(result.errors ?? []).join("; ")}`,
      );
    }
    const head = String(result.headAfterCheckout ?? "");
    if (head !== facts.baseCommit) {
      await this.bridge.call("container.stop", { handle: result.handle, removeMount: true });
      throw new ContainerSubstrateError(
        "SOURCE_REVISION_UNAVAILABLE",
        `container HEAD ${head || "(absent)"} is not the frozen base commit ${facts.baseCommit}`,
      );
    }
    const workingDirectory = String(result.workingDirectory ?? "/testbed");
    const usable = await assertTestbedUsable(this.bridge, String(result.handle), workingDirectory);
    if (usable.length > 0) {
      await this.bridge.call("container.stop", { handle: result.handle, removeMount: true });
      throw new ContainerSubstrateError("ENVIRONMENT_IRREPRODUCIBLE", usable.join("; "));
    }
    const handle: M216ContainerHandle = {
      image: String(result.image ?? facts.image),
      imageDigest: String(result.imageDigest ?? ""),
      workingDirectory,
      dependencyEnvironment: String(result.dependencyEnvironment ?? "testbed"),
      bridgeHandle: String(result.handle),
      hostMount: String(result.hostMount ?? ""),
      armRoot,
      instanceId: row.instanceId,
      runId: row.runId,
    };
    this.hostMounts.set(row.runId, handle.hostMount);
    return handle;
  }

  async resetToBaseCommit(handle: ContainerHandle, row: RunManifestRow): Promise<void> {
    const own = handle as M216ContainerHandle;
    const facts = this.options.instanceFacts(row.instanceId);
    const result = await this.bridge.call<{
      head: string; headMatchesBaseCommit: boolean;
      trackedChanges: string[]; untrackedAfterReset: string[];
    }>("container.resetToBaseCommit", {
      handle: own.bridgeHandle,
      baseCommit: facts.baseCommit,
    });
    if (!result.headMatchesBaseCommit) {
      throw new ContainerSubstrateError(
        "SOURCE_REVISION_UNAVAILABLE",
        `reset left HEAD at ${result.head}, not the frozen base commit ${facts.baseCommit}`,
      );
    }
    if (result.trackedChanges.length > 0) {
      throw new ContainerSubstrateError(
        "ENVIRONMENT_IRREPRODUCIBLE",
        `reset left tracked changes behind: ${result.trackedChanges.join(", ")}`,
      );
    }
    // Measured, not assumed: COLD_UNIFORM says nothing survives, and this is the
    // observation that can contradict it.
    const definition = armDefinition(row.arm);
    const treatmentPaths = [".vtrace", ".vexp"];
    this.inherited.set(
      own.bridgeHandle,
      Object.freeze(result.untrackedAfterReset.filter(
        (entry) => treatmentPaths.some((path) => entry === path || entry.startsWith(`${path}/`)),
      )),
    );
    void definition;
  }

  async trackedSourceDigest(handle: ContainerHandle): Promise<string> {
    const own = handle as M216ContainerHandle;
    const result = await this.bridge.call<{ digest: string | null; complete: boolean; rc: number | null }>(
      "container.trackedSourceDigest", { handle: own.bridgeHandle },
    );
    if (!result.complete || result.digest === null) {
      throw new ContainerSubstrateError(
        "ENVIRONMENT_IRREPRODUCIBLE",
        `tracked-source digest did not complete (rc ${String(result.rc)})`,
      );
    }
    if (!this.canonicalDigests.has(own.instanceId)) {
      this.canonicalDigests.set(own.instanceId, result.digest);
    }
    return result.digest;
  }

  async head(handle: ContainerHandle): Promise<string> {
    const own = handle as M216ContainerHandle;
    const result = await this.bridge.call<{ head: string }>(
      "container.head", { handle: own.bridgeHandle },
    );
    return result.head;
  }

  /**
   * §15 — DIRECTORY granularity, and the reason it is not a detail.
   *
   * With `--directory` a fully untracked treatment directory collapses to one
   * entry, so the derived exclusion covers everything written into it later.
   * Without it the exclusions name the files that happened to exist at snapshot
   * time, and a treatment file created DURING the run is captured as agent
   * output. M215 measured both on real git; this is the corrected invocation.
   */
  async untrackedPaths(handle: ContainerHandle): Promise<readonly string[]> {
    const own = handle as M216ContainerHandle;
    const result = await this.bridge.call<{ paths: string[]; complete: boolean; rc: number | null }>(
      "container.untrackedPaths", { handle: own.bridgeHandle, granularity: "DIRECTORY" },
    );
    if (!result.complete) {
      throw new ContainerSubstrateError(
        "PATCH_EXTRACTION_FAILURE",
        `the pre-agent untracked snapshot did not complete (rc ${String(result.rc)}); an `
        + "enumeration that did not answer is not an empty one",
      );
    }
    return Object.freeze([...result.paths]);
  }

  async untrackedSourceAffectingPaths(handle: ContainerHandle): Promise<readonly string[]> {
    const own = handle as M216ContainerHandle;
    const result = await this.bridge.call<{ paths: string[]; complete: boolean }>(
      "container.untrackedSourceAffectingPaths", { handle: own.bridgeHandle },
    );
    if (!result.complete) {
      throw new ContainerSubstrateError(
        "ENVIRONMENT_IRREPRODUCIBLE", "untracked source-affecting enumeration did not complete",
      );
    }
    return Object.freeze([...result.paths]);
  }

  /**
   * §42 — build the index before the agent starts, on the host, over the same
   * inodes the container sees.
   *
   * The catalogue is read back from the server that will actually serve it,
   * rather than from the configuration that was supposed to start it. That is
   * the difference between proving the treatment surface and restating it.
   */
  async initialiseTreatment(
    handle: ContainerHandle, row: RunManifestRow,
  ): Promise<TreatmentInitialisation> {
    const own = handle as M216ContainerHandle;
    const binary = this.options.vtraceBinary ?? VTRACE_BINARY;
    const started = Date.now();
    let initialised = false;
    let failureCategory: string | null = null;
    try {
      const result = spawnSync(binary, ["index", own.hostMount, "--quiet"], {
        encoding: "utf8", timeout: 1_800_000,
      });
      initialised = result.status === 0;
      if (!initialised) {
        failureCategory = "TREATMENT_INITIALISATION_FAILURE";
      }
    } catch (error) {
      failureCategory = "TREATMENT_INITIALISATION_FAILURE";
      void error;
    }
    const seconds = (Date.now() - started) / 1000;
    const stateDir = join(own.hostMount, ".vtrace");
    const bytes = existsSync(stateDir) ? directorySize(stateDir) : 0;
    if (initialised && bytes === 0) {
      initialised = false;
      failureCategory = "TREATMENT_INITIALISATION_FAILURE";
    }
    this.treatmentSetup.set(own.bridgeHandle, { seconds, bytes });

    const catalogue = initialised ? probeTreatmentCatalogue(binary, own.hostMount) : [];
    return {
      initialised,
      catalogSha256: catalogue.length > 0 ? treatmentCatalogSha256(catalogue) : null,
      exposedToolNames: Object.freeze(catalogue.map((name) => mcpToolName("vtrace", name))),
      indexBuildSeconds: seconds,
      indexSizeBytes: bytes,
      failureCategory,
    };
  }

  async inspectArmSurface(
    handle: ContainerHandle, row: RunManifestRow,
  ): Promise<ArmSurfaceObservation> {
    const own = handle as M216ContainerHandle;
    const definition = armDefinition(row.arm);
    const binary = this.options.vtraceBinary ?? VTRACE_BINARY;

    const listing = await this.bridge.call<{ stdout: string }>("container.exec", {
      handle: own.bridgeHandle, label: "workspace_entries",
      command: "ls -A -1",
    });
    const workspaceRootEntries = listing.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

    const armEnvironment = this.options.armEnvironments.for(row, own.armRoot, binary);
    const treatmentTools = row.arm === "vtrace"
      ? probeTreatmentCatalogue(binary, own.hostMount).map((name) => mcpToolName("vtrace", name))
      : [];

    const injectedContextDocuments = workspaceRootEntries
      .filter((entry) => entry === "CLAUDE.md" || entry === "AGENTS.md" || entry === ".claude");

    const goldNames = ["gold_patch", "test_patch", "report.json", "swe-bench", "FAIL_TO_PASS"];
    const goldArtifactsInAgentContext = workspaceRootEntries
      .filter((entry) => goldNames.some((name) => entry.toLowerCase().includes(name.toLowerCase())));

    const daemonSocketsReachable = readdirSafe("/tmp/cc-socks")
      .filter((entry) => entry.toLowerCase().includes("vtrace"))
      .concat(existsSync(join(own.hostMount, ".vtrace", "daemon.sock")) && row.arm === "baseline"
        ? [join(own.hostMount, ".vtrace", "daemon.sock")]
        : []);

    const setup = this.treatmentSetup.get(own.bridgeHandle);
    void setup;

    return {
      mcpServers: armEnvironment.mcpServers,
      modelVisibleToolNames: [...M214_NATIVE_TOOLS, ...treatmentTools],
      nativeToolNames: M214_NATIVE_TOOLS,
      environmentVariableNames: Object.keys(armEnvironment.env).sort(),
      workspaceRootEntries,
      injectedContextDocuments,
      daemonSocketsReachable,
      treatmentBinariesOnPath: treatmentBinariesOnPath(armEnvironment.env.PATH ?? ""),
      systemPromptAppendix: null,
      userPromptTemplate: M214_AGENT.userPromptText,
      agentVersion: observedAgentVersion(pinnedAgentBinary()),
      canonicalTrackedSourceDigest:
        this.canonicalDigests.get(own.instanceId) ?? await this.trackedSourceDigest(handle),
      goldArtifactsInAgentContext,
      environment: armEnvironment.env,
      resetPreservedPaths: [],
      treatmentStateInheritedFromPreviousRun: this.inherited.get(own.bridgeHandle) ?? [],
      cpuLimit: "host default (no cgroup cpu limit set by the harness)",
      memoryLimit: "host default (no cgroup memory limit set by the harness)",
      networkPolicy: "container network namespace default; the agent process is not network-isolated",
      systemPromptSha256: sha256(String(M214_AGENT.systemPrompt)),
      ...(definition.treatmentToolCatalog.length === 0 ? {} : {}),
    };
  }

  async capturePatch(
    handle: ContainerHandle, exclusions: readonly string[],
  ): Promise<CapturedPatch> {
    const own = handle as M216ContainerHandle;
    const result = await this.bridge.call<{
      ok: boolean; status: string; patch: string; paths: string[]; error: string | null;
    }>("container.capturePatch", { handle: own.bridgeHandle, exclusions: [...exclusions] });
    if (!result.ok) {
      throw new ContainerSubstrateError(
        "PATCH_EXTRACTION_FAILURE",
        `patch snapshot refused: ${result.status} ${result.error ?? ""}`,
      );
    }
    return {
      patch: result.patch,
      paths: Object.freeze([...result.paths]),
      exclusions: Object.freeze([...exclusions]),
    };
  }

  async stop(handle: ContainerHandle): Promise<void> {
    const own = handle as M216ContainerHandle;
    await this.bridge.call("container.stop", { handle: own.bridgeHandle, removeMount: true });
    this.options.armEnvironments.release(own.runId);
    // §43 — the arm's own scratch root, including the treatment's generated
    // state and the agent's private configuration directory, does not survive
    // into the next arm of the same task.
    try {
      rmSync(own.armRoot, { recursive: true, force: true });
    } catch {
      /* teardown reports rather than throws; the caller's isolation check decides */
    }
  }
}

/**
 * The checkout root exists and can be written to.
 *
 * Exported so a control can point it at a path that is not there and watch it
 * refuse: a probe that only ever runs inside `start` is a probe whose failure
 * branch nothing has executed, which is the shape of defect M215 spent its whole
 * closing argument on.
 */
export async function assertTestbedUsable(
  bridge: SubstrateBridge, bridgeHandle: string, workingDirectory: string,
): Promise<readonly string[]> {
  const probe = await bridge.call<{ exitCode: number | null; stdout: string }>("container.exec", {
    handle: bridgeHandle,
    label: "testbed_usable",
    command:
      `test -d ${workingDirectory} && touch ${workingDirectory}/.m216_write_probe `
      + `&& rm -f ${workingDirectory}/.m216_write_probe && echo TESTBED_WRITABLE`,
  });
  return probe.stdout.includes("TESTBED_WRITABLE")
    ? []
    : [`${workingDirectory} is absent or not writable in the started container`];
}

function directorySize(root: string): number {
  let total = 0;
  for (const entry of readdirSafe(root)) {
    const path = join(root, entry);
    try {
      const info = statSync(path);
      total += info.isDirectory() ? directorySize(path) : info.size;
    } catch {
      continue;
    }
  }
  return total;
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function treatmentBinariesOnPath(path: string): string[] {
  const found: string[] = [];
  for (const directory of path.split(":").filter(Boolean)) {
    for (const name of ["vtrace", "vexp"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)].sort();
}

export function observedAgentVersion(binary: string): string {
  try {
    const output = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 120_000 });
    return (output.trim().split(/\s+/)[0] ?? "").trim();
  } catch {
    return "";
  }
}

// ── The treatment catalogue, read from the server that serves it ────
//
// There is deliberately no digest function here. M215 already owns one —
// `treatmentCatalogSha256` — and `auditTreatmentIdentity` compares against it.
// The first version of this adapter defined a second formula over the same
// fact, and the real-substrate suite caught it as a treatment-identity failure
// on every vtrace row: two authorities for one digest is one authority too many,
// and the one that loses is whichever the gate does not use.

/**
 * §25 — speak MCP to the real server and read `tools/list` back.
 *
 * Comparing the intended configuration to the frozen catalogue would prove only
 * that the configuration file says what it was written to say. The question is
 * what the agent's client would be offered, and the only authority on that is
 * the server's own reply.
 */
export function probeTreatmentCatalogue(binary: string, repoRoot: string): readonly string[] {
  const requests = [
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "m216-catalogue-probe", version: "1" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  ].join("\n");
  const result = spawnSync(binary, ["mcp-serve", "--repo", repoRoot], {
    input: `${requests}\n`, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    let message: { id?: number; result?: { tools?: { name: string }[] } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    if (message.id === 2 && message.result?.tools !== undefined) {
      return Object.freeze(message.result.tools.map((tool) => tool.name));
    }
  }
  return Object.freeze([]);
}

// ── The agent invocation, frozen ────────────────────────────────────

export interface ArmAgentEnvironment {
  readonly configDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly isolationArgv: readonly string[];
  readonly mcpServers: readonly string[];
  readonly constructed: boolean;
  readonly issues: readonly string[];
}

/**
 * One environment constructor for both arms, differing in one value.
 *
 * M193A's constructor is reused verbatim for the private configuration
 * directory and the environment allowlist — it is what established that an
 * empty `--mcp-config` does not by itself remove the account's own connectors.
 * The arm's only difference is the MCP config document: an empty server map, or
 * one server. Everything else is shared code, so there is nowhere for a second
 * difference to appear.
 */
export function buildArmEnvironment(
  row: RunManifestRow, armRoot: string, vtraceBinary: string = VTRACE_BINARY,
  parentEnv: Record<string, string | undefined> = process.env,
  nonce?: string,
): ArmAgentEnvironment {
  const definition = armDefinition(row.arm);
  const constructed = constructArmEnvironment({
    armId: `${row.instanceId}--${row.arm}`,
    instanceId: row.instanceId,
    armRootDir: armRoot,
    hostConfigDir: join(process.env.HOME ?? "/home/calvin", ".claude"),
    adapterSettingsPath: null,
    parentEnv,
    nonce: nonce ?? createHash("sha256").update(`${row.runId}`).digest("hex").slice(0, 12),
  });
  const mcpConfig = definition.mcpServers.includes("vtrace")
    ? {
      mcpServers: {
        vtrace: { command: vtraceBinary, args: ["mcp-serve", "--repo", "/testbed"] },
      },
    }
    : { mcpServers: {} };
  const isolationArgv = Object.freeze([
    "--strict-mcp-config", "--mcp-config", JSON.stringify(mcpConfig),
  ]);
  // M193A builds the baseline's isolation argv itself. Rebuilding it here rather
  // than reusing it would let the two drift, so the baseline branch is required
  // to reproduce M193A's own bytes exactly and the vtrace branch is required to
  // differ from it in exactly one element.
  const issues = [...constructed.errors, ...constructed.audit.findings.map((f) => f.what)];
  if (row.arm === "baseline"
    && JSON.stringify(isolationArgv) !== JSON.stringify(constructed.argv)) {
    issues.push(
      `baseline isolation argv diverged from M193A's constructor: `
      + `${JSON.stringify(isolationArgv)} vs ${JSON.stringify(constructed.argv)}`,
    );
  }
  return {
    configDir: constructed.configDir,
    env: constructed.env,
    isolationArgv,
    mcpServers: definition.mcpServers,
    constructed: constructed.mayLaunchModel && issues.length === 0,
    issues: Object.freeze(issues),
  };
}

/**
 * The exact argv, derived from frozen authority only.
 *
 * Exported so a control can change one element and watch the executor refuse:
 * an argv that is assembled inside a private closure is an argv nobody can
 * falsify.
 */
export function buildAgentArgv(
  spec: AgentRunSpec, isolationArgv: readonly string[], prompt: string,
  binary: string = resolveAgentBinary(spec.agentBinary, spec.agentVersion).binary,
): readonly string[] {
  return Object.freeze([
    binary,
    "-p", prompt,
    "--output-format", "stream-json",
    "--model", spec.modelTarget,
    "--max-turns", String(spec.maxTurns),
    "--verbose",
    "--allowedTools", spec.nativeTools.join(","),
    "--max-budget-usd", String(spec.perRunCostCapUsd),
    ...isolationArgv,
  ]);
}

/** vexp-swe-bench's own prompt, filled from frozen fields only. */
export function buildUserPrompt(row: RunManifestRow, problemStatement: string): string {
  return M214_AGENT.userPromptText
    .replace("{repo}", row.repo)
    .replace("{problem_statement}", problemStatement);
}

// ── The stream-json parser ──────────────────────────────────────────

export interface ParsedAgentStream {
  readonly providerModelIdentity: string | null;
  readonly agentVersionReported: string | null;
  readonly mcpServersReported: readonly string[];
  readonly registryToolNames: readonly string[];
  readonly telemetry: readonly TelemetryEvent[];
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number | null;
  readonly resultSubtype: string | null;
  readonly sawResultEvent: boolean;
}

const TREATMENT_TOOL_PREFIX = "mcp__vtrace__";

/**
 * Classify one stream event into the executor's ordered telemetry model.
 *
 * The categories are the ones M215's ledger already distinguishes, and the
 * mapping is deliberately explicit rather than a name heuristic: a tool that
 * stopped being recognised would silently stop appearing in the treatment-use
 * accounting, which is the number the whole intention-to-treat rule rests on.
 */
const TEST_COMMAND = /\b(pytest|tox|nose|unittest|runtests|test_|\.\/tests?\b|python -m pytest)\b/;

export function telemetryKindFor(toolName: string, input: unknown): TelemetryEvent["kind"] {
  if (toolName.startsWith(TREATMENT_TOOL_PREFIX)) return "TREATMENT_TOOL_CALL";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return "EDIT";
  if (toolName === "Read" || toolName === "NotebookRead") return "FILE_READ";
  if (toolName === "Bash") {
    const command = String((input as { command?: unknown } | null)?.command ?? "");
    return TEST_COMMAND.test(command) ? "TEST_RUN" : "SHELL_COMMAND";
  }
  return "NATIVE_TOOL_CALL";
}

/**
 * PURE. Bytes in, telemetry out, no clock and no filesystem.
 *
 * §49's determinism requirement is only checkable if the parser has no inputs
 * the caller cannot supply, so wall-clock latency is reported as zero rather
 * than measured here: a field that varies between two parses of the same bytes
 * would make the semantic digest of a run depend on when it was read.
 */
export function parseAgentStream(lines: readonly string[]): ParsedAgentStream {
  let providerModelIdentity: string | null = null;
  let agentVersionReported: string | null = null;
  let mcpServersReported: string[] = [];
  let registryToolNames: string[] = [];
  const telemetry: TelemetryEvent[] = [];
  let turn = 0;
  let ordinal = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | null = null;
  let resultSubtype: string | null = null;
  let sawResultEvent = false;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event.type ?? "");
    if (type === "system" && event.subtype === "init") {
      const model = event.model;
      providerModelIdentity = typeof model === "string" && model.trim().length > 0 ? model : null;
      const version = event.claude_code_version;
      agentVersionReported = typeof version === "string" ? version : null;
      const servers = event.mcp_servers;
      mcpServersReported = Array.isArray(servers)
        ? servers.map((entry) => (typeof entry === "string"
          ? entry
          : String((entry as { name?: unknown }).name ?? "")))
        : [];
      const tools = event.tools;
      registryToolNames = Array.isArray(tools) ? tools.map(String) : [];
      telemetry.push({
        ordinal: ordinal++, kind: "AGENT_INIT", turn, name: "init",
        detail: `agent ${agentVersionReported ?? "(unreported)"}; mcp `
          + `[${mcpServersReported.join(", ")}]`,
        outputBytes: line.length, latencyMs: 0,
      });
      // The identity is its own event rather than a field on the init event, so
      // "the provider never told us" is a visible absence in the ordered
      // telemetry instead of an empty string somebody has to notice.
      telemetry.push({
        ordinal: ordinal++, kind: "MODEL_IDENTITY", turn, name: "model",
        detail: providerModelIdentity ?? "(no provider model identity in the init event)",
        outputBytes: 0, latencyMs: 0,
      });
      continue;
    }
    if (type === "assistant") {
      turn += 1;
      const content = ((event.message as { content?: unknown } | undefined)?.content ?? []) as unknown[];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const entry = block as { type?: string; name?: string; input?: unknown };
        if (entry.type !== "tool_use") continue;
        const name = String(entry.name ?? "");
        telemetry.push({
          ordinal: ordinal++, kind: telemetryKindFor(name, entry.input), turn, name,
          detail: JSON.stringify(entry.input ?? {}).slice(0, 400),
          outputBytes: 0, latencyMs: 0,
        });
      }
      continue;
    }
    if (type === "user") {
      const content = ((event.message as { content?: unknown } | undefined)?.content ?? []) as unknown[];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const entry = block as { type?: string; content?: unknown };
        if (entry.type !== "tool_result") continue;
        const previous = telemetry[telemetry.length - 1];
        if (previous !== undefined) {
          telemetry[telemetry.length - 1] = {
            ...previous, outputBytes: JSON.stringify(entry.content ?? "").length,
          };
        }
      }
      continue;
    }
    if (type === "result") {
      sawResultEvent = true;
      resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
      const cost = event.total_cost_usd;
      costUsd = typeof cost === "number" ? cost : null;
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      inputTokens = Number(usage.input_tokens ?? 0);
      outputTokens = Number(usage.output_tokens ?? 0);
      cachedInputTokens =
        Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
      const turns = event.num_turns;
      if (typeof turns === "number") turn = turns;
      telemetry.push({
        ordinal: ordinal++, kind: "TERMINATION", turn, name: resultSubtype ?? "result",
        detail: `cost=${costUsd ?? "unreported"}`, outputBytes: line.length, latencyMs: 0,
      });
    }
  }

  return {
    providerModelIdentity, agentVersionReported,
    mcpServersReported: Object.freeze(mcpServersReported),
    registryToolNames: Object.freeze(registryToolNames),
    telemetry: Object.freeze(telemetry),
    turnCount: turn, inputTokens, outputTokens, cachedInputTokens,
    costUsd, resultSubtype, sawResultEvent,
  };
}

/**
 * M194's frozen termination categories, restated against M215's enum.
 *
 * A non-zero exit is not one thing: the CLI exits non-zero for a turn limit, a
 * budget stop, a crash and a killed process, and those have different validity
 * consequences. Collapsing them is how an infrastructure failure becomes an
 * ordinary unresolved outcome.
 */
export function classifyTermination(
  parsed: ParsedAgentStream, timedOut: boolean, started: boolean, perRunCostCapUsd: number,
): { readonly reason: TerminationReason; readonly failureCategory: string | null } {
  if (!started) {
    return {
      reason: "HARNESS_ABORT",
      failureCategory: "AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE",
    };
  }
  if (timedOut) return { reason: "WALL_CLOCK_TIMEOUT", failureCategory: null };
  if (!parsed.sawResultEvent) {
    return { reason: "AGENT_ERROR", failureCategory: "MODEL_SERVICE_FAILURE" };
  }
  if (parsed.resultSubtype === "error_max_turns") {
    return { reason: "TURN_LIMIT_REACHED", failureCategory: null };
  }
  if (parsed.resultSubtype === "error_max_budget" || parsed.resultSubtype === "error_budget_exceeded") {
    return { reason: "COST_CAP_REACHED", failureCategory: null };
  }
  if (parsed.costUsd !== null && parsed.costUsd >= perRunCostCapUsd) {
    return { reason: "COST_CAP_REACHED", failureCategory: null };
  }
  if (parsed.resultSubtype === "success") return { reason: "AGENT_COMPLETED", failureCategory: null };
  return { reason: "AGENT_ERROR", failureCategory: "MODEL_SERVICE_FAILURE" };
}

// ── Agent adapter ───────────────────────────────────────────────────

export interface M216AgentOptions {
  readonly bridge: SubstrateBridge;
  readonly mode: SubstrateMode;
  readonly providerBoundary: ProviderBoundary;
  readonly workRoot: string;
  readonly problemStatement: (instanceId: string) => string;
  readonly armRootFor: (spec: AgentRunSpec) => string;
  /** The host side of the run's single tree; bound at /testbed for the agent. */
  readonly hostMountFor: (spec: AgentRunSpec) => string;
  readonly armEnvironments: ArmEnvironmentRegistry;
  readonly spendAuthorized?: boolean;
  readonly vtraceBinary?: string;
  /**
   * §31 — the lowest provider boundary, and the ONLY thing a zero-spend control
   * replaces. Given the production argv, it returns the argv actually spawned.
   * In LIVE it is the identity function.
   */
  readonly providerSubstitution?: (argv: readonly string[], spec: AgentRunSpec) => readonly string[];
}

/**
 * The production agent process.
 *
 * What a zero-spend control may replace is the last element of the chain: which
 * executable the constructed argv finally names. Everything before it — the
 * private configuration directory, the environment allowlist, the MCP config,
 * the frozen flags, the sandbox, the spawn, the ordered stream, the parser, the
 * identity hook, the termination classification and the cost accounting — is
 * the same code the paid path runs, because the point of the control is to test
 * that code rather than to test an interface again.
 */
export class M216AgentAdapter implements AgentAdapter {
  private readonly options: M216AgentOptions;
  readonly lastArgv: string[] = [];
  readonly lastLiveArgv: string[] = [];
  lastStderrTail = "";
  lastSandboxed = false;

  constructor(options: M216AgentOptions) {
    this.options = options;
  }

  async run(spec: AgentRunSpec, hooks: AgentRunHooks): Promise<AgentRunOutcome> {
    const armRoot = this.options.armRootFor(spec);
    // The SAME environment the container adapter audited. Building a second one
    // here would launch into a directory nothing had inspected.
    const environment = this.options.armEnvironments.for(
      spec.row, armRoot, this.options.vtraceBinary ?? VTRACE_BINARY,
    );
    if (!environment.constructed) {
      throw new SubstrateError(
        `arm environment could not be constructed: ${environment.issues.join("; ")}`,
      );
    }
    const resolution = resolveAgentBinary(spec.agentBinary, spec.agentVersion);
    if (resolution.issues.length > 0) {
      throw new SubstrateError(
        `refusing to launch: ${resolution.issues.join("; ")}. M214 pins the agent version and the `
        + "cohort aborts on any difference.",
      );
    }
    const prompt = buildUserPrompt(spec.row, this.options.problemStatement(spec.row.instanceId));
    const liveArgv = buildAgentArgv(spec, environment.isolationArgv, prompt, resolution.binary);
    this.lastLiveArgv.length = 0;
    this.lastLiveArgv.push(...liveArgv);
    const argv = this.options.providerSubstitution?.(liveArgv, spec) ?? liveArgv;
    this.lastArgv.length = 0;
    this.lastArgv.push(...argv);

    const streamPath = join(armRoot, "raw", `${spec.attemptId}.agent_stream.jsonl`);
    const abortPath = join(armRoot, "raw", `${spec.attemptId}.abort`);
    mkdirSync(join(armRoot, "raw"), { recursive: true });

    const lines: string[] = [];
    let identityAsserted = false;
    let identityError: Error | null = null;

    const onEvent = (event: Record<string, unknown>): void => {
      const line = String(event.line ?? "");
      lines.push(line);
      if (identityAsserted || identityError !== null) return;
      let parsedEvent: Record<string, unknown>;
      try {
        parsedEvent = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsedEvent.type !== "system" || parsedEvent.subtype !== "init") return;
      identityAsserted = true;
      const model = parsedEvent.model;
      const observed = typeof model === "string" && model.trim().length > 0 ? model : null;
      try {
        hooks.assertProviderModelIdentity(observed);
      } catch (error) {
        identityError = error as Error;
        // The assertion is a hook so that it can stop the run, not merely label
        // it afterwards. Writing the sentinel is what actually stops it.
        writeFileSync(abortPath, `${(error as Error).message}\n`);
      }
    };

    const result = await this.options.bridge.call<{
      started: boolean; exitCode: number | null; timedOut: boolean; durationMs: number;
      sandboxed: boolean; stderrTail: string; error?: string;
    }>("agent.run", {
      mode: this.options.mode,
      providerBoundary: this.options.providerBoundary,
      spendAuthorized: this.options.spendAuthorized === true,
      instanceId: spec.row.instanceId,
      argv: [...argv],
      env: { ...environment.env },
      // The agent works at /testbed on BOTH sides of the container boundary, so
      // the host side of the tree travels with the request and the substrate
      // binds it. An agent whose `pwd` says /testbed while its Read tool needs a
      // different absolute path is being asked to reason about two filesystems.
      cwd: spec.workingDirectory,
      hostMount: this.options.hostMountFor(spec),
      armRoot,
      streamPath,
      abortPath,
      timeoutSeconds: spec.wallClockTimeoutSeconds,
    }, onEvent);
    this.lastStderrTail = result.stderrTail ?? "";
    this.lastSandboxed = result.sandboxed === true;

    if (identityError !== null) throw identityError;

    const parsed = parseAgentStream(lines);
    // The hook can only fire on an init event that arrived. A run that produced
    // none never had its identity asserted, and silence is a failure.
    if (!identityAsserted) hooks.assertProviderModelIdentity(parsed.providerModelIdentity);

    const termination = classifyTermination(
      parsed, result.timedOut, result.started, spec.perRunCostCapUsd,
    );
    return {
      providerModelIdentity: parsed.providerModelIdentity,
      telemetry: parsed.telemetry,
      turnCount: parsed.turnCount,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cachedInputTokens: parsed.cachedInputTokens,
      // §39 — an attempt whose cost the provider never reported is charged at
      // its cap against the ceiling. Recording it as $0 would make a retryable
      // MODEL_SERVICE_FAILURE the one way real spend escapes the guard.
      costUsd: parsed.costUsd ?? (parsed.sawResultEvent ? 0 : spec.perRunCostCapUsd),
      wallClockSeconds: result.durationMs / 1000,
      terminationReason: termination.reason,
      failureCategory: termination.failureCategory,
    };
  }
}

// ── Evaluator adapter ───────────────────────────────────────────────

export interface M216EvaluatorOptions {
  readonly bridge: SubstrateBridge;
  readonly mode: SubstrateMode;
  readonly workRoot: string;
  readonly dataset?: string;
}

export class M216EvaluatorAdapter implements EvaluatorAdapter {
  private readonly options: M216EvaluatorOptions;

  constructor(options: M216EvaluatorOptions) {
    this.options = options;
  }

  async evaluate(row: RunManifestRow, patch: string): Promise<EvaluationOutcome> {
    const runId = `m216-${row.instanceId}-${row.arm}-${sha256(row.runId).slice(0, 8)}`;
    const result = await this.options.bridge.call<{
      command: string; evaluatorIdentity: string; exitStatus: number; rawResult: string;
      resolved: boolean; evaluatorRan: boolean; outcome: string;
    }>("evaluator.evaluate", {
      mode: this.options.mode,
      instanceId: row.instanceId,
      patch,
      runId,
      workRoot: join(this.options.workRoot, "evaluation"),
      ...(this.options.dataset === undefined ? {} : { dataset: this.options.dataset }),
    });
    return {
      command: result.command,
      evaluatorIdentity: result.evaluatorIdentity,
      exitStatus: result.exitStatus,
      rawResult: result.rawResult,
      resolved: result.resolved,
      evaluatorRan: result.evaluatorRan,
    };
  }
}

export const M216_FROZEN_BUDGET_IDENTITY = M214_BUDGET;
export const M216_FROZEN_MODEL = M214_MODEL.model;
