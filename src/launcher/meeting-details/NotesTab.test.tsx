import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sampleDoc } from "../../live-notes/fixtures";

const h = vi.hoisted(() => ({ doc: null as unknown, saved: [] as unknown[], exported: [] as unknown[], copied: [] as string[] }));

vi.mock("../../lib/ipc", () => ({
  getNotetakerState: async () => {
    throw new Error("no state");
  },
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

beforeEach(() => {
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
