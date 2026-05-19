import { listProjectRules } from "../../db/repositories/projectRulesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import {
  createActiveProjectRule,
  disableProjectRule,
  dismissProjectRule,
  formatProjectRuleForOutput,
  generateProjectRuleCandidates,
  promoteProjectRule,
} from "../../projectRules/projectRules";
import { formatJson } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  ensureDatabaseDirectory,
  failure,
  resolveOptions,
  resolveRepoCommandPaths,
  success,
} from "./helpers";

const RULE_ACTIONS = new Set(["list", "generate", "add-active", "promote", "dismiss", "disable"]);

export async function runRulesCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const resolvedOptions = resolveOptions(options);

  try {
    const parsed = parseRulesArgs(args);

    if (parsed === undefined) {
      return failure("Usage: rules <list|generate|add-active|promote|dismiss|disable> <repo> [rule-id|options]");
    }

    const resolvedRepo = await resolveRepoCommandPaths(resolvedOptions, parsed.repoPath);
    await ensureDatabaseDirectory(resolvedRepo.dbPath);
    const db = openIndexerDatabase(resolvedRepo.dbPath);

    try {
      switch (parsed.action) {
        case "list":
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            rules: listProjectRules(db, { repoRoot: resolvedRepo.repoRoot })
              .map(formatProjectRuleForOutput),
          }));
        case "generate": {
          const result = generateProjectRuleCandidates(db, {
            repoRoot: resolvedRepo.repoRoot,
          });
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            created: result.created.map(formatProjectRuleForOutput),
            updated: result.updated.map(formatProjectRuleForOutput),
            skippedBelowThreshold: result.skippedBelowThreshold,
          }));
        }
        case "add-active":
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            rule: formatProjectRuleForOutput(createActiveProjectRule(db, {
              repoRoot: resolvedRepo.repoRoot,
              summary: requireOption(parsed.options, "summary"),
              files: parsed.options.file,
              symbolFqns: parsed.options.symbol,
              terms: parsed.options.term,
              toolNames: parsed.options.tool,
              intents: parsed.options.intent,
            })),
          }));
        case "promote":
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            rule: formatProjectRuleForOutput(promoteProjectRule(db, requireRuleId(parsed))),
          }));
        case "dismiss":
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            rule: formatProjectRuleForOutput(dismissProjectRule(db, requireRuleId(parsed))),
          }));
        case "disable":
          return success(formatJson({
            repoRoot: resolvedRepo.repoRoot,
            rule: formatProjectRuleForOutput(disableProjectRule(db, requireRuleId(parsed))),
          }));
      }
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(`rules failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRulesArgs(args: readonly string[]): {
  action: "list" | "generate" | "add-active" | "promote" | "dismiss" | "disable";
  repoPath: string;
  ruleId?: string;
  options: Record<string, string[]>;
} | undefined {
  if (args.length < 2) {
    return undefined;
  }

  const [first, second, third] = args;

  if (first !== undefined && RULE_ACTIONS.has(first)) {
    return {
      action: first as "list" | "generate" | "add-active" | "promote" | "dismiss" | "disable",
      repoPath: second!,
      ...(third === undefined || third.startsWith("--") ? {} : { ruleId: third }),
      options: parseOptionArgs(args.slice(2)),
    };
  }

  if (second !== undefined && RULE_ACTIONS.has(second)) {
    return {
      action: second as "list" | "generate" | "add-active" | "promote" | "dismiss" | "disable",
      repoPath: first!,
      ...(third === undefined || third.startsWith("--") ? {} : { ruleId: third }),
      options: parseOptionArgs(args.slice(2)),
    };
  }

  return undefined;
}

function parseOptionArgs(args: readonly string[]): Record<string, string[]> {
  const options: Record<string, string[]> = {};

  for (let index = 0; index < args.length; index++) {
    const current = args[index];

    if (current === undefined || !current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const value = args[index + 1];

    if (key.length === 0 || value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }

    options[key] = [...(options[key] ?? []), value];
    index++;
  }

  return options;
}

function requireOption(options: Record<string, string[]>, key: string): string {
  const value = options[key]?.[0]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`--${key} is required`);
  }

  return value;
}

function requireRuleId(input: { ruleId?: string }): string {
  if (input.ruleId === undefined || input.ruleId.trim().length === 0) {
    throw new Error("rule id is required for this action");
  }

  return input.ruleId;
}
