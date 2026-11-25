import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, TalkingPoint, TranscriptSegment } from "../../lib/types";

const ipc = vi.hoisted(() => ({
  listTalkingPoints: vi.fn(),
  createTalkingPoint: vi.fn(),
  patchTalkingPoint: vi.fn(),
  deleteTalkingPoint: vi.fn(),
  copyTalkingPoint: vi.fn(),
  reorderTalkingPoints: vi.fn(),
  getPointProgress: vi.fn(),
  savePointProgress: vi.fn(),
  getMeetingPointEdit: vi.fn(),
  saveMeetingPointEdit: vi.fn(),
  getMeetingScope: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

import { PointsPanel } from "./PointsPanel";
import { useMeetingStore } from "../../stores/meetingStore";
import { useConfigStore } from "../../stores/configStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { __resetTalkingPointsForTests, useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { docFromText, docBlocks, parseDoc } from "../../talking-points/doc/model";
import { keyBelongsToFocusedControl } from "../../lib/hotkeys";

function note(id: string, title: string, text: string, sort: number, ws = "w1"): TalkingPoint {
  const doc = docFromText(text);
  return {
    id,
    workspace_id: ws,
    title,
    doc_json: JSON.stringify(doc),
    markdown: text,
    plain_text: text,
    in_context: false,
    sort,
    created_at: 1,
    updated_at: 1,
  };
}

const OPENING = "Welcome everyone to the quarterly review.\nFirst, revenue grew twelve percent compared with last year.\nSecond, we hired fourteen engineers across three product teams.";
const NOTES = [note("n1", "Opening", OPENING, 0), note("n2", "Pricing", "Our price is simple.\nOne plan for every team.", 1), note("n3", "Closing", "Thank you all.", 2)];

function startMeeting(over: Partial<Meeting> = {}) {
  useMeetingStore.setState({
    activeMeeting: { id: "m1", title: "Sync", workspace_id: "w1", config_snapshot: { stt_provider: "deepgram" }, ...over } as Meeting,
    audioMode: "online",
  });
}

const sayLine = (id: string, text: string, o: Partial<TranscriptSegment> = {}) =>
  act(() =>
    useTranscriptStore.getState().updateInterimSegment({ id, text, speaker: "User", timestamp_ms: 0, is_final: true, confidence: 0.9, ...o }),
  );

// a small fake backend: patches merge into the latest copy of the note
const rows = new Map<string, TalkingPoint>();
let clock = 1000;
const saveCalls = () => ipc.createTalkingPoint.mock.calls.length + ipc.patchTalkingPoint.mock.calls.length;
const lastSaved = () => [...rows.values()].sort((a, b) => b.updated_at - a.updated_at)[0];
function wireBackend() {
  rows.clear();
  clock = 1000;
  ipc.patchTalkingPoint.mockImplementation(async (id: string, patch: Partial<TalkingPoint>) => {
    const base = rows.get(id) ?? NOTES.find((n) => n.id === id)!;
    const next = { ...base, ...patch, updated_at: ++clock };
    rows.set(id, next);
    return next;
  });
  ipc.createTalkingPoint.mockImplementation(async (ws: string, title: string, c: { doc_json: string; markdown: string; plain_text: string; in_context?: boolean }) => {
    const next: TalkingPoint = { id: "created" + ++clock, workspace_id: ws, title, ...c, in_context: c.in_context ?? true, sort: 99, created_at: 1, updated_at: ++clock };
    rows.set(next.id, next);
    return next;
  });
}

// jsdom has no layout; ProseMirror asks for rectangles when it scrolls the caret into view
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const list = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => list as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  document.elementFromPoint = () => null;
});

beforeEach(() => {
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.listTalkingPoints.mockImplementation(async (ws: string) => NOTES.filter((n) => n.workspace_id === ws));
  wireBackend();
  ipc.getPointProgress.mockResolvedValue(null);
  ipc.getMeetingPointEdit.mockResolvedValue(null);
  ipc.saveMeetingPointEdit.mockResolvedValue(undefined);
  ipc.savePointProgress.mockResolvedValue(undefined);
  ipc.getMeetingScope.mockResolvedValue({ meeting_id: "m1", home: "w1", borrowed: [], effective: ["w1"] });
  ipc.listWorkspaces.mockResolvedValue([{ id: "w1", name: "Sales" }]);
  localStorage.clear();
  useTranscriptStore.getState().clearSegments();
  useConfigStore.setState({ mutedYou: false });
  startMeeting();
});
afterEach(() => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null });
});

describe("PointsPanel states", () => {
  it("invites writing the first note when the workspace has none, and opens the editor", async () => {
    ipc.listTalkingPoints.mockResolvedValue([]);
    render(<PointsPanel />);
    expect(await screen.findByText("Write your first talking points")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Write a note" }));
    expect(ipc.createTalkingPoint).toHaveBeenCalledWith("w1", "Talking points", expect.objectContaining({ in_context: true }));
    expect(await screen.findByRole("button", { name: "Save to workspace" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: /Edit Talking points/ })).toBeInTheDocument();
  });

  it("says when the notes did not load and offers to try again", async () => {
    ipc.listTalkingPoints.mockRejectedValueOnce("database busy");
    render(<PointsPanel />);
    expect(await screen.findByText("Your notes did not load")).toBeInTheDocument();
    expect(screen.getByText("database busy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: /Talking points: Opening/ })).toBeInTheDocument();
  });

  it("shows the first note, with its text and a labelled reading region", async () => {
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: "Talking points: Opening" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByText(/Welcome everyone/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opening" })).toHaveAttribute("aria-haspopup", "listbox");
  });

  it("opens the note used last in this workspace", async () => {
    useTalkingPointsStore.getState().rememberNote("w1", "n2");
    render(<PointsPanel />);
    expect(await screen.findByRole("region", { name: "Talking points: Pricing" })).toBeInTheDocument();
  });

  it("borrowed workspaces' notes appear in the switcher with where they come from", async () => {
    ipc.getMeetingScope.mockResolvedValue({ meeting_id: "m1", home: "w1", borrowed: ["w2"], effective: ["w1", "w2"] });
    ipc.listWorkspaces.mockResolvedValue([{ id: "w1", name: "Sales" }, { id: "w2", name: "General" }]);
    ipc.listTalkingPoints.mockImplementation(async (ws: string) => (ws === "w2" ? [note("g1", "House style", "Be kind.", 0, "w2")] : NOTES));
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await userEvent.click(screen.getByRole("button", { name: "Opening" }));
    const list = await screen.findByRole("listbox", { name: "Notes" });
    await waitFor(() => expect(within(list).getByText("General")).toBeInTheDocument());
    expect(within(list).getByText("House style")).toBeInTheDocument();
  });
});

describe("switcher", () => {
  it("filters as you type, moves with the arrows, opens with Enter, remembers it, closes with Escape", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Opening" }));
    const box = screen.getByRole("combobox", { name: "Find a note" });
    expect(box).toHaveFocus();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Opening", "Pricing", "Closing"]);
    await user.keyboard("o");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Opening", "Closing", "Pricing"].filter((t) => /o/i.test(t) || t === "Pricing"));
    await user.clear(box);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Talking points: Closing" })).toBeInTheDocument();
    expect(useTalkingPointsStore.getState().lastNote.w1).toBe("n3");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Closing" }));
    // recent first: Closing, then Opening was opened before it in this session? (only n3 is remembered here)
    expect(screen.getAllByRole("option")[0].textContent).toBe("Closing");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closing" })).toHaveFocus();
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Opening" }));
    await user.keyboard("zzzz");
    expect(screen.getByText("No note matches that.")).toBeInTheDocument();
  });
});

describe("keys belong to the panel only when it has focus", () => {
  it("Space in the reading region does not reach the meeting shortcuts, and starts auto-scroll in auto mode", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    useTalkingPointsStore.getState().setReading({ mode: "auto" });
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: /Opening/ });
    // the guard alone would let Space through here: the region is not a control
    expect(keyBelongsToFocusedControl({ target: region, key: " " })).toBe(false);
    region.focus();
    expect(screen.getByRole("button", { name: "Start auto-scroll" })).toBeInTheDocument();
    await user.keyboard(" ");
    expect(seen).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause auto-scroll" })).toBeInTheDocument();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Start auto-scroll" })).toBeInTheDocument();
    window.removeEventListener("keydown", seen);
  });

  it("Space elsewhere still reaches the window (the panel does not swallow every key)", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    await user.keyboard(" ");
    expect(seen).toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });

  it("a focused tick or button keeps its own Space (the guard ignores it)", async () => {
    render(<PointsPanel />);
    const tick = (await screen.findAllByRole("button", { name: /^Said it:/ }))[0];
    expect(keyBelongsToFocusedControl({ target: tick, key: " " })).toBe(true);
  });

  it("Enter ticks the current line, plus and minus change the text size", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: /Opening/ });
    region.focus();
    const before = useTalkingPointsStore.getState().reading.fontSize;
    await user.keyboard("+");
    expect(useTalkingPointsStore.getState().reading.fontSize).toBe(before + 2);
    await user.keyboard("-{-}");
    expect(useTalkingPointsStore.getState().reading.fontSize).toBe(before - 2);
    await user.keyboard("{Enter}");
    expect(screen.getByText(/1 left to say|2 left to say/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { pressed: true, name: /^Said it:/ })).toHaveLength(1);
  });

  it("typing in the switcher or the settings never reaches the meeting shortcuts", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Opening" }));
    await user.keyboard("abc 1");
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });
});

describe("how the note moves", () => {
  it("auto-scroll never starts by itself, in any motion setting", async () => {
    useTalkingPointsStore.getState().setReading({ mode: "auto" });
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    expect(screen.getByRole("button", { name: "Start auto-scroll" })).toBeInTheDocument();
    expect(screen.getByText("140 words a minute")).toBeInTheDocument();
  });

  it("Follow my voice explains why it cannot work", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({ mutedYou: true });
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("radio", { name: /Follow my voice/ }));
    expect(await screen.findByText(/microphone is muted/)).toBeInTheDocument();
    cleanup();
    useConfigStore.setState({ mutedYou: false });
    startMeeting();
    useMeetingStore.setState({ audioMode: "in_person" });
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    expect(await screen.findByText(/in-person meeting/)).toBeInTheDocument();
  });

  it("follows what you say and counts what is left, from the You side only", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("radio", { name: "Follow my voice" }));
    expect(screen.getByText("3 left to say")).toBeInTheDocument();
    sayLine("t1", "welcome everyone to the quarterly review", { speaker: "Them" });
    expect(screen.getByText("3 left to say")).toBeInTheDocument();
    sayLine("u1", "welcome everyone to the quarterly review", { is_final: false });
    sayLine("u1", "welcome everyone to the quarterly review"); // interims hold back their last words; the final settles it
    expect(await screen.findByText("2 left to say")).toBeInTheDocument();
    expect(await screen.findByText("Following you")).toBeInTheDocument();
    sayLine("u2", "first revenue grew twelve percent compared with last year");
    sayLine("u3", "second we hired fourteen engineers across three product teams");
    expect(await screen.findByText("All said")).toBeInTheDocument();
  });

  it("said ticks are saved for the meeting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<PointsPanel />);
      const tick = (await screen.findAllByRole("button", { name: /^Said it:/ }))[1];
      act(() => tick.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });
      expect(ipc.savePointProgress).toHaveBeenCalledTimes(1);
      const [meetingId, pointId, said] = ipc.savePointProgress.mock.calls[0];
      expect(meetingId).toBe("m1");
      expect(pointId).toBe("n1");
      const ids = docBlocks(parseDoc(NOTES[0].doc_json)).map((b) => b.id);
      expect(said).toEqual([{ block_id: ids[1], by: "manual", ticked: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores ticks saved earlier in this meeting", async () => {
    const ids = docBlocks(parseDoc(NOTES[0].doc_json)).map((b) => b.id);
    ipc.getPointProgress.mockResolvedValue({ meeting_id: "m1", point_id: "n1", said: [{ block_id: ids[0], by: "voice", ticked: true }] });
    render(<PointsPanel />);
    expect(await screen.findByText("2 left to say")).toBeInTheDocument();
  });

  it("can turn said-it off", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    const dlg = screen.getByRole("dialog", { name: "Reading settings" });
    await user.click(within(dlg).getByRole("switch", { name: "Tick what I have said" }));
    expect(useTalkingPointsStore.getState().reading.saidIt).toBe(false);
    expect(screen.queryByText(/left to say/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Said it:/ })).toHaveLength(0);
  });
});

describe("reading settings", () => {
  it("changes and remembers size, spacing and speed", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    const dlg = screen.getByRole("dialog", { name: "Reading settings" });
    await user.click(within(dlg).getByRole("button", { name: "Increase text size" }));
    await user.click(within(dlg).getByRole("button", { name: "Increase line spacing" }));
    await user.click(within(dlg).getByRole("button", { name: "Increase speed" }));
    const r = useTalkingPointsStore.getState().reading;
    expect(r.fontSize).toBe(28);
    expect(r.lineSpacing).toBe(1.6);
    expect(r.wpm).toBe(150);
    expect(region.style.fontSize).toBe("28px");
    expect(region.style.lineHeight).toBe("1.6");
    expect(JSON.parse(localStorage.getItem("nexq-talking-points-v1")!).reading.fontSize).toBe(28);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Reading settings" })).not.toBeInTheDocument();
  });
});

describe("edit in place", () => {
  it("'Only this meeting' keeps the workspace note as it was", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Edit this note" }));
    const editor = await screen.findByRole("textbox", { name: "Edit Opening" });
    await user.click(editor);
    await user.keyboard("Added today. ");
    await user.click(screen.getByRole("button", { name: "Only this meeting" }));
    await waitFor(() => expect(ipc.saveMeetingPointEdit).toHaveBeenCalled());
    const [m, id, json] = ipc.saveMeetingPointEdit.mock.calls[0];
    expect([m, id]).toEqual(["m1", "n1"]);
    expect(json).toContain("Added today.");
    expect(saveCalls()).toBe(0);
    const region = await screen.findByRole("region", { name: /Opening/ });
    expect(within(region).getByText(/Added today\./)).toBeInTheDocument();
    expect(screen.getByText("edited for this meeting")).toBeInTheDocument();
  });

  it("'Save to workspace' saves the note itself", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Edit this note" }));
    await user.click(await screen.findByRole("textbox", { name: "Edit Opening" }));
    await user.keyboard("For everyone. ");
    await user.click(screen.getByRole("button", { name: "Save to workspace" }));
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    expect(lastSaved().plain_text).toContain("For everyone.");
    await waitFor(() => expect(ipc.saveMeetingPointEdit).toHaveBeenLastCalledWith("m1", "n1", null));
  });

  it("Cancel leaves everything as it was", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Edit this note" }));
    await user.click(await screen.findByRole("textbox", { name: "Edit Opening" }));
    await user.keyboard("Oops");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveCalls()).toBe(0);
    expect(ipc.saveMeetingPointEdit).not.toHaveBeenCalled();
    expect(await screen.findByRole("region", { name: /Opening/ })).toBeInTheDocument();
  });

  it("keeps the editor open and says so when saving to the workspace fails", async () => {
    const user = userEvent.setup();
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    await user.click(screen.getByRole("button", { name: "Edit this note" }));
    await user.click(await screen.findByRole("textbox", { name: "Edit Opening" }));
    await user.keyboard("x");
    ipc.patchTalkingPoint.mockRejectedValue("offline");
    await user.click(screen.getByRole("button", { name: "Save to workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("textbox", { name: "Edit Opening" })).toBeInTheDocument();
  });
});

describe("ticks belong to the meeting they were made in", () => {
  it("reopening a meeting brings its ticks back; another meeting starts clean", async () => {
    // a small backend for progress, keyed by meeting and note
    const saved = new Map<string, unknown>();
    ipc.savePointProgress.mockImplementation(async (m: string, p: string, said: unknown) => void saved.set(`${m}/${p}`, said));
    ipc.getPointProgress.mockImplementation(async (m: string, p: string) => {
      const said = saved.get(`${m}/${p}`);
      return said ? { meeting_id: m, point_id: p, said } : null;
    });

    const first = render(<PointsPanel />);
    const ticks = await screen.findAllByRole("button", { name: /^Said it:/ });
    expect(screen.getByText("3 left to say")).toBeInTheDocument();
    act(() => ticks[1].click());
    expect(screen.getByText("2 left to say")).toBeInTheDocument();
    first.unmount(); // closing the window saves what is waiting
    await waitFor(() => expect(saved.has("m1/n1")).toBe(true));

    // later: the same meeting opened again in a fresh window
    __resetTalkingPointsForTests();
    render(<PointsPanel />);
    expect(await screen.findByText("2 left to say")).toBeInTheDocument();
    const again = screen.getAllByRole("button", { name: /^Said it:/ });
    expect(again[1]).toHaveAttribute("aria-pressed", "true");
    expect(again[0]).toHaveAttribute("aria-pressed", "false");
    cleanup();

    // a different meeting does not inherit them
    __resetTalkingPointsForTests();
    startMeeting({ id: "m2" });
    render(<PointsPanel />);
    expect(await screen.findByText("3 left to say")).toBeInTheDocument();
    expect(ipc.getPointProgress).toHaveBeenCalledWith("m2", "n1");
  });
});

describe("a hostile note is only ever drawn as text", () => {
  it("scripts, images, links and odd colours in a saved note do not become elements", async () => {
    const hostile = {
      type: "doc",
      content: [
        { type: "heading", attrs: { id: "h", level: 9 }, content: [{ type: "text", text: "<script>alert(1)</script>" }] },
        { type: "image", attrs: { src: "https://evil.test/x.png" } },
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [
            { type: "text", text: '<img src=x onerror="alert(2)">', marks: [{ type: "link", attrs: { href: "javascript:alert(3)" } }, { type: "tpColor", attrs: { name: "red;background:url(//evil.test)" } }] },
          ],
        },
      ],
    };
    ipc.listTalkingPoints.mockResolvedValue([{ ...NOTES[0], doc_json: JSON.stringify(hostile), plain_text: "x" }]);
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: /Opening/ });
    expect(region.querySelector("img, script, a, iframe, style, [onerror], [href], [src]")).toBeNull();
    expect(region.textContent).toContain("<script>alert(1)</script>");
    expect(region.textContent).toContain('<img src=x onerror="alert(2)">');
    expect(region.innerHTML).not.toMatch(/evil\.test|javascript:/);
    expect(region.querySelector("h1, h2, h3")).not.toBeNull();
  });
});
