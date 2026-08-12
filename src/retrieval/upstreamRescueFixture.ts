// Synthetic repositories for the M140-B upstream-rescue acceptance.
//
// Each fixture is a call graph with a deliberate shape: a strong downstream
// implementation the query matches, and orchestration above it that the query
// describes but does not name. Kept generic on purpose — no ARC/Django symbol
// names — so the lane is proven on structure rather than on one repository.

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { persistParseResult } from "../db/persistParseResult";
import { insertEdges } from "../db/repositories/edgesRepository";
import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type EdgeRecord,
  type FileRecord,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";

export interface FixtureSymbolSpec {
  readonly name: string;
  readonly kind?: SymbolKind;
  readonly signature?: string;
  readonly docstring?: string;
  readonly parent?: string;
}

export interface FixtureFileSpec {
  readonly path: string;
  readonly symbols: readonly FixtureSymbolSpec[];
}

export interface RescueFixtureSpec {
  readonly files: readonly FixtureFileSpec[];
  /** `calls[i] = [callerFq, calleeFq]`, each `path::Name` or `path::Class.Name`. */
  readonly calls?: ReadonlyArray<readonly [string, string]>;
  readonly contains?: ReadonlyArray<readonly [string, string]>;
}

/** Seeds the fixture and returns fully-qualified name -> symbol id. */
export function seedRescueFixture(db: Database, spec: RescueFixtureSpec): Map<string, string> {
  const ids = new Map<string, string>();

  for (const file of spec.files) {
    const byName = new Map<string, SymbolRecord>();
    let offset = 0;
    const symbols = file.symbols.map((symbolSpec) => {
      const parent = symbolSpec.parent === undefined ? undefined : byName.get(symbolSpec.parent);
      const symbolPath = parent === undefined
        ? [symbolSpec.name]
        : [parent.localName, symbolSpec.name];
      const fqName = buildFQName({ filePath: file.path, symbolPath });
      const kind = symbolSpec.kind ?? (parent === undefined ? SymbolKind.Function : SymbolKind.Method);
      const startByte = offset;
      const endByte = offset + 40;
      offset = endByte + 1;
      const symbol: SymbolRecord = {
        id: computeSymbolId({ filePath: file.path, fqName, kind, startByte, endByte }),
        filePath: file.path,
        fqName,
        localName: symbolSpec.name,
        kind,
        signature: symbolSpec.signature ?? `def ${symbolSpec.name}()`,
        startLine: 1,
        endLine: 1,
        startByte,
        endByte,
        ...(parent === undefined ? {} : { parentSymbolId: parent.id }),
        exported: false,
        ...(symbolSpec.docstring === undefined ? {} : { docstring: symbolSpec.docstring }),
      };
      byName.set(symbolSpec.name, symbol);
      ids.set(fqName, symbol.id);
      return symbol;
    });

    const parseResult: ParseResult = { file: makeFileRecord(file.path), symbols, edges: [], diagnostics: [] };
    persistParseResult(db, parseResult);
  }

  const edges: EdgeRecord[] = [];
  const resolve = (fqName: string): string => {
    const id = ids.get(fqName);
    if (id === undefined) {
      throw new Error(`fixture: unknown symbol ${fqName}`);
    }
    return id;
  };
  for (const [from, to] of spec.calls ?? []) {
    edges.push(edge(resolve(from), resolve(to), EdgeType.Calls));
  }
  for (const [from, to] of spec.contains ?? []) {
    edges.push(edge(resolve(from), resolve(to), EdgeType.Contains));
  }
  if (edges.length > 0) {
    insertEdges(db, edges);
  }

  return ids;
}

/**
 * §41: a three-stage reconstruction chain. The query names the parsing at the
 * bottom; the two orchestration stages above it describe themselves only in
 * their docstrings, which is what keeps them out of the lexical top ranks.
 */
export const ORCHESTRATION_CHAIN_FIXTURE: RescueFixtureSpec = {
  files: [
    {
      path: "app/loader.py",
      symbols: [
        {
          name: "deserialize",
          docstring: "Entry point that turns a serialized payload into an object.",
        },
        {
          name: "rebuild_model",
          docstring: "Rebuild the object from decoded serialized fields.",
        },
      ],
    },
    {
      path: "app/parser.py",
      symbols: [
        {
          name: "parse_raw_data",
          docstring: "Parse raw serialized data into typed fields.",
        },
      ],
    },
    // Unrelated neighbours, so the pool is not trivially the whole repository.
    {
      path: "app/render.py",
      symbols: [
        { name: "render_template", docstring: "Render an HTML template to a string." },
        { name: "flush_output", docstring: "Flush buffered output to the socket." },
      ],
    },
  ],
  calls: [
    ["app/loader.py::deserialize", "app/loader.py::rebuild_model"],
    ["app/loader.py::rebuild_model", "app/parser.py::parse_raw_data"],
  ],
};

export const ORCHESTRATION_CHAIN_QUERY =
  "How is an object rebuilt from a serialized payload before raw data parsing?";

/**
 * §42: one entry point choosing between two branches, with the query-matching
 * helper reachable through only one of them.
 */
export const CONDITIONAL_BRANCH_FIXTURE: RescueFixtureSpec = {
  files: [
    {
      path: "app/state.py",
      symbols: [
        {
          name: "load_state",
          docstring: "Decide whether to reuse the cached state or regenerate it.",
        },
        { name: "use_cached", docstring: "Return the previously cached state object." },
        { name: "regenerate", docstring: "Rebuild the state from scratch when no cache is valid." },
      ],
    },
    {
      path: "app/cache.py",
      symbols: [
        {
          name: "read_cache_entry",
          docstring: "Read a cached state entry and validate its checksum.",
        },
      ],
    },
    {
      path: "app/unrelated.py",
      symbols: [{ name: "send_metrics", docstring: "Emit counters to the metrics sink." }],
    },
  ],
  calls: [
    ["app/state.py::load_state", "app/state.py::use_cached"],
    ["app/state.py::load_state", "app/state.py::regenerate"],
    ["app/state.py::use_cached", "app/cache.py::read_cache_entry"],
  ],
};

export const CONDITIONAL_BRANCH_QUERY =
  "When do we reuse cached state rather than regenerate it?";

/**
 * §44/§45: the minimal depth fixtures. `entry -> middle -> strong_seed` proves a
 * two-hop recovery; `lone_caller -> solo_seed` proves one hop needs no depth 2.
 */
export const TWO_HOP_FIXTURE: RescueFixtureSpec = {
  files: [
    {
      path: "app/pipeline.py",
      symbols: [
        { name: "entry", docstring: "Start the checksum verification workflow for a payload." },
        { name: "middle", docstring: "Coordinate checksum verification across payload chunks." },
      ],
    },
    {
      path: "app/checksum.py",
      symbols: [
        {
          name: "verify_payload_checksum",
          docstring: "Verify the checksum of a payload chunk.",
        },
      ],
    },
    {
      path: "app/solo.py",
      symbols: [
        { name: "lone_caller", docstring: "Drive the signature validation workflow for a payload." },
        { name: "validate_payload_signature", docstring: "Validate the signature of a payload." },
      ],
    },
  ],
  calls: [
    ["app/pipeline.py::entry", "app/pipeline.py::middle"],
    ["app/pipeline.py::middle", "app/checksum.py::verify_payload_checksum"],
    ["app/solo.py::lone_caller", "app/solo.py::validate_payload_signature"],
  ],
};

export const TWO_HOP_QUERY =
  "How does payload checksum verification get started and coordinated?";

export const ONE_HOP_QUERY =
  "How does payload signature validation get driven?";

/** §46: `A -> B -> C -> A`. Incoming traversal must terminate on the revisit. */
export const CYCLE_FIXTURE: RescueFixtureSpec = {
  files: [
    {
      path: "app/cycle.py",
      symbols: [
        { name: "stage_a", docstring: "Rotate the ledger snapshot and hand off to stage b." },
        { name: "stage_b", docstring: "Rotate the ledger snapshot and hand off to stage c." },
        { name: "stage_c", docstring: "Rotate the ledger snapshot and hand off to stage a." },
      ],
    },
  ],
  calls: [
    ["app/cycle.py::stage_a", "app/cycle.py::stage_b"],
    ["app/cycle.py::stage_b", "app/cycle.py::stage_c"],
    ["app/cycle.py::stage_c", "app/cycle.py::stage_a"],
  ],
};

export const CYCLE_QUERY = "How does the ledger snapshot rotation happen?";

/**
 * §43: one helper with `callerCount` callers, of which only a handful mention
 * anything the query asks about. Proves the lane's cost and output track its
 * caps rather than the helper's popularity.
 */
export function highFanInFixture(callerCount: number): RescueFixtureSpec {
  const callers: FixtureSymbolSpec[] = [];
  const calls: Array<readonly [string, string]> = [];
  for (let index = 0; index < callerCount; index += 1) {
    const name = `bulk_consumer_${index}`;
    callers.push({
      name,
      // Deliberately unrelated vocabulary: these must never be ADMITTED by the
      // rescue lane, however many of them there are.
      docstring: "Iterate widgets and append them to the inventory listing.",
    });
    calls.push([`app/bulk.py::${name}`, "app/common.py::record_delivery_retry_outcome"]);
  }
  // The few genuinely relevant callers. Their NAMES deliberately avoid the query
  // vocabulary — only their docstrings relate them — so lexical search cannot
  // reach them and the rescue lane is what has to.
  const relevant: FixtureSymbolSpec[] = [
    {
      name: "flush_pending_batch",
      docstring: "Schedule the next delivery attempt batch after a transient failure.",
    },
    {
      name: "finalize_delivery",
      docstring: "Record the outcome of a delivery attempt once it settles.",
    },
  ];
  for (const symbol of relevant) {
    calls.push([`app/queue.py::${symbol.name}`, "app/common.py::record_delivery_retry_outcome"]);
  }

  return {
    files: [
      {
        path: "app/common.py",
        symbols: [
          {
            name: "record_delivery_retry_outcome",
            docstring: "Shared helper that records a delivery retry attempt outcome.",
          },
        ],
      },
      { path: "app/bulk.py", symbols: callers },
      { path: "app/queue.py", symbols: relevant },
    ],
    calls,
  };
}

export const HIGH_FAN_IN_SEED = "app/common.py::record_delivery_retry_outcome";

export const HIGH_FAN_IN_QUERY =
  "How does a delivery retry attempt outcome get recorded?";

/**
 * §47: two strong seeds whose caller sets overlap, so dedupe and the global cap
 * are both exercised by one request.
 */
export const MULTI_SEED_FIXTURE: RescueFixtureSpec = {
  files: [
    {
      path: "app/index.py",
      symbols: [
        { name: "build_shard_index", docstring: "Build the shard index for a segment." },
        { name: "merge_shard_index", docstring: "Merge shard index segments together." },
      ],
    },
    {
      path: "app/driver.py",
      symbols: [
        {
          name: "run_shard_maintenance",
          docstring: "Coordinate shard index build and merge for a segment.",
        },
        {
          name: "schedule_shard_job",
          docstring: "Schedule a shard index maintenance segment job.",
        },
      ],
    },
  ],
  calls: [
    ["app/driver.py::run_shard_maintenance", "app/index.py::build_shard_index"],
    ["app/driver.py::run_shard_maintenance", "app/index.py::merge_shard_index"],
    ["app/driver.py::schedule_shard_job", "app/index.py::build_shard_index"],
    ["app/driver.py::schedule_shard_job", "app/index.py::merge_shard_index"],
  ],
};

export const MULTI_SEED_QUERY =
  "How does shard index build and merge maintenance happen for a segment?";

/**
 * §50: a helper whose NAME is common vocabulary, with broad fan-in from callers
 * that have nothing to do with the request.
 */
export function commonNameFixture(callerCount: number): RescueFixtureSpec {
  const callers: FixtureSymbolSpec[] = [];
  const calls: Array<readonly [string, string]> = [];
  for (let index = 0; index < callerCount; index += 1) {
    const name = `module_${index}_entry`;
    callers.push({ name, docstring: "Coordinate an unrelated subsystem startup routine." });
    calls.push([`app/wide.py::${name}`, "app/util.py::copy"]);
  }
  return {
    files: [
      {
        path: "app/util.py",
        symbols: [
          { name: "copy", docstring: "Copy a value." },
          { name: "get", docstring: "Get a value." },
          { name: "load", docstring: "Load a value." },
        ],
      },
      { path: "app/wide.py", symbols: callers },
    ],
    calls,
  };
}

/**
 * End-to-end fixture: the only route to the entry point is upstream rescue.
 *
 * Every other lane is deliberately blocked. The seed's own package is padded so
 * same-module expansion spends its per-seed quota on neighbours; the
 * orchestration lives in a different package so it is never a sibling; and it is
 * TWO call hops up, beyond the depth-1 graph expansion. Its name shares no
 * vocabulary with the query — only its docstring relates it — so lexical search
 * cannot reach it either.
 */
export function deepChainFixture(padding: number): RescueFixtureSpec {
  const noise: FixtureSymbolSpec[] = Array.from({ length: padding }, (_, index) => ({
    name: `codec_helper_${index}`,
    docstring: "Encode and decode a transport frame header field.",
  }));
  return {
    files: [
      {
        path: "transport/frames.py",
        symbols: [
          {
            name: "verify_frame_checksum",
            docstring: "Verify the checksum of a transport frame before dispatch.",
          },
          ...noise,
        ],
      },
      {
        path: "workflow/dispatch.py",
        symbols: [
          {
            name: "relay_chunk",
            docstring: "Relay one chunk onward, verifying its checksum first.",
          },
          {
            name: "begin_session",
            docstring: "Start a dispatch session and verify each transport frame checksum.",
          },
        ],
      },
    ],
    calls: [
      ["workflow/dispatch.py::begin_session", "workflow/dispatch.py::relay_chunk"],
      ["workflow/dispatch.py::relay_chunk", "transport/frames.py::verify_frame_checksum"],
    ],
  };
}

export const DEEP_CHAIN_QUERY =
  "How does a transport frame checksum get verified during a dispatch session?";

function makeFileRecord(filePath: string): FileRecord {
  const content = `# ${filePath}\n`;
  return {
    id: computeFileId(filePath),
    path: filePath,
    language: Language.Python,
    contentHash: stableHash([content]),
    sizeBytes: Buffer.byteLength(content),
  };
}

function edge(src: string, dst: string, edgeType: EdgeType): EdgeRecord {
  return {
    id: stableHash([src, dst, edgeType]),
    srcSymbolId: src,
    dstSymbolId: dst,
    edgeType,
    confidence: 1,
  };
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
