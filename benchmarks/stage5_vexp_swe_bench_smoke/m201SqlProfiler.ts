/**
 * M201 — SQLite statement instrumentation for the frozen A5 query path.
 *
 * `Database.prototype.query`/`prepare` are wrapped so every statement the
 * PRODUCTION code prepares is returned inside a recording proxy. Nothing in
 * `src/` is modified and no statement text is rewritten: the proxy forwards to
 * the real statement and only observes how often each one is executed, how long
 * its executions take, and how many rows come back.
 *
 * This is what makes an N+1 visible. A statement executed once per candidate is
 * indistinguishable from a statement executed once, in a wall-clock total; it is
 * obvious the moment executions are counted per statement text.
 */
import { Database } from "bun:sqlite";

export interface StatementRecord {
  sql: string;
  prepares: number;
  executions: number;
  totalMs: number;
  rows: number;
  /** Executions attributed to `query()` (bun caches these) vs `prepare()`. */
  viaQuery: number;
  viaPrepare: number;
}

const EXEC_METHODS = new Set(["all", "get", "run", "values", "iterate"]);

/**
 * Statements this profiler has already wrapped.
 *
 * `Database.prototype.query` is implemented ON TOP OF `Database.prototype.prepare`,
 * so patching both and wrapping unconditionally puts two recording proxies around
 * every statement a caller obtained through `query()` — and each `.all()` is then
 * counted twice. That inflation is invisible in a total (everything doubles) and
 * decisive in a ratio: it turns one retrieval pass into an apparent two, which is
 * exactly the kind of finding this instrument exists to establish. Wrapping once
 * per statement is therefore a correctness requirement, not a tidiness one.
 */
const wrapped = new WeakSet<object>();

let recording = false;
const records = new Map<string, StatementRecord>();
let patched = false;

const bump = (sql: string): StatementRecord => {
  let r = records.get(sql);
  if (r === undefined) {
    r = { sql, prepares: 0, executions: 0, totalMs: 0, rows: 0, viaQuery: 0, viaPrepare: 0 };
    records.set(sql, r);
  }
  return r;
};

const rowCount = (result: unknown): number =>
  Array.isArray(result) ? result.length : result === null || result === undefined ? 0 : 1;

function wrap(statement: any, sql: string, origin: "query" | "prepare"): any {
  if (typeof statement === "object" && statement !== null && wrapped.has(statement)) {
    return statement;
  }
  const rec = bump(sql);
  rec.prepares += 1;
  const proxy = new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== "string" || !EXEC_METHODS.has(prop) || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...callArgs: unknown[]) => {
        if (!recording) return value.apply(target, callArgs);
        const t0 = performance.now();
        const result = value.apply(target, callArgs);
        rec.totalMs += performance.now() - t0;
        rec.executions += 1;
        if (origin === "query") rec.viaQuery += 1; else rec.viaPrepare += 1;
        rec.rows += rowCount(result);
        return result;
      };
    },
  });
  wrapped.add(proxy);
  return proxy;
}

/** Idempotent: patching twice would double-count every execution. */
export function installSqlProfiler(): void {
  if (patched) return;
  patched = true;
  for (const method of ["query", "prepare"] as const) {
    const original = (Database.prototype as any)[method];
    (Database.prototype as any)[method] = function patchedMethod(this: Database, sql: string, ...rest: unknown[]) {
      const statement = original.call(this, sql, ...rest);
      if (!recording || typeof sql !== "string") return statement;
      return wrap(statement, sql, method);
    };
  }
}

export function startRecording(): void { records.clear(); recording = true; }

export function stopRecording(): StatementRecord[] {
  recording = false;
  return [...records.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function summarize(rows: readonly StatementRecord[]) {
  const executions = rows.reduce((n, r) => n + r.executions, 0);
  const totalMs = rows.reduce((n, r) => n + r.totalMs, 0);
  return {
    distinctStatements: rows.length,
    executions,
    totalSqlMs: +totalMs.toFixed(2),
    rowsReturned: rows.reduce((n, r) => n + r.rows, 0),
    /**
     * A statement executed many times per query is the N+1 signature. Reported
     * as a population rather than a single worst case, because one hot loop and
     * ten warm ones are different problems.
     */
    repeatedStatements: rows.filter((r) => r.executions > 1).length,
    executionsFromRepeatedStatements: rows.filter((r) => r.executions > 1)
      .reduce((n, r) => n + r.executions, 0),
  };
}
