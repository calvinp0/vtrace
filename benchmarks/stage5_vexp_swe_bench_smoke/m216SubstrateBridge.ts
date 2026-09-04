/**
 * M216 §10 — the client half of the substrate boundary.
 *
 * One long-lived child process per executor session, spoken to in NDJSON. The
 * protocol is deliberately narrow: an operation name and its parameters, in;
 * a result or a typed refusal, out. There is no "run the next row" request,
 * because the substrate has no opinion about which row is next.
 *
 * The one operation that streams is `agent.run`, and it has to. M215's
 * model-identity assertion is a HOOK that fires during initialisation, and a
 * boundary that returned the transcript after the process exited would put that
 * assertion after the money. So events cross the boundary as they arrive and
 * the executor's hook runs on the init event while the agent is still starting.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const M216_BRIDGE_CLIENT_VERSION = "stage5.m216.substrate-bridge-client.v1" as const;

/** The interpreter that owns swebench and the Docker SDK. Not this repo's bun. */
export const M216_SUBSTRATE_PYTHON = "/home/calvin/code/vexp-swe-bench/.venv/bin/python" as const;
export const M216_BRIDGE_SCRIPT = "m216_substrate_bridge.py" as const;

/**
 * Who is asking, and therefore what the substrate will do for them.
 *
 * `RESEARCH` is refused every real operation on a frozen task; `COHORT` is the
 * only mode that can reach one, and the only mode in which a provider call is
 * even expressible. The mode travels on every request rather than being set
 * once at startup, so a long-lived bridge cannot be talked into changing its
 * mind halfway through a session.
 */
export type SubstrateMode = "RESEARCH" | "COHORT";

/** §20 — where the real path stops and a recorded event source takes over. */
export type ProviderBoundary = "LIVE" | "REPLAY";

export class SubstrateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubstrateRefusedError";
  }
}

export class SubstrateError extends Error {
  readonly detail: string;
  constructor(message: string, detail = "") {
    super(message);
    this.name = "SubstrateError";
    this.detail = detail;
  }
}

interface PendingCall {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly onEvent?: (event: Record<string, unknown>) => void;
}

export interface SubstrateIdentity {
  readonly bridgeVersion: string;
  readonly python: string;
  readonly dockerSdk: string | null;
  readonly dockerServer: string | null;
  readonly swebench: string | null;
  readonly containerAuthority: string;
  readonly patchSnapshotAuthority: string;
  readonly untrackedSnapshotAuthority: string;
  readonly trackedSourceDigestAuthority: string;
  readonly dataset: string;
  readonly frozenPopulationSize: number;
}

export interface SubstrateAccounting {
  readonly containersCreated: number;
  readonly containersStarted: number;
  readonly containersTornDown: number;
  readonly openContainers: readonly string[];
  readonly frozenInstancesTouched: readonly string[];
  readonly nonFrozenInstancesTouched: readonly string[];
  readonly commandCount: number;
}

export class SubstrateBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = "";
  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;
  private closed = false;
  private exitReason: string | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitReason = `substrate bridge exited (code ${code}, signal ${signal ?? "none"})`;
      for (const [, call] of this.pending) call.reject(new SubstrateError(this.exitReason));
      this.pending.clear();
    });
  }

  /**
   * Start the bridge, bound to the frozen manifest.
   *
   * The manifest is not a convenience: it is the §35 guard's only input. A
   * bridge started without it would have no way to know which instance ids are
   * the frozen 100, so the refusal is wired at construction rather than left to
   * each call site to remember.
   */
  static async start(options: {
    readonly benchmarkDir: string;
    readonly manifestPath: string;
    readonly python?: string;
    readonly dataset?: string;
  }): Promise<SubstrateBridge> {
    const python = options.python ?? M216_SUBSTRATE_PYTHON;
    const script = join(options.benchmarkDir, M216_BRIDGE_SCRIPT);
    if (!existsSync(python)) {
      throw new SubstrateError(
        `substrate interpreter absent: ${python}. The bridge needs the environment that owns `
        + "swebench and the Docker SDK; this repository's runtime is not it.",
      );
    }
    if (!existsSync(script)) throw new SubstrateError(`substrate bridge script absent: ${script}`);
    if (!existsSync(options.manifestPath)) {
      throw new SubstrateError(`frozen manifest absent: ${options.manifestPath}`);
    }
    const args = [script, "--manifest", options.manifestPath];
    if (options.dataset !== undefined) args.push("--dataset", options.dataset);
    const child = spawn(python, args, {
      cwd: options.benchmarkDir,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const bridge = new SubstrateBridge(child);
    await bridge.readyPromise;
    return bridge;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.ready === true) {
      this.readyResolve();
      return;
    }
    const id = message.id as number | null;
    if (id === null || id === undefined) return;
    const call = this.pending.get(id);
    if (call === undefined) return;
    if (message.streaming === true) {
      call.onEvent?.(message);
      return;
    }
    this.pending.delete(id);
    if (message.ok === true) {
      call.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    const error = String(message.error ?? "substrate operation failed");
    call.reject(
      message.errorKind === "REFUSED"
        ? new SubstrateRefusedError(error)
        : new SubstrateError(error, String(message.traceback ?? "")),
    );
  }

  async call<T = Record<string, unknown>>(
    op: string,
    params: Record<string, unknown>,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<T> {
    if (this.closed) throw new SubstrateError(this.exitReason ?? "substrate bridge is closed");
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
    });
    this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    return (await promise) as T;
  }

  identity(): Promise<SubstrateIdentity> {
    return this.call<SubstrateIdentity>("substrate.identity", {});
  }

  accounting(): Promise<SubstrateAccounting> {
    return this.call<SubstrateAccounting>("accounting", {});
  }

  /** Shut down, returning the substrate's own accounting of what it touched. */
  async shutdown(): Promise<SubstrateAccounting | null> {
    if (this.closed) return null;
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ id, op: "shutdown" })}\n`);
    const accounting = (await promise) as unknown as SubstrateAccounting;
    this.child.stdin.end();
    return accounting;
  }
}
