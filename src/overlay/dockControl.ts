import {
  type DockAction,
  type Layout,
  type PanelId,
  findStackOf,
} from "./dock";

/** A panel the user can see right now: docked, the front tab of its stack, stack not a strip. */
export function isShowing(layout: Layout, panel: PanelId): boolean {
  if (layout.hidden.includes(panel)) return false;
  const stack = findStackOf(layout.root, panel);
  return !!stack && stack.active === panel && !stack.collapsed;
}

/** The header buttons and keys: bring the panel into view, or put it away when it is in view. */
export function toggleAction(layout: Layout, panel: PanelId): DockAction {
  return isShowing(layout, panel) ? { type: "hide", panel } : { type: "reveal", panel };
}

/* ---- today's three layouts ("split", "ai", "transcript") as strip collapse ---- */

export type FocusMode = "split" | "ai" | "transcript";

/** Only a stack inside a split can collapse to a strip. */
function strip(layout: Layout, panel: PanelId) {
  const s = findStackOf(layout.root, panel);
  return s && layout.root !== s ? s : undefined;
}

export function focusMode(layout: Layout, left: PanelId = "transcript", right: PanelId = "assistant"): FocusMode {
  const l = strip(layout, left);
  const r = strip(layout, right);
  if (l?.collapsed && !r?.collapsed) return "ai";
  if (r?.collapsed && !l?.collapsed) return "transcript";
  return "split";
}

function actionsFor(layout: Layout, mode: FocusMode, left: PanelId, right: PanelId): DockAction[] {
  const l = strip(layout, left);
  const r = strip(layout, right);
  const out: DockAction[] = [];
  if (l && r && l.id === r.id) return out;
  if (l && l.collapsed !== (mode === "ai")) out.push({ type: "collapse", stackId: l.id, collapsed: mode === "ai" });
  if (r && r.collapsed !== (mode === "transcript")) {
    out.push({ type: "collapse", stackId: r.id, collapsed: mode === "transcript" });
  }
  return out;
}

const ORDER: FocusMode[] = ["split", "ai", "transcript"];

/** The old cycle button: split -> focus AI -> focus transcript -> split. Steps that make no change are skipped. */
export function nextFocus(
  layout: Layout,
  left: PanelId = "transcript",
  right: PanelId = "assistant",
): { mode: FocusMode; actions: DockAction[] } {
  const at = ORDER.indexOf(focusMode(layout, left, right));
  for (let i = 1; i <= ORDER.length; i++) {
    const mode = ORDER[(at + i) % ORDER.length];
    const actions = actionsFor(layout, mode, left, right);
    if (actions.length) return { mode, actions };
  }
  return { mode: "split", actions: [] };
}

export const FOCUS_TOOLTIP: Record<FocusMode, string> = {
  split: "Focus AI panel",
  ai: "Focus Transcript",
  transcript: "Split view",
};
