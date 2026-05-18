import { listProjectRules } from "../../db/repositories/projectRulesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import {
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

const RULE_ACTIONS = new Set(["list", "generate", "promote", "dismiss", "disable"]);

export async function runRulesCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseRulesArgs(args);

  if (parsed === undefined) {
    return failure("Usage: rules <list|generate|promote|dismiss|disable> <repo> [rule-id]");
  }

  const resolvedOptions = resolveOptions(options);

  try {
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
  action: "list" | "generate" | "promote" | "dismiss" | "disable";
  repoPath: string;
  ruleId?: string;
} | undefined {
  if (args.length < 2) {
    return undefined;
  }

  const [first, second, third] = args;

  if (first !== undefined && RULE_ACTIONS.has(first)) {
    return {
      action: first as "list" | "generate" | "promote" | "dismiss" | "disable",
      repoPath: second!,
      ...(third === undefined ? {} : { ruleId: third }),
    };
  }

  if (second !== undefined && RULE_ACTIONS.has(second)) {
    return {
      action: second as "list" | "generate" | "promote" | "dismiss" | "disable",
      repoPath: first!,
      ...(third === undefined ? {} : { ruleId: third }),
    };
  }

  return undefined;
}

function requireRuleId(input: { ruleId?: string }): string {
  if (input.ruleId === undefined || input.ruleId.trim().length === 0) {
    throw new Error("rule id is required for this action");
  }

  return input.ruleId;
}
