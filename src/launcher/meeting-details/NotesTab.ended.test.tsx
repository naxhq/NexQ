import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { sampleDoc } from "../../live-notes/fixtures";
import finished from "../../contracts/fixtures/notetaker_state_finished.json";

const h = vi.hoisted(() => ({ state: null as unknown, reads: 0 }));
vi.mock("../../lib/ipc", () => ({
  getNotetakerState: async () => {
    h.reads += 1;
    return h.state;
  },
  getMeetingNotes: async () => structuredClone(sampleDoc),
  getNotetakerSettings: async () => ({ enabled: false, scope: "meeting", provider: null, model: null, effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true }),
}));
vi.mock("../../lib/events", () => ({
  onNotetakerDoc: async () => () => {},
  onNotetakerState: async () => () => {},
}));

import { NotesTab } from "./NotesTab";
import { useLiveNotesStore } from "../../stores/liveNotesStore";

beforeEach(() => {
  h.reads = 0;
  // An ended meeting with the notes switched off and a range left uncovered.
  h.state = { ...finished, status: "finished", reason: "Live notes are turned off" };
  useLiveNotesStore.getState().reset();
});

describe("NotesTab of an ended meeting", () => {
  it("shows the final state and the range, never the turned-off wording, on every mount", async () => {
    for (let round = 0; round < 3; round++) {
      const { unmount } = render(<NotesTab meetingId="m1" title="Sync" />);
      expect(await screen.findByTestId("notes-tab-state")).toHaveTextContent("Stopped early");
      expect(screen.getByText("Not covered: 2:00 to 40:00")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update notes" })).toBeInTheDocument();
      expect(screen.queryByText(/turned off/)).toBeNull();
      unmount();
    }
    await waitFor(() => expect(h.reads).toBe(3));
  });

  it("reads the state again on a new mount, so a changed backend answer shows", async () => {
    const first = render(<NotesTab meetingId="m1" title="Sync" />);
    await screen.findByText("Not covered: 2:00 to 40:00");
    first.unmount();
    h.state = { ...finished, status: "finished", not_covered: null, reason: null, can: ["start"], ended: { kind: "covered", detail: null } };
    render(<NotesTab meetingId="m1" title="Sync" />);
    await waitFor(() => expect(screen.getByTestId("notes-tab-state")).toHaveTextContent("Finished"));
    expect(screen.queryByText(/Not covered/)).toBeNull();
  });
});
