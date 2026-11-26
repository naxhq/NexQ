import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("./chat/ChatPane", () => ({ ChatPane: () => <div data-testid="chat" /> }));

import { HEADER_ICONS_BELOW, HEADER_NAME_ONLY_BELOW, MiddlePane } from "./MiddlePane";
import { SHORT_PANE } from "./layout";
import { WorkspaceActionsProvider } from "./WorkspaceActions";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import { mockBackend, seedWorkspaces, ws } from "./testUtils";

const LONG = "A very long workspace name for the annual renewal of the Acme master services agreement";

function mountAt(width: number, height: number, name = LONG) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isPane = this.hasAttribute("data-header");
    return { width: isPane ? width : 100, height: isPane ? height : 20, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  return render(
    <WorkspaceActionsProvider>
      <MiddlePane
        workspace={ws({ id: "acme", name, is_default: false, description: "The rollout" })}
        starting={false}
        onStart={() => {}}
        onOpenMeeting={() => {}}
        showLibraryToggle
        onToggleLibrary={() => {}}
        onShowLibrary={() => {}}
        onGoAll={() => {}}
        switcherOpen={false}
        onSwitcherOpenChange={() => {}}
      />
    </WorkspaceActionsProvider>,
  );
}

beforeEach(() => {
  mockBackend({ list_workspace_meetings: { meetings: [], total: 0 } });
  seedWorkspaces([ws(), ws({ id: "acme", name: LONG, is_default: false })], "acme");
  useWorkspaceChatStore.setState({ activeChat: {}, sessions: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the workspace header at the width of its own column", () => {
  it("shows words for Edit workspace and Library in a roomy column", () => {
    mountAt(HEADER_ICONS_BELOW + 100, 800);
    expect(screen.getByRole("button", { name: "Edit workspace" })).toHaveTextContent("Edit workspace");
    expect(screen.getByRole("button", { name: "Library" })).toHaveTextContent("Library");
  });

  it("collapses them to icon buttons with the same accessible names in a narrow column", () => {
    const { container } = mountAt(HEADER_ICONS_BELOW - 1, 800);
    const edit = screen.getByRole("button", { name: "Edit workspace" });
    expect(edit.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Library" }).textContent).toBe("");
    expect(container.querySelector("[data-narrow]")).not.toBeNull();
  });

  it("keeps Start meeting whole at every column width from 320 to 900", () => {
    for (const w of [320, 400, 520, 700, 900]) {
      cleanup();
      vi.restoreAllMocks();
      mountAt(w, 800);
      const start = screen.getByRole("button", { name: "Start meeting" });
      expect(start).toHaveTextContent("Start meeting");
      expect(start.className).toMatch(/whitespace-nowrap/);
    }
  });

  it("lets the name shrink with an ellipsis and says it in full on a tooltip target and as the accessible name", () => {
    mountAt(520, 800);
    const crumb = screen.getByRole("button", { name: new RegExp(`^${LONG}, switch workspace`) });
    expect(crumb.className).toMatch(/\bshrink\b/);
    expect(crumb.className).toMatch(/min-w-0/);
    const text = crumb.querySelector("span[dir=auto]");
    expect(text).toHaveTextContent(LONG);
    expect(text?.className).toMatch(/truncate/);
  });

  it("drops the Workspaces crumb, not the name, in a very narrow column", () => {
    mountAt(HEADER_NAME_ONLY_BELOW - 1, 800);
    expect(screen.queryByRole("button", { name: "Workspaces" })).toBeNull();
    expect(screen.getByRole("button", { name: new RegExp("switch workspace") })).toBeInTheDocument();
  });

  it("names in other scripts stay one truncating, direction-aware line", () => {
    for (const name of ["中文工作空间名称很长很长很长很长", "اسم مساحة العمل الطويل جدا للاختبار هنا"]) {
      cleanup();
      vi.restoreAllMocks();
      mountAt(500, 800, name);
      const span = screen.getByRole("button", { name: new RegExp("switch workspace") }).querySelector("span[dir=auto]");
      expect(span).toHaveTextContent(name);
      expect(span?.className).toMatch(/truncate/);
    }
  });

  it("is one line on a pane too short for the full header, so the chat keeps the room", () => {
    const { container } = mountAt(900, SHORT_PANE - 1);
    expect(container.querySelector('[data-header="compact"]')).not.toBeNull();
    cleanup();
    vi.restoreAllMocks();
    const tall = mountAt(900, SHORT_PANE + 100);
    expect(tall.container.querySelector('[data-header="full"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("dir", "auto");
  });
});
