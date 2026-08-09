import {
  ObservationCompatibilityState,
  ObservationFreshnessReason,
  ObservationScope,
  OBSERVATION_PROVENANCE_SCHEMA_VERSION,
  type CurrentObservationContext,
  type Observation,
  type ObservationCompatibility,
} from "./types";

/** Pure M138 compatibility gate shared by every model-facing memory surface. */
export function classifyObservationCompatibility(
  observation: Pick<Observation, "scope" | "provenance" | "toolName">,
  current: CurrentObservationContext,
): ObservationCompatibility {
  const scope = observation.scope;
  if (scope === ObservationScope.Global) {
    return result(ObservationCompatibilityState.Applicable, true, [ObservationFreshnessReason.GlobalScope], {
      repoMatch: null,
      worktreeMatch: null,
      sourceStateMatch: null,
      indexMatch: null,
      implementationCompatible: null,
    });
  }

  const provenance = observation.provenance;
  if (scope === undefined || provenance === undefined) {
    return result(
      ObservationCompatibilityState.ProvenanceIncomplete,
      false,
      [ObservationFreshnessReason.LegacyProvenanceMissing],
    );
  }
  if (provenance.schemaVersion !== OBSERVATION_PROVENANCE_SCHEMA_VERSION) {
    return result(
      ObservationCompatibilityState.ProvenanceIncomplete,
      false,
      [ObservationFreshnessReason.UnsupportedProvenanceSchema],
    );
  }

  const repoMatch = provenance.repository.repositoryId === current.repository.repositoryId;
  if (!repoMatch) {
    return result(ObservationCompatibilityState.ForeignRepository, false, [ObservationFreshnessReason.RepoMismatch], {
      repoMatch: false,
    });
  }
  if (scope === ObservationScope.Repository) {
    return classifyImplementation(observation, current, { repoMatch: true });
  }

  const worktreeMatch = provenance.repository.worktreeId === current.repository.worktreeId;
  if (!worktreeMatch) {
    return result(ObservationCompatibilityState.StaleWorktree, false, [ObservationFreshnessReason.WorktreeMismatch], {
      repoMatch: true,
      worktreeMatch: false,
    });
  }
  if (scope === ObservationScope.Worktree) {
    return classifyImplementation(observation, current, { repoMatch: true, worktreeMatch: true });
  }

  const headMatch = provenance.repository.headCommit === current.repository.headCommit;
  if (!headMatch) {
    return result(ObservationCompatibilityState.StaleRepoState, false, [ObservationFreshnessReason.HeadMismatch], {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: false,
    });
  }
  const dirtyMatch = provenance.repository.dirtyFingerprint === current.repository.dirtyFingerprint;
  if (!dirtyMatch) {
    return result(ObservationCompatibilityState.StaleDirtyState, false, [ObservationFreshnessReason.DirtyFingerprintMismatch], {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: false,
    });
  }
  if (scope === ObservationScope.SourceState) {
    return classifyImplementation(observation, current, {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: true,
    });
  }

  const observedIndex = provenance.index;
  const currentIndex = current.index;
  if (observedIndex === null || currentIndex === null) {
    return result(
      ObservationCompatibilityState.ProvenanceIncomplete,
      false,
      [ObservationFreshnessReason.LegacyProvenanceMissing],
      { repoMatch: true, worktreeMatch: true, sourceStateMatch: true, indexMatch: null },
    );
  }
  const observationIndexOwnsSourceState = observedIndex.worktreeId === provenance.repository.worktreeId
    && observedIndex.headCommit === provenance.repository.headCommit
    && observedIndex.dirtyFingerprint === provenance.repository.dirtyFingerprint;
  const currentIndexOwnsSourceState = currentIndex.worktreeId === current.repository.worktreeId
    && currentIndex.headCommit === current.repository.headCommit
    && currentIndex.dirtyFingerprint === current.repository.dirtyFingerprint;
  if (!observationIndexOwnsSourceState || !currentIndexOwnsSourceState) {
    return result(ObservationCompatibilityState.StaleIndex, false, [ObservationFreshnessReason.IndexIdentityMismatch], {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: true,
      indexMatch: false,
    });
  }
  const capabilityMatch = observedIndex.formatVersion === currentIndex.formatVersion
    && observedIndex.schemaVersion === currentIndex.schemaVersion
    && observedIndex.indexerFingerprint === currentIndex.indexerFingerprint
    && observedIndex.parserFingerprint === currentIndex.parserFingerprint
    && observedIndex.configFingerprint === currentIndex.configFingerprint;
  if (!capabilityMatch) {
    return result(ObservationCompatibilityState.StaleIndex, false, [ObservationFreshnessReason.IndexCapabilityMismatch], {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: true,
      indexMatch: false,
    });
  }
  if (observedIndex.identity !== currentIndex.identity) {
    return result(ObservationCompatibilityState.StaleIndex, false, [ObservationFreshnessReason.IndexIdentityMismatch], {
      repoMatch: true,
      worktreeMatch: true,
      sourceStateMatch: true,
      indexMatch: false,
    });
  }

  return classifyImplementation(observation, current, {
    repoMatch: true,
    worktreeMatch: true,
    sourceStateMatch: true,
    indexMatch: true,
  });
}

export function isHistoricalCompatibility(compatibility: ObservationCompatibility): boolean {
  return !compatibility.currentTruthEligible;
}

function classifyImplementation(
  observation: Pick<Observation, "provenance" | "toolName">,
  current: CurrentObservationContext,
  matches: Partial<Pick<ObservationCompatibility, "repoMatch" | "worktreeMatch" | "sourceStateMatch" | "indexMatch">>,
): ObservationCompatibility {
  const provenance = observation.provenance!;
  const observedImplementation = provenance.implementation;
  const exactImplementation = observedImplementation.commit === current.implementation.commit
    && observedImplementation.tree === current.implementation.tree
    && observedImplementation.dirtyFingerprint === current.implementation.dirtyFingerprint;
  const memoryCompatible = observedImplementation.memoryCapabilityFingerprint
    === current.implementation.memoryCapabilityFingerprint;
  const toolName = provenance.tool?.name ?? observation.toolName;
  const currentToolCapability = toolName === undefined
    ? undefined
    : current.toolCapabilityFingerprints[toolName];
  const toolCompatible = provenance.tool === null
    || (currentToolCapability !== undefined
      && provenance.tool.capabilityFingerprint === currentToolCapability);

  if (!memoryCompatible || !toolCompatible) {
    return result(
      ObservationCompatibilityState.SupersededImplementation,
      false,
      [
        ...(!memoryCompatible ? [ObservationFreshnessReason.ImplementationSemanticsMismatch] : []),
        ...(!toolCompatible ? [ObservationFreshnessReason.ToolSemanticsMismatch] : []),
      ],
      { ...matches, implementationCompatible: false },
    );
  }

  // Dirty implementation builds are only exact-compatible. We cannot prove
  // that an uncommitted semantic edit was harmless from a version constant.
  if (!exactImplementation
    && (observedImplementation.dirtyFingerprint !== null
      || current.implementation.dirtyFingerprint !== null)) {
    return result(
      ObservationCompatibilityState.SupersededImplementation,
      false,
      [ObservationFreshnessReason.ImplementationSemanticsMismatch],
      { ...matches, implementationCompatible: false },
    );
  }

  return result(
    exactImplementation
      ? ObservationCompatibilityState.Current
      : ObservationCompatibilityState.CurrentCompatible,
    true,
    exactImplementation
      ? [ObservationFreshnessReason.Current]
      : [ObservationFreshnessReason.ImplementationChangedCompatible],
    { ...matches, implementationCompatible: true },
  );
}

function result(
  state: ObservationCompatibility["state"],
  currentTruthEligible: boolean,
  reasons: ObservationCompatibility["reasons"],
  matches: Partial<Pick<
    ObservationCompatibility,
    "repoMatch" | "worktreeMatch" | "sourceStateMatch" | "indexMatch" | "implementationCompatible"
  >> = {},
): ObservationCompatibility {
  return {
    state,
    currentTruthEligible,
    reasons,
    repoMatch: matches.repoMatch ?? null,
    worktreeMatch: matches.worktreeMatch ?? null,
    sourceStateMatch: matches.sourceStateMatch ?? null,
    indexMatch: matches.indexMatch ?? null,
    implementationCompatible: matches.implementationCompatible ?? null,
  };
}
