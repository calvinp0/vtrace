import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";

import { Language, type FileRecord, type ModuleBindingSurface } from "../domain/types";
import {
  FILE_SNAPSHOT_SCHEMA_VERSION,
  MAX_BINDING_CLOSURE_FRACTION,
  bindingSurfaceDigest,
  computeSnapshotHash,
  deriveBindingClosure,
  planIncrementalRefresh,
  type IndexedFileSnapshot,
  type IndexedFileSnapshotSet,
  type ReverseBindingAuthority,
} from "./incrementalIndex";

function file(path: string, contentHash: string): FileRecord {
  return { id: path, path, language: Language.TypeScript, contentHash, sizeBytes: contentHash.length };
}

function snap(path: string, contentHash: string): IndexedFileSnapshot {
  return { relativePath: path, language: Language.TypeScript, contentHash, contentKind: "working_tree_hash", indexOutcome: "indexed", parserCapability: "supported", parserId: "ts", parserVersion: "v1", parserConfigFingerprint: "c1", bindingContextHash: "b1", parseCacheKey: `${path}:${contentHash}`, sizeBytes: contentHash.length };
}

function snapshot(files: IndexedFileSnapshot[]): IndexedFileSnapshotSet {
  return { schemaVersion: FILE_SNAPSHOT_SCHEMA_VERSION, files, fileCount: files.length, snapshotHash: computeSnapshotHash(files), graphSchemaVersion: 1, retrievalSchemaVersion: 1, bindingContextHash: "b1", semanticContextHash: "s1", parserRegistryFingerprint: "r1" };
}

test("planner emits deterministic noop and modified-only incremental plans", () => {
  const previous = snapshot([snap("a.ts", "aa"), snap("b.ts", "bb")]);
  const noop = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("b.ts", "bb"), file("a.ts", "aa")], previous, compatible: true });
  assert.equal(noop.mode, "noop");
  assert.deepEqual(noop.unchanged.map((entry) => entry.relativePath), ["a.ts", "b.ts"]);
  const changed = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("b.ts", "bc"), file("a.ts", "aa")], previous, compatible: true });
  assert.equal(changed.mode, "incremental");
  assert.deepEqual(changed.modified.map((entry) => entry.relativePath), ["b.ts"]);
});

test("planner classifies same-content rename and conservatively falls back", () => {
  const previous = snapshot([snap("old.ts", "same")]);
  const plan = planIncrementalRefresh({ requestedMode: "auto", currentFiles: [file("new.ts", "same")], previous, compatible: true });
  assert.equal(plan.mode, "full_rebuild");
  assert.equal(plan.fullRebuildReason, "closure_uncertain");
  assert.deepEqual(plan.renamed, [{ from: "old.ts", to: "new.ts", contentHash: "same" }]);
});

test("planner reports legacy and explicit full fallbacks precisely", () => {
  const current = [file("a.ts", "aa")];
  assert.equal(planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, compatible: true }).fullRebuildReason, "snapshot_missing");
  assert.equal(planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, compatible: false, incompatibilityReason: "parser_incompatible" }).fullRebuildReason, "parser_incompatible");
  assert.equal(planIncrementalRefresh({ requestedMode: "full", currentFiles: current, compatible: true }).mode, "full_rebuild");
});

test("measured lightweight-parser crossover selects a precise large-change fallback", () => {
  const oldFiles = Array.from({ length: 20 }, (_, index) => snap(`f${index}.ts`, "old"));
  const current = oldFiles.map((entry, index) => file(entry.relativePath, index < 4 ? "new" : "old"));
  const plan = planIncrementalRefresh({ requestedMode: "auto", currentFiles: current, previous: snapshot(oldFiles), compatible: true });
  assert.equal(plan.mode, "full_rebuild");
  assert.equal(plan.fullRebuildReason, "change_set_too_large");
});

// ------------------------------------------------- M200 module binding closure


function surface(
  filePath: string,
  bindings: ModuleBindingSurface["bindings"],
  unboundedNames = false,
): ModuleBindingSurface {
  return { filePath, isPackageSurface: filePath.endsWith("__init__.py"), bindings, unboundedNames };
}

const reExport = (localName: string, importedName: string, targetPath: string) =>
  ({ localName, kind: "re_export" as const, importedName, targetPath });

/**
 * An authority backed by plain maps, so the derivation can be exercised on
 * shapes no fixture repository has to be built for.
 */
function authority(input: {
  importers?: Record<string, string[]>;
  wildcards?: Record<string, string[]>;
  reExports?: Record<string, string[]>;
  available?: boolean;
}): ReverseBindingAuthority {
  return {
    isAvailable: () => input.available ?? true,
    importersOf: (target) => input.importers?.[target] ?? [],
    wildcardImportersOf: (target) => input.wildcards?.[target] ?? [],
    reExportsThrough: (file, target) => (input.reExports?.[file] ?? []).includes(target),
  };
}

const derive = (over: Partial<Parameters<typeof deriveBindingClosure>[0]>) => deriveBindingClosure({
  changedModules: [], surfaceless: [], unboundedModules: [],
  authority: authority({}), repositoryFileCount: 100,
  maxClosureFraction: MAX_BINDING_CLOSURE_FRACTION,
  ...over,
});

// --------------------------------------------------------------- the digest

test("a surface digest ignores nothing that decides a resolution", () => {
  const base = surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/foo.py")]);

  // Same bindings, built independently: equal. This is what makes an appended
  // comment cheap, and it is the ONLY thing M200 needs for the frozen A3 case.
  assert.equal(
    bindingSurfaceDigest(base),
    bindingSurfaceDigest(surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/foo.py")])),
  );

  // Every field that can move a consumer's resolution moves the digest.
  const redirected = surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/bar.py")]);
  const renamedSource = surface("pkg/__init__.py", [reExport("Foo", "Other", "pkg/foo.py")]);
  const renamedPublic = surface("pkg/__init__.py", [reExport("PublicFoo", "Foo", "pkg/foo.py")]);
  const removed = surface("pkg/__init__.py", []);
  const wildcard = surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/foo.py")], true);
  for (const [label, other] of Object.entries({ redirected, renamedSource, renamedPublic, removed, wildcard })) {
    assert.notEqual(bindingSurfaceDigest(base), bindingSurfaceDigest(other), label);
  }
});

/**
 * F12. The gate has to be able to go red, so here is the implementation §8
 * explicitly warns about — a surface keyed by published NAME alone — shown
 * failing on the one case that separates it from the real one.
 */
test("F12: a name-only surface digest cannot see a redirected re-export", () => {
  const nameOnlyDigest = (value: ModuleBindingSurface) => createHash("sha256")
    .update(value.bindings.map((binding) => binding.localName).sort().join("\n")).digest("hex");

  const before = surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/foo.py")]);
  const after = surface("pkg/__init__.py", [reExport("Foo", "Foo", "pkg/bar.py")]);

  assert.equal(nameOnlyDigest(before), nameOnlyDigest(after),
    "the broken derivation calls a redirect unchanged — which is the false negative");
  assert.notEqual(bindingSurfaceDigest(before), bindingSurfaceDigest(after),
    "the shipped derivation must not");
});

// -------------------------------------------------------------- the closure

test("the closure reaches direct consumers and stops there", () => {
  const closure = derive({
    changedModules: ["pkg/__init__.py"],
    authority: authority({ importers: { "pkg/__init__.py": ["consumer.py", "other.py"] } }),
  });
  assert.equal(closure.ok, true);
  assert.deepEqual(closure.ok && closure.files, ["consumer.py", "other.py"]);
});

test("the closure follows a re-export chain past its first hop", () => {
  // consumer.py imports pkg; pkg/__init__.py republishes through pkg/a.py.
  // Only a transitive walk starting at pkg/a.py reaches consumer.py.
  const closure = derive({
    changedModules: ["pkg/a.py"],
    authority: authority({
      importers: { "pkg/a.py": ["pkg/__init__.py"], "pkg/__init__.py": ["consumer.py"] },
      reExports: { "pkg/__init__.py": ["pkg/a.py"] },
    }),
  });
  assert.equal(closure.ok, true);
  assert.deepEqual(closure.ok && closure.files, ["consumer.py", "pkg/__init__.py"]);
});

test("a re-export cycle terminates rather than being refused", () => {
  const closure = derive({
    changedModules: ["pkg/a.py"],
    authority: authority({
      importers: { "pkg/a.py": ["pkg/b.py"], "pkg/b.py": ["pkg/a.py"] },
      reExports: { "pkg/a.py": ["pkg/b.py"], "pkg/b.py": ["pkg/a.py"] },
    }),
  });
  assert.equal(closure.ok, true);
  assert.deepEqual(closure.ok && closure.files, ["pkg/a.py", "pkg/b.py"]);
});

test("a consumer that only USES a name does not extend the walk", () => {
  const closure = derive({
    changedModules: ["pkg/__init__.py"],
    authority: authority({
      importers: { "pkg/__init__.py": ["consumer.py"], "consumer.py": ["downstream.py"] },
      // consumer.py imports the package but republishes nothing from it.
      reExports: {},
    }),
  });
  assert.equal(closure.ok, true);
  assert.deepEqual(closure.ok && closure.files, ["consumer.py"], "downstream.py is not reachable");
});

// ------------------------------------------------------------- the refusals

test("every unbounded condition refuses instead of returning a smaller closure", () => {
  const cases: [string, Parameters<typeof deriveBindingClosure>[0]][] = [
    ["descriptors_unavailable", { changedModules: ["a.py"], surfaceless: [], unboundedModules: [],
      authority: authority({ available: false }), repositoryFileCount: 100, maxClosureFraction: 0.2 }],
    ["surface_not_derivable", { changedModules: [], surfaceless: ["index.ts"], unboundedModules: [],
      authority: authority({}), repositoryFileCount: 100, maxClosureFraction: 0.2 }],
    ["wildcard_surface", { changedModules: ["pkg/__init__.py"], surfaceless: [],
      unboundedModules: ["pkg/__init__.py"], authority: authority({}), repositoryFileCount: 100, maxClosureFraction: 0.2 }],
    ["wildcard_consumer", { changedModules: ["pkg/__init__.py"], surfaceless: [], unboundedModules: [],
      authority: authority({ wildcards: { "pkg/__init__.py": ["wild.py"] } }),
      repositoryFileCount: 100, maxClosureFraction: 0.2 }],
    ["closure_too_large", { changedModules: ["pkg/__init__.py"], surfaceless: [], unboundedModules: [],
      authority: authority({ importers: { "pkg/__init__.py": ["a.py", "b.py", "c.py"] } }),
      repositoryFileCount: 10, maxClosureFraction: 0.2 }],
  ];
  for (const [expected, input] of cases) {
    const closure = deriveBindingClosure(input);
    assert.equal(closure.ok, false, expected);
    assert.equal(!closure.ok && closure.refusal, expected);
  }
});

test("the cap is a cost boundary and does not change what a closure contains", () => {
  const authorityWithSix = authority({
    importers: { "pkg/__init__.py": ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"] },
  });
  const capped = derive({ changedModules: ["pkg/__init__.py"], authority: authorityWithSix, repositoryFileCount: 10 });
  const uncapped = derive({
    changedModules: ["pkg/__init__.py"], authority: authorityWithSix,
    repositoryFileCount: 100, maxClosureFraction: 1,
  });
  assert.equal(capped.ok, false);
  assert.equal(!capped.ok && capped.refusal, "closure_too_large");
  assert.equal(uncapped.ok, true);
  assert.equal(uncapped.ok && uncapped.files.length, 6);
});
