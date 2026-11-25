import type { BriefState, NotetakerState, RunAction } from "../lib/types";

/** What the backend would allow in each state (for tests that do not care which buttons). */
export function defaultCan(status: NotetakerState["status"]): RunAction[] {
  switch (status) {
    case "running":
      return [];
    case "waiting":
    case "on":
      return ["update", "pause"];
    case "paused":
      return ["resume", "update"];
    case "capped":
      return ["keep_going"];
    case "error":
      return ["try_again"];
    default:
      return ["start"];
  }
}

/** A complete run state, as the backend sends it, for tests that need a particular one. */
export function ns(status: NotetakerState["status"], can: RunAction[] = defaultCan(status), over: Partial<NotetakerState> = {}): NotetakerState {
  return { meeting_id: "m1", status, tokens_used: 0, cap: 120000, next_in_ms: null, total_tokens: 0, reason: null, error_kind: null, can, model: null, not_covered: null, ...over };
}
export const bs = (status: BriefState["status"], can: RunAction[] = defaultCan(status), over: Partial<BriefState> = {}): BriefState => ({ ...ns(status, can), ...over }) as BriefState;
