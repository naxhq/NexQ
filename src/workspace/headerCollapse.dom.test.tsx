import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
// A chat whose scroller reports whatever position the test says; it opens scrolled to the end, as a real chat does.
vi.mock("./chat/ChatPane", () => ({
  ChatPane: () => (
    <div
      data-testid="scroller"
      data-chat-scroll=""
      tabIndex={0}
      ref={(el) => {
        if (el) Object.defineProperty(el, "scrollTop", { value: 400, configurable: true });
      }}
    />
  ),
}));

import { MiddlePane } from "./MiddlePane";
import { WorkspaceActionsProvider } from "./WorkspaceActions";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import { mockBackend, meeting, seedWorkspaces, ws } from "./testUtils";

function mount(messages: boolean) {
  useWorkspaceChatStore.setState(
    messages ? { activeChat: { acme: "c1" }, sessions: { c1: { messages: [{ id: 1 }], turn: null } as never } } : { activeChat: {}, sessions: {} },
  );
  return render(
    <WorkspaceActionsProvider>
      <MiddlePane
        workspace={ws({ id: "acme", name: "Acme", description: "The rollout", is_default: false })}
        starting={false}
        onStart={() => {}}
        onOpenMeeting={() => {}}
        showLibraryToggle={false}
        onToggleLibrary={() => {}}
        onShowLibrary={() => {}}
        onGoAll={() => {}}
        switcherOpen={false}
        onSwitcherOpenChange={() => {}}
      />
    </WorkspaceActionsProvider>,
  );
}

const pane = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-header]")!;
const scrollTo = (top: number) => {
  const el = screen.getByTestId("scroller");
  Object.defineProperty(el, "scrollTop", { value: top, configurable: true });
  act(() => void fireEvent.scroll(el));
};
const calm = (on: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

beforeEach(() => {
  mockBackend({ list_workspace_meetings: { meetings: [meeting({ id: "m1", title: "Weekly sync" })], total: 1 } });
  seedWorkspaces([ws(), ws({ id: "acme", name: "Acme", is_default: false })], "acme");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the header condenses with the chat's scroll", () => {
  it("is the full header on a new chat, with no bar extras and no chevron", () => {
    calm(true);
    const { container } = mount(false);
    expect(pane(container).dataset.header).toBe("full");
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /header/i })).toBeNull();
  });

  it("opens a chat that has messages as the bar, then is full at the top and condensed past the threshold", () => {
    calm(true);
    const { container } = mount(true);
    expect(pane(container).dataset.header).toBe("compact");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    scrollTo(0);
    expect(pane(container).dataset.header).toBe("full");
    expect(pane(container).dataset.progress).toBe("0.000");
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    scrollTo(400);
    expect(pane(container).dataset.header).toBe("compact");
    expect(pane(container).dataset.progress).toBe("1.000");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("with reduced motion is only ever fully open or fully condensed, and keeps its state between the thresholds", () => {
    calm(true);
    const { container } = mount(true);
    const seen = new Set<string>();
    for (const y of [0, 30, 60, 75, 100, 120, 90, 70, 40, 10, 0, 148]) {
      scrollTo(y);
      seen.add(pane(container).dataset.progress!);
    }
    expect([...seen].sort()).toEqual(["0.000", "1.000"]);
    scrollTo(0);
    scrollTo(75); // half of the range: inside the dead zone, so it stays full
    expect(pane(container).dataset.header).toBe("full");
    scrollTo(120);
    scrollTo(75);
    expect(pane(container).dataset.header).toBe("compact");
  });

  it("without reduced motion a big jump glides through the in-between and lands, a small step lands at once", () => {
    calm(false);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const { container } = mount(true);
    scrollTo(0); // a jump from condensed to the top
    act(() => void vi.advanceTimersByTime(20));
    const mid = Number(pane(container).dataset.progress);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0);
    act(() => void vi.advanceTimersByTime(48));
    expect(Number(pane(container).dataset.progress)).toBeLessThan(mid);
    act(() => void vi.advanceTimersByTime(1000));
    expect(pane(container).dataset.progress).toBe("0.000");
    scrollTo(30); // a small step follows exactly: 30 of the 148 px range
    expect(Number(pane(container).dataset.progress)).toBeCloseTo(30 / 148, 2);
  });

  it("names the meeting buttons the same in the mini wave, and exposes one wave and one Start at a time", async () => {
    calm(true);
    mount(true);
    expect(await screen.findByRole("button", { name: /^Weekly sync, .*30 min$/ })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /oldest to newest/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Start meeting" })).toHaveLength(1);
    scrollTo(0);
    expect(screen.getByRole("button", { name: /^Weekly sync, .*30 min$/ })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /oldest to newest/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Start meeting" })).toHaveLength(1);
  });

  it("opens on demand with the chevron and closes with it or Escape, without moving the chat; a wheel closes it", () => {
    calm(true);
    const { container } = mount(true);
    scrollTo(400);
    const chevron = screen.getByRole("button", { name: "Expand the header" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chevron);
    expect(pane(container).dataset.header).toBe("full");
    expect(screen.getByRole("button", { name: "Collapse the header" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.getByTestId("scroller").scrollTop).toBe(400);
    fireEvent.keyDown(pane(container), { key: "Escape" });
    expect(pane(container).dataset.header).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "Expand the header" }));
    expect(pane(container).dataset.header).toBe("full");
    fireEvent.wheel(screen.getByTestId("scroller"));
    expect(pane(container).dataset.header).toBe("compact");
  });

  it("keeps the room it takes constant whatever the progress: the overlay is one fixed size", () => {
    calm(true);
    const { container } = mount(true);
    const shell = container.querySelector<HTMLElement>("[data-header-shell]")!;
    const h0 = shell.style.height;
    scrollTo(0);
    scrollTo(400);
    expect(shell.style.height).toBe(h0);
  });
});
