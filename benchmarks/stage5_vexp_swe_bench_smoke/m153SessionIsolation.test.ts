// M153 §48-§52: paired benchmark arms must not contaminate one another.
//
// This is benchmark HYGIENE, not product suppression. M152 deliberately gave
// product state its own lifecycle and its own file, and `get_code_context`
// writing observations is correct behaviour. The consequence for measurement is
// that two runs of the same corpus are not independent unless the harness makes
// them so, which was observed rather than theorised: with the behavioural lane
// enabled, a workspace request routed to a different repository, that repository
// accumulated observations, and later oracle calls in the same pass read them —
// the arm under test was perturbing its own control.
//
// The invariant these tests pin: every arm starts from the same mutable product
// state, and one arm's writes never reach another's starting point.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveSessionDbPath } from "../../src/session/sessionStore";

import { resetSessionState, sessionFingerprint } from "./m153BehavioralHarness";

const roots: string[] = [];

function fakeRepoWithSessionState(bytes: number): string {
  const root = mkdtempSync(path.join(tmpdir(), "m153-iso-"));
  roots.push(root);
  mkdirSync(path.join(root, ".vtrace"), { recursive: true });
  writeFileSync(resolveSessionDbPath(root), Buffer.alloc(bytes, 1));
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a repository carrying product state reports it", () => {
  const root = fakeRepoWithSessionState(2048);
  expect(sessionFingerprint(root).bytes).toBe(2048);
});

test("resetting discards mutable product state", () => {
  const root = fakeRepoWithSessionState(4096);
  resetSessionState([root]);
  expect(existsSync(resolveSessionDbPath(root))).toBe(false);
  expect(sessionFingerprint(root).bytes).toBe(0);
});

test("§50 arm B starts clean after arm A has written", () => {
  const a = fakeRepoWithSessionState(0);
  const b = fakeRepoWithSessionState(0);
  const scope = [a, b];

  // Arm A runs and writes product state into both members.
  resetSessionState(scope);
  writeFileSync(resolveSessionDbPath(a), Buffer.alloc(8192, 1));
  writeFileSync(resolveSessionDbPath(b), Buffer.alloc(1024, 1));
  expect(sessionFingerprint(a).bytes).toBeGreaterThan(0);

  // Arm B begins. Its starting state must be identical to arm A's, which is
  // what makes the two comparable at all.
  resetSessionState(scope);
  expect(scope.map((root) => sessionFingerprint(root).bytes)).toEqual([0, 0]);
});

test("§50 the reverse direction holds too", () => {
  const a = fakeRepoWithSessionState(0);
  const scope = [a];
  resetSessionState(scope);
  writeFileSync(resolveSessionDbPath(a), Buffer.alloc(512, 1));
  resetSessionState(scope);
  expect(sessionFingerprint(a).bytes).toBe(0);
});

test("resetting a repository that never had product state is not an error", () => {
  const root = mkdtempSync(path.join(tmpdir(), "m153-iso-"));
  roots.push(root);
  expect(() => resetSessionState([root])).not.toThrow();
});

test("resetting leaves the INDEX alone", () => {
  const root = fakeRepoWithSessionState(1024);
  const indexPath = path.join(root, ".vtrace", "index.sqlite");
  writeFileSync(indexPath, Buffer.alloc(3072, 7));
  resetSessionState([root]);
  // Repository-derived evidence survives; only the mutable half is discarded.
  expect(existsSync(indexPath)).toBe(true);
  expect(existsSync(resolveSessionDbPath(root))).toBe(false);
});
