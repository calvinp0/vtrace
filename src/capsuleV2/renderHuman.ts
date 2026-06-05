// Human rendering for capsule v2.
//
// Turns the assembled capsule into the product's text output: an intent + budget
// header, then the pivots (focused source, highest priority) and support
// (signatures/skeletons). Reuses `itemBlockText` so the printed capsule is the
// exact text the budget accounting counted. Deterministic — no locale-dependent
// formatting.

import { itemBlockText } from "./renderItem";
import {
  CapsuleV2Mode,
  type CapsuleV2Result,
} from "./types";

export function renderCapsuleV2Human(result: CapsuleV2Result): string {
  const lines: string[] = [];
  lines.push(`intent: ${result.intent}`);
  lines.push(
    `budget: ${formatThousands(result.budget.estimated_tokens)} / `
    + `${formatThousands(result.budget.max_tokens)} tokens used`,
  );

  if (result.actual_mode === CapsuleV2Mode.NoContext) {
    lines.push("");
    lines.push(`actual_mode: ${CapsuleV2Mode.NoContext}`);
    lines.push(`reason: ${result.reason ?? "no high-confidence edit target recovered"}`);
    return lines.join("\n");
  }

  for (const pivot of result.pivots) {
    lines.push("");
    lines.push(itemBlockText(pivot));
  }
  for (const item of result.support) {
    lines.push("");
    lines.push(itemBlockText(item));
  }

  return lines.join("\n");
}

// Group an integer's digits with commas, deterministically (no toLocaleString,
// whose grouping is locale-dependent). 8000 -> "8,000".
export function formatThousands(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ",";
    }
    grouped += digits[index];
  }
  return negative ? `-${grouped}` : grouped;
}
