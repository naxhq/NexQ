import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
// The editor is its own screen with its own tests; here a note only has to be asked for.
vi.mock("../talking-points/TalkingPointsEditor", () => ({
  TalkingPointsEditor: ({ initialId }: { initialId?: string | null }) => <div data-testid="editor">editor on {initialId ?? "first"}</div>,
}));

import { MemorySection } from "../memory/MemorySection";
import { TalkingPointsSection } from "../talking-points/TalkingPointsSection";
import { LibraryPanel } from "./LibraryPanel";
import { useMemoryStore, type MemoryRow } from "../memory/memoryStore";
import { __resetTalkingPointsForTests } from "../stores/talkingPointsStore";
import { useContextStore } from "../stores/contextStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { detailOf, item, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";
import { memoryLook, MEMORY_LOOK } from "../memory/memoryDisplay";
import { KIND_LOOK } from "./libraryKinds";
import type { TalkingPoint } from "../lib/types";

const ACME = ws({ id: "acme", name: "Acme", is_default: false });

const mem = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: "m1",
  workspace_id: "acme",
  kind: "fact",
  title: "Budget cap",
  text: "40k a quarter",
  source_meeting: null,
  source_ms: null,
  status: "saved",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const note = (id: string, title: string, over: Partial<TalkingPoint> = {}): TalkingPoint => ({
  id,
  workspace_id: "acme",
  title,
  doc_json: "{}",
  markdown: "",
  plain_text: "one two three",
  in_context: false,
  sort: 0,
  created_at: 1,
  updated_at: 1,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([ws(), ACME], "acme");
  useMemoryStore.setState({ byWorkspace: {}, loadError: {}, suggest: {} });
  __resetTalkingPointsForTests();
  useContextStore.setState({ resources: [] });
  useConfigStore.setState({ contextStrategy: "full_context" } as never);
  useMeetingStore.setState({ recentMeetings: [meeting({ id: "hp", title: "Hiring panel" })] });
});
afterEach(() => cleanup());

describe("the shared row's actions menu, by keyboard", () => {
  it("opens with the arrow keys from the row's menu button, picks with Enter, and Escape gives focus back", async () => {
    const b = mockBackend({ list_memory: [mem(), mem({ id: "m2", title: "Start date", updated_at: 0 })], delete_memory: null });
    render(<MemorySection workspaceId="acme" />);
    const button = await screen.findByRole("button", { name: "Actions for Budget cap" });
    button.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu", { name: "Actions for Budget cap" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Edit", "Forget"]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    // Forget asks first; nothing is deleted yet.
    const confirm = await screen.findByRole("alertdialog");
    expect(b.called("delete_memory")).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(b.called("delete_memory")[0]?.args).toMatchObject({ id: "m1" }));
  });

  it("is reached from the row with the arrow keys of the list, with one tab stop for the whole list", async () => {
    mockBackend({ list_memory: [mem(), mem({ id: "m2", title: "Start date", updated_at: 0 })] });
    render(<MemorySection workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Memory items" });
    const [first, second] = within(list).getAllByRole("button", { name: /, Fact$/ });
    await waitFor(() => expect(first.tabIndex).toBe(0));
    expect(second.tabIndex).toBe(-1);
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Actions for Start date" })).toHaveFocus();
  });

  it("the same menu works on a talking point, with its checkable context item", async () => {
    const b = mockBackend({
      list_talking_points: [note("a", "Opening"), note("b", "Pricing", { in_context: true })],
      patch_talking_point: (a: Record<string, unknown>) => note(String(a.id), "Opening", { in_context: true, updated_at: 2 }),
    });
    render(<TalkingPointsSection workspaceId="acme" />);
    const button = await screen.findByRole("button", { name: "Actions for Opening" });
    button.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu", { name: "Actions for Opening" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Open", "Duplicate", "Delete"]);
    const ctx = within(menu).getByRole("menuitemcheckbox", { name: "Use as AI context" });
    expect(ctx).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(b.called("patch_talking_point")[0]?.args).toMatchObject({ id: "a", patch: { in_context: true } }));
  });
});

describe("talking points on the shared section", () => {
  it("folds like the other sections, remembers it, and keeps its action while folded", async () => {
    mockBackend({ list_talking_points: [note("a", "Opening")] });
    render(<TalkingPointsSection workspaceId="acme" />);
    const fold = await screen.findByRole("button", { name: /^Talking points/ });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Notes" })).toBeVisible();
    await userEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("list", { name: "Notes", hidden: true })).not.toBeVisible();
    expect(screen.getByRole("button", { name: "New note" })).toBeVisible();
    cleanup();
    mockBackend({ list_talking_points: [note("a", "Opening")] });
    render(<TalkingPointsSection workspaceId="acme" />);
    expect(await screen.findByRole("button", { name: /^Talking points/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("lists notes as compact rows, one muted line when empty, and opens the editor on the note asked for", async () => {
    mockBackend({ list_talking_points: [note("a", "Opening"), note("b", "Pricing", { in_context: true })] });
    render(<TalkingPointsSection workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("3 words");
    expect(within(list.querySelectorAll("li")[1] as HTMLElement).getByText("AI context")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Pricing" }));
    expect(await screen.findByTestId("editor")).toHaveTextContent("editor on b");
  });

  it("says No notes yet in one line, with the help behind the i", async () => {
    mockBackend({ list_talking_points: [] });
    render(<TalkingPointsSection workspaceId="acme" />);
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About talking points" })).toBeInTheDocument();
  });

  it("keeps a long list to a fixed height with Show all and a search", async () => {
    const many = Array.from({ length: 8 }, (_, n) => note(`n${n}`, `Note ${n}`, { plain_text: n === 6 ? "needle" : "plain" }));
    mockBackend({ list_talking_points: many });
    render(<TalkingPointsSection workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(list.parentElement!.style.maxHeight).toBe("15.5rem");
    await userEvent.click(screen.getByRole("button", { name: "Show all 8 notes" }));
    const dialog = await screen.findByRole("dialog", { name: "Talking points" });
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search notes" }), "needle");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Note 6" }));
    expect(await screen.findByTestId("editor")).toHaveTextContent("editor on n6");
  });
});

describe("the Library's Show all", () => {
  it("opens the whole library with a search, from six items on", async () => {
    const many = Array.from({ length: 9 }, (_, n) => item({ ref_id: `x${n}`, name: n === 4 ? "budget.pdf" : `file ${n}.pdf` }));
    mockBackend({ get_workspace: detailOf(ACME, many, ""), list_workspace_chats: [], list_memory: [], list_talking_points: [] });
    render(<LibraryPanel workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Library items" });
    expect(list.parentElement!.style.maxHeight).toBe("15.5rem");
    await userEvent.click(screen.getByRole("button", { name: "Show all 9 library items" }));
    const dialog = await screen.findByRole("dialog", { name: "Library" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(9);
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search library items" }), "budget");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
  });

  it("does not offer it for a short library", async () => {
    mockBackend({ get_workspace: detailOf(ACME, [item({ ref_id: "d1" })], ""), list_workspace_chats: [], list_memory: [], list_talking_points: [] });
    render(<LibraryPanel workspaceId="acme" />);
    await screen.findByRole("list", { name: "Library items" });
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });
});

describe("the four sections look alike", () => {
  it("each is a labelled section with a folding title, a count and one action", async () => {
    mockBackend({
      get_workspace: detailOf(ACME, [item({ ref_id: "d1" })], "Be brief."),
      list_workspace_chats: [],
      list_memory: [mem()],
      list_talking_points: [note("a", "Opening")],
    });
    render(<LibraryPanel workspaceId="acme" />);
    await screen.findByRole("list", { name: "Memory items" });
    await screen.findByRole("list", { name: "Notes" });
    for (const [region, action] of [
      ["Files, folders and tools", "Add to this workspace"],
      ["Instructions", "Edit instructions"],
      ["Talking points", "New note"],
      ["Memory", "Add to memory"],
    ] as const) {
      const section = screen.getByRole("region", { name: region });
      expect(within(section).getByRole("button", { name: new RegExp(`^${region.split(",")[0]}|^Library`) })).toHaveAttribute("aria-expanded", "true");
      expect(within(section).getByRole("button", { name: action })).toBeInTheDocument();
    }
  });
});

describe("the kind tags", () => {
  it("give every memory kind its own word and icon, and a neutral fact", () => {
    const words = Object.values(MEMORY_LOOK).map((l) => l.word);
    expect(new Set(words).size).toBe(words.length);
    expect(memoryLook("fact").text).toBe("text-muted-foreground");
    // Same recipe as the Library's kinds: a text token, and the same colour at 12% behind the icon.
    for (const look of [...Object.values(MEMORY_LOOK), ...Object.values(KIND_LOOK)]) {
      expect(look.text).toMatch(/^text-(muted-foreground|violet-500|rose-500|info|success|primary|warning)$/);
      expect(look.tile).toMatch(/^bg-(muted|\[hsl\(var\(--[a-z-]+-text\)\/0\.12\)\])$/);
    }
  });
});
