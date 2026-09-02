// Fixture: café — naïve 日本語 before any declaration
import { helper } from "./helper.js";

/** Adds two numbers. */
export function add(a, b) {
  return helper(a) + b;
}

class Counter {
  constructor() { this.n = 0; }
  /** Increment. */
  increment() { this.n += 1; }
}

export const answer = 42;
