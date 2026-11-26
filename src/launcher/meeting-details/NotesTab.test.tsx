import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sampleDoc } from "../../live-notes/fixtures";
import { ns } from "../../live-notes/testing";
import finishedFixture from "../../contracts/fixtures/notetaker_state_finished.json";

const h = vi.hoisted(() => ({ state: null as unknown, doc: null as unknown, saved: [] as unknown[], exported: [] as unknown[], copied: [] as string[] }));

vi.mock("../../lib/ipc", () => ({
  getNotetakerState: async () => h.state,
  getMeetingNotes: async () => h.doc,
  getNotetakerSettings: async () => ({ enabled: false, scope: "meeting", provider: null, model: null, effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true }),
  saveMeetingNotesEdit: async (_id: string, edit: unknown) => {
    h.saved.push(edit);
    return h.doc;
  },
}));
vi.mock("../../lib/events", () => ({
  onNotetakerDoc: async () => () => {},
  onNotetakerState: async () => () => {},
}));
vi.mock("../../lib/export", () => ({
  saveExportFile: async (o: unknown) => void h.exported.push(o),
}));
vi.mock("../../live-notes/clipboard", () => ({
  copyText: async (t: string) => void h.copied.push(t),
}));

import { NotesTab } from "./NotesTab";
import { useLiveNotesStore } from "../../stores/liveNotesStore";
import { useMeetingStore } from "../../stores/meetingStore";

beforeEach(() => {
  h.state = ns("off", ["start"], { reason: "No live notes were taken in this meeting" }); // nothing ever ran
  useMeetingStore.setState({ activeMeeting: null as never });
  h.saved.length = 0;
  h.exported.length = 0;
  h.copied.length = 0;
  useLiveNotesStore.getState().reset();
});

describe("NotesTab", () => {
  it("shows the saved notes as a page, editable, and copies clean Markdown", async () => {
    h.doc = structuredClone(sampleDoc);
    render(<NotesTab meetingId="m1" title="Weekly sync" />);
    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    expect(h.copied[0]).toContain("# Weekly sync");
    expect(h.copied[0]).not.toContain("{{");
    await userEvent.click(screen.getByRole("button", { name: "Save as file" }));
    expect(h.exported[0]).toMatchObject({ extension: "md", defaultName: "Weekly sync notes" });
  });

  it("edits in place and saves the change", async () => {
    h.doc = structuredClone(sampleDoc);
    render(<NotesTab meetingId="m1" title="Sync" />);
    await screen.findByRole("heading", { name: "Launch plan" });
    await userEvent.click(screen.getAllByRole("button", { name: /Options for this decision/ })[0]);
    await userEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    const box = screen.getByRole("textbox", { name: "Edit line" });
    await userEvent.clear(box);
    await userEvent.type(box, "Ship in May{Enter}");
    await waitFor(() => expect(h.saved).toEqual([{ op: "update", id: "b4", text: "Ship in May" }]));
  });

  it("explains an empty meeting and offers no export", async () => {
    h.doc = null;
    render(<NotesTab meetingId="m2" title="Quiet" />);
    expect(await screen.findByRole("heading", { name: "No notes for this meeting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as Markdown" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as file" })).toBeDisabled();
  });

  it("jumps to the transcript from a time", async () => {
    h.doc = structuredClone(sampleDoc);
    const onJump = vi.fn();
    render(<NotesTab meetingId="m1" title="Sync" onJump={onJump} />);
    await userEvent.click(await screen.findByRole("button", { name: "Jump to 1:05 in the transcript" }));
    expect(onJump).toHaveBeenCalledWith(65_000);
  });
});

describe("NotesTab state of a meeting", () => {
  it("shows no box at all for a meeting without notes", async () => {
    h.doc = null;
    render(<NotesTab meetingId="m1" title="Quiet" />);
    expect(await screen.findByRole("heading", { name: "No notes for this meeting" })).toBeInTheDocument();
    expect(screen.queryByTestId("notes-tab-state")).toBeNull();
    expect(screen.queryByText(/Finished/)).toBeNull();
  });

  it("with the backend's finished example: says what became of the notes, the range, and Update notes runs on that meeting", async () => {
    h.doc = structuredClone(sampleDoc);
    h.state = { ...finishedFixture, can: ["update"] };
    const calls: string[] = [];
    useLiveNotesStore.setState({ updateNow: (async (id?: string) => void calls.push(String(id))) as never });
    render(<NotesTab meetingId="m1" title="Sync" />);
    expect(await screen.findByTestId("notes-tab-state")).toHaveTextContent("Stopped early");
    expect(screen.getByText("Not covered: 2:00 to 40:00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update notes" }));
    expect(calls).toEqual(["m1"]);
  });

  it.each([
    ["covered", "Finished", "The notes cover the whole call."],
    ["limit", "Stopped at the limit", "The notes stopped at the limit you set."],
    ["error", "Stopped by an error", "The notes stopped because of an error."],
    ["plan_limit", "Stopped by a usage limit", "your plan's usage limit was reached"],
    ["paused", "Paused", "paused when the meeting ended"],
    ["manual", "Not updated automatically", "on manual"],
    ["out_of_time", "Stopped early", "ran out of time"],
    ["stopped", "Stopped", "You stopped the notes."],
  ] as const)("says in a plain sentence why the notes ended (%s)", async (kind, heading, sentence) => {
    h.doc = structuredClone(sampleDoc);
    h.state = ns("finished", [], { ended: { kind, detail: null } });
    render(<NotesTab meetingId="m1" title="Sync" />);
    expect(await screen.findByTestId("notes-tab-state")).toHaveTextContent(heading);
    expect(screen.getByText((text) => text.includes(sentence))).toBeInTheDocument();
  });

  it("offers Keep going on an ended meeting when the backend allows it", async () => {
    h.doc = structuredClone(sampleDoc);
    h.state = ns("capped", ["keep_going"], { ended: { kind: "limit", detail: null } });
    const calls: string[] = [];
    useLiveNotesStore.setState({ keepGoing: (async (id?: string) => void calls.push(String(id))) as never });
    render(<NotesTab meetingId="m1" title="Sync" />);
    await userEvent.click(await screen.findByRole("button", { name: "Keep going" }));
    expect(calls).toEqual(["m1"]);
  });

  it("uses live words while the meeting runs", async () => {
    h.doc = structuredClone(sampleDoc);
    h.state = ns("running", []);
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "t" } as never });
    useLiveNotesStore.setState({ settings: { enabled: true, scope: "meeting", provider: null, model: null, effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true } as never });
    render(<NotesTab meetingId="m1" title="Sync" />);
    expect(await screen.findByTestId("notes-tab-state")).toHaveTextContent("Taking notes");
  });

  it("says once, and can be dismissed, that the notes moved to an online provider", async () => {
    h.doc = structuredClone(sampleDoc);
    h.state = ns("finished", [], { ended: { kind: "covered", detail: null }, moved_online: { from: "ollama", to: "openai" } });
    render(<NotesTab meetingId="m1" title="Sync" />);
    expect(await screen.findByText("Notes now use OpenAI (online).")).toBeInTheDocument();
    const dismissed: string[] = [];
    useLiveNotesStore.setState({ dismissMoved: (async (id: string) => void dismissed.push(id)) as never });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/now use OpenAI/)).toBeNull();
    expect(dismissed).toEqual(["m1"]);
  });

  it("shows a refusal from Update notes", async () => {
    h.doc = structuredClone(sampleDoc);
    render(<NotesTab meetingId="m1" title="Sync" />);
    await screen.findByRole("heading", { name: "Launch plan" });
    useLiveNotesStore.setState({ notice: "Nothing new to add." });
    expect(await screen.findByText("Nothing new to add.")).toBeInTheDocument();
  });
});
