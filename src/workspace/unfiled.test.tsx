import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("./chat/ChatPane", () => ({ ChatPane: () => <div data-testid="chat" /> }));

import { WorkspaceHome } from "./WorkspaceHome";
import { WorkspaceActionsProvider, useWorkspaceActions } from "./WorkspaceActions";
import { RecentMeetings } from "../launcher/RecentMeetings";
import { SuggestFromMeeting } from "../memory/SuggestFromMeeting";
import { MemorySection } from "../memory/MemorySection";
import { isUnfiledHome, unfiledOf } from "./unfiled";
import { recapFailureLine, recapsDescription } from "./WorkspaceDialog";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { loadFixture } from "../contracts/loadFixture";
import { detailOf, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

const GEN = ws();
const ACME = ws({ id: "acme", name: "Acme", is_default: false });
const FREE = [
  meeting({ id: "u1", title: "Call with a stranger", workspace_id: "unfiled:u1", start_time: new Date(Date.now() - 2 * 86400000).toISOString() }),
  meeting({ id: "u2", title: "Hallway chat", workspace_id: "unfiled:u2" }),
  meeting({ id: "f1", title: "Filed one", workspace_id: "acme" }),
];

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([GEN, ACME], "acme");
  useWorkspaceStore.setState({ view: "home" });
  useMeetingStore.setState({ recentMeetings: [], activeMeeting: null, selectedMeetingId: null });
});
afterEach(() => cleanup());

const backend = (extra: Record<string, unknown> = {}) =>
  mockBackend({
    list_workspaces: [GEN, ACME],
    // The backend lists every home that is not a workspace as "unfiled": the unfiled:<id> ones.
    list_workspace_meetings: (a: Record<string, unknown>) => {
      if (a.id !== "unfiled") return { meetings: [], total: 0 };
      const q = String(a.query ?? "").toLowerCase();
      const hit = FREE.filter((m) => m.workspace_id?.startsWith("unfiled:") && (!q || m.title.toLowerCase().includes(q)));
      return { meetings: hit.slice(Number(a.offset), Number(a.offset) + Number(a.limit)), total: hit.length };
    },
    count_unfiled_meetings: FREE.filter((m) => m.workspace_id?.startsWith("unfiled:")).length,
    get_workspace: detailOf(ACME, []),
    get_meeting_scope: { meeting_id: "u1", home: "acme", borrowed: [], effective: ["acme"] },
    move_meeting: null,
    ...extra,
  });

const mount = () =>
  render(
    <WorkspaceActionsProvider>
      <WorkspaceHome starting={false} onStart={() => {}} onOpenMeeting={() => {}} />
    </WorkspaceActionsProvider>,
  );

describe("meetings that are not filed", () => {
  it("knows an unfiled home by its prefix, and lists the newest first", () => {
    expect(isUnfiledHome("unfiled:abc")).toBe(true);
    expect(isUnfiledHome("general")).toBe(false);
    expect(isUnfiledHome(undefined)).toBe(false);
    expect(unfiledOf(FREE).map((m) => m.id)).toEqual(["u2", "u1"]);
  });

  it("a Not filed row appears in the rail only when there are any, and opens their list", async () => {
    backend();
    mount();
    const row = await screen.findByRole("button", { name: /Not filed/ });
    expect(row).toHaveTextContent("2");
    await userEvent.click(row);
    expect(await screen.findByRole("heading", { level: 1, name: "Not filed" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Meetings that are not filed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Call with a stranger");
    expect(screen.getByText(/used none of your files/)).toBeInTheDocument();
  });

  it("no row when everything is filed", async () => {
    backend({ count_unfiled_meetings: 0 });
    mount();
    await screen.findByRole("heading", { level: 1, name: /Acme/ });
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByRole("button", { name: /^Not filed/ })).toBeNull();
  });

  it("files one meeting with the normal move", async () => {
    const b = backend();
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Not filed/ }));
    const list = await screen.findByRole("list", { name: "Meetings that are not filed" });
    const first = within(list).getAllByRole("listitem").find((li) => li.textContent?.includes("Call with a stranger"))!;
    await userEvent.click(within(first).getByRole("button", { name: "File in…" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Acme" }));
    await waitFor(() => expect(b.called("move_meeting")[0]?.args).toMatchObject({ meetingId: "u1", workspaceId: "acme" }));
  });

  it("files all of them in one workspace, and says how many", async () => {
    const b = backend();
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Not filed/ }));
    await userEvent.click(await screen.findByRole("button", { name: "File all in…" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Acme" }));
    await waitFor(() => expect(b.called("move_meeting")).toHaveLength(2));
    expect(b.called("move_meeting").map((c) => c.args.meetingId).sort()).toEqual(["u1", "u2"]);
  });

  it("See all has a Not filed entry that opens the list", async () => {
    backend();
    useWorkspaceStore.setState({ view: "all" });
    mount();
    const index = await screen.findByRole("list", { name: "All workspaces" });
    const entry = await within(index).findByRole("button", { name: "Not filed" });
    expect(index).toHaveTextContent("2 meetings aren't in a workspace");
    await userEvent.click(entry);
    expect(useWorkspaceStore.getState().view).toBe("unfiled");
  });

  it("a meeting row names its workspace as Not filed when searching everywhere", () => {
    render(<RecentMeetings meetings={[FREE[0]]} onSelect={() => {}} onDelete={() => {}} onRename={() => {}} workspaces={[GEN, ACME]} />);
    expect(screen.getByText("Not filed")).toBeInTheDocument();
  });

  it("Suggest from this meeting is refused for it, with the reason for a screen reader", () => {
    backend();
    render(<SuggestFromMeeting meetingId="u1" workspaceId="unfiled:u1" />);
    const b = screen.getByRole("button", { name: "Suggest from this meeting" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription("File this meeting in a workspace first.");
  });
});

describe("the backend shape: listed as unfiled, counted, searched and paged", () => {
  it("asks list_workspace_meetings for the id unfiled with the fixture's arguments, and counts with count_unfiled_meetings", async () => {
    const b = backend();
    useWorkspaceStore.setState({ view: "unfiled" });
    mount();
    await screen.findByRole("list", { name: "Meetings that are not filed" });
    const sent = b.called("list_workspace_meetings").find((c) => c.args.id === "unfiled")!;
    expect(sent.args).toMatchObject({ id: "unfiled", query: null, limit: 50, offset: 0 });
    expect(Object.keys(loadFixture("list_workspace_meetings_unfiled") as object).sort()).toEqual(Object.keys(sent.args).sort());
    expect(b.called("count_unfiled_meetings").length).toBeGreaterThan(0);
    expect(loadFixture("count_unfiled_meetings")).toEqual({});
  });

  it("lists the unfiled:<id> homes, searches them, and shows more", async () => {
    const many = Array.from({ length: 60 }, (_, i) => meeting({ id: `x${i}`, title: `Loose ${i}`, workspace_id: `unfiled:x${i}` }));
    mockBackend({
      list_workspaces: [GEN, ACME],
      count_unfiled_meetings: 60,
      list_workspace_meetings: (a: Record<string, unknown>) => {
        const q = String(a.query ?? "").toLowerCase();
        const hit = many.filter((m) => !q || m.title.toLowerCase().includes(q));
        return { meetings: hit.slice(0, Number(a.limit)), total: hit.length };
      },
    });
    useWorkspaceStore.setState({ view: "unfiled" });
    mount();
    const list = await screen.findByRole("list", { name: "Meetings that are not filed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(within(list).getAllByRole("listitem")[0].textContent).toContain("Loose 0");
    await userEvent.click(screen.getByRole("button", { name: "Show more meetings that are not filed" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Meetings that are not filed" })).getAllByRole("listitem")).toHaveLength(60));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search meetings that are not filed" }), "Loose 59");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Meetings that are not filed" })).getAllByRole("listitem")).toHaveLength(1));
  });
});

describe("honest recap and memory texts", () => {
  it("says what failed, with the latest reason, and nothing when nothing did", () => {
    expect(recapFailureLine({ count: 3, reason: "no key" })).toBe("3 recaps failed: no key.");
    expect(recapFailureLine({ count: 1, reason: null })).toBe("1 recap failed.");
    expect(recapFailureLine({ count: 0, reason: "x" })).toBeNull();
    expect(recapFailureLine(undefined)).toBeNull();
  });

  it("the recap text names the model it is given and says failed ones are not retried", () => {
    const t = recapsDescription("the automatic model, Claude Haiku (cheapest)");
    expect(t).toMatch(/uses the automatic model, Claude Haiku \(cheapest\), and sends/);
    expect(t).toMatch(/not tried again until the transcript changes or you rescan/);
    expect(t).not.toMatch(/\(the automatic/);
  });

  it("the memory text says up to 4 calls and up to 8 items, with the label the backend gave", async () => {
    mockBackend({
      list_memory: [],
      get_automatic_model: { provider: "claude_cli", model: "haiku", effort: null, label: "Claude Haiku (cheapest)" },
      get_workspace: detailOf(ACME, []),
    });
    useWorkspaceStore.setState({ details: { acme: detailOf(ACME, []) } });
    render(<MemorySection workspaceId="acme" />);
    expect(await screen.findByText(/in up to 4 calls \(a very long meeting keeps its start and end\)\. It proposes up to 8 items/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/goes to Automatic: Claude Haiku \(cheapest\) in up to 4 calls/)).toBeInTheDocument());
  });
});

function _unused() {
  return useWorkspaceActions;
}
void _unused;
