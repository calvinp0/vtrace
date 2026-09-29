import { describe, expect, test } from "bun:test";

import {
  type AccountProfileFacts,
  type CliAuthStatus,
  type CredentialFileFacts,
  M220_QUOTA_AVAILABILITY,
  assessSubscriptionAuth,
  auditAuthSource,
  autoUpdatePosture,
  collectSubscriptionAuth,
  inspectAuthEnvironment,
  inspectSettingsFile,
  parseCliAuthStatus,
  readAccountProfileFacts,
  readCredentialFacts,
  redactedAuthSummary,
} from "./m220SubscriptionAuth";

const cliOk: CliAuthStatus = { command: "claude auth status --json", available: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", fieldNames: ["authMethod", "loggedIn"], error: null };
const credsOk: CredentialFileFacts = { path: "/x/.credentials.json", exists: true, hasClaudeAiOauth: true, subscriptionType: "max", rateLimitTier: "default_claude_max_5x", accessTokenExpiresAtIso: "2030-01-01T00:00:00.000Z", refreshTokenExpiresAtIso: "2030-01-01T00:00:00.000Z", secretsRead: false };
const accountOff: AccountProfileFacts = { path: "/x/.claude.json", exists: true, hasExtraUsageEnabled: false, organizationType: "claude_max", billingType: "stripe_subscription", profileFetchedAtIso: "2026-09-05T00:00:00.000Z", autoUpdates: false, installMethod: "native" };
const cleanEnv = { PATH: "/usr/bin", HOME: "/home/x" };

function assess(overrides: Partial<Parameters<typeof assessSubscriptionAuth>[0]> = {}) {
  return assessSubscriptionAuth({
    environment: inspectAuthEnvironment(cleanEnv),
    settings: [],
    cliAuth: cliOk,
    credentials: credsOk,
    account: accountOff,
    autoUpdate: autoUpdatePosture(accountOff, cleanEnv),
    at: "2026-09-05T12:00:00.000Z",
    ...overrides,
  });
}

describe("environment inspection (F1, F2, F3)", () => {
  test("a clean environment has no override and the child policy is recorded", () => {
    const inspection = inspectAuthEnvironment(cleanEnv);
    expect(inspection.verdict).toBe("NO_PROVIDER_OVERRIDE_PRESENT");
    expect(inspection.apiKeyPresent).toBe(false);
    expect(inspection.childEnvironmentPolicy).toMatch(/drops every ANTHROPIC_\* and CLAUDE_\* key/);
  });

  test("ANTHROPIC_API_KEY is detected by presence and its value is never recorded", () => {
    const inspection = inspectAuthEnvironment({ ...cleanEnv, ANTHROPIC_API_KEY: "FAKE-VALUE-NOT-A-REAL-KEY-0123456789" });
    expect(inspection.verdict).toBe("PROVIDER_OVERRIDE_PRESENT");
    expect(inspection.apiKeyPresent).toBe(true);
    expect(inspection.present[0]!.classification).toBe("API_KEY_BILLING");
    expect(JSON.stringify(inspection)).not.toContain("FAKE-VALUE-NOT-A-REAL-KEY-0123456789");
    const report = assess({ environment: inspection });
    expect(report.authModeVerdict).toBe("SUBSCRIPTION_AUTH_MODE_NOT_PROVEN");
    expect(report.launchPermitted).toBe(false);
    expect(JSON.stringify(report)).not.toContain("FAKE-VALUE-NOT-A-REAL-KEY-0123456789");
    expect(JSON.stringify(redactedAuthSummary(report))).toContain("\"ANTHROPIC_API_KEY_PRESENT\":true");
  });

  test("bearer tokens, cloud routes, alternate identities, model overrides and unknown ANTHROPIC_ names all refuse", () => {
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_SOMETHING_NEW"]) {
      const report = assess({ environment: inspectAuthEnvironment({ ...cleanEnv, [name]: "x" }) });
      expect(report.launchPermitted).toBe(false);
      expect(report.issues.some((issue) => issue.includes(name))).toBe(true);
    }
    // An empty value is absence, not presence.
    expect(inspectAuthEnvironment({ ...cleanEnv, ANTHROPIC_API_KEY: "" }).verdict).toBe("NO_PROVIDER_OVERRIDE_PRESENT");
  });
});

describe("CLI auth status and files (F4)", () => {
  test("the subscription login is proven only by claude.ai / firstParty / max, logged in, with an OAuth credential", () => {
    expect(assess().authModeVerdict).toBe("SUBSCRIPTION_AUTH_MODE_PROVEN");
    expect(assess().launchPermitted).toBe(true);
    expect(assess().authModeStrength).toBe("LOCAL_CLI_AUTH_STATE");
    expect(assess().providerConfirmation).toBe("PENDING_AT_FIRST_LIVE_RUN");
    expect(assess({ cliAuth: { ...cliOk, authMethod: "console" } }).authModeVerdict).toBe("SUBSCRIPTION_AUTH_MODE_NOT_PROVEN");
    expect(assess({ cliAuth: { ...cliOk, apiProvider: "bedrock" } }).launchPermitted).toBe(false);
    expect(assess({ cliAuth: { ...cliOk, subscriptionType: "pro" } }).launchPermitted).toBe(false);
    expect(assess({ cliAuth: { ...cliOk, loggedIn: false } }).launchPermitted).toBe(false);
    expect(assess({ credentials: { ...credsOk, hasClaudeAiOauth: false } }).launchPermitted).toBe(false);
    expect(assess({ cliAuth: { ...cliOk, available: false, error: "spawn failed" } }).authModeVerdict).toBe("SUBSCRIPTION_AUTH_MODE_UNRESOLVED");
  });

  test("an expired refresh token and a managed apiKeyHelper refuse; a host-only apiKeyHelper warns", () => {
    expect(assess({ credentials: { ...credsOk, refreshTokenExpiresAtIso: "2020-01-01T00:00:00.000Z" } }).launchPermitted).toBe(false);
    const managed = inspectSettingsFile({ path: "/etc/claude-code/managed-settings.json", reachesTheArm: true, why: "policy" }, () => JSON.stringify({ apiKeyHelper: "/bin/key.sh" }));
    expect(managed.apiKeyHelperConfigured).toBe(true);
    expect(assess({ settings: [managed] }).launchPermitted).toBe(false);
    const host = inspectSettingsFile({ path: "/home/x/.claude/settings.json", reachesTheArm: false, why: "not copied" }, () => JSON.stringify({ apiKeyHelper: "/bin/key.sh", env: { ANTHROPIC_API_KEY: "x" } }));
    const report = assess({ settings: [host] });
    expect(report.launchPermitted).toBe(true);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(host)).not.toContain("\"x\"");
  });

  test("the auth status parser keeps field names and drops identity values", () => {
    const parsed = parseCliAuthStatus("cmd", JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "someone@example.com", orgId: "org-secret" }));
    expect(parsed.available).toBe(true);
    expect(parsed.fieldNames).toContain("email");
    expect(JSON.stringify(parsed)).not.toContain("someone@example.com");
    expect(JSON.stringify(parsed)).not.toContain("org-secret");
    expect(parseCliAuthStatus("cmd", "not json").available).toBe(false);
  });
});

describe("usage-credit overflow (F5)", () => {
  // M220-A3 superseded "no attestation overrides an ENABLED profile": the
  // profile flag is organisation-scoped and can lag, so a newer user-level
  // OFF supersedes it (with a warning) while a user-level ON never can be.
  test("a cached true with no newer authority refuses launch with an operator requirement", () => {
    const enabled = assess({ account: { ...accountOff, hasExtraUsageEnabled: true } });
    expect(enabled.overflowVerdict).toBe("USAGE_CREDIT_OVERFLOW_ENABLED_AT_ACCOUNT");
    expect(enabled.launchPermitted).toBe(false);
    expect(enabled.overflowIssues).toHaveLength(1);
    expect(enabled.technicalIssues).toEqual([]);
  });

  test("a newer OFF attestation supersedes a cached true with STALE_CACHED_EXTRA_USAGE_STATE (A3)", () => {
    const attested = assess({ account: { ...accountOff, hasExtraUsageEnabled: true }, overflowAttestation: "operator" });
    expect(attested.launchPermitted).toBe(true);
    expect(attested.extraUsage.decidedBy).toBe("OPERATOR_ATTESTATION");
    expect(attested.warnings.some((warning) => warning.startsWith("STALE_CACHED_EXTRA_USAGE_STATE"))).toBe(true);
  });

  test("usage credits ON in user-level evidence are never attested past", () => {
    const on = assess({ overflowAttestation: { state: "ENABLED", statement: "credits on", attestedAt: "2026-09-05T12:00:00.000Z" } });
    expect(on.launchPermitted).toBe(false);
    expect(on.issues.some((issue) => issue.includes("No flag overrides this"))).toBe(true);
  });

  test("unknown overflow state needs an operator attestation; disabled passes", () => {
    const unknown = assess({ account: { ...accountOff, hasExtraUsageEnabled: null } });
    expect(unknown.overflowVerdict).toBe("USAGE_CREDIT_OVERFLOW_STATE_UNKNOWN");
    expect(unknown.launchPermitted).toBe(false);
    const attested = assess({ account: { ...accountOff, hasExtraUsageEnabled: null }, overflowAttestation: "operator" });
    expect(attested.launchPermitted).toBe(true);
    expect(attested.extraUsage.decidedBy).toBe("OPERATOR_ATTESTATION");
    expect(assess().overflowVerdict).toBe("USAGE_CREDIT_OVERFLOW_DISABLED_AT_ACCOUNT");
  });
});

describe("runtime credential source (F4, R16)", () => {
  test("only apiKeySource 'none' passes; silence and any key source fail", () => {
    expect(auditAuthSource("none")).toEqual([]);
    expect(auditAuthSource(null)).toHaveLength(1);
    expect(auditAuthSource(undefined)).toHaveLength(1);
    expect(auditAuthSource("")).toHaveLength(1);
    for (const source of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) expect(auditAuthSource(source)[0]).toContain(source);
  });
});

describe("auto-update posture (F21)", () => {
  test("autoUpdates=false or DISABLE_AUTOUPDATER proves disabled; otherwise a warning, never a launch refusal", () => {
    expect(autoUpdatePosture(accountOff, cleanEnv).verdict).toBe("AUTO_UPDATE_DISABLED");
    expect(autoUpdatePosture({ ...accountOff, autoUpdates: null }, { ...cleanEnv, DISABLE_AUTOUPDATER: "1" }).verdict).toBe("AUTO_UPDATE_DISABLED");
    const on = autoUpdatePosture({ ...accountOff, autoUpdates: true }, cleanEnv);
    expect(on.verdict).toBe("AUTO_UPDATE_NOT_PROVEN_DISABLED");
    const report = assess({ autoUpdate: on });
    expect(report.launchPermitted).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("auto-update"))).toBe(true);
  });
});

describe("real host facts (names only)", () => {
  test("the host credential and profile readers never expose a secret and the real collect runs", () => {
    const creds = readCredentialFacts();
    const account = readAccountProfileFacts();
    const text = JSON.stringify({ creds, account });
    expect(text).not.toMatch(/sk-ant-|"accessToken":|"refreshToken":/);
    expect(creds.secretsRead).toBe(false);
    if (creds.exists) expect(creds.hasClaudeAiOauth).toBe(true);
    const report = collectSubscriptionAuth({ env: cleanEnv, now: () => new Date().toISOString() });
    expect(["SUBSCRIPTION_AUTH_MODE_PROVEN", "SUBSCRIPTION_AUTH_MODE_NOT_PROVEN", "SUBSCRIPTION_AUTH_MODE_UNRESOLVED"]).toContain(report.authModeVerdict);
    expect(JSON.stringify(report)).not.toMatch(/sk-ant-|"accessToken"|"refreshToken"/);
    expect(M220_QUOTA_AVAILABILITY.preLaunchZeroCall).toBe("MACHINE_READABLE_QUOTA_UNAVAILABLE");
  });
});
