import type { AIScenario } from "../lib/types";

/**
 * Which scenario a meeting starts with (spec section 12): what the person
 * picked for this meeting beats the workspace's own, which beats "Start as"
 * and the remembered setup. Never applied to a meeting that is already running.
 */
export function pickScenario(order: {
  explicit?: AIScenario | null;
  workspaceDefault?: AIScenario | null;
  remembered?: AIScenario | null;
  startAs?: AIScenario | null;
}): AIScenario {
  return order.explicit ?? order.workspaceDefault ?? order.remembered ?? order.startAs ?? "team_meeting";
}
