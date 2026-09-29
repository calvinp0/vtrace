/**
 * M220 §16–§21, §38 — the subscription authentication audit, the API-key
 * billing-override guard, the usage-credit overflow guard, and the agent
 * auto-update posture.
 *
 * The operator runs the cohort on a Claude MAX subscription. Anthropic's
 * product rule is that an `ANTHROPIC_API_KEY` in the environment switches
 * Claude Code to API billing; other documented variables route requests to
 * another provider or inject another identity. So before a session starts,
 * the environment the LAUNCHER itself runs in is inspected by NAME (values are
 * never read past "present and non-empty"), the CLI's own zero-call
 * `auth status --json` is read, the credential file's non-secret fields and
 * the cached account profile are read, and one verdict is produced.
 *
 * Strength of the claim, stated exactly: everything here is LOCAL CLI AUTH
 * STATE. It proves what the CLI on this host believes and which billing path
 * it would take; it does not prove what the provider will do on the first
 * request. That is the runtime gate's job: the agent's own init event carries
 * `apiKeySource`, and a value other than 'none' aborts the attempt exactly as
 * model identity does. Provider confirmation is PENDING_AT_FIRST_LIVE_RUN.
 *
 * Nothing here spends. `auth status` is verified to work with networking
 * unshared by the falsification suite.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentBinary } from "./m216ProductionAdapters";

export const M220_AUTH_VERSION = "stage5.m220.subscription-auth.v1" as const;

// ── §17 — provider overrides, by name ───────────────────────────────

export type OverrideClass = "API_KEY_BILLING" | "PROVIDER_ROUTE" | "ALTERNATE_IDENTITY" | "MODEL_OVERRIDE" | "UNCLASSIFIED_ANTHROPIC_PREFIX";

/**
 * Variables that would change how, or as whom, Claude Code bills or routes.
 * Documented by Anthropic for the CLI; anything else with the `ANTHROPIC_`
 * prefix is treated as an override until classified, never ignored.
 */
export const PROVIDER_OVERRIDE_VARIABLES: readonly { readonly name: string; readonly classification: OverrideClass; readonly why: string }[] = Object.freeze([
  { name: "ANTHROPIC_API_KEY", classification: "API_KEY_BILLING", why: "switches Claude Code from subscription login to API (pay-as-you-go) billing" },
  { name: "ANTHROPIC_AUTH_TOKEN", classification: "API_KEY_BILLING", why: "a bearer token replaces the subscription login" },
  { name: "ANTHROPIC_CUSTOM_HEADERS", classification: "PROVIDER_ROUTE", why: "custom request headers can redirect or re-authenticate requests" },
  { name: "ANTHROPIC_BASE_URL", classification: "PROVIDER_ROUTE", why: "requests leave the first-party endpoint" },
  { name: "ANTHROPIC_BEDROCK_BASE_URL", classification: "PROVIDER_ROUTE", why: "Bedrock routing" },
  { name: "ANTHROPIC_VERTEX_BASE_URL", classification: "PROVIDER_ROUTE", why: "Vertex routing" },
  { name: "ANTHROPIC_VERTEX_PROJECT_ID", classification: "PROVIDER_ROUTE", why: "Vertex routing" },
  { name: "ANTHROPIC_FOUNDRY_BASE_URL", classification: "PROVIDER_ROUTE", why: "Foundry routing" },
  { name: "CLAUDE_CODE_USE_BEDROCK", classification: "PROVIDER_ROUTE", why: "cloud-provider billing instead of the subscription" },
  { name: "CLAUDE_CODE_USE_VERTEX", classification: "PROVIDER_ROUTE", why: "cloud-provider billing instead of the subscription" },
  { name: "CLAUDE_CODE_USE_FOXTROT", classification: "PROVIDER_ROUTE", why: "cloud-provider billing instead of the subscription" },
  { name: "CLAUDE_CODE_USE_FOUNDRY", classification: "PROVIDER_ROUTE", why: "cloud-provider billing instead of the subscription" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", classification: "ALTERNATE_IDENTITY", why: "a long-lived token can authenticate a different account than the audited login" },
  { name: "CLAUDE_CODE_HOST_CREDS_FILE", classification: "ALTERNATE_IDENTITY", why: "an alternate credential file replaces the audited one" },
  { name: "CLAUDE_CODE_HOST_AUTH_ENV_VAR", classification: "ALTERNATE_IDENTITY", why: "names another variable as the credential source" },
  { name: "ANTHROPIC_MODEL", classification: "MODEL_OVERRIDE", why: "would override the frozen model target" },
  { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", classification: "MODEL_OVERRIDE", why: "would re-map the frozen model alias" },
  { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", classification: "MODEL_OVERRIDE", why: "would re-map a model alias" },
  { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", classification: "MODEL_OVERRIDE", why: "would re-map a model alias" },
]);

export interface PresentOverride {
  readonly name: string;
  readonly classification: OverrideClass;
  readonly why: string;
  /** Presence only. The value is never read past "non-empty". */
  readonly present: true;
  readonly valueRecorded: false;
}

export interface AuthEnvironmentInspection {
  readonly checkedNames: readonly string[];
  readonly present: readonly PresentOverride[];
  readonly apiKeyPresent: boolean;
  readonly verdict: "NO_PROVIDER_OVERRIDE_PRESENT" | "PROVIDER_OVERRIDE_PRESENT";
  readonly childEnvironmentPolicy: string;
}

/** §17, §18 — inspect the launcher's environment by name; record presence, never contents. */
export function inspectAuthEnvironment(env: Readonly<Record<string, string | undefined>>): AuthEnvironmentInspection {
  const present: PresentOverride[] = [];
  const known = new Set(PROVIDER_OVERRIDE_VARIABLES.map((entry) => entry.name));
  for (const entry of PROVIDER_OVERRIDE_VARIABLES) {
    const value = env[entry.name];
    if (typeof value === "string" && value.length > 0) {
      present.push({ name: entry.name, classification: entry.classification, why: entry.why, present: true, valueRecorded: false });
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (known.has(name) || typeof value !== "string" || value.length === 0) continue;
    if (name.startsWith("ANTHROPIC_")) {
      present.push({ name, classification: "UNCLASSIFIED_ANTHROPIC_PREFIX", why: "an ANTHROPIC_-prefixed variable is treated as a provider override until classified", present: true, valueRecorded: false });
    }
  }
  present.sort((left, right) => left.name.localeCompare(right.name));
  return {
    checkedNames: Object.freeze(PROVIDER_OVERRIDE_VARIABLES.map((entry) => entry.name)),
    present: Object.freeze(present),
    apiKeyPresent: present.some((entry) => entry.name === "ANTHROPIC_API_KEY"),
    verdict: present.length === 0 ? "NO_PROVIDER_OVERRIDE_PRESENT" : "PROVIDER_OVERRIDE_PRESENT",
    childEnvironmentPolicy:
      "the agent never inherits these: each arm runs in the M193A allow-listed environment (PATH, HOME, USER, "
      + "LOGNAME, SHELL, LANG, LC_ALL, TERM, TMPDIR, SSL_CERT_FILE, SSL_CERT_DIR + a private CLAUDE_CONFIG_DIR), "
      + "which drops every ANTHROPIC_* and CLAUDE_* key. The launcher still refuses when one is present, so an "
      + "override is recorded and refused by name rather than dropped silently",
  };
}

// ── settings-file overrides ─────────────────────────────────────────

export interface SettingsFileInspection {
  readonly path: string;
  readonly exists: boolean;
  readonly parseable: boolean;
  readonly apiKeyHelperConfigured: boolean;
  /** Names only. */
  readonly envOverrideNames: readonly string[];
  readonly forceLoginMethod: string | null;
  readonly reachesTheArm: boolean;
  readonly why: string;
}

export function defaultSettingsPaths(home: string = homedir(), projectRoot?: string): readonly { path: string; reachesTheArm: boolean; why: string }[] {
  const paths = [
    { path: join(home, ".claude", "settings.json"), reachesTheArm: false, why: "the arm's CLAUDE_CONFIG_DIR is a private directory; the host user settings are not copied into it (M193A copies .credentials.json only)" },
    { path: join(home, ".claude", "settings.local.json"), reachesTheArm: false, why: "same: not copied into the private configuration directory" },
    { path: "/etc/claude-code/managed-settings.json", reachesTheArm: true, why: "managed (policy) settings are read from the system path regardless of CLAUDE_CONFIG_DIR" },
  ];
  if (projectRoot !== undefined) {
    paths.push({ path: join(projectRoot, ".claude", "settings.json"), reachesTheArm: false, why: "the launcher's project settings; the arm's cwd is /testbed, not this repository" });
  }
  return paths;
}

export function inspectSettingsFile(entry: { path: string; reachesTheArm: boolean; why: string }, read: (path: string) => string | null = readIfExists): SettingsFileInspection {
  const text = read(entry.path);
  if (text === null) {
    return { path: entry.path, exists: false, parseable: false, apiKeyHelperConfigured: false, envOverrideNames: [], forceLoginMethod: null, reachesTheArm: entry.reachesTheArm, why: entry.why };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const env = (parsed?.env ?? {}) as Record<string, unknown>;
  const overrideNames = Object.keys(env).filter((name) => name.startsWith("ANTHROPIC_") || PROVIDER_OVERRIDE_VARIABLES.some((entry) => entry.name === name)).sort();
  return {
    path: entry.path,
    exists: true,
    parseable: parsed !== null,
    apiKeyHelperConfigured: typeof parsed?.apiKeyHelper === "string" && parsed.apiKeyHelper.length > 0,
    envOverrideNames: Object.freeze(overrideNames),
    forceLoginMethod: typeof parsed?.forceLoginMethod === "string" ? parsed.forceLoginMethod : null,
    reachesTheArm: entry.reachesTheArm,
    why: entry.why,
  };
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

// ── §19 — the CLI's own auth status (zero provider call) ────────────

export interface CliAuthStatus {
  readonly command: string;
  readonly available: boolean;
  readonly loggedIn: boolean | null;
  readonly authMethod: string | null;
  readonly apiProvider: string | null;
  readonly subscriptionType: string | null;
  /** Field names the CLI returned; identity values (email, org ids) are never copied. */
  readonly fieldNames: readonly string[];
  readonly error: string | null;
}

export const CLI_AUTH_STATUS_ARGS: readonly string[] = Object.freeze(["auth", "status", "--json"]);

/**
 * `claude auth status --json` against the HOST configuration (where the
 * credentials the arms copy live). Run with a minimal environment so an
 * override in the launcher's own environment cannot colour the answer; the
 * override guard reports that separately.
 */
export function readCliAuthStatus(binary: string = resolveAgentBinary().binary, env: Readonly<Record<string, string | undefined>> = process.env): CliAuthStatus {
  const command = `${binary} ${CLI_AUTH_STATUS_ARGS.join(" ")}`;
  try {
    const out = execFileSync(binary, [...CLI_AUTH_STATUS_ARGS], {
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir(), USER: env.USER ?? "", LANG: env.LANG ?? "C.UTF-8", TERM: "dumb" },
    });
    return parseCliAuthStatus(command, out);
  } catch (error) {
    return { command, available: false, loggedIn: null, authMethod: null, apiProvider: null, subscriptionType: null, fieldNames: [], error: (error as Error).message.slice(0, 300) };
  }
}

export function parseCliAuthStatus(command: string, out: string): CliAuthStatus {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return { command, available: false, loggedIn: null, authMethod: null, apiProvider: null, subscriptionType: null, fieldNames: [], error: "auth status did not print JSON" };
  }
  return {
    command,
    available: true,
    loggedIn: typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null,
    authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
    subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    fieldNames: Object.freeze(Object.keys(parsed).sort()),
    error: null,
  };
}

// ── credential file and account profile: non-secret facts only ──────

export interface CredentialFileFacts {
  readonly path: string;
  readonly exists: boolean;
  readonly hasClaudeAiOauth: boolean;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  readonly accessTokenExpiresAtIso: string | null;
  readonly refreshTokenExpiresAtIso: string | null;
  readonly secretsRead: false;
}

export function readCredentialFacts(path: string = join(homedir(), ".claude", ".credentials.json"), read: (path: string) => string | null = readIfExists): CredentialFileFacts {
  const text = read(path);
  const none: CredentialFileFacts = { path, exists: false, hasClaudeAiOauth: false, subscriptionType: null, rateLimitTier: null, accessTokenExpiresAtIso: null, refreshTokenExpiresAtIso: null, secretsRead: false };
  if (text === null) return none;
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (oauth === undefined || typeof oauth !== "object") return { ...none, exists: true };
    const iso = (value: unknown): string | null => (typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value).toISOString() : null);
    return {
      path, exists: true, hasClaudeAiOauth: true,
      subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
      rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null,
      accessTokenExpiresAtIso: iso(oauth.expiresAt),
      refreshTokenExpiresAtIso: iso(oauth.refreshTokenExpiresAt),
      secretsRead: false,
    };
  } catch {
    return { ...none, exists: true };
  }
}

/**
 * M220-A3 §9 — the CLI's cached usage snapshot, the USER-level credit state.
 *
 * `cachedUsageUtilization.utilization.extra_usage.is_enabled` is the field the
 * CLI's own usage view renders as "Usage credits are off"; the CLI writes it,
 * with `fetchedAtMs` and the account it belongs to, when it fetches usage.
 * Only the facts below are copied; the account id is compared, never kept.
 */
export interface UsageSnapshotFacts {
  readonly present: boolean;
  readonly extraUsageEnabled: boolean | null;
  readonly userDisabled: boolean | null;
  readonly fetchedAtIso: string | null;
  /** Whether the snapshot belongs to the logged-in account; null when either side is absent. */
  readonly accountMatches: boolean | null;
}

export interface AccountProfileFacts {
  readonly path: string;
  readonly exists: boolean;
  /**
   * The cached profile field named hasExtraUsageEnabled. M220-A3 read the CLI:
   * it is copied from the profile endpoint's `organization.has_extra_usage_enabled`
   * (organisation-scoped) and can lag the user-level usage snapshot, which
   * is why it decides only when no user-level observation exists.
   */
  readonly hasExtraUsageEnabled: boolean | null;
  readonly organizationType: string | null;
  readonly billingType: string | null;
  readonly profileFetchedAtIso: string | null;
  readonly autoUpdates: boolean | null;
  readonly installMethod: string | null;
  /** M220-A3 — the user-level usage snapshot; absent from M220-era fixtures. */
  readonly usageSnapshot?: UsageSnapshotFacts;
}

const NO_USAGE_SNAPSHOT: UsageSnapshotFacts = { present: false, extraUsageEnabled: null, userDisabled: null, fetchedAtIso: null, accountMatches: null };

export function readAccountProfileFacts(path: string = join(homedir(), ".claude.json"), read: (path: string) => string | null = readIfExists): AccountProfileFacts {
  const text = read(path);
  const none: AccountProfileFacts = { path, exists: false, hasExtraUsageEnabled: null, organizationType: null, billingType: null, profileFetchedAtIso: null, autoUpdates: null, installMethod: null };
  if (text === null) return none;
  try {
    const parsed = JSON.parse(text) as { oauthAccount?: Record<string, unknown>; autoUpdates?: unknown; installMethod?: unknown; cachedUsageUtilization?: unknown };
    const account = parsed.oauthAccount ?? {};
    const cached = parsed.cachedUsageUtilization as { fetchedAtMs?: unknown; accountUuid?: unknown; utilization?: { extra_usage?: Record<string, unknown> | null } } | undefined;
    const extra = cached?.utilization?.extra_usage;
    const usageSnapshot: UsageSnapshotFacts = cached === undefined || cached === null || typeof cached !== "object"
      ? NO_USAGE_SNAPSHOT
      : {
        present: true,
        extraUsageEnabled: typeof extra?.is_enabled === "boolean" ? extra.is_enabled : null,
        userDisabled: typeof extra?.user_disabled === "boolean" ? extra.user_disabled : null,
        fetchedAtIso: typeof cached.fetchedAtMs === "number" ? new Date(cached.fetchedAtMs).toISOString() : null,
        accountMatches: typeof cached.accountUuid === "string" && typeof account.accountUuid === "string"
          ? cached.accountUuid === account.accountUuid
          : null,
      };
    return {
      path, exists: true,
      hasExtraUsageEnabled: typeof account.hasExtraUsageEnabled === "boolean" ? account.hasExtraUsageEnabled : null,
      organizationType: typeof account.organizationType === "string" ? account.organizationType : null,
      billingType: typeof account.billingType === "string" ? account.billingType : null,
      profileFetchedAtIso: typeof account.profileFetchedAt === "number" ? new Date(account.profileFetchedAt).toISOString() : null,
      autoUpdates: typeof parsed.autoUpdates === "boolean" ? parsed.autoUpdates : null,
      installMethod: typeof parsed.installMethod === "string" ? parsed.installMethod : null,
      usageSnapshot,
    };
  } catch {
    return { ...none, exists: true };
  }
}

// ── §38 — auto-update posture ───────────────────────────────────────

export interface AutoUpdatePosture {
  readonly autoUpdatesSetting: boolean | null;
  readonly disableAutoupdaterEnvPresent: boolean;
  readonly installMethod: string | null;
  /** The executable M214's declared launcher resolves to now (M220-A3: no pinned path). */
  readonly harnessBinary: string;
  readonly verdict: "AUTO_UPDATE_DISABLED" | "AUTO_UPDATE_NOT_PROVEN_DISABLED";
  readonly consequence: string;
}

export function autoUpdatePosture(account: AccountProfileFacts, env: Readonly<Record<string, string | undefined>>): AutoUpdatePosture {
  const envPresent = typeof env.DISABLE_AUTOUPDATER === "string" && env.DISABLE_AUTOUPDATER.length > 0;
  const disabled = account.autoUpdates === false || envPresent;
  return {
    autoUpdatesSetting: account.autoUpdates,
    disableAutoupdaterEnvPresent: envPresent,
    installMethod: account.installMethod,
    harnessBinary: resolveAgentBinary().binary,
    verdict: disabled ? "AUTO_UPDATE_DISABLED" : "AUTO_UPDATE_NOT_PROVEN_DISABLED",
    consequence:
      "under M214_A3 a Claude Code update is metadata: between complete pairs it is a recorded transition once the "
      + "capability contract passes on the new executable; inside a pair it refuses the second arm "
      + "(PAIR_HARNESS_DRIFT) and pauses the cohort. Disabling auto-update only makes the in-pair case rarer.",
  };
}

// ── M220-A3 §9–§12 — the usage-credit evidence hierarchy ─────────────

/** An operator statement recorded on this invocation. It authorises nothing but the state it names. */
export interface ExtraUsageAttestation {
  readonly state: "DISABLED" | "ENABLED";
  readonly statement: string;
  readonly attestedAt: string;
}

export type ExtraUsageSource = "LIVE_CLI_ACCOUNT_STATE" | "OPERATOR_ATTESTATION" | "CACHED_CLI_USAGE_SNAPSHOT" | "CACHED_ACCOUNT_PROFILE";

export interface ExtraUsageObservation {
  readonly source: ExtraUsageSource;
  readonly scope: "USER" | "ORGANIZATION";
  readonly state: "ENABLED" | "DISABLED";
  readonly observedAt: string | null;
  readonly detail: string;
}

export const STALE_CACHED_EXTRA_USAGE_STATE = "STALE_CACHED_EXTRA_USAGE_STATE" as const;
/** A decisive usage snapshot older than this is reported (never refused on age alone). */
export const USAGE_SNAPSHOT_AGE_WARNING_HOURS = 24 as const;

export interface ExtraUsageResolution {
  readonly verdict: OverflowVerdict;
  readonly decidedBy: ExtraUsageSource | null;
  readonly observations: readonly ExtraUsageObservation[];
  readonly staleCachedState: boolean;
  readonly liveStateAvailable: false;
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

const SOURCE_RANK: Readonly<Record<ExtraUsageSource, number>> = { LIVE_CLI_ACCOUNT_STATE: 0, OPERATOR_ATTESTATION: 1, CACHED_CLI_USAGE_SNAPSHOT: 2, CACHED_ACCOUNT_PROFILE: 3 };

function normaliseAttestation(value: string | ExtraUsageAttestation | null | undefined, at: string): ExtraUsageAttestation | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim().length === 0 ? null : { state: "DISABLED", statement: value, attestedAt: at };
  return value.statement.trim().length === 0 ? null : value;
}

/**
 * PURE. Which evidence answers "are the operator's usage credits on?".
 *
 * There is no zero-call LIVE source (auth status carries no usage field). The
 * user-level sources are the operator's attestation on this invocation and
 * the CLI's usage snapshot for the logged-in account; the newest decides and
 * a tie goes to the attestation. The profile flag is organisation-level: it
 * decides only when no user-level source exists, and a user-level DISABLED
 * beside it is STALE_CACHED_EXTRA_USAGE_STATE, a warning, never a block.
 */
export function resolveExtraUsageState(input: {
  readonly account: AccountProfileFacts;
  readonly attestation: ExtraUsageAttestation | null;
  readonly at: string;
}): ExtraUsageResolution {
  const observations: ExtraUsageObservation[] = [];
  const warnings: string[] = [];
  const issues: string[] = [];
  if (input.attestation !== null) {
    observations.push({
      source: "OPERATOR_ATTESTATION", scope: "USER", state: input.attestation.state, observedAt: input.attestation.attestedAt,
      detail: `operator attested extra usage ${input.attestation.state}: ${input.attestation.statement}`,
    });
  }
  const snapshot = input.account.usageSnapshot ?? NO_USAGE_SNAPSHOT;
  if (snapshot.present && snapshot.accountMatches === false) {
    warnings.push("the CLI usage snapshot belongs to a different account than the logged-in one; it is ignored");
  } else if (snapshot.present && snapshot.extraUsageEnabled !== null) {
    observations.push({
      source: "CACHED_CLI_USAGE_SNAPSHOT", scope: "USER", state: snapshot.extraUsageEnabled ? "ENABLED" : "DISABLED",
      observedAt: snapshot.fetchedAtIso,
      detail: `cachedUsageUtilization extra_usage.is_enabled=${snapshot.extraUsageEnabled}, user_disabled=${String(snapshot.userDisabled)} (fetched ${snapshot.fetchedAtIso ?? "unknown"})`,
    });
  }
  if (input.account.hasExtraUsageEnabled !== null) {
    observations.push({
      source: "CACHED_ACCOUNT_PROFILE", scope: "ORGANIZATION", state: input.account.hasExtraUsageEnabled ? "ENABLED" : "DISABLED",
      observedAt: input.account.profileFetchedAtIso,
      detail: `oauthAccount.hasExtraUsageEnabled=${input.account.hasExtraUsageEnabled} (organisation-level, fetched ${input.account.profileFetchedAtIso ?? "unknown"})`,
    });
  }
  const time = (entry: ExtraUsageObservation): number => (entry.observedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(entry.observedAt));
  const user = observations
    .filter((entry) => entry.scope === "USER")
    .sort((left, right) => (time(right) - time(left)) || (SOURCE_RANK[left.source] - SOURCE_RANK[right.source]));
  const profile = observations.find((entry) => entry.source === "CACHED_ACCOUNT_PROFILE") ?? null;

  let verdict: OverflowVerdict;
  let decidedBy: ExtraUsageSource | null = null;
  let stale = false;
  if (user.length > 0) {
    const decider = user[0]!;
    decidedBy = decider.source;
    for (const older of user.slice(1)) {
      if (older.state !== decider.state) warnings.push(`${older.source} (${older.state}, ${older.observedAt ?? "undated"}) is superseded by the newer ${decider.source} (${decider.state})`);
    }
    if (decider.state === "DISABLED") {
      verdict = "USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT";
      if (profile?.state === "ENABLED") {
        stale = true;
        warnings.push(
          `${STALE_CACHED_EXTRA_USAGE_STATE}: the cached profile reports hasExtraUsageEnabled=true, an organisation-scoped flag that can lag the user-level state; `
          + `the user-level ${decider.source} (${decider.observedAt ?? "undated"}) reports usage credits OFF and supersedes it`,
        );
      }
      if (decider.source === "CACHED_CLI_USAGE_SNAPSHOT" && decider.observedAt !== null
        && Date.parse(input.at) - Date.parse(decider.observedAt) > USAGE_SNAPSHOT_AGE_WARNING_HOURS * 3_600_000) {
        warnings.push(`the deciding usage snapshot is older than ${USAGE_SNAPSHOT_AGE_WARNING_HOURS}h (${decider.observedAt}); open the CLI's usage view or attest to refresh it`);
      }
    } else {
      verdict = "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT";
      issues.push(
        `${decider.source} reports usage credits / extra usage ENABLED (${decider.detail}): when the subscription limit is `
        + "reached the CLI can continue into paid usage, which the executor must never allow. Operator requirement: turn "
        + "usage credits off in the Claude account settings, then re-run the preflight. No flag overrides this.",
      );
    }
  } else if (profile !== null) {
    decidedBy = "CACHED_ACCOUNT_PROFILE";
    if (profile.state === "ENABLED") {
      verdict = "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT";
      issues.push(
        `the cached account profile (${input.account.path}, fetched ${input.account.profileFetchedAtIso ?? "unknown"}) reports `
        + "hasExtraUsageEnabled=true and no newer user-level observation supersedes it (no CLI usage snapshot for this "
        + "account, no attestation). Operator requirement: confirm usage credits are OFF in the Claude account and attest "
        + "with --attest-extra-usage-disabled \"<statement>\", or let the CLI refresh its usage view, then re-run the preflight.",
      );
    } else {
      verdict = "USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT";
    }
  } else {
    verdict = "USAGE_CREDIT_OVERFLOW_STATE_UNKNOWN";
    issues.push(
      `nothing on this host says whether usage credits are enabled (${input.account.path}); the operator must confirm they are `
      + "OFF in the Claude account and attest with --attest-extra-usage-disabled \"<statement>\"",
    );
  }
  return {
    verdict, decidedBy, observations: Object.freeze(observations), staleCachedState: stale, liveStateAvailable: false,
    issues: Object.freeze(issues), warnings: Object.freeze(warnings),
  };
}

// ── the verdicts ────────────────────────────────────────────────────

export type AuthModeVerdict = "SUBSCRIPTION_AUTH_MODE_PROVEN" | "SUBSCRIPTION_AUTH_MODE_NOT_PROVEN" | "SUBSCRIPTION_AUTH_MODE_UNRESOLVED";
export type OverflowVerdict = "USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT" | "USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT" | "USAGE_CREDIT_OVERFLOW_STATE_UNKNOWN";

export const REQUIRED_SUBSCRIPTION_TYPE = "max" as const;
export const REQUIRED_AUTH_METHOD = "claude.ai" as const;
export const REQUIRED_API_PROVIDER = "firstParty" as const;
/** The init-event value that means "no API key in use" (claude.ai OAuth login). */
export const SUBSCRIPTION_API_KEY_SOURCE = "none" as const;

export interface SubscriptionAuthReport {
  readonly version: typeof M220_AUTH_VERSION;
  readonly at: string;
  readonly environment: AuthEnvironmentInspection;
  readonly settings: readonly SettingsFileInspection[];
  readonly cliAuth: CliAuthStatus;
  readonly credentials: CredentialFileFacts;
  readonly account: AccountProfileFacts;
  readonly autoUpdate: AutoUpdatePosture;
  readonly authModeVerdict: AuthModeVerdict;
  readonly authModeStrength: "LOCAL_CLI_AUTH_STATE";
  readonly providerConfirmation: "PENDING_AT_FIRST_LIVE_RUN";
  readonly runtimeGate: string;
  readonly overflowVerdict: OverflowVerdict;
  readonly overflowAttestation: string | null;
  /** M220-A3 — which evidence decided the usage-credit state, and what it overrode. */
  readonly extraUsage: ExtraUsageResolution;
  /** Issues that are defects of the authentication MODE (technical gate). */
  readonly technicalIssues: readonly string[];
  /** Issues about the usage-credit state (an operator prerequisite). */
  readonly overflowIssues: readonly string[];
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
  readonly launchPermitted: boolean;
}

export interface SubscriptionAuthInputs {
  readonly environment: AuthEnvironmentInspection;
  readonly settings: readonly SettingsFileInspection[];
  readonly cliAuth: CliAuthStatus;
  readonly credentials: CredentialFileFacts;
  readonly account: AccountProfileFacts;
  readonly autoUpdate: AutoUpdatePosture;
  /**
   * M220-A3 — the operator's statement on this invocation. A string is a
   * DISABLED attestation made at `at`. It competes with the CLI's user-level
   * usage snapshot by recency and supersedes the organisation-level profile.
   */
  readonly overflowAttestation?: string | ExtraUsageAttestation | null;
  readonly at: string;
}

/** PURE — assemble the verdicts from the facts, so every branch can be falsified with injected facts. */
export function assessSubscriptionAuth(input: SubscriptionAuthInputs): SubscriptionAuthReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const present of input.environment.present) {
    issues.push(`${present.name} is present in the launcher environment (${present.classification}: ${present.why}); presence recorded, value not read; SUBSCRIPTION_AUTH_MODE_NOT_PROVEN`);
  }
  for (const file of input.settings) {
    if (!file.exists) continue;
    if (file.apiKeyHelperConfigured && file.reachesTheArm) issues.push(`${file.path} configures apiKeyHelper and reaches the arm; API-key authentication would override the subscription login`);
    else if (file.apiKeyHelperConfigured) warnings.push(`${file.path} configures apiKeyHelper; it does not reach the arm (${file.why})`);
    if (file.envOverrideNames.length > 0 && file.reachesTheArm) issues.push(`${file.path} sets provider overrides [${file.envOverrideNames.join(", ")}] and reaches the arm`);
    else if (file.envOverrideNames.length > 0) warnings.push(`${file.path} sets [${file.envOverrideNames.join(", ")}]; it does not reach the arm (${file.why})`);
    if (file.forceLoginMethod !== null && file.forceLoginMethod !== "claudeai") issues.push(`${file.path} forces login method ${file.forceLoginMethod}`);
  }

  let authMode: AuthModeVerdict;
  if (!input.cliAuth.available) {
    authMode = "SUBSCRIPTION_AUTH_MODE_UNRESOLVED";
    issues.push(`the CLI's auth status could not be read (${input.cliAuth.error ?? "unknown"}); subscription mode cannot be proven locally`);
  } else {
    const local: string[] = [];
    if (input.cliAuth.loggedIn !== true) local.push("the CLI reports not logged in");
    if (input.cliAuth.authMethod !== REQUIRED_AUTH_METHOD) local.push(`auth method is ${input.cliAuth.authMethod ?? "(absent)"}, not ${REQUIRED_AUTH_METHOD}`);
    if (input.cliAuth.apiProvider !== REQUIRED_API_PROVIDER) local.push(`API provider is ${input.cliAuth.apiProvider ?? "(absent)"}, not ${REQUIRED_API_PROVIDER}`);
    if (input.cliAuth.subscriptionType !== REQUIRED_SUBSCRIPTION_TYPE) local.push(`subscription type is ${input.cliAuth.subscriptionType ?? "(absent)"}, not ${REQUIRED_SUBSCRIPTION_TYPE}`);
    if (!input.credentials.hasClaudeAiOauth) local.push(`${input.credentials.path} carries no claude.ai OAuth credential; the arms copy this file and would have nothing to authenticate with`);
    else if (input.credentials.subscriptionType !== null && input.credentials.subscriptionType !== REQUIRED_SUBSCRIPTION_TYPE) local.push(`the credential file records subscription type ${input.credentials.subscriptionType}`);
    if (local.length > 0 || input.environment.present.length > 0 || issues.length > 0) {
      authMode = "SUBSCRIPTION_AUTH_MODE_NOT_PROVEN";
      issues.push(...local);
    } else {
      authMode = "SUBSCRIPTION_AUTH_MODE_PROVEN";
    }
  }
  if (input.credentials.refreshTokenExpiresAtIso !== null && Date.parse(input.credentials.refreshTokenExpiresAtIso) < Date.parse(input.at)) {
    issues.push(`the credential file's refresh token expired at ${input.credentials.refreshTokenExpiresAtIso}; re-login before a session`);
  }

  const technicalIssues = [...issues];
  const attestation = normaliseAttestation(input.overflowAttestation, input.at);
  const extraUsage = resolveExtraUsageState({ account: input.account, attestation, at: input.at });
  const overflow = extraUsage.verdict;
  issues.push(...extraUsage.issues);
  warnings.push(...extraUsage.warnings);
  if (input.autoUpdate.verdict !== "AUTO_UPDATE_DISABLED") {
    warnings.push("auto-update is not proven disabled; an update between complete pairs is a recorded transition, but one inside a pair pauses the cohort (PAIR_HARNESS_DRIFT)");
  }

  return {
    version: M220_AUTH_VERSION,
    at: input.at,
    environment: input.environment,
    settings: input.settings,
    cliAuth: input.cliAuth,
    credentials: input.credentials,
    account: input.account,
    autoUpdate: input.autoUpdate,
    authModeVerdict: authMode,
    authModeStrength: "LOCAL_CLI_AUTH_STATE",
    providerConfirmation: "PENDING_AT_FIRST_LIVE_RUN",
    runtimeGate: `R16_AUTH_SOURCE: the agent's init event must report apiKeySource '${SUBSCRIPTION_API_KEY_SOURCE}'; any other value aborts the attempt before it can become an outcome`,
    overflowVerdict: overflow,
    overflowAttestation: attestation === null ? null : `${attestation.state}: ${attestation.statement}`,
    extraUsage,
    technicalIssues: Object.freeze(technicalIssues),
    overflowIssues: extraUsage.issues,
    issues: Object.freeze(issues),
    warnings: Object.freeze(warnings),
    launchPermitted: issues.length === 0 && authMode === "SUBSCRIPTION_AUTH_MODE_PROVEN",
  };
}

/** The launcher's path: gather the real facts and assess. */
export function collectSubscriptionAuth(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly projectRoot?: string;
  readonly binary?: string;
  readonly overflowAttestation?: string | ExtraUsageAttestation | null;
  readonly now?: () => string;
} = {}): SubscriptionAuthReport {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const account = readAccountProfileFacts(join(home, ".claude.json"));
  return assessSubscriptionAuth({
    environment: inspectAuthEnvironment(env),
    settings: defaultSettingsPaths(home, options.projectRoot).map((entry) => inspectSettingsFile(entry)),
    cliAuth: readCliAuthStatus(options.binary ?? resolveAgentBinary().binary, env),
    credentials: readCredentialFacts(join(home, ".claude", ".credentials.json")),
    account,
    autoUpdate: autoUpdatePosture(account, env),
    overflowAttestation: options.overflowAttestation ?? null,
    at: (options.now ?? (() => new Date().toISOString()))(),
  });
}

/** §17, §19 — the runtime gate over the init event's credential source. Silence is not confirmation. */
export function auditAuthSource(apiKeySource: string | null | undefined): readonly string[] {
  if (apiKeySource === null || apiKeySource === undefined || apiKeySource.trim().length === 0) {
    return ["the agent's init event carried no apiKeySource; the credential path cannot be confirmed and silence is not confirmation"];
  }
  if (apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) {
    return [`the agent's init event reports apiKeySource '${apiKeySource}'; the subscription login reports '${SUBSCRIPTION_API_KEY_SOURCE}' (no API key in use)`];
  }
  return [];
}

// ── M221 — provider confirmation, projected from the live runs ──────

export type ProviderConfirmationState = "PENDING_AT_FIRST_LIVE_RUN" | "VERIFIED_AT_LIVE_RUN" | "NOT_VERIFIED_AT_LIVE_RUN";

/** The operational fields of a persisted result record this projection reads; nothing outcome-bearing. */
export interface LiveRunAuthEvidence {
  readonly attemptId: string;
  readonly mode: string;
  readonly modelTarget: string;
  readonly providerModelIdentity: string | null;
  readonly modelIdentityVerified: boolean;
  readonly lifecyclePhasesObserved: readonly string[];
  readonly runtimeGates: readonly { readonly gateId: string; readonly status: string }[];
}

export interface ProviderConfirmation {
  readonly state: ProviderConfirmationState;
  readonly liveAttempts: number;
  readonly confirmedAttempts: number;
  readonly unconfirmedAttemptIds: readonly string[];
  readonly issues: readonly string[];
}

/**
 * PURE — the pre-launch audit can only say PENDING_AT_FIRST_LIVE_RUN; after a
 * COHORT attempt reaches the agent, the answer is in its persisted runtime
 * gates. An attempt confirms only when R12 and R16 both PASSED on its own init
 * event and the provider identity equals the frozen target. Fail closed: one
 * attempt that reached the agent without that evidence makes the projection
 * NOT_VERIFIED; synthetic records never count (their R16 passes vacuously).
 */
export function deriveProviderConfirmation(records: readonly LiveRunAuthEvidence[], frozenModel: string): ProviderConfirmation {
  const live = records.filter((record) => record.mode === "COHORT" && record.lifecyclePhasesObserved.includes("AGENT_RUN"));
  const issues: string[] = [];
  const unconfirmed: string[] = [];
  for (const record of live) {
    const gate = (gateId: string): string => record.runtimeGates.find((entry) => entry.gateId === gateId)?.status ?? "ABSENT";
    const problems: string[] = [];
    if (gate("R12_PROVIDER_MODEL_IDENTITY") !== "PASS") problems.push(`R12_PROVIDER_MODEL_IDENTITY ${gate("R12_PROVIDER_MODEL_IDENTITY")}`);
    if (gate("R16_AUTH_SOURCE") !== "PASS") problems.push(`R16_AUTH_SOURCE ${gate("R16_AUTH_SOURCE")}`);
    if (record.modelTarget !== frozenModel) problems.push(`model target ${record.modelTarget} is not the frozen ${frozenModel}`);
    if (record.providerModelIdentity !== frozenModel) problems.push(`provider served ${record.providerModelIdentity ?? "(no identity)"}, not the frozen ${frozenModel}`);
    if (!record.modelIdentityVerified) problems.push("modelIdentityVerified is false");
    if (problems.length > 0) {
      unconfirmed.push(record.attemptId);
      issues.push(`${record.attemptId}: ${problems.join("; ")}`);
    }
  }
  const state: ProviderConfirmationState = live.length === 0
    ? "PENDING_AT_FIRST_LIVE_RUN"
    : unconfirmed.length === 0 ? "VERIFIED_AT_LIVE_RUN" : "NOT_VERIFIED_AT_LIVE_RUN";
  return {
    state, liveAttempts: live.length, confirmedAttempts: live.length - unconfirmed.length,
    unconfirmedAttemptIds: Object.freeze(unconfirmed), issues: Object.freeze(issues),
  };
}

/** A redacted view for logs and journals: verdicts and names, never values or identities. */
export function redactedAuthSummary(report: SubscriptionAuthReport): Record<string, unknown> {
  return {
    authModeVerdict: report.authModeVerdict,
    authModeStrength: report.authModeStrength,
    providerConfirmation: report.providerConfirmation,
    overflowVerdict: report.overflowVerdict,
    launchPermitted: report.launchPermitted,
    ANTHROPIC_API_KEY_PRESENT: report.environment.apiKeyPresent,
    overridesPresent: report.environment.present.map((entry) => entry.name),
    cliAuth: { loggedIn: report.cliAuth.loggedIn, authMethod: report.cliAuth.authMethod, apiProvider: report.cliAuth.apiProvider, subscriptionType: report.cliAuth.subscriptionType },
    credentialSubscriptionType: report.credentials.subscriptionType,
    accountOrganizationType: report.account.organizationType,
    hasExtraUsageEnabled: report.account.hasExtraUsageEnabled,
    hasExtraUsageEnabledScope: "ORGANIZATION",
    usageSnapshotExtraUsageEnabled: report.account.usageSnapshot?.extraUsageEnabled ?? null,
    usageSnapshotFetchedAt: report.account.usageSnapshot?.fetchedAtIso ?? null,
    overflowDecidedBy: report.extraUsage.decidedBy,
    staleCachedExtraUsageState: report.extraUsage.staleCachedState,
    operatorAttestation: report.overflowAttestation !== null,
    autoUpdate: report.autoUpdate.verdict,
    issueCount: report.issues.length,
    warningCount: report.warnings.length,
  };
}

// ── §10 — machine-readable quota availability ───────────────────────

export const M220_QUOTA_AVAILABILITY = Object.freeze({
  preLaunchZeroCall: "MACHINE_READABLE_QUOTA_UNAVAILABLE",
  preLaunchEvidence:
    "`claude auth status --json` (the only zero-call auth surface the CLI exposes) returns login, method, provider "
    + "and subscription fields and no utilisation or reset fields; the CLI has no `usage` subcommand for headless "
    + "use; the interactive /usage view is UI state and is not scraped",
  inRun: "IN_RUN_STRUCTURED_RATE_LIMIT_EVENTS_AVAILABLE",
  inRunEvidence:
    "the pinned CLI's stream-json schema emits {type: rate_limit_event, rate_limit_info: {status allowed | "
    + "allowed_warning | rejected, rateLimitType five_hour | seven_day*, resetsAt, utilization, isUsingOverage, "
    + "overageStatus}} when rate-limit info changes; absent for API-key, Bedrock and Vertex sessions",
  policy:
    "manual bounded pair sessions are authoritative: the operator checks Claude Settings > Usage, chooses a "
    + "conservative --max-pairs-this-session, and the launcher enforces it. In-run events may only request a pause "
    + "after the current pair (warning) or classify an interruption (rejected / overage); they never select rows",
});

/** §55 — the authorisation sentence the launch will eventually require, for the report; M220 neither asks for nor infers it. */
export const M220_REQUIRED_AUTHORIZATION_TEXT =
  "I authorize execution of the frozen M214+A1+A2 Baseline vs VTRACE cohort using my Claude MAX subscription, in "
  + "outcome-blind quota-window sessions, with no intentional usage-credit/API fallback, and with a hard maximum of "
  + "$735 additional billed spend if the frozen safeguards permit it.";
