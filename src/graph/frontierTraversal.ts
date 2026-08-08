/**
 * Bounded, indexed, level-synchronous frontier traversal over the symbol graph.
 *
 * The point of this module is a single architectural rule, learned the hard way
 * in M130: **the cost of answering a graph question must track the subgraph the
 * question actually explores, not the size of the repository's edge table.**
 * The pre-M130 flow search materialised every symbol and every edge before
 * searching, then bounded the search by truncating that materialised list — so
 * a one-edge answer paid for the whole repository AND could silently lose the
 * edge it was looking for.
 *
 * Here the graph is never materialised. Each level issues ONE batched adjacency
 * query for the whole frontier (`expandFrontier`), and the budget counts edges
 * actually relaxed. A budget that bites is reported (`budgetExhausted`), never
 * silently folded into "nothing found".
 *
 * This module is deliberately policy-free: direction, allowed edge types,
 * filtering and ordering are all supplied by the caller, so flow and impact can
 * share the mechanics without sharing semantics.
 */

/** Shared work budget. One query's traversals draw from one pool. */
export interface TraversalBudget {
  readonly limit: number;
  /** Edges relaxed so far across every traversal that shares this budget. */
  spent: number;
}

export function createTraversalBudget(limit: number): TraversalBudget {
  return { limit: Math.max(1, Math.floor(limit)), spent: 0 };
}

export interface FrontierTraversalCounters {
  /** Nodes whose adjacency was requested. */
  readonly nodesExpanded: number;
  /** Adjacency rows returned by the batched queries (before caller filtering). */
  readonly edgesFetched: number;
  /** Edges the search actually relaxed. This is what the budget counts. */
  readonly edgesRelaxed: number;
  /** Batched adjacency queries issued (one per frontier level, per chunk). */
  readonly frontierBatches: number;
  readonly maxFrontierSize: number;
  /** Underlying indexed queries issued, including endpoint hydration. */
  readonly dbQueries: number;
  readonly visitedNodes: number;
  readonly depthReached: number;
  readonly budgetLimit: number;
  readonly budgetExhausted: boolean;
  readonly targetFound: boolean;
}

export interface FrontierTraversalInput<TEdge> {
  readonly startSymbolId: string;
  /**
   * Stop once this node is known AND the level that discovered it is complete.
   * Level completeness is what keeps early exit safe: every node closer to the
   * start than the target already has its final distance and full adjacency.
   */
  readonly targetSymbolId?: string;
  readonly maxDepth: number;
  readonly budget: TraversalBudget;
  /**
   * ONE batched query for the whole frontier. Implementations may chunk large
   * frontiers internally; they must report how many queries that took.
   */
  readonly expandFrontier: (symbolIds: readonly string[]) => FrontierExpansion<TEdge>;
  /** The node an edge leads to, in this traversal's direction. */
  readonly edgeTarget: (edge: TEdge) => string;
  /** The node an edge leaves from, in this traversal's direction. */
  readonly edgeOrigin: (edge: TEdge) => string;
  /** Total order over one node's adjacency. Fixes which edge is relaxed first. */
  readonly compareEdges: (left: TEdge, right: TEdge) => number;
  /** Total order over frontier nodes, so relaxation order never depends on SQLite row order. */
  readonly compareNodes: (left: string, right: string) => number;
}

export interface FrontierExpansion<TEdge> {
  /** Adjacency rows that survived the caller's filter. */
  readonly edges: readonly TEdge[];
  /** Rows the query returned, before filtering. */
  readonly fetched: number;
  /** Indexed queries issued to produce this expansion. */
  readonly dbQueries: number;
}

export interface FrontierTraversalResult<TEdge> {
  /** Shortest edge-count distance from the start, for every discovered node. */
  readonly distances: ReadonlyMap<string, number>;
  /** Sorted adjacency of every node this traversal expanded. */
  readonly adjacency: ReadonlyMap<string, readonly TEdge[]>;
  readonly counters: FrontierTraversalCounters;
}

/**
 * Breadth-first search that expands one complete level per batched query.
 *
 * Level-synchronous (rather than a single growing queue) for two reasons: it
 * makes the batched query natural — a whole level is one `IN (...)` — and it
 * makes early termination provably safe, because a level is either fully
 * relaxed or the budget stopped the search and said so.
 */
export function traverseFrontier<TEdge>(
  input: FrontierTraversalInput<TEdge>,
): FrontierTraversalResult<TEdge> {
  const distances = new Map<string, number>([[input.startSymbolId, 0]]);
  const adjacency = new Map<string, readonly TEdge[]>();
  const maxDepth = Math.max(0, Math.floor(input.maxDepth));

  let frontier: string[] = [input.startSymbolId];
  let nodesExpanded = 0;
  let edgesFetched = 0;
  let edgesRelaxed = 0;
  let frontierBatches = 0;
  let maxFrontierSize = frontier.length;
  let dbQueries = 0;
  let depthReached = 0;
  let budgetExhausted = false;
  let targetFound = input.targetSymbolId === input.startSymbolId;

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && !budgetExhausted && !targetFound; depth += 1) {
    const expansion = input.expandFrontier(frontier);
    frontierBatches += 1;
    edgesFetched += expansion.fetched;
    dbQueries += expansion.dbQueries;
    nodesExpanded += frontier.length;

    const adjacencyByOrigin = new Map<string, TEdge[]>();
    const frontierSet = new Set(frontier);

    for (const edge of expansion.edges) {
      const origin = input.edgeOrigin(edge);
      if (!frontierSet.has(origin)) {
        continue;
      }
      const bucket = adjacencyByOrigin.get(origin);
      if (bucket === undefined) {
        adjacencyByOrigin.set(origin, [edge]);
      } else {
        bucket.push(edge);
      }
    }

    const discovered: string[] = [];

    for (const symbolId of frontier) {
      const outgoing = (adjacencyByOrigin.get(symbolId) ?? []).sort(input.compareEdges);
      adjacency.set(symbolId, outgoing);

      for (const edge of outgoing) {
        if (input.budget.spent >= input.budget.limit) {
          budgetExhausted = true;
          break;
        }

        input.budget.spent += 1;
        edgesRelaxed += 1;

        const next = input.edgeTarget(edge);
        if (distances.has(next)) {
          continue;
        }

        distances.set(next, depth + 1);
        discovered.push(next);

        if (next === input.targetSymbolId) {
          targetFound = true;
        }
      }

      if (budgetExhausted) {
        break;
      }
    }

    depthReached = depth + 1;
    frontier = discovered.sort(input.compareNodes);
    maxFrontierSize = Math.max(maxFrontierSize, frontier.length);
  }

  return {
    distances,
    adjacency,
    counters: {
      nodesExpanded,
      edgesFetched,
      edgesRelaxed,
      frontierBatches,
      maxFrontierSize,
      dbQueries,
      visitedNodes: distances.size,
      depthReached,
      budgetLimit: input.budget.limit,
      budgetExhausted,
      targetFound: input.targetSymbolId === undefined ? false : distances.has(input.targetSymbolId),
    },
  };
}
