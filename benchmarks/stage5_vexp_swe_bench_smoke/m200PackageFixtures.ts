/**
 * M200 — adversarial package/import fixtures (§15). PURE.
 *
 * These exist to answer one objection: that making the frozen A3 comment append
 * incremental is a way of not noticing package changes. Each fixture is a pair
 * of repository states differing in ONE way, and each declares what the binding
 * authority must conclude — so the same derivation that lets P1 through has to
 * catch P2 through P11, and has to refuse P10's and P11's shapes rather than
 * guess at them.
 *
 * Every fixture is padded to `PADDING_MODULES` unrelated files. That is not
 * decoration: `MAX_BINDING_CLOSURE_FRACTION` is a fraction of the repository, so
 * on a five-file fixture the cap is one file and every case would exercise the
 * fallback instead of the closure. A fixture whose size decides its outcome is
 * measuring the fixture (§26).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Unrelated modules every fixture carries, so the closure cap is not the thing under test. */
export const PADDING_MODULES = 30;

export type ExpectedPlan = "incremental" | "full_rebuild";

export interface PackageFixture {
  readonly id: string;
  readonly title: string;
  /** Why this case exists — the objection it answers. */
  readonly rationale: string;
  /** Files written before the first (cold) index. */
  readonly before: Readonly<Record<string, string>>;
  /** Files rewritten before the refresh. A null value deletes the file. */
  readonly after: Readonly<Record<string, string | null>>;
  readonly expect: {
    /** Whether the package's derived surface must differ across the edit. */
    readonly surfaceChanged: boolean;
    readonly plan: ExpectedPlan;
    /** When the plan is a rebuild, the refusal that must have produced it. */
    readonly refusal?: string;
    /** Files the closure must contain, when one is derived. */
    readonly closureIncludes?: readonly string[];
    /**
     * Edges that must exist after the refresh, as `src -> dst` file pairs. This
     * is the anti-staleness check: it is asserted against the incremental result
     * and independently against a clean rebuild of the same final tree.
     */
    readonly edgesAfter?: readonly (readonly [string, string])[];
    /** Edges that must NOT exist, i.e. resolutions that must not survive. */
    readonly edgesAbsentAfter?: readonly (readonly [string, string])[];
    /** Files that must NOT enter the closure, when one is derived. */
    readonly closureExcludes?: readonly string[];
    /**
     * Persisted `import_descriptors` rows that must exist after the refresh,
     * as (file_path, requested_module, relative_level, resolved_target_path).
     * This is how a resolver capability is asserted rather than assumed (§10).
     */
    readonly descriptorsInclude?: readonly (readonly [string, string, number, string | null])[];
  };
}

const FOO = "class Foo:\n    def go(self):\n        return 1\n";
const BAR = "class Foo:\n    def go(self):\n        return 2\n";
const CONSUMER = "from pkg import Foo\n\n\ndef use():\n    return Foo().go()\n";
const ALIASED_CONSUMER = "from pkg import Foo as F\n\n\ndef use():\n    return F().go()\n";
const MODULE_CONSUMER = "import pkg\n\n\ndef use():\n    return pkg.Foo().go()\n";
const ALIASED_MODULE_CONSUMER = "import pkg as p\n\n\ndef use():\n    return p.Foo().go()\n";

/** The base package every fixture starts from unless it says otherwise. */
const base = (init: string): Record<string, string> => ({
  "pkg/__init__.py": init,
  "pkg/foo.py": FOO,
  "pkg/bar.py": BAR,
});

export const PACKAGE_FIXTURES: readonly PackageFixture[] = [
  {
    id: "P1",
    title: "non-semantic package edit",
    rationale: "The frozen A3 mutation's shape. Bytes move, no binding does; a "
      + "rebuild here is pure waste, and this is the only case A3 needs.",
    before: { ...base("from .foo import Foo\n"), "consumer.py": CONSUMER },
    after: { "pkg/__init__.py": "# a comment the surface does not carry\nfrom .foo import Foo\n" },
    expect: {
      surfaceChanged: false, plan: "incremental",
      edgesAfter: [["consumer.py", "pkg/foo.py"]],
      descriptorsInclude: [["consumer.py", "pkg", 0, "pkg/__init__.py"]],
    },
  },
  {
    id: "P2",
    title: "added re-export",
    rationale: "A name that did not resolve now does. The consumer gains an edge "
      + "it could not have had, so it must be in the closure.",
    before: { ...base("# nothing re-exported yet\n"), "consumer.py": CONSUMER },
    after: { "pkg/__init__.py": "from .foo import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAfter: [["consumer.py", "pkg/foo.py"]],
    },
  },
  {
    id: "P3",
    title: "removed re-export",
    rationale: "The staleness case. If the consumer is not reparsed its edge "
      + "survives, and the graph claims a resolution the source no longer has.",
    before: { ...base("from .foo import Foo\n"), "consumer.py": CONSUMER },
    after: { "pkg/__init__.py": "# the re-export is gone\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAbsentAfter: [["consumer.py", "pkg/foo.py"]],
    },
  },
  {
    id: "P4",
    title: "redirected re-export",
    rationale: "The name is unchanged and the target is not. A surface keyed by "
      + "NAME alone would call this equal — §8's explicit warning.",
    before: { ...base("from .foo import Foo\n"), "consumer.py": CONSUMER },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAfter: [["consumer.py", "pkg/bar.py"]],
      edgesAbsentAfter: [["consumer.py", "pkg/foo.py"]],
    },
  },
  {
    id: "P5",
    title: "aliased re-export",
    rationale: "The published name and the defining name differ, so the surface "
      + "must carry both or a rename of one looks like a change to the other.",
    before: {
      ...base("from .foo import Foo as PublicFoo\n"),
      "consumer.py": "from pkg import PublicFoo\n\n\ndef use():\n    return PublicFoo().go()\n",
    },
    after: { "pkg/__init__.py": "from .bar import Foo as PublicFoo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAfter: [["consumer.py", "pkg/bar.py"]],
    },
  },
  {
    id: "P6",
    title: "aliased consumer",
    rationale: "The consumer's local name has nothing to do with the published "
      + "one. A reverse query keyed by local name would miss it.",
    before: { ...base("from .foo import Foo\n"), "consumer.py": ALIASED_CONSUMER },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAfter: [["consumer.py", "pkg/bar.py"]],
    },
  },
  {
    id: "P7",
    title: "module import consumer",
    rationale: "`import pkg` names no member, so this consumer can reach ANY "
      + "name the package publishes and cannot be narrowed by the changed name.",
    before: { ...base("from .foo import Foo\n"), "modconsumer.py": MODULE_CONSUMER },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["modconsumer.py"],
      edgesAfter: [["modconsumer.py", "pkg/bar.py"]],
    },
  },
  {
    id: "P8",
    title: "aliased module import consumer",
    rationale: "As P7, with the module bound under another name.",
    before: { ...base("from .foo import Foo\n"), "modconsumer.py": ALIASED_MODULE_CONSUMER },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["modconsumer.py"],
      edgesAfter: [["modconsumer.py", "pkg/bar.py"]],
    },
  },
  {
    id: "P9",
    title: "transitive re-export",
    rationale: "The changed file is NOT the package surface. The consumer imports "
      + "from `pkg`, so only a walk that follows re-export chains reaches it — "
      + "this is the case a direct-importers-only closure gets wrong.",
    before: {
      "pkg/__init__.py": "from .a import Foo\n",
      "pkg/a.py": "from .b import Foo\n",
      "pkg/b.py": FOO,
      "pkg/c.py": BAR,
      "consumer.py": CONSUMER,
    },
    after: { "pkg/a.py": "from .c import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py", "pkg/__init__.py"],
      edgesAfter: [["consumer.py", "pkg/c.py"]],
      edgesAbsentAfter: [["consumer.py", "pkg/b.py"]],
    },
  },
  {
    id: "P10",
    title: "cyclic re-export",
    rationale: "A real Python shape. The walk must TERMINATE, not refuse — "
      + "refusing a cycle would rebuild the repository for an ordinary edit.",
    before: {
      "pkg/__init__.py": "from .a import Foo\n",
      "pkg/a.py": "from .b import Foo\n",
      "pkg/b.py": "from .a import Bar\n" + FOO,
      "pkg/c.py": BAR,
      "consumer.py": CONSUMER,
    },
    after: { "pkg/a.py": "from .c import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py", "pkg/__init__.py"],
      edgesAfter: [["consumer.py", "pkg/c.py"]],
    },
  },
  {
    id: "P11",
    title: "ambiguous binding",
    rationale: "Two imports claim one name. The resolver already refuses to bind "
      + "it; the surface must record the refusal, so no exact target is invented.",
    before: {
      ...base("from .foo import Foo\n"),
      "pkg/other.py": BAR,
      "consumer.py": CONSUMER,
    },
    after: { "pkg/__init__.py": "from .foo import Foo\nfrom .other import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAbsentAfter: [["consumer.py", "pkg/foo.py"], ["consumer.py", "pkg/other.py"]],
    },
  },
  {
    id: "P12",
    title: "unrelated package export",
    rationale: "The independence control. A consumer of another package must NOT "
      + "enter the closure, or the derivation is a rebuild wearing a smaller name.",
    before: {
      ...base("from .foo import Foo\n"),
      "other/__init__.py": "from .thing import Thing\n",
      "other/thing.py": "class Thing:\n    def go(self):\n        return 3\n",
      "consumer.py": CONSUMER,
      "otherconsumer.py": "from other import Thing\n\n\ndef use():\n    return Thing().go()\n",
    },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental", closureIncludes: ["consumer.py"],
      edgesAfter: [["consumer.py", "pkg/bar.py"], ["otherconsumer.py", "other/thing.py"]],
    },
  },
  {
    id: "P13",
    title: "wildcard consumer (negative control)",
    rationale: "§35: the architecture must still be able to say no. A wildcard "
      + "publishes names this parser cannot enumerate, so the closure is refused "
      + "and the rebuild is the honest answer — not a smaller closure.",
    before: {
      ...base("from .foo import Foo\n"),
      "wild.py": "from pkg import *\n\n\ndef use():\n    return Foo().go()\n",
    },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: { surfaceChanged: true, plan: "full_rebuild", refusal: "wildcard_consumer" },
  },
  {
    id: "P14",
    title: "relative parent import",
    rationale: "§30. `from ..foo import Foo` reaches the defining module directly, "
      + "NOT through the package surface, so redirecting the package must leave "
      + "it alone — and the descriptor must carry the level, or a relative import "
      + "from a sibling package would resolve into this one.",
    before: {
      ...base("from .foo import Foo\n"),
      "pkg/sub/__init__.py": "",
      "pkg/sub/deep.py": "from ..foo import Foo\n\n\ndef use():\n    return Foo().go()\n",
      "consumer.py": CONSUMER,
    },
    after: { "pkg/__init__.py": "from .bar import Foo\n" },
    expect: {
      surfaceChanged: true, plan: "incremental",
      closureIncludes: ["consumer.py"], closureExcludes: ["pkg/sub/deep.py"],
      edgesAfter: [["consumer.py", "pkg/bar.py"], ["pkg/sub/deep.py", "pkg/foo.py"]],
      descriptorsInclude: [["pkg/sub/deep.py", "foo", 2, "pkg/foo.py"]],
    },
  },
];

/** Write a fixture state into `root`, creating package directories as needed. */
export function writeFixtureState(root: string, files: Readonly<Record<string, string | null>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    if (content === null) continue;
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Unrelated modules, so the closure cap is a policy and not an artefact of size. */
export function writePadding(root: string, count = PADDING_MODULES): void {
  for (let index = 0; index < count; index += 1) {
    writeFileSync(path.join(root, `pad_${index}.py`), `def pad_${index}():\n    return ${index}\n`);
  }
}
