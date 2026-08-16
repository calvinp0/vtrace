// Does the answer role established by retrieval survive into what the model sees?
//
// The retrieval-side contracts live in `src/retrieval/operationRole.test.ts`.
// These assert the DELIVERY half: the capsule leads with the definition the pool
// chose, the pair still reverses at the capsule layer, and none of the guards
// that stop an arbitrary mechanism candidate becoming an edit target were
// loosened to achieve it.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { CapsuleIntent } from "./types";

async function indexed(files: Record<string, string>): Promise<{ db: Database; root: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "m150-delivery-"));
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return { db, root };
}

function capsule(db: Database, root: string, task: string) {
  const built = buildCapsuleV2({ db, repoRoot: root, task, intent: CapsuleIntent.Explain, maxTokens: 6000 });
  const items = [...built.pivots, ...built.support];
  return {
    lead: built.pivots[0]?.fq_name ?? null,
    pivots: built.pivots.map((entry) => entry.fq_name),
    items,
    roleOf: (fqName: string) => {
      const item = items.find((entry) => entry.fq_name === fqName);
      return item === undefined ? null : (item.selection_role ?? item.role);
    },
  };
}

// `alpha` orders; `beta` consumes the order and picks. Neither name says so, and
// neither matches the question — which is exactly why the delivery layer used to
// discard both and return no context at all.
const PAIRED = {
  "pipeline.py": `
def collect(registry):
    found = []
    for plugin in registry.plugins:
        if plugin.enabled:
            found.append(plugin)
    return found


def alpha(registry):
    plugins = collect(registry)
    return sorted(plugins)


def beta(registry):
    plugins = alpha(registry)
    return plugins[0]
`,
};

test("the capsule leads with the orderer on an ordering query", async () => {
  const { db, root } = await indexed(PAIRED);
  const result = capsule(db, root, "What determines plugin precedence?");

  expect(result.lead).toBe("pipeline.py::alpha");
  expect(result.items.length).toBeGreaterThan(0);
});

test("the capsule leads with the selector on a selection query", async () => {
  const { db, root } = await indexed(PAIRED);
  const result = capsule(db, root, "How does the system decide which plugin wins?");

  expect(result.lead).toBe("pipeline.py::beta");
});

test("a deliverable direct implementer no longer yields an empty capsule", async () => {
  // Every subject word appears only in bodies, so nothing matches by name and
  // the whole pool used to fall under the pivot bar.
  const { db, root } = await indexed({
    "generic.py": `
def gather(config):
    found = []
    for channel in config.channels:
        if channel.reachable:
            found.append(channel)
    return found


def process(config):
    channels = gather(config)
    return sorted(channels)
`,
  });
  const result = capsule(db, root, "What determines channel precedence?");

  expect(result.items.length).toBeGreaterThan(0);
  expect(result.lead).toBe("generic.py::process");
});

test("a lexically stronger consumer does not take the lead", async () => {
  const { db, root } = await indexed({
    "rules.py": `
def collect_rules(data):
    found = []
    for entry in data.entries:
        if entry.active:
            found.append(entry)
    return found


def prepare(data):
    rules = collect_rules(data)
    return sorted(rules)


def rule_candidate_selector(data):
    rules = prepare(data)
    return rules[0]
`,
  });
  const result = capsule(db, root, "What determines rule candidate precedence?");

  expect(result.lead).toBe("rules.py::prepare");
});

test("a test symbol carrying the fact is never delivered as an edit target", async () => {
  const { db, root } = await indexed({
    "queues_test.py": `
def test_queue_order():
    queues = [entry for entry in collect_queues() if entry.active]
    ordered = sorted(queues, key=lambda queue: queue.rank)
    assert ordered[0].name == "primary"
    return ordered
`,
  });
  const result = capsule(db, root, "What determines queue precedence?");

  expect(result.pivots).not.toContain("queues_test.py::test_queue_order");
});

test("no ordering source means no context is invented", async () => {
  const { db, root } = await indexed({
    "take.py": `
def take_first(entries):
    return entries[0]
`,
  });
  const result = capsule(db, root, "What establishes precedence between entries?");

  // `take_first` may legitimately appear as context; what it may never do is lead
  // an ordering question it has no evidence of answering.
  expect(result.lead).not.toBe("take.py::take_first");
});

test("answer-role authority is granted to at most one candidate", async () => {
  // Three definitions each end in a subject-aligned ordering. Only the
  // best-ranked may take pivot authority from its mechanism evidence, or the
  // rule floods the capsule with every definition performing the operation.
  const { db, root } = await indexed({
    "many.py": `
def first_orderer(items):
    return sorted(items)


def second_orderer(items):
    return sorted(items)


def third_orderer(items):
    return sorted(items)
`,
  });
  const result = capsule(db, root, "What determines item precedence?");

  expect(result.pivots.length).toBeLessThanOrEqual(2);
});

test("a request with no behavioural operation delivers exactly as before", async () => {
  const { db, root } = await indexed(PAIRED);
  // Deliberately names nothing in the repository: a bug report, not a question
  // about behaviour. Without a requested operation there is no mechanism
  // evidence, so no answer-role authority can exist and the pivot bar is the one
  // every other task has always seen.
  const result = capsule(db, root, "AttributeError raised while serializing the report footer");

  expect(result.pivots).not.toContain("pipeline.py::alpha");
});
