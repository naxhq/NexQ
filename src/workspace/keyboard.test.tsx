import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { WorkspaceHome } from "./WorkspaceHome";
import { WorkspaceActionsProvider } from "./WorkspaceActions";
import { SkipLinks, useRegionKeys } from "./regions";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useMeetingStore } from "../stores/meetingStore";
import { meeting, mockBackend, seedWorkspaces, ws, detailOf } from "./testUtils";

const GENERAL = ws({ id: "general", name: "General", is_default: true });
const ACME = ws({ id: "acme", name: "Acme account", sort: 1 });
const BETA = ws({ id: "beta", name: "Beta", sort: 2 });

function Shell() {
  useRegionKeys();
  return (
    <WorkspaceActionsProvider>
      <SkipLinks />
      <WorkspaceHome starting={false} onStart={vi.fn()} onOpenMeeting={vi.fn()} />
      <footer id="region-footer" data-region tabIndex={-1} aria-label="Status">
        <button type="button">Status</button>
      </footer>
    </WorkspaceActionsProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  seedWorkspaces([GENERAL, ACME, BETA], "acme");
  useMeetingStore.setState({ activeMeeting: null, recentMeetings: [] });
  mockBackend({
    list_workspaces: [GENERAL, ACME, BETA],
    list_workspace_meetings: () => ({
      meetings: [1, 2, 3].map((n) => meeting({ id: `m${n}`, title: `Meeting ${n}`, workspace_id: "acme" })),
      total: 3,
    }),
    get_workspace: () => detailOf(ACME, [], ""),
  });
});
afterEach(() => cleanup());

const tabStops = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("button,a[href],[role=button],[tabindex]")].filter((el) => el.tabIndex === 0 && el.closest('[data-rove-row]'));

describe("keyboard navigation", () => {
  it("keeps one tab stop per list of meetings", async () => {
    const { container } = render(<Shell />);
    await screen.findByRole("button", { name: /Meeting: Meeting 1/ });
    const meetingStops = tabStops(container).filter((el) => /^Meeting:/.test(el.getAttribute("aria-label") ?? ""));
    expect(meetingStops).toHaveLength(1);
    // The actions inside a meeting are not tab stops.
    const rename = within(screen.getByRole("button", { name: /Meeting: Meeting 1/ })).getAllByRole("button")[0];
    expect(rename.tabIndex).toBe(-1);
  });

  it("moves between meetings with the arrow keys and opens actions with Right", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const first = await screen.findByRole("button", { name: /Meeting: Meeting 1/ });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Meeting: Meeting 2/ })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: /Meeting: Meeting 3/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).not.toBe(first);
    expect(first.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(first).toHaveFocus();
  });

  it("makes the workspace rail one stop, with Not filed in the same list", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const nav = screen.getByRole("navigation", { name: "Workspaces" });
    const stops = [...nav.querySelectorAll<HTMLElement>("[data-rove-row]")].map((r) => (r.matches("button") ? r : r.querySelector<HTMLElement>("button")!)).filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    stops[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(nav.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(stops[0]);
  });

  it("goes between regions with F6 and Shift+F6", async () => {
    render(<Shell />);
    await screen.findByRole("button", { name: /Meeting: Meeting 1/ });
    const rail = screen.getByRole("complementary", { name: "Workspaces and meetings" });
    rail.focus();
    act(() => { fireEvent.keyDown(rail, { key: "F6" }); });
    expect(screen.getByRole("main", { name: "Chat and meeting" })).toHaveFocus();
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "F6" }); });
    expect(screen.getByRole("complementary", { name: "Library" })).toHaveFocus();
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "F6" }); });
    expect(screen.getByRole("contentinfo")).toHaveFocus();
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "F6", shiftKey: true }); });
    expect(screen.getByRole("complementary", { name: "Library" })).toHaveFocus();
  });

  it("offers skip links as the first stops", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    (document.activeElement as HTMLElement | null)?.blur(); // the chat box takes focus on load; start from the top
    await user.click(document.body);
    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to workspaces and meetings" })).toHaveFocus();
    await user.keyboard("{Tab}{Tab}");
    const lib = screen.getByRole("link", { name: "Skip to Library" });
    expect(lib).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "Library" })).toHaveFocus();
  });
});
