import { expect, test } from "bun:test";

import { extractMechanismFacts, type MechanismFactKind } from "./extractMechanismFacts";

function kinds(body: string): MechanismFactKind[] {
  return extractMechanismFacts(body).map((fact) => fact.kind);
}

function factOf(body: string, kind: MechanismFactKind) {
  return extractMechanismFacts(body).find((fact) => fact.kind === kind);
}

// --- §31–§36 the mechanisms M150 must be able to see --------------------------

test("§31 first-item selection on an unhelpfully named function", () => {
  const body = "def process(data):\n    options = collect(data)\n    return options[0]\n";
  expect(kinds(body)).toContain("first_item_selection");
  expect(factOf(body, "first_item_selection")?.subject).toBe("options");
  expect(factOf(body, "first_item_selection")?.resultBearing).toBe(true);
});

test("§33 sorting then taking the first is a compound mechanism, not two", () => {
  const body = "def prepare(items):\n    items = sorted(items, key=priority)\n    return items[0]\n";
  expect(kinds(body)).toContain("sort_then_first");
  expect(kinds(body)).toContain("ordering_established");
});

test("§34 a loop returning the first acceptable candidate", () => {
  const body = "def resolve(backends):\n    for backend in backends:\n        result = backend.try_resolve()\n        if result is not None:\n            return result\n";
  expect(kinds(body)).toContain("first_success_return");
  expect(factOf(body, "first_success_return")?.subject).toBe("backends");
});

test("§35 an absence check that reaches for a second route is a fallback", () => {
  const body = "def convert(value):\n    result = primary(value)\n    if result is None:\n        result = fallback(value)\n    return result\n";
  expect(kinds(body)).toContain("fallback_branch");
  // NOT default_then_override: the guard tested for absence, so the primary
  // produced nothing rather than producing a default worth replacing.
  expect(kinds(body)).not.toContain("default_then_override");
});

test("a non-absence guard replacing a pre-assigned value is an override, not a fallback", () => {
  const body = "def timeout(config):\n    value = DEFAULT_TIMEOUT\n    if config.timeout:\n        value = read_timeout(config)\n    return value\n";
  expect(kinds(body)).toContain("default_then_override");
  expect(kinds(body)).not.toContain("fallback_branch");
});

test("§36 a precedence table consulted as an ordering key", () => {
  const body = "def choose(items):\n    return min(items, key=lambda x: PRIORITY[x.kind])\n";
  expect(kinds(body)).toContain("min_selection");
  expect(kinds(body)).toContain("priority_lookup");
  expect(factOf(body, "priority_lookup")?.subject).toBe("priority");
});

// --- §37–§40 the negative controls --------------------------------------------

test("§37 an incidental [0] on a singular operand is not a selection", () => {
  // `name` is a scalar; `name[0]` is its first character. Refused at extraction
  // rather than left for query gating, because the syntax is identical to a real
  // selection and only the operand's shape distinguishes them.
  expect(kinds("def first_character(name):\n    return name[0]\n")).toEqual([]);
});

test("§38 sorting for display establishes order but selects nothing", () => {
  const body = "def render(names):\n    return ', '.join(sorted(names))\n";
  expect(kinds(body)).toContain("ordering_established");
  expect(kinds(body)).not.toContain("sort_then_first");
  expect(kinds(body)).not.toContain("first_item_selection");
});

test("§39 a cache wrapper carries cache evidence and no selection evidence", () => {
  const body = "def load(key):\n    if key in CACHE:\n        return CACHE[key]\n    value = process(key)\n    CACHE[key] = value\n    return value\n";
  expect(kinds(body)).toContain("cache_lookup");
  expect(kinds(body)).not.toContain("first_item_selection");
  expect(kinds(body)).not.toContain("first_success_return");
});

test("§40 an accessor returns storage, not a choice", () => {
  const body = "def family(self):\n    return self._family\n";
  expect(kinds(body)).toEqual(["attribute_return"]);
});

// --- truthfulness properties (§55, §62, §63) ----------------------------------

test("§62 taking element zero never claims to know the ordering", () => {
  const facts = extractMechanismFacts("def pick(rows):\n    return rows[0]\n");
  expect(facts.map((fact) => fact.kind)).toEqual(["first_item_selection"]);
  // There is no `winner_by_priority` kind to promote it to, by construction.
  expect(facts.every((fact) => fact.kind !== "sort_then_first")).toBe(true);
});

test("a guard clause bailing out with None is not a first-success return", () => {
  // `return None` means "give up", not "this candidate wins". Measured on ARC:
  // without this rule `get_reactive_bonds_from_family` reported a first-success
  // whose evidence line was literally `return None`.
  const body = "def scan(entries):\n    for entry in entries:\n        if entry is None:\n            return None\n";
  expect(kinds(body)).not.toContain("first_success_return");
});

test("a docstring mentioning a mechanism produces no fact", () => {
  // ARC has a docstring reading `typically comes from product_dicts[0]['products']`.
  // Prose about code is not code.
  const body = "def helper(x):\n    \"\"\"Typically comes from product_dicts[0]['products'].\"\"\"\n    return x\n";
  expect(kinds(body)).toEqual([]);
});

test("a commented-out mechanism produces no fact", () => {
  expect(kinds("def helper(xs):\n    # return xs[0]\n    return None\n")).toEqual([]);
});

test("§55 location is an offset within the definition, not an absolute line", () => {
  const fact = factOf("def pick(rows):\n    return rows[0]\n", "first_item_selection");
  expect(fact?.lineOffset).toBe(1);
});

test("a mechanism that does not produce the result is recorded but not result-bearing", () => {
  // `bond` is appended to a list; the returned value is that list. The statement
  // is real and is recorded truthfully — it simply is not what the definition is
  // for, which is what `resultBearing` exists to say.
  const body = "def collect(pairs):\n    out = []\n    for pair in pairs:\n        bond = pairs[0]\n        out.append(bond)\n    return out\n";
  const fact = factOf(body, "first_item_selection");
  expect(fact).toBeDefined();
  expect(fact?.resultBearing).toBe(false);
});

test("an attribute call sharing a local's name does not make it result-bearing", () => {
  // `group` and `match.group(1)` are unrelated. Counting the second made ARC's
  // `get_reactant_num` look as though its first-reactant index produced the
  // number it returns.
  const body = "def count(self):\n    group = self.groups[self.reactants[0][0]]\n    groups = group.split()\n    if m:\n        return int(m.group(1))\n    return len(groups)\n";
  expect(factOf(body, "first_item_selection")?.resultBearing).toBe(false);
});

test("extraction is bounded per definition", () => {
  const body = `def big(xs):\n${Array.from({ length: 60 }, (_, i) => `    a${i} = xs[0]`).join("\n")}\n    return xs[0]\n`;
  expect(extractMechanismFacts(body).length).toBeLessThanOrEqual(8);
});

test("extraction is deterministic", () => {
  const body = "def prepare(items):\n    items = sorted(items, key=priority)\n    return items[0]\n";
  expect(JSON.stringify(extractMechanismFacts(body))).toBe(JSON.stringify(extractMechanismFacts(body)));
});
