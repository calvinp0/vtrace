/**
 * M201 — a query-cost gate that counts OPERATIONS rather than milliseconds.
 *
 * A5 is a wall-clock claim, and a wall-clock assertion in the normal suite is a
 * flake generator: M198-M200 measured the same tree at 111/439/627 ms under load
 * and this milestone measured it at 44/196/332 ms quiet, with no source change
 * between them. What did NOT move across any of those runs is the amount of work
 * the query path performs, so that is what this gate bounds.
 *
 * Three invariants, each aimed at a failure the profiling actually looked for:
 *
 *   - `wholeTableScans`   a lane that materialises the entire symbol table must
 *                         do so at most once per lane per request. This is the
 *                         one that catches a rescue pass, a retry, or a second
 *                         retrieval quietly re-running the same scan.
 *   - `maxRepeatsOfOneStatement`  the N+1 signature: one statement text executed
 *                         once per candidate.
 *   - `executions`        total statement executions, a coarse backstop for work
 *                         that is neither a scan nor a single hot loop.
 *
 * The counter is deliberately written to be double-counting-proof.
 * `Database.prototype.query` is implemented on top of `Database.prototype.prepare`,
 * so a naive instrument that patches both wraps every `query()` statement twice
 * and reports exactly twice the executions. M201 hit that: it read as a second
 * retrieval pass, and a repair was written and measured against a duplication
 * that did not exist. `wrapped` is the control, and `countsEachExecutionOnce` in
 * the accompanying test is the falsification for it.
 */
import { Database } from "bun:sqlite";

export interface StatementCount {
  readonly sql: string;
  readonly executions: number;
  readonly rows: number;
}

export interface QueryOperationCounts {
  readonly executions: number;
  readonly distinctStatements: number;
  readonly rowsReturned: number;
  /** Executions that returned at least `wholeTableRowThreshold` rows. */
  readonly wholeTableScans: number;
  readonly maxRepeatsOfOneStatement: number;
  readonly statements: readonly StatementCount[];
}

export interface QueryOperationBudget {
  readonly wholeTableRowThreshold: number;
  readonly maxWholeTableScans: number;
  readonly maxRepeatsOfOneStatement: number;
  readonly maxExecutions: number;
}

export interface QueryOperationVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly counts: QueryOperationCounts;
  readonly budget: QueryOperationBudget;
}

const EXEC_METHODS = new Set(["all", "get", "run", "values", "iterate"]);
const wrapped = new WeakSet<object>();

interface MutableCount { sql: string; executions: number; rows: number }

let recording = false;
let records = new Map<string, MutableCount>();
let scans = 0;
let scanThreshold = Number.POSITIVE_INFINITY;
let installed = false;

const rowCount = (result: unknown): number =>
  Array.isArray(result) ? result.length : result === null || result === undefined ? 0 : 1;

/** Idempotent. Safe to call from every test in a file. */
export function installQueryOperationCounter(): void {
  if (installed) return;
  installed = true;
  for (const method of ["query", "prepare"] as const) {
    const original = (Database.prototype as never as Record<string, (...a: never[]) => unknown>)[method]!;
    (Database.prototype as never as Record<string, unknown>)[method] = function patched(
      this: Database, sql: string, ...rest: unknown[]
    ) {
      const statement = original.call(this as never, sql as never, ...(rest as never[])) as object;
      if (typeof sql !== "string" || statement === null || typeof statement !== "object") return statement;
      // The whole point of the WeakSet: `query()` hands us a statement `prepare()`
      // already wrapped, and wrapping it again doubles every execution.
      if (wrapped.has(statement)) return statement;
      const proxy = new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof prop !== "string" || !EXEC_METHODS.has(prop) || typeof value !== "function") {
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          }
          return (...callArgs: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, callArgs);
            if (!recording) return result;
            let record = records.get(sql);
            if (record === undefined) {
              record = { sql, executions: 0, rows: 0 };
              records.set(sql, record);
            }
            record.executions += 1;
            const rows = rowCount(result);
            record.rows += rows;
            if (rows >= scanThreshold) scans += 1;
            return result;
          };
        },
      });
      wrapped.add(proxy);
      return proxy;
    };
  }
}

export function startQueryOperationRecording(wholeTableRowThreshold: number): void {
  records = new Map();
  scans = 0;
  scanThreshold = wholeTableRowThreshold;
  recording = true;
}

export function stopQueryOperationRecording(): QueryOperationCounts {
  recording = false;
  const statements = [...records.values()]
    .map((r): StatementCount => ({ sql: r.sql, executions: r.executions, rows: r.rows }))
    .sort((a, b) => b.executions - a.executions);
  return {
    executions: statements.reduce((n, s) => n + s.executions, 0),
    distinctStatements: statements.length,
    rowsReturned: statements.reduce((n, s) => n + s.rows, 0),
    wholeTableScans: scans,
    maxRepeatsOfOneStatement: statements.reduce((n, s) => Math.max(n, s.executions), 0),
    statements,
  };
}

/** Every violated bound is named; the gate does not stop at the first. */
export function evaluateQueryOperationBudget(
  counts: QueryOperationCounts,
  budget: QueryOperationBudget,
): QueryOperationVerdict {
  const violations: string[] = [];
  if (counts.wholeTableScans > budget.maxWholeTableScans) {
    violations.push(`whole_table_scans ${counts.wholeTableScans} > ${budget.maxWholeTableScans}`);
  }
  if (counts.maxRepeatsOfOneStatement > budget.maxRepeatsOfOneStatement) {
    violations.push(`statement_repeats ${counts.maxRepeatsOfOneStatement} > ${budget.maxRepeatsOfOneStatement}`);
  }
  if (counts.executions > budget.maxExecutions) {
    violations.push(`executions ${counts.executions} > ${budget.maxExecutions}`);
  }
  return { ok: violations.length === 0, violations, counts, budget };
}
