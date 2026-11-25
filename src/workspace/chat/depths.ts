import type { ContextDepth } from "../../lib/types";

export const DEPTHS: Array<{ value: ContextDepth; label: string; text: string }> = [
  { value: "lean", label: "Lean", text: "Quick and cheap. Looks at about 8k tokens of your material." },
  { value: "balanced", label: "Balanced", text: "For most questions. Up to 24k tokens, and it stops when nothing more is relevant." },
  { value: "deep", label: "Deep", text: "Searches widely, up to 80k tokens. Slower, and it costs more." },
];
