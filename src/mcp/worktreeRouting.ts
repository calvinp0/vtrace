// Request -> worktree routing for MCP product tools.
//
// WHY THIS EXISTS
// ----------------
// A vtrace MCP server is launched once, bound to the checkout it was started in.
// Agents and subagents routinely work somewhere else: a linked worktree holding a
// PR branch, a scratch checkout under /tmp. Before M132 a product call that did
// not name a root silently answered from the server's bound checkout, and the
// agent had to reverse-engineer that from the content it got back ("Index is bound
// to /home/calvin/code/ARC @ 1202705b and does NOT contain PR #944's code").
//
// WHAT MCP ACTUALLY GIVES US (M132 audit, §13)
// ----------------
// The stdio JSON-RPC surface carries NO caller working directory. `initialize`
// exchanges protocol version, capabilities and clientInfo; this server neither
// declares nor consumes the `roots` client capability, and even `roots` would
// describe client workspace roots rather than the cwd of the subagent making a
// particular call. `process.cwd()` is the SERVER's launch directory, which is
// exactly the value that must never win. So caller context cannot be detected
// today, and the product contract is: an explicit `repo_root` selects the
// worktree; absent that, the bound root answers and says so.
//
// The routing decision therefore never guesses. It reports which of the three
// sources supplied the root, and every failure is an actionable diagnostic rather
// than a silent fallback to a different checkout.

import path from "node:path";

import { detectRepoRoot } from "../setup/repoState";
import {
  resolveWorktreeIdentity,
  type ResolvedWorktreeIdentity,
} from "../indexer/worktreeIdentity";

/** Where the served worktree root came from. */
export const WorktreeRoutingSource = Object.freeze({
  /** The caller passed `repo_root` on this tool call. */
  ExplicitRoot: "explicit_root",
  /** Supplied by the client/runtime integration. Unused today — see the audit. */
  ClientContext: "client_context",
  /** The root the server process was bound to at launch. */
  ProcessDefault: "process_default",
});

export type WorktreeRoutingSource =
  (typeof WorktreeRoutingSource)[keyof typeof WorktreeRoutingSource];

export const WorktreeRoutingReason = Object.freeze({
  /** No explicit root, no client context, and no server-bound root. */
  ContextRequired: "worktree_context_required",
  /** The requested root does not exist (deleted or moved worktree). */
  WorktreeMissing: "worktree_missing",
  /** The requested worktree is real but its index belongs to another worktree. */
  WorktreeMismatch: "worktree_mismatch",
  /** The requested worktree is real and has no index of its own. */
  IndexMissing: "worktree_index_missing",
});

export type WorktreeRoutingReason =
  (typeof WorktreeRoutingReason)[keyof typeof WorktreeRoutingReason];

export interface WorktreeRoutingInput {
  /** `repo_root` from the tool call, when supplied. */
  readonly requestedRoot?: string | undefined;
  /** Caller-supplied workspace/project root, when a runtime can provide one. */
  readonly clientContextRoot?: string | null | undefined;
  /** The root this server process was bound to. Never overrides the two above. */
  readonly boundRoot?: string | null | undefined;
}

export interface WorktreeRoutingDecision {
  /** The canonical worktree root that will answer this request. */
  readonly repoRoot: string;
  /** The path the caller named, before canonicalisation. */
  readonly requestedRoot: string;
  readonly routingSource: WorktreeRoutingSource;
  readonly identity: ResolvedWorktreeIdentity;
}

export interface WorktreeRoutingFailure {
  readonly ok: false;
  readonly reason: WorktreeRoutingReason;
  readonly message: string;
  /** The root the caller named, when there was one. */
  readonly requestedWorktree?: string;
  /** The root this server is bound to, for an actionable retry. */
  readonly activeIndex?: {
    readonly root: string;
    readonly branch: string | null;
    readonly head: string | null;
  };
  readonly action: { readonly type: "retry_with_worktree_root" | "call_index_repo" | "choose_worktree" };
}

export type WorktreeRoutingResult =
  | { readonly ok: true; readonly decision: WorktreeRoutingDecision }
  | WorktreeRoutingFailure;

/**
 * Resolve the worktree a product request means, in strict precedence:
 * explicit `repo_root` > client context > server-bound root.
 *
 * The server's own working directory is NOT a candidate: a long-lived server
 * launched in the parent checkout must not capture a request meant for a linked
 * worktree. When nothing at all is available the caller gets
 * `worktree_context_required` rather than an arbitrary checkout's source.
 */
export async function resolveWorktreeRouting(
  input: WorktreeRoutingInput,
): Promise<WorktreeRoutingResult> {
  const selected = selectRoot(input);

  if (selected === undefined) {
    return {
      ok: false,
      reason: WorktreeRoutingReason.ContextRequired,
      message: "Vtrace could not determine which Git worktree this request refers to. Pass repo_root with the worktree you are working in.",
      action: { type: "retry_with_worktree_root" },
    };
  }

  let repoRoot: string;
  try {
    repoRoot = (await detectRepoRoot(selected.root)).repoRoot;
  } catch (error) {
    const active = await describeActiveIndex(input.boundRoot);
    return {
      ok: false,
      reason: WorktreeRoutingReason.WorktreeMissing,
      message: `Vtrace cannot reach the requested worktree ${path.resolve(selected.root)}: ${error instanceof Error ? error.message : String(error)}`,
      requestedWorktree: path.resolve(selected.root),
      ...(active === undefined ? {} : { activeIndex: active }),
      action: { type: "retry_with_worktree_root" },
    };
  }

  return {
    ok: true,
    decision: {
      repoRoot,
      requestedRoot: path.resolve(selected.root),
      routingSource: selected.source,
      identity: await resolveWorktreeIdentity(repoRoot),
    },
  };
}

/**
 * Fail-closed identity check on the hot path: the index selected for a request
 * must have been built for the worktree the request routed to.
 *
 * Deliberately compares recorded ROOTS rather than re-deriving Git identity. The
 * manifest root was canonicalised at index time, so this is an O(1) string
 * comparison with no subprocess — cheap enough to run on every product call,
 * which is what makes it a real invariant rather than an occasional audit.
 *
 * Silent on a manifest that records no worktree root: an index written before
 * worktree identity existed makes no claim to contradict, and treating "no claim"
 * as "wrong worktree" would fail closed on indexes that are merely old.
 * `get_code_context` still runs the full M114 identity comparison on top of this.
 */
export function detectIndexWorktreeMismatch(input: {
  readonly routedRoot: string;
  readonly indexedWorktreeRoot: string | null | undefined;
}): WorktreeRoutingFailure | undefined {
  if (!isUsablePath(input.indexedWorktreeRoot)) return undefined;

  const indexed = path.resolve(input.indexedWorktreeRoot);
  const routed = path.resolve(input.routedRoot);
  if (indexed === routed) return undefined;

  return {
    ok: false,
    reason: WorktreeRoutingReason.WorktreeMismatch,
    message: `The index stored under ${routed} was built for a different worktree (${indexed}). Vtrace will not answer this request from another checkout's index.`,
    requestedWorktree: routed,
    activeIndex: { root: indexed, branch: null, head: null },
    action: { type: "choose_worktree" },
  };
}

/**
 * The compact per-request provenance block. One of these per response is enough:
 * absolute paths appear exactly once, and no field is repeated per selected item.
 */
export interface WorktreeProvenance {
  readonly repoRoot: string;
  readonly canonicalRepoId: string;
  readonly worktreeId: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly routingSource: WorktreeRoutingSource;
  /** True when the routed worktree is not the server-bound one. */
  readonly worktreeMatchesServerDefault: boolean;
}

export function describeWorktreeProvenance(
  decision: WorktreeRoutingDecision,
  boundRoot: string | null | undefined,
): WorktreeProvenance {
  return {
    repoRoot: decision.repoRoot,
    canonicalRepoId: decision.identity.repository.repositoryId,
    worktreeId: decision.identity.worktree.worktreeId,
    branch: decision.identity.snapshot.branch,
    head: decision.identity.snapshot.headCommit,
    routingSource: decision.routingSource,
    worktreeMatchesServerDefault: boundRoot === null || boundRoot === undefined
      ? false
      : path.resolve(boundRoot) === decision.repoRoot,
  };
}

/**
 * The routing source a request will resolve to, without doing the resolution.
 * Lets a response stamp its provenance without a second filesystem round-trip.
 */
export function routingSourceFor(input: WorktreeRoutingInput): WorktreeRoutingSource {
  return selectRoot(input)?.source ?? WorktreeRoutingSource.ProcessDefault;
}

function selectRoot(
  input: WorktreeRoutingInput,
): { readonly root: string; readonly source: WorktreeRoutingSource } | undefined {
  if (isUsablePath(input.requestedRoot)) {
    return { root: input.requestedRoot, source: WorktreeRoutingSource.ExplicitRoot };
  }
  if (isUsablePath(input.clientContextRoot)) {
    return { root: input.clientContextRoot, source: WorktreeRoutingSource.ClientContext };
  }
  if (isUsablePath(input.boundRoot)) {
    return { root: input.boundRoot, source: WorktreeRoutingSource.ProcessDefault };
  }
  return undefined;
}

function isUsablePath(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function describeActiveIndex(
  boundRoot: string | null | undefined,
): Promise<WorktreeRoutingFailure["activeIndex"]> {
  if (!isUsablePath(boundRoot)) return undefined;
  try {
    const identity = await resolveWorktreeIdentity(boundRoot);
    return {
      root: identity.worktree.worktreeRoot,
      branch: identity.snapshot.branch,
      head: identity.snapshot.headCommit,
    };
  } catch {
    return undefined;
  }
}
