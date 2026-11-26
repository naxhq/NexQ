import type { ContextDepth, DepthBudgets } from "../../lib/types";
import { formatTokens } from "../../voiceprint";

export const DEPTHS: Array<{ value: ContextDepth; label: string }> = [
  { value: "lean", label: "Lean" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
];

/**
 * What a depth means, in the budget the chat's model really gets (`ContextReport.depth_budgets`:
 * it differs by model and window). Until the backend has said, the words carry no number.
 */
export function depthText(depth: ContextDepth, budgets?: DepthBudgets | null): string {
  const n = budgets ? formatTokens(budgets[depth]) : null;
  switch (depth) {
    case "lean":
      return `Quick and cheap. Looks at ${n ? `up to ${n} tokens` : "a small amount"} of your material.`;
    case "balanced":
      return `For most questions. ${n ? `Up to ${n} tokens, and it` : "It"} stops when nothing more is relevant.`;
    default:
      return `Searches widely${n ? `, up to ${n} tokens` : ""}. Slower, and it costs more.`;
  }
}
