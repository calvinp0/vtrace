export const RESULT_TYPES = Object.freeze({
  IndexStatus: "index_status",
  Freshness: "freshness",
  Runtime: "runtime",
  SetupConfig: "setup_config",
  ExecutableResolution: "executable_resolution",
  Doctor: "doctor",
  FileSkeleton: "file_skeleton",
  ImpactGraph: "impact_graph",
  ContextCapsule: "context_capsule",
  RunPipeline: "run_pipeline",
});

const RESULT_TITLES = Object.freeze({
  [RESULT_TYPES.IndexStatus]: "vtrace — Index Status",
  [RESULT_TYPES.Freshness]: "vtrace — Freshness",
  [RESULT_TYPES.Runtime]: "vtrace — Runtime",
  [RESULT_TYPES.SetupConfig]: "vtrace — Setup / Config",
  [RESULT_TYPES.ExecutableResolution]: "vtrace — Executable Resolution",
  [RESULT_TYPES.Doctor]: "vtrace — Doctor",
  [RESULT_TYPES.FileSkeleton]: "vtrace — File Skeleton",
  [RESULT_TYPES.ImpactGraph]: "vtrace — Impact Graph",
  [RESULT_TYPES.ContextCapsule]: "vtrace — Context Capsule",
  [RESULT_TYPES.RunPipeline]: "vtrace — Pipeline Result",
});

export function buildResultView(result) {
  const title = computeTitle(result);
  const repoRoot = result.repoRoot ?? null;
  const body = renderBody(result);
  const rawJson = formatRawJson(result.rawData);
  return { type: result.type, title, repoRoot, body, rawJson };
}

export function buildHtml(view) {
  const repoLine = view.repoRoot
    ? `<div class="repo" data-testid="repo-root">Repo: ${escapeHtml(view.repoRoot)}</div>`
    : "";
  const rawSection = view.rawJson
    ? `<section class="raw" data-testid="raw-section">
    <div class="raw-actions">
      <button type="button" id="toggle-raw" aria-expanded="false">Show raw JSON</button>
      <button type="button" id="copy-raw">Copy JSON</button>
      <span id="copy-status" class="muted" aria-live="polite"></span>
    </div>
    <pre id="raw-json" hidden>${escapeHtml(view.rawJson)}</pre>
  </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(view.title)}</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); padding: 12px 18px; }
  header h1 { font-size: 1.2rem; margin: 0 0 2px 0; }
  .repo { color: var(--vscode-descriptionForeground, #888); font-size: 0.85rem; margin-bottom: 12px; }
  section { margin-bottom: 14px; }
  section h2 { font-size: 0.95rem; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground, #888); }
  dl.kv { margin: 0; display: grid; grid-template-columns: max-content 1fr; column-gap: 12px; row-gap: 2px; }
  dl.kv dt { color: var(--vscode-descriptionForeground, #888); }
  ul { margin: 2px 0 0 0; padding-left: 18px; }
  ul.bare { list-style: none; padding-left: 0; }
  ul.bare li { margin: 2px 0; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .card { border: 1px solid var(--vscode-panel-border, #333); padding: 8px 10px; border-radius: 4px; margin-bottom: 6px; }
  pre { background: var(--vscode-textBlockQuote-background, #1e1e1e); padding: 8px; overflow: auto; border-radius: 4px; }
  .raw button { cursor: pointer; background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: inherit; padding: 3px 8px; border-radius: 3px; }
  .raw-actions { display: flex; gap: 8px; align-items: center; }
  .summary-strip { display: flex; flex-wrap: wrap; gap: 18px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; margin-bottom: 12px; font-size: 0.85rem; }
  .summary-strip .item { white-space: nowrap; }
  .summary-strip .item .label { color: var(--vscode-descriptionForeground, #888); margin-right: 4px; }
  .header-block { display: grid; grid-template-columns: max-content 1fr; column-gap: 12px; row-gap: 2px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; margin-bottom: 10px; font-size: 0.9rem; }
  .header-block dt { color: var(--vscode-descriptionForeground, #888); }
  .members-subsection { margin-top: 6px; padding-top: 4px; border-top: 1px dashed var(--vscode-panel-border, #333); }
  .members-subsection .members-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground, #888); margin-bottom: 2px; }
  .empty-state p { margin: 0 0 8px 0; }
  .notes { font-size: 0.8rem; color: var(--vscode-descriptionForeground, #888); border-top: 1px dashed var(--vscode-panel-border, #333); padding-top: 6px; margin-top: 10px; }
  .muted { color: var(--vscode-descriptionForeground, #888); }
  .tag { display: inline-block; font-size: 0.75rem; padding: 1px 6px; border: 1px solid currentColor; border-radius: 10px; margin-right: 4px; opacity: 0.85; }
  .subsection-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground, #888); margin: 8px 0 4px 0; }
  .deferred-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .deferred-actions button { cursor: pointer; background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: inherit; padding: 3px 8px; border-radius: 3px; }
  .deferred-actions button[disabled] { opacity: 0.6; cursor: progress; }
  .vexp-expansion { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--vscode-panel-border, #333); }
  .vexp-expansion[hidden] { display: none; }
  .vexp-expansion-error { color: var(--vscode-errorForeground, #f48771); }
  .vexp-meta { margin-top: 6px; }
  .vexp-meta summary { cursor: pointer; color: var(--vscode-descriptionForeground, #888); font-size: 0.8rem; }
</style>
</head>
<body data-result-type="${escapeHtml(view.type)}">
<header>
  <h1 data-testid="result-title">${escapeHtml(view.title)}</h1>
  ${repoLine}
</header>
${view.body}
${rawSection}
<script>
  (function () {
    const toggleBtn = document.getElementById("toggle-raw");
    const pre = document.getElementById("raw-json");
    if (toggleBtn && pre) {
      toggleBtn.addEventListener("click", () => {
        const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
        if (expanded) {
          pre.setAttribute("hidden", "");
          toggleBtn.setAttribute("aria-expanded", "false");
          toggleBtn.textContent = "Show raw JSON";
        } else {
          pre.removeAttribute("hidden");
          toggleBtn.setAttribute("aria-expanded", "true");
          toggleBtn.textContent = "Hide raw JSON";
        }
      });
    }
    const copyBtn = document.getElementById("copy-raw");
    const status = document.getElementById("copy-status");
    if (copyBtn && pre) {
      copyBtn.addEventListener("click", async () => {
        const text = pre.textContent || "";
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const fallback = document.createElement("textarea");
            fallback.value = text;
            document.body.appendChild(fallback);
            fallback.select();
            document.execCommand("copy");
            document.body.removeChild(fallback);
          }
          if (status) { status.textContent = "Copied."; setTimeout(() => { status.textContent = ""; }, 1500); }
        } catch {
          if (status) { status.textContent = "Copy failed."; }
        }
      });
    }

    // Deferred V-REF expansion: post messages to the extension host for each
    // expand-button click, then render the response inline under the same card.
    const vsCodeApi = (typeof acquireVsCodeApi === "function") ? acquireVsCodeApi() : null;
    const expandButtons = document.querySelectorAll('button[data-vexp-action="expand"]');
    expandButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const hash = btn.getAttribute("data-vexp-hash");
        const kind = btn.getAttribute("data-vexp-kind");
        const id = btn.getAttribute("data-vexp-id");
        const slot = document.querySelector('.vexp-expansion[data-vexp-expansion-for="' + hash + '"]');
        if (slot) {
          slot.removeAttribute("hidden");
          slot.innerHTML = '<p class="muted">Expanding…</p>';
        }
        btn.setAttribute("disabled", "true");
        btn.setAttribute("aria-expanded", "true");
        if (vsCodeApi) {
          vsCodeApi.postMessage({ type: "expandVexpRef", hash, kind, id });
        }
      });
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type !== "expandedVexpRef") return;
      const hash = message.hash;
      const slot = document.querySelector('.vexp-expansion[data-vexp-expansion-for="' + hash + '"]');
      const btn = document.querySelector('button[data-vexp-action="expand"][data-vexp-hash="' + hash + '"]');
      if (slot && typeof message.html === "string") {
        slot.removeAttribute("hidden");
        slot.innerHTML = message.html;
      }
      if (btn) {
        btn.removeAttribute("disabled");
        btn.textContent = "Re-expand V-REF";
      }
    });
  })();
</script>
</body>
</html>`;
}

export function renderIndexStatusBody(snapshot, busyState = null) {
  const freshness = snapshot.rawStatus?.indexState?.freshness ?? null;
  const watcher = snapshot.rawStatus?.watcher ?? null;
  const rows = [
    kv("Repo root", snapshot.repoRoot ?? "unknown"),
    ...(busyState === null ? [] : [kv("Current action", formatBusyState(busyState))]),
    kv("Setup", snapshot.kind === "repo" ? (snapshot.initialized ? "initialized" : "not initialized") : "unknown"),
    kv("Index", describeIndex(snapshot)),
    kv("Latest run", snapshot.latestRunId === null || snapshot.latestRunId === undefined ? "none" : `#${snapshot.latestRunId}`),
    kv("Freshness", describeFreshness(snapshot)),
    kv("Changed files", String(countChangedFiles(freshness, watcher))),
    kv("Runtime", snapshot.kind === "repo" ? (snapshot.runtimeRunning ? "running" : "not running") : "unknown"),
  ];
  const watcherHtml = renderWatcherSummary(watcher);
  const changedFilesHtml = renderChangedFilesList(freshness, watcher);
  const nextAction = pickNextAction(snapshot);
  return `${section("Summary", `<dl class="kv">${rows.join("")}</dl>`)}${
    nextAction ? section("Next action", `<p>${escapeHtml(nextAction)}</p>`) : ""
  }${watcherHtml}${changedFilesHtml}`;
}

export function renderFreshnessBody(snapshot) {
  const freshness = snapshot.rawStatus?.indexState?.freshness ?? null;
  const watcher = snapshot.rawStatus?.watcher ?? null;
  const reasons = Array.isArray(freshness?.reasons) ? freshness.reasons : [];
  const summary = section("Summary", `<dl class="kv">
    ${kv("State", describeFreshness(snapshot))}
    ${freshness?.summary ? kv("Detail", freshness.summary) : ""}
    ${kv("Changed files", String(countChangedFiles(freshness, watcher)))}
  </dl>`);

  const reasonsHtml = reasons.length === 0
    ? ""
    : section("Why", `<ul>${reasons.map((reason) => {
      const count = reason.count !== null && reason.count !== undefined ? ` <span class="muted">(${escapeHtml(String(reason.count))})</span>` : "";
      return `<li>${escapeHtml(reason.message ?? reason.code ?? "reason")}${count}</li>`;
    }).join("")}</ul>`);

  const whyMatters = freshness?.whyItMatters
    ? section("Why this matters", `<p>${escapeHtml(freshness.whyItMatters)}</p>`)
    : "";

  const recommendation = (snapshot.freshnessRecommendedAction ?? freshness?.recommendedAction ?? null);
  const actionHtml = recommendation
    ? section("Recommended action", `<p>${escapeHtml(recommendation)}</p>`)
    : "";

  return `${summary}${renderChangedFilesList(freshness, watcher)}${renderWatcherSummary(watcher)}${reasonsHtml}${whyMatters}${actionHtml}`;
}

function renderWatcherSummary(watcher) {
  if (watcher === null || watcher === undefined) {
    return section("Watcher", `<dl class="kv">
      ${kv("Status", "unknown")}
      ${kv("Auto re-index", "unknown")}
    </dl>`);
  }

  const rows = [
    kv("Status", watcher.running ? "running" : watcher.enabled ? "enabled" : "not running"),
    kv("Auto re-index", watcher.autoReindexEnabled ? "enabled" : "disabled"),
    kv("Re-index state", watcher.reindexState ?? "idle"),
    kv("Pending changed files", String(watcher.pendingChangedFileCount ?? 0)),
  ];
  if (watcher.lastEventAtMs !== null && watcher.lastEventAtMs !== undefined) {
    rows.push(kv("Last watcher event", String(watcher.lastEventAtMs)));
  }
  if (watcher.lastAutoReindexStartedAtMs !== null && watcher.lastAutoReindexStartedAtMs !== undefined) {
    rows.push(kv("Last auto re-index start", String(watcher.lastAutoReindexStartedAtMs)));
  }
  if (watcher.lastAutoReindexFinishedAtMs !== null && watcher.lastAutoReindexFinishedAtMs !== undefined) {
    rows.push(kv("Last auto re-index success", String(watcher.lastAutoReindexFinishedAtMs)));
  }
  if (watcher.lastAutoReindexFailedAtMs !== null && watcher.lastAutoReindexFailedAtMs !== undefined) {
    rows.push(kv("Last auto re-index failure", String(watcher.lastAutoReindexFailedAtMs)));
  }
  if (watcher.lastAutoReindexError !== null && watcher.lastAutoReindexError !== undefined) {
    rows.push(kv("Auto re-index error", truncate(String(watcher.lastAutoReindexError), 180)));
  }

  const action = watcher.lastAutoReindexError
    ? `<p class="muted">Recommended action: run <code>vtrace index</code> explicitly.</p>`
    : "";

  return section("Watcher", `<dl class="kv">${rows.join("")}</dl>${action}`);
}

function renderChangedFilesList(freshness, watcher) {
  const files = collectChangedFiles(freshness, watcher);
  if (files.length === 0) {
    return "";
  }
  return section("Changed files", `<ul class="bare mono">${files.map((filePath) => `<li>${escapeHtml(filePath)}</li>`).join("")}</ul>`);
}

function countChangedFiles(freshness, watcher) {
  if (typeof watcher?.pendingChangedFileCount === "number") {
    return watcher.pendingChangedFileCount;
  }
  const observed = freshness?.observedFileChanges;
  if (typeof observed?.count === "number") {
    return observed.count;
  }
  if (Array.isArray(observed?.changedFiles)) {
    return observed.changedFiles.length;
  }
  if (Array.isArray(watcher?.changedFiles)) {
    return watcher.changedFiles.length;
  }
  return 0;
}

function collectChangedFiles(freshness, watcher) {
  const candidates = [
    ...(Array.isArray(watcher?.changedFiles) ? watcher.changedFiles : []),
    ...(Array.isArray(freshness?.observedFileChanges?.changedFiles) ? freshness.observedFileChanges.changedFiles : []),
  ];
  return [...new Set(candidates.map((filePath) => String(filePath)))].sort().slice(0, 10);
}

function formatBusyState(busyState) {
  switch (busyState) {
    case "running_setup": return "Setting up and indexing…";
    case "running_reindex": return "Re-indexing…";
    case "failed": return "Failed";
    case "complete": return "Complete";
    default: return String(busyState);
  }
}

export function renderRuntimeBody(snapshot) {
  const runtime = snapshot.rawStatus?.runtime ?? null;
  const running = snapshot.kind !== "repo" ? "unknown" : snapshot.runtimeRunning ? "running" : "not running";

  const summary = section("Summary", `<dl class="kv">
    ${kv("State", running)}
    ${snapshot.runtimeStatus ? kv("Status", snapshot.runtimeStatus) : ""}
  </dl>`);

  const files = section("Files", `<dl class="kv">
    ${kv("State file", runtime?.statePath ?? "unknown")}
    ${kv("Log file", runtime?.logPath ?? "unknown")}
    ${kv("Stale state", runtime?.staleStatePresent ? "present (cleanup recommended)" : "none")}
  </dl>`);

  const nextAction = pickRuntimeAction(snapshot, runtime);
  const actionHtml = nextAction
    ? section("Recommended action", `<p>${escapeHtml(nextAction)}</p>`)
    : "";

  return `${summary}${files}${actionHtml}`;
}

export function renderSetupConfigBody(snapshot) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const summary = section("Summary", `<dl class="kv">
    ${kv("Initialized", snapshot.kind === "repo" ? (snapshot.initialized ? "yes" : "no") : "unknown")}
    ${kv("Selected agent", snapshot.defaultAgentId ?? (agents[0]?.id ?? "none"))}
  </dl>`);

  const agentsHtml = agents.length === 0
    ? section("Agents", `<p class="muted">No vtrace agent status was found for this workspace.</p>`)
    : section("Agents", agents.map((agent) => {
      const configStatus = !agent.installed
        ? "not installed"
        : agent.matchesExpected ? "installed and current" : "installed but drifted";
      return `<div class="card">
        <div><strong>${escapeHtml(agent.label)}</strong> <span class="muted">(${escapeHtml(agent.id)})</span></div>
        <dl class="kv">
          ${kv("Config state", configStatus)}
          ${agent.configPath ? kv("Config file", agent.configPath) : ""}
        </dl>
      </div>`;
    }).join(""));

  const recommendation = pickSetupAction(snapshot);
  const actionHtml = recommendation
    ? section("Recommended action", `<p>${escapeHtml(recommendation)}</p>`)
    : "";

  return `${summary}${agentsHtml}${actionHtml}`;
}

export function renderExecutableResolutionBody(executable, fallbackMessage = null) {
  if (executable === null || executable === undefined) {
    return `${section("Summary", `<p class="muted">No vtrace executable resolution has been recorded yet.</p>`)}${
      fallbackMessage ? section("Failure", `<p>${escapeHtml(fallbackMessage)}</p>`) : ""
    }${section("Next step", `<p>Set <code>vtrace.cliPath</code> in VS Code Settings or install vtrace on PATH.</p>`)}`;
  }

  const summary = section("Summary", `<dl class="kv">
    ${kv("Resolved path", executable.command ?? "unknown")}
    ${kv("Source", describeExecutableSourceLocal(executable.source))}
  </dl>`);

  const attemptedHtml = Array.isArray(executable.attempted) && executable.attempted.length > 0
    ? section("Resolution order tried", `<ul class="bare mono">${executable.attempted.map((entry) => `<li>${escapeHtml(describeExecutableSourceLocal(entry.source))}: ${escapeHtml(entry.path ?? "(no path)")}</li>`).join("")}</ul>`)
    : "";

  const failureHtml = fallbackMessage
    ? section("Failure", `<p>${escapeHtml(fallbackMessage)}</p>`)
    : "";

  const nextHtml = section("Next step", executable.source === "missing"
    ? `<p>Set <code>vtrace.cliPath</code> in VS Code Settings or install vtrace on PATH.</p>`
    : `<p>To override, set <code>vtrace.cliPath</code> in VS Code Settings.</p>`);

  return `${summary}${attemptedHtml}${failureHtml}${nextHtml}`;
}

export function renderDoctorBody(snapshot) {
  const primary = primaryLabel(snapshot);
  const summary = section("Summary", `<dl class="kv">
    ${kv("Repo state", primary)}
    ${kv("Index", describeIndex(snapshot))}
    ${kv("Freshness", describeFreshness(snapshot))}
    ${kv("Runtime", snapshot.kind === "repo" ? (snapshot.runtimeRunning ? "running" : "not running") : "unknown")}
  </dl>`);

  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  const warningsHtml = warnings.length === 0
    ? ""
    : section("Warnings", `<ul>${warnings.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`);

  const nextSteps = Array.isArray(snapshot.nextSteps) ? snapshot.nextSteps : [];
  const nextStepsHtml = nextSteps.length === 0
    ? ""
    : section("Next steps", `<ul>${nextSteps.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`);

  return `${summary}${warningsHtml}${nextStepsHtml}`;
}

export function renderFileSkeletonBody(skeleton, filePath) {
  const requestedPath = filePath ?? "unknown";
  const file = pickSkeletonFile(skeleton, filePath);

  if (file === null) {
    return renderSkeletonEmptyState({
      heading: "File Skeleton",
      message: "No skeleton data was produced for this file.",
      fields: [
        { label: "File", value: requestedPath },
        { label: "Status", value: "unknown" },
      ],
    });
  }

  if (file.status === "file_not_found") {
    return renderSkeletonEmptyState({
      heading: "File Skeleton",
      message: "The requested file was not found.",
      fields: [
        { label: "File", value: file.filePath ?? requestedPath },
        { label: "Status", value: "file_not_found" },
      ],
      extra: file.message ?? null,
    });
  }

  if (file.status === "not_indexed") {
    return renderSkeletonEmptyState({
      heading: "File Skeleton",
      message: "This file is present but not indexed for skeleton output.",
      fields: [
        { label: "File", value: file.filePath ?? requestedPath },
        { label: "Status", value: "not_indexed" },
      ],
      extra: file.message ?? null,
    });
  }

  if (file.status !== "ok") {
    return renderSkeletonEmptyState({
      heading: "File Skeleton",
      message: "This file could not be rendered as a skeleton.",
      fields: [
        { label: "File", value: file.filePath ?? requestedPath },
        { label: "Status", value: String(file.status) },
      ],
      extra: file.message ?? null,
    });
  }

  const declarations = file.declarations ?? [];
  const imports = file.imports ?? [];
  const exportsList = file.exports ?? [];
  const memberCount = declarations.reduce((total, declaration) => total + (declaration.members?.length ?? 0), 0);

  const header = renderHeaderBlock([
    { label: "File", value: file.filePath },
    { label: "Language", value: file.language ?? "unknown" },
    { label: "Status", value: "ok" },
  ]);

  if (declarations.length === 0 && imports.length === 0 && exportsList.length === 0) {
    return renderSkeletonEmptyState({
      heading: "File Skeleton",
      message: "No indexed declarations were found in this file.",
      fields: [
        { label: "File", value: file.filePath },
        { label: "Language", value: file.language ?? "unknown" },
        { label: "Status", value: "ok" },
      ],
    });
  }

  const strip = renderSummaryStrip([
    { label: "Imports", value: String(imports.length) },
    { label: "Exports", value: String(exportsList.length) },
    { label: "Declarations", value: String(declarations.length) },
    { label: "Members", value: String(memberCount) },
  ]);

  const importsHtml = imports.length === 0
    ? ""
    : section("Imports", `<ul class="bare">${imports.map((entry) => `<li><span class="mono">${escapeHtml(entry.name)}</span> <span class="muted">· ${escapeHtml(entry.kind)} · ${escapeHtml(entry.fromFilePath)}</span></li>`).join("")}</ul>`);

  const exportsHtml = exportsList.length === 0
    ? ""
    : section("Exports", `<ul class="bare">${exportsList.map((entry) => `<li><span class="mono">${escapeHtml(entry.name)}</span> <span class="muted">· ${escapeHtml(entry.kind)}</span></li>`).join("")}</ul>`);

  const declarationsHtml = declarations.length === 0
    ? ""
    : section("Top-level declarations", declarations.map(renderDeclarationCard).join(""));

  const notesHtml = `<p class="notes">This skeleton excludes implementation bodies. Only indexed structural data is shown.</p>`;

  return `${header}${strip}${importsHtml}${exportsHtml}${declarationsHtml}${notesHtml}`;
}

function renderDeclarationCard(declaration) {
  const exportedTag = declaration.exported ? `<span class="tag">exported</span>` : "";
  const signature = declaration.signature ? `<div class="mono">${escapeHtml(declaration.signature)}</div>` : "";
  const lineLabel = formatLineRange(declaration.startLine, declaration.endLine);
  const lineHtml = lineLabel ? `<span class="muted">${escapeHtml(lineLabel)}</span>` : "";
  const decoratorsHtml = (declaration.decorators ?? []).length > 0
    ? `<div class="muted">${declaration.decorators.map((decorator) => `<span class="tag">@${escapeHtml(decorator)}</span>`).join("")}</div>`
    : "";
  const docstringHtml = declaration.docstring
    ? `<p class="muted">${escapeHtml(truncate(declaration.docstring, 240))}</p>`
    : "";

  const members = declaration.members ?? [];
  const membersHtml = members.length === 0
    ? ""
    : `<div class="members-subsection">
        <div class="members-label">Members (${members.length})</div>
        <ul class="bare">${members.map(renderMemberRow).join("")}</ul>
      </div>`;

  return `<div class="card">
    <div><strong>${escapeHtml(declaration.name)}</strong> <span class="muted">· ${escapeHtml(declaration.kind)}</span> ${exportedTag} ${lineHtml}</div>
    ${signature}
    ${decoratorsHtml}
    ${docstringHtml}
    ${membersHtml}
  </div>`;
}

function renderMemberRow(member) {
  const label = member.signature ? member.signature : member.name;
  const lineLabel = formatLineRange(member.startLine, member.endLine);
  const lineHtml = lineLabel ? ` <span class="muted">${escapeHtml(lineLabel)}</span>` : "";
  const decorators = (member.decorators ?? []).length > 0
    ? ` <span class="muted">${member.decorators.map((decorator) => `<span class="tag">@${escapeHtml(decorator)}</span>`).join("")}</span>`
    : "";
  const doc = member.docstring
    ? `<div class="muted">${escapeHtml(truncate(member.docstring, 160))}</div>`
    : "";
  return `<li><span class="mono">${escapeHtml(label)}</span> <span class="muted">· ${escapeHtml(member.kind)}</span>${lineHtml}${decorators}${doc}</li>`;
}

function renderSkeletonEmptyState(input) {
  const fieldsHtml = input.fields.map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`).join("");
  const extra = input.extra ? `<p class="muted">${escapeHtml(input.extra)}</p>` : "";
  return `<section class="empty-state">
    <h2>${escapeHtml(input.heading)}</h2>
    <p>${escapeHtml(input.message)}</p>
    <dl class="kv">${fieldsHtml}</dl>
    ${extra}
  </section>`;
}

function renderHeaderBlock(fields) {
  return `<dl class="header-block" data-testid="header-block">${
    fields.map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`).join("")
  }</dl>`;
}

function renderSummaryStrip(fields) {
  return `<div class="summary-strip" data-testid="summary-strip">${
    fields.map((field) => `<span class="item"><span class="label">${escapeHtml(field.label)}:</span>${escapeHtml(field.value)}</span>`).join("")
  }</div>`;
}

function formatLineRange(startLine, endLine) {
  if (startLine === null || startLine === undefined) {
    return null;
  }
  if (endLine === null || endLine === undefined || endLine === startLine) {
    return `Lines ${startLine}`;
  }
  return `Lines ${startLine}–${endLine}`;
}

function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function renderImpactGraphBody(impact, symbolFqn) {
  const requested = symbolFqn ?? "unknown";

  if (impact === null || impact === undefined) {
    return renderImpactEmptyState({
      message: "No impact graph result was produced.",
      fields: [
        { label: "Requested symbol", value: requested },
      ],
    });
  }

  if (impact.ok === false) {
    const error = impact.error ?? {};
    const code = error.code ?? "unknown";

    if (code === "cross_repo_unsupported" || error.details?.crossRepoRequested === true) {
      return renderImpactEmptyState({
        message: "Cross-repo impact analysis is not supported in this workspace.",
        fields: [
          { label: "Requested symbol", value: requested },
          { label: "Cross-repo", value: "true" },
        ],
      });
    }

    return renderImpactEmptyState({
      message: "The symbol could not be resolved exactly.",
      fields: [
        { label: "Requested symbol", value: requested },
        { label: "Resolution mode", value: "exact_fqn" },
      ],
      extra: error.message ?? null,
    });
  }

  const output = impact.output ?? impact;
  const requestedInput = output.requested ?? {};

  if (requestedInput.crossRepo === true) {
    return renderImpactEmptyState({
      message: "Cross-repo impact analysis is not supported in this workspace.",
      fields: [
        { label: "Requested symbol", value: requestedInput.symbolFqn ?? requested },
        { label: "Cross-repo", value: "true" },
      ],
    });
  }

  const resolved = output.resolvedSymbol ?? {};
  const summary = output.summary ?? {};
  const coverage = output.coverage ?? {};
  const nodes = Array.isArray(output.nodes) ? output.nodes : [];
  const edges = Array.isArray(output.edges) ? output.edges : [];
  const dependentFiles = Array.isArray(output.dependentFiles) ? output.dependentFiles : [];
  const dependentSymbolCount = summary.dependentSymbolCount ?? 0;
  const dependentFileCount = summary.dependentFileCount ?? 0;

  if (dependentSymbolCount === 0 && dependentFileCount === 0) {
    return renderImpactEmptyState({
      message: "No dependents were found for this symbol in the indexed structural graph.",
      fields: [
        { label: "Symbol", value: resolved.fqName ?? requested },
        { label: "Dependent symbols", value: "0" },
        { label: "Dependent files", value: "0" },
      ],
    });
  }

  const header = renderHeaderBlock([
    { label: "Symbol", value: resolved.fqName ?? requested },
    { label: "Kind", value: resolved.kind ?? "unknown" },
    { label: "File", value: resolved.filePath ?? "unknown" },
    { label: "Resolution", value: coverage.resolutionMode ?? "exact_fqn" },
    { label: "Analysis kind", value: coverage.analysisKind ?? "unknown" },
  ]);

  const strip = renderSummaryStrip([
    { label: "Dependent symbols", value: String(dependentSymbolCount) },
    { label: "Dependent files", value: String(dependentFileCount) },
    { label: "Max depth", value: String(summary.maxDepth ?? 0) },
    { label: "Max observed distance", value: String(summary.maxObservedDistance ?? 0) },
  ]);

  const topDependents = nodes.filter((node) => (node.distance ?? 0) > 0).slice(0, 10);
  const topDependentsHtml = topDependents.length === 0
    ? section("Top dependents", `<p class="muted">none</p>`)
    : section("Top dependents", `<ul class="bare">${topDependents.map((node) => {
      const label = node.fqName ?? node.localName ?? "?";
      return `<li><span class="mono">${escapeHtml(label)}</span> <span class="muted">· ${escapeHtml(node.kind ?? "unknown")} · ${escapeHtml(node.filePath ?? "")} · distance ${escapeHtml(String(node.distance ?? "?"))}</span></li>`;
    }).join("")}</ul>`);

  const coverageHtml = section("Coverage", `<dl class="kv">
    ${kv("Analysis kind", coverage.analysisKind ?? "unknown")}
    ${kv("Supported edge types", formatEdgeTypes(coverage.supportedEdgeTypes))}
    ${kv("Observed edge types", formatEdgeTypes(coverage.observedEdgeTypes))}
    ${kv("Cross-repo", coverage.crossRepo === true ? "true" : "false")}
  </dl>${Array.isArray(coverage.notes) && coverage.notes.length > 0
    ? `<ul>${coverage.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : ""}`);

  const edgeSummaryHtml = section("Edge summary", `<dl class="kv">
    ${kv("Total edges", String(edges.length))}
  </dl>`);

  const dependentFilesHtml = shouldShowDependentFiles(dependentFiles)
    ? section("Dependent files", `<ul class="bare mono">${dependentFiles.map((filePath) => `<li>${escapeHtml(filePath)}</li>`).join("")}</ul>`)
    : "";

  const notesHtml = section("Notes", renderImpactNotes(coverage));

  return `${header}${strip}${topDependentsHtml}${coverageHtml}${edgeSummaryHtml}${dependentFilesHtml}${notesHtml}`;
}

function renderImpactNotes(coverage) {
  const lines = ["Top dependents are derived from bounded reverse structural traversal."];
  const analysisKind = coverage?.analysisKind ?? null;
  const supported = Array.isArray(coverage?.supportedEdgeTypes) ? coverage.supportedEdgeTypes : [];
  const observed = Array.isArray(coverage?.observedEdgeTypes) ? coverage.observedEdgeTypes : [];
  const missingEdgeTypes = supported.filter((edgeType) => !observed.includes(edgeType));

  if (analysisKind === "structural") {
    lines.push("Coverage is conservative: results reflect static structural evidence and do not represent runtime dispatch truth.");
  }
  if (missingEdgeTypes.length > 0) {
    lines.push(`No ${missingEdgeTypes.join(", ")} edges were observed for this symbol; dependents via those edge types may exist but are not shown.`);
  }
  if (coverage?.crossRepo === true) {
    lines.push("Cross-repo coverage is not indexed in this workspace.");
  }

  return `<ul>${lines.map((line) => `<li class="muted">${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function renderImpactEmptyState(input) {
  const fieldsHtml = input.fields.map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`).join("");
  const extra = input.extra ? `<p class="muted">${escapeHtml(input.extra)}</p>` : "";
  return `<section class="empty-state">
    <h2>Impact Graph</h2>
    <p>${escapeHtml(input.message)}</p>
    <dl class="kv">${fieldsHtml}</dl>
    ${extra}
  </section>`;
}

function formatEdgeTypes(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "(none)";
  }
  return list.join(", ");
}

function shouldShowDependentFiles(dependentFiles) {
  return Array.isArray(dependentFiles) && dependentFiles.length > 0 && dependentFiles.length <= 10;
}

export function renderRunPipelineBody(pipeline, repoRoot) {
  if (pipeline === null || pipeline === undefined) {
    return section("Summary", `<p class="muted">No run_pipeline result available.</p>`);
  }

  const request = pipeline.request ?? {};
  const intent = pipeline.intent ?? {};
  const taskSummary = pipeline.taskSummary ?? {};
  const context = pipeline.context ?? {};
  const impact = pipeline.impact ?? {};
  const memory = pipeline.memory ?? { session: {}, durable: {} };
  const diagnostics = pipeline.diagnostics ?? {};
  const rules = pipeline.rules ?? {};
  const deferred = Array.isArray(pipeline.deferred) ? pipeline.deferred : [];

  const headerRows = [
    { label: "Task", value: taskSummary.query ?? request.query ?? "(unknown)" },
    { label: "Repo", value: repoRoot ?? "(unknown)" },
    { label: "Intent", value: `${intent.selected ?? "?"}${intent.requested && intent.requested !== intent.selected ? ` (requested ${intent.requested})` : ""}` },
  ];
  if (request.sessionId) {
    headerRows.push({ label: "Session", value: request.sessionId });
  }

  const summaryStrip = renderSummaryStrip([
    { label: "Pivots", value: String(arrayLength(context.pivots)) },
    { label: "Supports", value: String(arrayLength(context.supports)) },
    { label: "Impact", value: impact.included ? "included" : "omitted" },
    { label: "Memory", value: memoryStripState(memory) },
    { label: "Rules", value: rulesStripState(rules) },
    { label: "Deferred", value: String(deferred.length) },
  ]);

  const intentBody = renderRunPipelineIntent(intent);
  const taskBody = renderRunPipelineTaskSummary(taskSummary, context);
  const contextBody = renderRunPipelineContext(context);
  const impactBody = renderRunPipelineImpact(impact);
  const memoryBody = renderRunPipelineMemory(memory);
  const rulesBody = renderRunPipelineRules(rules);
  const diagnosticsBody = renderRunPipelineDiagnostics(diagnostics, intent);
  const deferredBody = renderRunPipelineDeferred(deferred);

  return [
    renderHeaderBlock(headerRows),
    summaryStrip,
    section("Intent", intentBody),
    section("Task Summary", taskBody),
    section("Context", contextBody),
    section("Impact", impactBody),
    section("Memory", memoryBody),
    section("Rules", rulesBody),
    section("Diagnostics", diagnosticsBody),
    sectionWithAttrs("Deferred", deferredBody, { "data-testid": "deferred-section" }),
  ].join("");
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function memoryStripState(memory) {
  const session = memory?.session?.included ? "session" : null;
  const durable = memory?.durable?.included ? "durable" : null;
  const parts = [session, durable].filter(Boolean);
  return parts.length === 0 ? "omitted" : parts.join("+");
}

function rulesStripState(rules) {
  const active = Array.isArray(rules?.active) ? rules.active.length : 0;
  const candidates = Array.isArray(rules?.candidates) ? rules.candidates.length : 0;
  if (active === 0 && candidates === 0) {
    return "none";
  }
  return `active ${active}; candidates ${candidates}`;
}

function renderRunPipelineIntent(intent) {
  const rows = [];
  rows.push(kv("Preset", intent.selected ?? "?"));
  if (intent.requested && intent.requested !== intent.selected) {
    rows.push(kv("Requested", intent.requested));
  }
  if (intent.source) {
    rows.push(kv("Source", intent.source));
  }
  if (intent.editGoal) {
    rows.push(kv("Edit goal", intent.editGoal));
  }
  if (intent.includeTestsDefault !== undefined) {
    rows.push(kv("Include tests by default", intent.includeTestsDefault ? "yes" : "no"));
  }
  if (intent.fallbackApplied === true) {
    rows.push(kv("Fallback applied", "yes"));
  }
  const reasonHtml = intent.rationale
    ? `<p class="muted">${escapeHtml(intent.rationale)}</p>`
    : "";
  return `<dl class="kv">${rows.join("")}</dl>${reasonHtml}`;
}

function renderRunPipelineTaskSummary(taskSummary, context) {
  const rows = [
    kv("Query", taskSummary.query ?? "(unknown)"),
  ];
  if (taskSummary.normalizedQuery && taskSummary.normalizedQuery !== taskSummary.query) {
    rows.push(kv("Normalized", taskSummary.normalizedQuery));
  }
  if (taskSummary.editGoal) {
    rows.push(kv("Likely focus", taskSummary.editGoal));
  }
  const profileBits = [];
  if (context?.routingProfileId) profileBits.push(`routing=${context.routingProfileId}`);
  if (context?.capsuleProfileId) profileBits.push(`capsule=${context.capsuleProfileId}`);
  if (profileBits.length > 0) {
    rows.push(kv("Profiles", profileBits.join(" · ")));
  }
  return `<dl class="kv">${rows.join("")}</dl>`;
}

function renderRunPipelineContext(context) {
  if (!context || (context.included === false && (!context.pivots || context.pivots.length === 0))) {
    const reason = context?.skipReason ? ` <span class="muted">(${escapeHtml(context.skipReason)})</span>` : "";
    return `<p class="muted">Context omitted${reason}.</p>`;
  }
  const pivots = Array.isArray(context.pivots) ? context.pivots : [];
  const supports = Array.isArray(context.supports) ? context.supports : [];
  const summaryLine = `<p class="muted">${pivots.length} pivot(s), ${supports.length} support(s).${context.truncated ? " Some content truncated to fit budget." : ""}${context.compressed ? " Compressed representation." : ""}</p>`;

  const pivotsHtml = pivots.length === 0
    ? `<p class="muted">No pivots.</p>`
    : `<div class="subsection-label">Pivots</div>${pivots.map(renderRunPipelineContextItemCard).join("")}`;
  const supportsHtml = supports.length === 0
    ? `<p class="muted">No supports.</p>`
    : `<div class="subsection-label">Supports</div>${supports.map(renderRunPipelineContextItemCard).join("")}`;

  return `${summaryLine}${pivotsHtml}${supportsHtml}`;
}

function renderRunPipelineContextItemCard(item) {
  if (!item || typeof item !== "object") return "";
  const role = item.role ?? "item";
  const repTags = [];
  if (item.contentMode) {
    repTags.push(`<span class="tag">${escapeHtml(String(item.contentMode))}</span>`);
  }
  if (item.compressed) {
    repTags.push(`<span class="tag">compressed</span>`);
  }
  const fileLine = item.filePath
    ? `<div class="muted mono">${escapeHtml(item.filePath)}</div>`
    : "";
  const symbolLabel = item.fqName ?? item.localName ?? "(unknown)";
  return `<div class="card">
    <div><strong class="mono">${escapeHtml(String(symbolLabel))}</strong> <span class="muted">· ${escapeHtml(item.kind ?? "?")} · ${escapeHtml(role)}</span> ${repTags.join(" ")}</div>
    ${fileLine}
  </div>`;
}

function renderRunPipelineImpact(impact) {
  if (!impact || impact.included !== true) {
    const reason = impact?.skipReason ? ` <span class="muted">(${escapeHtml(impact.skipReason)})</span>` : "";
    return `<p class="muted">Impact omitted${reason}.</p>`;
  }
  const focal = impact.focalSymbol ?? null;
  const summary = impact.summary ?? null;
  const topDeps = Array.isArray(impact.topDependents) ? impact.topDependents : [];

  const focalRows = focal === null
    ? `<p class="muted">No focal symbol selected.</p>`
    : `<dl class="kv">
        ${kv("Focal symbol", focal.fqName ?? focal.localName ?? "?")}
        ${kv("Kind", focal.kind ?? "?")}
        ${kv("File", focal.filePath ?? "?")}
        ${impact.triggerReason ? kv("Trigger", impact.triggerReason) : ""}
      </dl>`;

  const summaryHtml = summary === null
    ? ""
    : `<dl class="kv">
        ${kv("Dependent symbols", String(summary.dependentSymbolCount ?? 0))}
        ${kv("Dependent files", String(summary.dependentFileCount ?? 0))}
        ${kv("Max depth", String(summary.maxDepth ?? 0))}
      </dl>`;

  const topDepsHtml = topDeps.length === 0
    ? ""
    : `<div class="subsection-label">Top dependents</div><ul class="bare">${topDeps.map((node) => {
      const label = node.fqName ?? node.localName ?? "?";
      return `<li><span class="mono">${escapeHtml(String(label))}</span> <span class="muted">· ${escapeHtml(node.kind ?? "?")} · ${escapeHtml(node.filePath ?? "")} · distance ${escapeHtml(String(node.distance ?? "?"))}</span></li>`;
    }).join("")}</ul>`;

  return `${focalRows}${summaryHtml}${topDepsHtml}`;
}

function renderRunPipelineMemory(memory) {
  const session = memory?.session ?? {};
  const durable = memory?.durable ?? {};

  const sessionHtml = session.included
    ? `<dl class="kv">
        ${kv("Session", session.sessionId ?? "?")}
        ${kv("Observations", String(session.observationCount ?? (session.recentObservations?.length ?? 0)))}
      </dl>${renderRunPipelineObservationList(session.recentObservations)}`
    : `<p class="muted">Session evidence skipped${session.skipReason ? ` (${escapeHtml(session.skipReason)})` : ""}.</p>`;

  const durableHtml = durable.included
    ? `<dl class="kv">${kv("Matches", String(durable.matchedCount ?? 0))}</dl>${renderRunPipelineObservationList(durable.topObservations)}`
    : `<p class="muted">Durable memory skipped${durable.skipReason ? ` (${escapeHtml(durable.skipReason)})` : ""}.</p>`;

  return `<div class="subsection-label">Session</div>${sessionHtml}<div class="subsection-label">Durable memory</div>${durableHtml}`;
}

function renderRunPipelineRules(rules) {
  if (!rules || rules.included !== true) {
    const omitted = rules?.omitted ?? {};
    const counts = renderRuleCounts(rules, omitted);
    return `${counts}<p class="muted">No active rules or candidate previews matched this task.</p>`;
  }

  const active = Array.isArray(rules.active) ? rules.active : [];
  const candidates = Array.isArray(rules.candidates) ? rules.candidates : [];
  const omitted = rules.omitted ?? {};
  const notes = Array.isArray(rules.notes) ? rules.notes : [];

  const activeHtml = active.length === 0
    ? `<p class="muted">No active injected rules matched this task.</p>`
    : active.map((rule) => renderRuleCard(rule, "active injected rule")).join("");
  const candidateHtml = candidates.length === 0
    ? `<p class="muted">No candidate rule previews matched this task.</p>`
    : candidates.map((rule) => renderRuleCard(rule, "candidate preview")).join("");
  const notesHtml = notes.length === 0
    ? ""
    : `<ul>${notes.map((note) => `<li class="muted">${escapeHtml(note)}</li>`).join("")}</ul>`;

  return `${renderRuleCounts(rules, omitted)}
    <div class="subsection-label">Active injected rules</div>${activeHtml}
    <div class="subsection-label">Candidate previews</div>${candidateHtml}
    ${notesHtml}`;
}

function renderRuleCounts(rules, omitted) {
  return `<dl class="kv">
    ${kv("Active matched", String(Array.isArray(rules?.active) ? rules.active.length : 0))}
    ${kv("Active total", String(rules?.activeCount ?? 0))}
    ${kv("Candidate previews", String(Array.isArray(rules?.candidates) ? rules.candidates.length : 0))}
    ${kv("Candidate total", String(rules?.candidateCount ?? omitted?.candidateRuleCount ?? 0))}
    ${kv("Stale", String(omitted?.staleRuleCount ?? 0))}
    ${kv("Disabled", String(omitted?.disabledRuleCount ?? 0))}
    ${kv("Dismissed", String(omitted?.dismissedRuleCount ?? 0))}
  </dl>`;
}

function renderRuleCard(rule, label) {
  const confidence = rule.confidence ? `<span class="tag">${escapeHtml(rule.confidence)}</span>` : "";
  const status = rule.status ? `<span class="tag">${escapeHtml(rule.status)}</span>` : "";
  const reason = rule.reason ? `<div class="muted">${escapeHtml(rule.reason)}</div>` : "";
  const evidence = rule.evidenceCount === undefined ? "" : `<div class="muted">Evidence: ${escapeHtml(String(rule.evidenceCount))}</div>`;
  return `<div class="card">
    <div><strong>${escapeHtml(rule.summary ?? "(no summary)")}</strong> <span class="muted">· ${escapeHtml(label)}</span> ${status}${confidence}</div>
    ${reason}
    ${evidence}
  </div>`;
}

function renderRunPipelineObservationList(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return "";
  }
  return `<ul class="bare">${observations.map((observation) => {
    const summary = observation.summary ?? "(no summary)";
    const kind = observation.kind ?? "observation";
    return `<li><span class="tag">${escapeHtml(String(kind))}</span> ${escapeHtml(truncate(String(summary), 200))}</li>`;
  }).join("")}</ul>`;
}

function renderRunPipelineDiagnostics(diagnostics, intent) {
  const retrieval = diagnostics?.retrieval ?? {};
  const impact = diagnostics?.impact ?? {};
  const memory = diagnostics?.memory ?? {};
  const rows = [];
  rows.push(kv("Fallback applied", retrieval.fallbackApplied ? `yes${retrieval.fallbackMode ? ` (${retrieval.fallbackMode})` : ""}` : "no"));
  if (retrieval.initialReason || retrieval.finalReason) {
    rows.push(kv("Retrieval signal", `${retrieval.initialReason ?? "ok"} → ${retrieval.finalReason ?? "ok"}`));
  }
  rows.push(kv(
    "Context items",
    `${retrieval.initialContextItemCount ?? 0} → ${retrieval.finalContextItemCount ?? 0}`,
  ));
  rows.push(kv("Impact", impact.included ? "included" : `omitted (${impact.skipReason ?? "?"})`));
  rows.push(kv(
    "Memory",
    `session ${memory.sessionIncluded ? "included" : `skipped (${memory.sessionSkipReason ?? "?"})`}; durable ${memory.durableIncluded ? "included" : `skipped (${memory.durableSkipReason ?? "?"})`}`,
  ));
  if (intent?.includeTestsDefault !== undefined) {
    rows.push(kv("include_tests default", intent.includeTestsDefault ? "yes" : "no"));
  }
  rows.push(kv("Deferred items", String(diagnostics.deferredCount ?? 0)));
  if (diagnostics?.freshness !== undefined) {
    rows.push(kv("Freshness", diagnostics.freshness?.state ?? "unknown"));
  }
  if (diagnostics?.rules !== undefined) {
    const rules = diagnostics.rules;
    rows.push(kv(
      "Rules",
      `active ${rules.activeMatchedCount ?? 0}/${rules.activeTotalCount ?? 0}; candidates ${rules.candidatePreviewCount ?? 0}/${rules.candidateTotalCount ?? 0}`,
    ));
  }
  rows.push(kv("Omitted sections", String(diagnostics.omittedSectionCount ?? 0)));
  return `<dl class="kv">${rows.join("")}</dl>`;
}

function renderRunPipelineDeferred(deferred) {
  if (deferred.length === 0) {
    return `<p class="muted">No deferred V-REFs emitted.</p>`;
  }
  const note = `<p class="muted">V-REF expansion is exact stored-payload lookup. Retained refs can be expanded later from repo-local storage; expired, unknown, or malformed refs fail explicitly. vtrace does not use fuzzy lookup or semantic reconstruction for V-REF expansion.</p>`;
  return `${note}${deferred.map(renderRunPipelineDeferredCard).join("")}`;
}

function renderRunPipelineDeferredCard(item) {
  if (!item || typeof item !== "object") return "";
  const hash = String(item.hash ?? "");
  const kind = String(item.kind ?? "?");
  const id = String(item.id ?? "");
  const summary = String(item.summary ?? "");
  const tool = item.suggestedTool ? `<span class="tag">${escapeHtml(String(item.suggestedTool))}</span>` : "";
  return `<div class="card deferred-item" data-testid="deferred-item" data-vexp-hash="${escapeHtml(hash)}" data-vexp-kind="${escapeHtml(kind)}" data-vexp-id="${escapeHtml(id)}">
    <div class="deferred-row">
      <div>
        <strong>${escapeHtml(kind)}</strong> ${tool}
        <div class="muted">${escapeHtml(summary)}</div>
        <div class="muted mono">V-REF ${escapeHtml(hash)}</div>
        <div class="muted">Exact stored payload. No fuzzy or semantic reconstruction.</div>
      </div>
      <div class="deferred-actions">
        <button type="button" class="vexp-expand-btn" data-vexp-action="expand" data-vexp-hash="${escapeHtml(hash)}" data-vexp-kind="${escapeHtml(kind)}" data-vexp-id="${escapeHtml(id)}" aria-expanded="false">Expand V-REF</button>
      </div>
    </div>
    <div class="vexp-expansion" data-vexp-expansion-for="${escapeHtml(hash)}" hidden></div>
  </div>`;
}

function sectionWithAttrs(heading, body, attrs) {
  const attrString = Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeHtml(String(value))}"`).join("");
  return `<section${attrString}><h2>${escapeHtml(heading)}</h2>${body}</section>`;
}

export function renderExpandedVexpRefContent(expansion) {
  if (expansion === null || expansion === undefined) {
    return `<p class="muted">No expansion available.</p>`;
  }
  if (expansion.resolved === false) {
    const reason = expansion.reason ?? "unknown";
    const message = expansion.message ?? "";
    return `<div class="vexp-expansion-error">
      <div><strong>Could not expand V-REF</strong> <span class="tag">${escapeHtml(reason)}</span></div>
      ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ""}
    </div>`;
  }
  const stableId = expansion.stableId ?? "";
  const category = expansion.category ?? "";
  const content = expansion.content ?? null;
  const meta = expansion.metadata ?? null;

  const header = `<div class="muted">${escapeHtml(stableId)} <span class="tag">${escapeHtml(category)}</span></div>`;
  const truthNote = `<p class="muted">Expanded from stored V-REF payload. This is not recomputed from disk.</p>`;
  const contentHtml = renderExpandedContentBlock(content);
  const metaHtml = meta && Object.keys(meta).length > 0
    ? `<details class="vexp-meta"><summary>metadata</summary><pre>${escapeHtml(safeJson(meta))}</pre></details>`
    : "";
  return `${header}${truthNote}${contentHtml}${metaHtml}`;
}

function renderExpandedContentBlock(content) {
  if (content === null || content === undefined) {
    return `<p class="muted">(empty content)</p>`;
  }
  if (content.kind === "text") {
    return `<pre>${escapeHtml(String(content.text ?? ""))}</pre>`;
  }
  if (content.kind === "json") {
    return `<pre>${escapeHtml(safeJson(content.value))}</pre>`;
  }
  return `<pre>${escapeHtml(safeJson(content))}</pre>`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function renderContextCapsuleBody(capsuleJson) {
  if (capsuleJson === null || capsuleJson === undefined) {
    return section("Summary", `<p class="muted">No capsule output available.</p>`);
  }

  const capsule = capsuleJson.capsule ?? capsuleJson;
  const query = capsuleJson.query ?? capsule.query ?? "";
  const intent = capsuleJson.intent ?? null;
  const routingProfile = capsuleJson.routingProfile ?? null;
  const capsuleProfile = capsuleJson.capsuleProfile ?? null;
  const pivots = Array.isArray(capsule.pivots) ? capsule.pivots : [];
  const supporting = Array.isArray(capsule.supportingItems) ? capsule.supportingItems : [];
  const memories = Array.isArray(capsule.memories) ? capsule.memories : [];
  const budget = capsule.budget ?? null;

  const header = section("Summary", `<dl class="kv">
    ${kv("Query", query)}
    ${intent ? kv("Intent", String(intent)) : ""}
    ${routingProfile ? kv("Routing profile", routingProfile.id ?? "") : ""}
    ${capsuleProfile ? kv("Capsule profile", capsuleProfile.id ?? "") : ""}
    ${kv("Pivots", String(pivots.length))}
    ${kv("Supporting items", String(supporting.length))}
    ${memories.length > 0 ? kv("Memories", String(memories.length)) : ""}
    ${kv("Truncated", capsule.truncated === true ? "yes" : "no")}
    ${budget ? kv("Budget", `${budget.usedCharacters ?? "?"} / ${budget.maxCharacters ?? "?"} chars`) : ""}
  </dl>`);

  const pivotsHtml = pivots.length === 0
    ? ""
    : section("Pivots", pivots.map((pivot) => renderCapsuleItemCard(pivot)).join(""));

  const supportingHtml = supporting.length === 0
    ? ""
    : section("Supporting items", supporting.map((item) => renderCapsuleItemCard(item)).join(""));

  return `${header}${pivotsHtml}${supportingHtml}`;
}

function renderCapsuleItemCard(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const role = item.role ?? "item";
  const symbol = item.symbol?.fqName ?? item.fqName ?? item.file?.filePath ?? "(unknown)";
  const reasons = Array.isArray(item.inclusionReasons) ? item.inclusionReasons.map((reason) => reason.kind ?? "").filter(Boolean) : [];
  return `<div class="card">
    <div><strong>${escapeHtml(String(symbol))}</strong> <span class="muted">(${escapeHtml(String(role))})</span></div>
    ${reasons.length > 0 ? `<div class="muted">${reasons.map((reason) => `<span class="tag">${escapeHtml(reason)}</span>`).join("")}</div>` : ""}
  </div>`;
}

function renderBody(result) {
  switch (result.type) {
    case RESULT_TYPES.IndexStatus:
      return renderIndexStatusBody(result.snapshot, result.busyState ?? null);
    case RESULT_TYPES.Freshness:
      return renderFreshnessBody(result.snapshot);
    case RESULT_TYPES.Runtime:
      return renderRuntimeBody(result.snapshot);
    case RESULT_TYPES.SetupConfig:
      return renderSetupConfigBody(result.snapshot);
    case RESULT_TYPES.ExecutableResolution:
      return renderExecutableResolutionBody(result.executable, result.message ?? null);
    case RESULT_TYPES.Doctor:
      return renderDoctorBody(result.snapshot);
    case RESULT_TYPES.FileSkeleton:
      return renderFileSkeletonBody(result.skeleton, result.filePath);
    case RESULT_TYPES.ImpactGraph:
      return renderImpactGraphBody(result.impact, result.symbolFqn);
    case RESULT_TYPES.ContextCapsule:
      return renderContextCapsuleBody(result.capsule);
    case RESULT_TYPES.RunPipeline:
      return renderRunPipelineBody(result.pipeline, result.repoRoot);
    default:
      return section("Summary", `<p class="muted">Unknown result type: ${escapeHtml(String(result.type))}.</p>`);
  }
}

function computeTitle(result) {
  const base = RESULT_TITLES[result.type] ?? "vtrace — Result";
  if (result.type === RESULT_TYPES.FileSkeleton && result.filePath) {
    return `${base}: ${result.filePath}`;
  }
  if (result.type === RESULT_TYPES.ImpactGraph && result.symbolFqn) {
    return `${base}: ${result.symbolFqn}`;
  }
  if (result.type === RESULT_TYPES.RunPipeline) {
    const query = result.pipeline?.taskSummary?.query ?? result.pipeline?.request?.query;
    return query ? `${base}: ${truncate(String(query), 80)}` : base;
  }
  return base;
}

function formatRawJson(rawData) {
  if (rawData === null || rawData === undefined) {
    return null;
  }
  if (typeof rawData === "string") {
    return rawData;
  }
  try {
    return JSON.stringify(rawData, null, 2);
  } catch {
    return null;
  }
}

function kv(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function section(heading, body) {
  return `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`;
}

function describeIndex(snapshot) {
  if (snapshot.kind !== "repo") return "unknown";
  if (!snapshot.initialized) return "not initialized yet";
  if (snapshot.readinessStatus === "ready") return "ready";
  return "unknown";
}

function describeFreshness(snapshot) {
  if (snapshot.kind !== "repo") return "unknown";
  if (snapshot.freshnessState === "fresh") return "fresh";
  if (snapshot.freshnessState === "possibly_stale") return "possibly stale";
  return "unknown";
}

function primaryLabel(snapshot) {
  if (snapshot.kind === "no_workspace") return "No workspace";
  if (snapshot.kind === "cli_unavailable") return "vtrace not found";
  if (snapshot.kind === "unavailable") return "Unknown";
  if (snapshot.state === "ready") return "Ready";
  if (snapshot.state === "stale") return "Possibly stale";
  if (snapshot.state === "not_initialized") return "Not initialized";
  return "Unknown";
}

function pickNextAction(snapshot) {
  if (Array.isArray(snapshot.nextSteps) && snapshot.nextSteps.length > 0) {
    return snapshot.nextSteps[0];
  }
  if (snapshot.kind === "no_workspace") return "Open a folder to use vtrace in VS Code.";
  if (snapshot.kind === "cli_unavailable") return "Set vtrace.cliPath or install vtrace on PATH.";
  if (snapshot.kind === "repo" && !snapshot.initialized) return "Run Setup Agent to initialize vtrace.";
  return null;
}

function pickRuntimeAction(snapshot, runtime) {
  if (snapshot.kind !== "repo") return "Open a workspace and run Setup Agent if you need the optional runtime daemon.";
  if (runtime?.staleStatePresent === true) return "Run vtrace doctor to clean up the stale runtime state file.";
  if (snapshot.runtimeRunning) return null;
  return "The runtime daemon is optional. Start it only if a vtrace command needs it.";
}

function pickSetupAction(snapshot) {
  if (snapshot.kind !== "repo") return "Open a workspace to manage vtrace setup.";
  if (!snapshot.initialized) return "Run Setup Agent to initialize vtrace for this repo.";
  const agents = snapshot.agents ?? [];
  const drifted = agents.find((agent) => !agent.installed || !agent.matchesExpected);
  if (drifted !== undefined) {
    return `Run Setup Agent to install or refresh the ${drifted.label} config.`;
  }
  return null;
}

function pickSkeletonFile(skeleton, filePath) {
  if (skeleton === null || skeleton === undefined) return null;
  const files = Array.isArray(skeleton.files) ? skeleton.files : [];
  if (files.length === 0) return null;
  if (filePath) {
    const match = files.find((file) => file.filePath === filePath);
    if (match !== undefined) return match;
  }
  return files[0];
}

function describeExecutableSourceLocal(source) {
  switch (source) {
    case "configured": return "From vtrace.cliPath setting";
    case "bundled": return "Bundled launcher";
    case "bundled_dev": return "Bundled launcher (dev repo layout)";
    case "path": return "Resolved from PATH";
    case "missing": return "Not found";
    default: return "Unknown";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

export class ResultPanelController {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.viewType = options.viewType ?? "vtrace.result";
    this.panel = null;
    this.lastResult = null;
    this.expandVexpRef = options.expandVexpRef ?? null;
    this._messageDisposable = null;
  }

  setExpandVexpRefHandler(handler) {
    this.expandVexpRef = handler;
  }

  showResult(result) {
    const view = buildResultView(result);
    const html = buildHtml(view);
    this.lastResult = result;

    if (this.panel === null) {
      const column = this.vscode.ViewColumn?.Active ?? 1;
      this.panel = this.vscode.window.createWebviewPanel(
        this.viewType,
        view.title,
        column,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const disposeHandler = () => {
        this.panel = null;
        this._messageDisposable = null;
      };
      if (typeof this.panel.onDidDispose === "function") {
        this.panel.onDidDispose(disposeHandler);
      }
      this._wireMessages();
    }

    this.panel.title = view.title;
    if (this.panel.webview !== undefined && this.panel.webview !== null) {
      this.panel.webview.html = html;
    }
    if (typeof this.panel.reveal === "function") {
      this.panel.reveal(undefined, true);
    }

    return view;
  }

  _wireMessages() {
    const webview = this.panel?.webview;
    if (!webview || typeof webview.onDidReceiveMessage !== "function") {
      return;
    }
    this._messageDisposable = webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "expandVexpRef") {
        void this._handleExpandRequest(message);
      }
    });
  }

  async _handleExpandRequest(message) {
    const hash = String(message.hash ?? "");
    if (this.expandVexpRef === null) {
      this._postExpansion(hash, { resolved: false, reason: "unsupported_category", message: "Expansion is not wired for this panel." });
      return;
    }
    const lastPipeline = this.lastResult?.type === RESULT_TYPES.RunPipeline ? this.lastResult : null;
    try {
      const expansion = await this.expandVexpRef({
        hash,
        kind: message.kind ?? null,
        id: message.id ?? null,
        repoRoot: lastPipeline?.repoRoot ?? null,
        query: lastPipeline?.pipeline?.taskSummary?.query ?? lastPipeline?.pipeline?.request?.query ?? null,
        sessionId: lastPipeline?.pipeline?.request?.sessionId ?? null,
      });
      this._postExpansion(hash, expansion);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      this._postExpansion(hash, { resolved: false, reason: "unknown_hash", message: errMessage });
    }
  }

  _postExpansion(hash, expansion) {
    const html = renderExpandedVexpRefContent(expansion);
    const webview = this.panel?.webview;
    if (webview && typeof webview.postMessage === "function") {
      void webview.postMessage({ type: "expandedVexpRef", hash, html, expansion });
    }
  }

  dispose() {
    if (this.panel !== null && typeof this.panel.dispose === "function") {
      this.panel.dispose();
    }
    this.panel = null;
  }
}
