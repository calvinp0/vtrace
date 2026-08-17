import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { expectedDerivation, gateIndexDerivation } from "./indexDerivationGate";
import { computeIndexFingerprints } from "../../src/indexer/indexMeta";

// M155-B2. The committed regression baselines scored current retrieval code
// against indexes this runtime rejects, and reported it as authoritative. These
// are the controls that make that impossible to repeat: every rejection reason has
// a known-positive fixture, and acceptance has a known-negative one.

async function workspace(meta: unknown | null, withDb = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "m155-deriv-"));
  await mkdir(path.join(root, ".vtrace"), { recursive: true });
  if (withDb) await writeFile(path.join(root, ".vtrace", "index.sqlite"), "");
  if (meta !== null) {
    await writeFile(path.join(root, ".vtrace", "index.meta.json"), JSON.stringify(meta, null, 2));
  }
  return root;
}

async function currentMeta(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const fp = await computeIndexFingerprints();
  return {
    ...fp,
    repo_head: null,
    created_at: new Date(0).toISOString(),
    manifest: { schemaVersion: 4 },
    ...overrides,
  };
}

// --- acceptance (known-negative for "invalid") ------------------------------

test("an index whose derivation matches the running implementation is valid", async () => {
  const verdict = await gateIndexDerivation(await workspace(await currentMeta()));
  assert.equal(verdict.valid, true);
  assert.equal(verdict.reason, "derivation_agrees");
});

// --- rejection reasons, each with a known-positive fixture -------------------

test("a missing index is rejected, not treated as an empty result", async () => {
  const verdict = await gateIndexDerivation(await workspace(await currentMeta(), false));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "index_missing");
});

test("an index with NO meta fails closed, unlike the product's reuse decision", async () => {
  // This is the one deliberate divergence from `resolveDerivationRebuildReason`,
  // which returns undefined ("nothing stored, nothing to discard") for this case.
  // Four of the 20 committed django.expanded workspaces were in exactly this
  // state, so the divergence is load-bearing, not theoretical.
  const verdict = await gateIndexDerivation(await workspace(null));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "meta_missing");
});

test("an unsupported index_format_version is rejected", async () => {
  // The exact shape of the committed 2026-06-08 baselines: format 1 against {5}.
  const verdict = await gateIndexDerivation(await workspace(await currentMeta({ index_format_version: 1 })));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "schema_unsupported");
  assert.match(verdict.detail, /index_format_version 1 is not in the supported set/);
});

test("a changed parser fingerprint is rejected as parser_incompatible", async () => {
  const verdict = await gateIndexDerivation(await workspace(await currentMeta({ parser_fingerprint: "0".repeat(64) })));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "parser_incompatible");
});

test("a changed indexer fingerprint is rejected as derivation_incompatible", async () => {
  const verdict = await gateIndexDerivation(await workspace(await currentMeta({ indexer_fingerprint: "0".repeat(64) })));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "derivation_incompatible");
});

test("a changed config hash is rejected as configuration_incompatible", async () => {
  const verdict = await gateIndexDerivation(await workspace(await currentMeta({ config_hash: "0".repeat(64) })));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "configuration_incompatible");
});

// --- identity binding -------------------------------------------------------

test("the gate binds to the implementation under evaluation, not to a commit label", async () => {
  // vtrace_commit is explicitly a NON-derivation field: an index built by a
  // different commit that did not change derivation semantics stays valid, which
  // is what keeps the fast gate practical rather than rebuilding on every commit.
  const verdict = await gateIndexDerivation(
    await workspace(await currentMeta({ vtrace_commit: "f".repeat(40) })),
  );
  assert.equal(verdict.valid, true);
  assert.equal(verdict.storedVtraceCommit, "f".repeat(40));
});

test("the verdict reports both stored and expected derivation identity", async () => {
  const expected = await expectedDerivation();
  const verdict = await gateIndexDerivation(await workspace(await currentMeta()));
  assert.equal(verdict.expectedIndexerFingerprint, expected.indexer_fingerprint);
  assert.equal(verdict.storedIndexerFingerprint, expected.indexer_fingerprint);
  assert.equal(verdict.expectedFormatVersion, expected.index_format_version);
});
