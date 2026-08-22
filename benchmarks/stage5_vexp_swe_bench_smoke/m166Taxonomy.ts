/**
 * M166-B — mutually exclusive classification of a model-facing response.
 *
 * Every character the model was handed is charged to exactly one category, and the
 * categories sum to the serialized payload. Nothing is estimated by eye: the rule
 * table is frozen, path-addressed and ordered, and the duplicate detector works on
 * semantic identity rather than on whether a span merely looks redundant (§24).
 *
 * The one editorial decision, stated so it can be argued with: `modelVisibleContext`
 * is the CANONICAL model-facing rendering. It is the only field the product itself
 * declares model-visible, and the only one written to be read. Every other span that
 * re-conveys a fact already present in it is charged DUPLICATE — not because the
 * structured copy is worthless, but because the model is paying for the same fact
 * twice and only one of the two was written for it.
 */

export const ResponseCategory = Object.freeze({
  /** The actual intelligence payload: what the repository is and where. */
  RepositoryEvidence: "REPOSITORY_EVIDENCE",
  /** Truth-protecting control the agent needs to avoid over- or under-claiming. */
  AgentUsefulControl: "AGENT_USEFUL_CONTROL",
  /** Scorer internals, counts, timings, budget bookkeeping. */
  MachineDiagnostic: "MACHINE_DIAGNOSTIC",
  /** Index/workspace identity, hashes, versions, producer ids. */
  Provenance: "PROVENANCE",
  /** A fact already conveyed elsewhere in the same model-facing response. */
  Duplicate: "DUPLICATE",
  /** JSON keys, braces, quotes, commas — the shape rather than the content. */
  TransportStructure: "TRANSPORT_STRUCTURE",
  Other: "OTHER",
});
export type ResponseCategory = (typeof ResponseCategory)[keyof typeof ResponseCategory];

/** The field the product itself calls model-visible; the canonical rendering. */
export const CANONICAL_RENDERING_PATH = "productContext.modelVisibleContext";

/** Below this a repeated string is a coincidence, not a re-conveyed fact. */
const MIN_FACT_CHARACTERS = 12;
/** Above this a string is composite and gets line-level rather than whole-value treatment. */
const COMPOSITE_STRING_CHARACTERS = 200;
/** Below this an identical object is too small for object-level duplication to matter. */
const MIN_DUPLICATE_OBJECT_CHARACTERS = 200;

interface Rule { readonly pattern: RegExp; readonly category: ResponseCategory }

const rule = (pattern: string, category: ResponseCategory): Rule => ({ pattern: new RegExp(pattern), category });

/**
 * Ordered; first match wins. Paths are normalized with `[]` for array elements, so
 * `productContext.items[].path` addresses every item's path at once.
 */
export const CLASSIFICATION_RULES: readonly Rule[] = Object.freeze([
  // ---- repository evidence -------------------------------------------------
  rule("^productContext\\.modelVisibleContext$", ResponseCategory.RepositoryEvidence),
  rule("^productContext\\.leadPivot$", ResponseCategory.RepositoryEvidence),
  rule("^productContext\\.roleCounts\\.", ResponseCategory.RepositoryEvidence),
  rule("^productContext\\.items\\[\\]\\.(path|symbol|fqName|contentMode|roles\\[\\]|selectionReasons\\[\\]|lineSpan\\.)", ResponseCategory.RepositoryEvidence),
  rule("^productContext\\.items\\[\\]\\.metadata\\.(fqName|kind|returnType|exported|pivotFqName|direction|edgeType|relationKind|evidenceStrength|applicability|targetKind|requiredTargetSources)", ResponseCategory.RepositoryEvidence),
  rule("^pivotNeighborhood\\[\\]\\.(pivot\\.|excerpts\\[\\]\\.(filePath|symbol|fqName|startLine|endLine|text|reason))", ResponseCategory.RepositoryEvidence),
  rule("^pivotNeighborhood\\[\\]\\.skipped", ResponseCategory.AgentUsefulControl),
  rule("^inspectFirst\\.", ResponseCategory.RepositoryEvidence),
  rule("^capsuleResult\\.digest$", ResponseCategory.RepositoryEvidence),
  rule("^capsuleResult\\.(pivots|support)\\[\\]\\.(path|fqName|symbol|kind|contentMode|role|signature|source|evidence|roleReason|isNonSourceExample)", ResponseCategory.RepositoryEvidence),
  rule("^context\\.(pivots|supports)\\[\\]\\.(filePath|fqName|symbol|contentMode|role)", ResponseCategory.RepositoryEvidence),
  rule("^impact\\.(focalSymbol|summary|topDependents)", ResponseCategory.RepositoryEvidence),
  rule("^flow\\.(start|end|paths|summary)", ResponseCategory.RepositoryEvidence),
  rule("^deferred\\.items\\[\\]\\.summary$", ResponseCategory.RepositoryEvidence),

  // ---- agent-useful control (§21: not all status is overhead) --------------
  rule("^productContext\\.(resultState|resolved|retrievalFound|deliveryFailed|capsuleMode)$", ResponseCategory.AgentUsefulControl),
  rule("^productContext\\.coverage\\.", ResponseCategory.AgentUsefulControl),
  rule("^productContext\\.delivery\\.status$", ResponseCategory.AgentUsefulControl),
  rule("^productContext\\.diagnostics\\.(limitations\\[\\]|staticEvidenceOnly|duplicatePolicy)$", ResponseCategory.AgentUsefulControl),
  rule("^productContext\\.accounting\\.claimBoundary$", ResponseCategory.AgentUsefulControl),
  rule("^productContext\\.freshness\\.(status|reason|action)$", ResponseCategory.AgentUsefulControl),
  rule("^(impact|flow)\\.(included|skipReason|triggerReason|selectionSource|claimScope|verificationRecommended|bothDirectionsReachable|endpointsResolved)$", ResponseCategory.AgentUsefulControl),
  rule("^memory\\.[a-zA-Z]+\\.(included|skipReason)$", ResponseCategory.AgentUsefulControl),
  rule("^rules\\.included$", ResponseCategory.AgentUsefulControl),
  rule("^context\\.(included|skipReason|truncated|compressed|note|itemCount)$", ResponseCategory.AgentUsefulControl),
  rule("^capsuleResult\\.(warnings\\[\\]|reason|actualMode|actionabilityHints)", ResponseCategory.AgentUsefulControl),
  rule("^deferred\\.(notes\\[\\]|expandable|expansionTool)$", ResponseCategory.AgentUsefulControl),
  rule("^deferred\\.items\\[\\]\\.(kind|expandable|expansionTool|suggestedTool)$", ResponseCategory.AgentUsefulControl),
  rule("^intent\\.(selectedIntent|confidence|reason|rationale|impactSkipReason|flowSkipReason|editGoal)$", ResponseCategory.AgentUsefulControl),
  rule("^workspaceRouting\\.(outcome|reason|uniquenessProven)$", ResponseCategory.AgentUsefulControl),
  rule("^diagnostics\\.freshness\\.(state|isStale|summary|whyItMatters|recommendedAction)$", ResponseCategory.AgentUsefulControl),
  rule("^diagnostics\\.(freshness|indexFreshness)\\.readiness\\.", ResponseCategory.AgentUsefulControl),
  rule("^diagnostics\\.indexFreshness\\.(status|reason|action)$", ResponseCategory.AgentUsefulControl),
  rule("^responseBudget\\.(compacted_fields\\[\\]|omitted_detail_counts\\.|expansion_available\\.|within_envelope|compaction_applied)", ResponseCategory.AgentUsefulControl),

  // ---- provenance ----------------------------------------------------------
  rule("^(schemaVersion|authoritativeCapsuleManifestId)$", ResponseCategory.Provenance),
  rule("^(runtime|capsule)\\.", ResponseCategory.Provenance),
  rule("^productContext\\.(responseVersion|taskHash|selectedFileHash)$", ResponseCategory.Provenance),
  rule("^productContext\\.repository\\.", ResponseCategory.Provenance),
  rule("^productContext\\.items\\[\\]\\.(stableId|contentHash|id)$", ResponseCategory.Provenance),
  rule("^productContext\\.items\\[\\]\\.metadata\\.(contextId|contextReference|pivotContextId|pivotContextReference|skeletonFallback)$", ResponseCategory.Provenance),
  rule("^context\\.(capsuleManifestId|capsuleRef|capsuleProfileId|routingProfileId|supersededBy)$", ResponseCategory.Provenance),
  rule("^deferred\\.items\\[\\]\\.(id|hash)$", ResponseCategory.Provenance),
  rule("^(impact\\.impactRef|flow\\.flowRef)$", ResponseCategory.Provenance),
  rule("^responseBudget\\.envelopeVersion$", ResponseCategory.Provenance),
  rule("\\.(worktreeRoot|headCommit|currentHead|previousHead|latestRunId|indexRunId|lastIndexed[A-Za-z]+)$", ResponseCategory.Provenance),
  rule("^diagnostics\\.(freshness|indexFreshness)\\.(snapshot\\.|requestedWorktree\\.|indexedWorktree\\.)", ResponseCategory.Provenance),
  rule("^productContext\\.freshness\\.refreshDiagnostics\\.(snapshot\\.|requestedWorktree\\.|indexedWorktree\\.)", ResponseCategory.Provenance),

  // ---- machine diagnostic --------------------------------------------------
  rule("^diagnostics\\.", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.(timing|accounting|delivery)\\.", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.diagnostics\\.", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.freshness\\.", ResponseCategory.MachineDiagnostic),
  rule("^capsuleResult\\.(diagnostics|budget|summary|discarded)", ResponseCategory.MachineDiagnostic),
  rule("^capsuleResult\\.(query|intent)$", ResponseCategory.MachineDiagnostic),
  rule("^capsuleResult\\.(pivots|support)\\[\\]\\.(estimatedTokens|contextItemId)$", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.(task|intent)$", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.items\\[\\]\\.(estimatedTokens|contentCharacters|selectionReasonsOmitted)$", ResponseCategory.MachineDiagnostic),
  rule("^productContext\\.items\\[\\]\\.metadata\\.boundedMetadataOmittedKeys$", ResponseCategory.MachineDiagnostic),
  rule("^pivotNeighborhood\\[\\]\\.excerpts\\[\\]\\.textCharacters$", ResponseCategory.MachineDiagnostic),
  rule("^(request|taskSummary|accounting|savedObservation)", ResponseCategory.MachineDiagnostic),
  rule("^responseBudget\\.", ResponseCategory.MachineDiagnostic),
  rule("^context\\.budget\\.", ResponseCategory.MachineDiagnostic),
  rule("^(impact|flow)\\.", ResponseCategory.MachineDiagnostic),
  rule("^memory\\.", ResponseCategory.MachineDiagnostic),
  rule("^rules\\.", ResponseCategory.MachineDiagnostic),
  rule("^intent\\.", ResponseCategory.MachineDiagnostic),
  rule("^workspaceRouting\\.", ResponseCategory.MachineDiagnostic),
]);

export function baseCategory(normalizedPath: string): ResponseCategory {
  for (const entry of CLASSIFICATION_RULES) {
    if (entry.pattern.test(normalizedPath)) return entry.category;
  }
  return ResponseCategory.Other;
}

export interface LeafSpan {
  readonly path: string;
  readonly normalizedPath: string;
  readonly characters: number;
  /** The reported category: DUPLICATE when the leaf is wholly a restatement. */
  readonly category: ResponseCategory;
  /**
   * What the rule table said before duplication was considered. Consumers deciding
   * what may be REMOVED must read this, not `category`: a control leaf that repeats
   * an earlier value is still per-component semantics and is never safe to drop.
   */
  readonly baseCategory: ResponseCategory;
  /** Characters within this leaf re-conveying a fact already present elsewhere. */
  readonly duplicateCharacters: number;
  readonly duplicateOf: string | null;
}

export interface Decomposition {
  readonly totalCharacters: number;
  readonly byCategory: Readonly<Record<ResponseCategory, number>>;
  readonly leaves: readonly LeafSpan[];
  /** Largest contributors after duplication is charged out, for §94. */
  readonly topGroups: readonly { readonly group: string; readonly characters: number; readonly category: ResponseCategory }[];
}

interface Leaf { path: string; normalizedPath: string; value: unknown; characters: number }

function collectLeaves(node: unknown, path: string, normalized: string, out: Leaf[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectLeaves(child, `${path}[${i}]`, `${normalized}[]`, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      collectLeaves(child, path === "" ? key : `${path}.${key}`, normalized === "" ? key : `${normalized}.${key}`, out);
    }
    return;
  }
  out.push({ path, normalizedPath: normalized, value: node, characters: JSON.stringify(node ?? null).length });
}

/** Objects large enough that an identical twin elsewhere is a real duplication. */
function collectObjects(node: unknown, path: string, out: Map<string, string[]>): void {
  if (node === null || typeof node !== "object") return;
  const serialized = JSON.stringify(node);
  if (serialized.length >= MIN_DUPLICATE_OBJECT_CHARACTERS) {
    const seen = out.get(serialized) ?? [];
    seen.push(path);
    out.set(serialized, seen);
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectObjects(child, `${path}[${i}]`, out));
    return;
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    collectObjects(child, path === "" ? key : `${path}.${key}`, out);
  }
}

/**
 * Charge every character of the payload to exactly one category.
 *
 * Transport structure is what remains once every leaf value is subtracted from the
 * serialized whole: keys, braces, colons, commas. It is measured, not modelled.
 */
export function decompose(output: unknown): Decomposition {
  const totalCharacters = JSON.stringify(output).length;
  const leaves: Leaf[] = [];
  collectLeaves(output, "", "", leaves);

  const canonical = leaves.find((leaf) => leaf.normalizedPath === CANONICAL_RENDERING_PATH);
  const canonicalText = typeof canonical?.value === "string" ? canonical.value : "";
  const canonicalLines = new Set(
    canonicalText.split("\n").map((line) => line.trim()).filter((line) => line.length >= MIN_FACT_CHARACTERS),
  );

  // Object-level duplication: an identical twin elsewhere in the same response.
  const objects = new Map<string, string[]>();
  collectObjects(output, "", objects);
  const duplicateObjectPaths = new Map<string, string>();
  for (const paths of objects.values()) {
    if (paths.length < 2) continue;
    const [first, ...rest] = paths;
    for (const later of rest) duplicateObjectPaths.set(later, first!);
  }

  const seenValues = new Map<string, string>();
  const seenLines = new Set<string>();
  const spans: LeafSpan[] = [];

  for (const leaf of leaves) {
    const isCanonical = leaf.normalizedPath === CANONICAL_RENDERING_PATH;
    const base = baseCategory(leaf.normalizedPath);
    let duplicateCharacters = 0;
    let duplicateOf: string | null = null;

    const enclosingDuplicate = [...duplicateObjectPaths.keys()].find((prefix) => leaf.path === prefix || leaf.path.startsWith(`${prefix}.`) || leaf.path.startsWith(`${prefix}[`));
    if (!isCanonical && enclosingDuplicate !== undefined) {
      duplicateCharacters = leaf.characters;
      duplicateOf = duplicateObjectPaths.get(enclosingDuplicate)!;
    } else if (!isCanonical && typeof leaf.value === "string" && leaf.value.length >= MIN_FACT_CHARACTERS) {
      if (leaf.value.length > COMPOSITE_STRING_CHARACTERS) {
        // Composite string: charge the lines that restate facts, keep the rest.
        for (const line of leaf.value.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length < MIN_FACT_CHARACTERS) continue;
          if (canonicalLines.has(trimmed) || seenLines.has(trimmed)) {
            duplicateCharacters += line.length + 1;
            duplicateOf ??= canonicalLines.has(trimmed) ? CANONICAL_RENDERING_PATH : "earlier span";
          } else {
            seenLines.add(trimmed);
          }
        }
        duplicateCharacters = Math.min(duplicateCharacters, leaf.characters);
      } else if (canonicalText.includes(leaf.value)) {
        duplicateCharacters = leaf.characters;
        duplicateOf = CANONICAL_RENDERING_PATH;
      } else {
        const earlier = seenValues.get(leaf.value);
        if (earlier !== undefined) {
          duplicateCharacters = leaf.characters;
          duplicateOf = earlier;
        } else {
          seenValues.set(leaf.value, leaf.path);
        }
      }
    }

    spans.push({
      path: leaf.path,
      normalizedPath: leaf.normalizedPath,
      characters: leaf.characters,
      category: duplicateCharacters >= leaf.characters ? ResponseCategory.Duplicate : base,
      baseCategory: base,
      duplicateCharacters,
      duplicateOf,
    });
  }

  const byCategory: Record<string, number> = {};
  for (const value of Object.values(ResponseCategory)) byCategory[value] = 0;
  let leafCharacters = 0;
  for (const span of spans) {
    leafCharacters += span.characters;
    const duplicated = Math.min(span.duplicateCharacters, span.characters);
    byCategory[ResponseCategory.Duplicate]! += duplicated;
    const residual = span.characters - duplicated;
    if (residual > 0) byCategory[span.category === ResponseCategory.Duplicate ? ResponseCategory.Other : span.category]! += residual;
  }
  byCategory[ResponseCategory.TransportStructure] = Math.max(0, totalCharacters - leafCharacters);

  // Group by the first two path segments, so §94 can name offenders not fields.
  const groups = new Map<string, { characters: number; category: ResponseCategory }>();
  for (const span of spans) {
    const residual = span.characters - Math.min(span.duplicateCharacters, span.characters);
    if (residual <= 0) continue;
    const parts = span.normalizedPath.split(".");
    const group = parts.slice(0, 2).join(".") || span.normalizedPath;
    const existing = groups.get(group) ?? { characters: 0, category: span.category };
    groups.set(group, { characters: existing.characters + residual, category: existing.category });
  }

  return {
    totalCharacters,
    byCategory: Object.freeze(byCategory) as Readonly<Record<ResponseCategory, number>>,
    leaves: Object.freeze(spans),
    topGroups: Object.freeze([...groups.entries()]
      .map(([group, value]) => ({ group, characters: value.characters, category: value.category }))
      .sort((a, b) => b.characters - a.characters)),
  };
}

/**
 * §30. A category that is zero or uniform across every task is a detector under
 * suspicion until it has been shown firing. This reports what fired, so a zero can
 * be read as measured rather than as a rule table that never matched.
 */
export interface DetectorControl {
  readonly category: ResponseCategory;
  readonly tasksWhereNonZero: number;
  readonly tasks: number;
  readonly distinctValues: number;
  readonly uniformAcrossTasks: boolean;
  readonly suspicious: boolean;
}

export function detectorControls(decompositions: readonly Decomposition[]): readonly DetectorControl[] {
  return Object.values(ResponseCategory).map((category) => {
    const values = decompositions.map((d) => d.byCategory[category] ?? 0);
    const nonZero = values.filter((v) => v > 0).length;
    const distinct = new Set(values).size;
    return {
      category,
      tasksWhereNonZero: nonZero,
      tasks: values.length,
      distinctValues: distinct,
      uniformAcrossTasks: distinct === 1 && values.length > 1,
      // Never fired at all, or identical on every task: either can mean a dead rule.
      suspicious: nonZero === 0 || (distinct === 1 && values.length > 1),
    };
  });
}
