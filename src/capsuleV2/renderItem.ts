// Per-item rendering for capsule v2.
//
// One function builds the human text block for a selected item, and it is the
// SINGLE SOURCE OF TRUTH for both the rendered capsule and its token accounting:
// the budget allocator counts an item by the very text the agent will read, so
// the reported `estimated_tokens` can never drift from what is actually emitted.

import {
  CapsuleV2ContentMode,
  type CapsuleV2Item,
} from "./types";

/** A pivot is marked with a filled bullet, support with a hollow one. */
export function roleBullet(role: "pivot" | "support"): string {
  return role === "pivot" ? "●" : "○";
}

/** The human-readable text block for one selected item. */
export function itemBlockText(item: CapsuleV2Item): string {
  const lines: string[] = [];
  lines.push(`${roleBullet(item.role)} ${item.role} ${item.path}::${item.symbol}`);

  // Pivots carry their "why" so the agent can judge the edit target; support is
  // kept terse (signature/skeleton only) — that is what makes it support.
  if (item.role === "pivot" && item.evidence.length > 0) {
    lines.push("  reason:");
    for (const reason of item.evidence) {
      lines.push(`  - ${reason}`);
    }
  }

  switch (item.content_mode) {
    case CapsuleV2ContentMode.Full:
      lines.push("");
      lines.push("  source:");
      lines.push(indent(item.source ?? "", "  "));
      break;
    case CapsuleV2ContentMode.Signature:
      lines.push("");
      lines.push("  signature:");
      lines.push(`  ${item.signature ?? item.symbol}`);
      break;
    case CapsuleV2ContentMode.Skeleton:
      lines.push("  skeleton only");
      break;
    case CapsuleV2ContentMode.DocumentExcerpt:
      lines.push("");
      lines.push(`  ${item.document_kind ?? "document"} excerpt:`);
      lines.push(indent(item.source ?? "", "  "));
      break;
  }

  return lines.join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}
