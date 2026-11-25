// The backend's examples of a finished meeting's notes (stopped, interrupted, another meeting)
// go through the Notes tab and the ended panel: each says its own sentence and nothing false.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { sampleDoc } from "../live-notes/fixtures";
import stopped from "./fixtures/notetaker_state_finished_stopped.json";
import interrupted from "./fixtures/notetaker_state_finished_interrupted.json";
import otherMeeting from "./fixtures/notetaker_state_finished_other_meeting.json";
import nothing from "./fixtures/notetaker_state_finished_nothing_to_note.json";

const h = vi.hoisted(() => ({ state: null as unknown, empty: false }));
vi.mock("../lib/ipc", () => ({
  getNotetakerState: async () => h.state,
  getMeetingNotes: async () => (h.empty ? null : structuredClone(sampleDoc)),
  getNotetakerSettings: async () => ({ enabled: false, scope: "meeting", provider: null, model: null, effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true }),
  getAutomaticModel: async () => null,
  getLLMProviders: async () => [],
  cliAgentStatus: async () => null,
  getApiKey: async () => null,
}));
vi.mock("../lib/events", async () => {
  const hotkeys = await import("../lib/hotkeys");
  return {
    onNotetakerDoc: async () => () => {},
    onNotetakerState: async () => () => {},
    onNotetakerSettingsChanged: async () => () => {},
    onAutomaticModelUpdated: async () => () => {},
    onNotesUpdateRequested: (cb: () => void) => {
      window.addEventListener(hotkeys.NOTES_UPDATE_EVENT, cb);
      return () => window.removeEventListener(hotkeys.NOTES_UPDATE_EVENT, cb);
    },
  };
});

import { NotesTab } from "../launcher/meeting-details/NotesTab";
import { NotesPanel } from "../live-notes/LiveNotesPanel";
import { endedSentence, endedWords } from "../live-notes/runState";
import { useLiveNotesStore } from "../stores/liveNotesStore";
import { useMeetingStore } from "../stores/meetingStore";
import type { NotetakerState } from "../lib/types";

const CASES = [
  { name: "stopped", fixture: stopped, heading: "Stopped", sentence: "You stopped the notes.", never: ["closed", "another meeting"] },
  { name: "interrupted", fixture: interrupted, heading: "Interrupted", sentence: "NexQ was closed before the notes were finished.", never: ["You stopped", "another meeting"] },
  { name: "other_meeting", fixture: otherMeeting, heading: "Stopped for another meeting", sentence: "The notes stopped because another meeting started.", never: ["closed", "You stopped"] },
] as const;

beforeEach(() => {
  useLiveNotesStore.getState().reset();
  useMeetingStore.setState({ activeMeeting: null as never });
});

describe.each(CASES)("finished meeting: $name", ({ fixture, heading, sentence, never }) => {
  const state = fixture as unknown as NotetakerState;

  it("reads as its own words and sentence", () => {
    expect(endedWords(state)).toBe(heading);
    expect(endedSentence(state.ended)).toContain(sentence);
    expect(endedSentence(state.ended)).toContain(state.ended!.detail!);
  });

  it("shows in the Notes tab with the range and Update notes", async () => {
    h.state = fixture;
    render(<NotesTab meetingId="m1" title="Sync" />);
    expect(await screen.findByTestId("notes-tab-state")).toHaveTextContent(heading);
    expect(screen.getByText(new RegExp(sentence.slice(0, 20)))).toBeInTheDocument();
    expect(screen.getByText("Not covered: 2:00 to 40:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update notes" })).toBeInTheDocument();
    for (const wrong of never) expect(screen.queryByText(new RegExp(wrong))).toBeNull();
  });

  it("shows in the ended panel with the same sentence", async () => {
    h.state = fixture;
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "t" } as never });
    await useLiveNotesStore.getState().attach("m1");
    await vi.waitFor(() => expect(useLiveNotesStore.getState().runs.m1).toBeDefined());
    const { rerender } = render(<NotesPanel />);
    act(() => useMeetingStore.setState({ activeMeeting: null as never }));
    rerender(<NotesPanel />);
    expect(screen.getByText(`Live notes: ${heading}`)).toBeInTheDocument();
    expect(screen.getByText(endedSentence(state.ended)!)).toBeInTheDocument();
    for (const wrong of never) expect(screen.queryByText(new RegExp(wrong))).toBeNull();
  });
});


describe("finished meeting: nothing_to_note", () => {
  const state = nothing as unknown as NotetakerState;

  it("reads in the backend's own words", () => {
    expect(endedWords(state)).toBe("Nothing to note");
    expect(endedSentence(state.ended)).toBe("The notes read the whole call and found nothing to write down.");
  });

  it("the Notes tab says it once, in place of the empty state, with no box and no contradiction", async () => {
    h.state = nothing;
    h.empty = true;
    render(<NotesTab meetingId="m1" title="Quiet" />);
    expect(await screen.findByRole("heading", { name: "Nothing to note" })).toBeInTheDocument();
    expect(screen.getByText("The notes read the whole call and found nothing to write down.")).toBeInTheDocument();
    expect(screen.queryByText(/No notes for this meeting/)).toBeNull();
    expect(screen.queryByText(/Turn on live notes/)).toBeNull();
    expect(screen.queryByTestId("notes-tab-state")).toBeNull();
    h.empty = false;
  });

  it("the ended panel says the same, not 'Nothing yet'", async () => {
    h.state = nothing;
    h.empty = true;
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "t" } as never });
    await useLiveNotesStore.getState().attach("m1");
    await vi.waitFor(() => expect(useLiveNotesStore.getState().runs.m1).toBeDefined());
    const { rerender } = render(<NotesPanel />);
    act(() => useMeetingStore.setState({ activeMeeting: null as never }));
    rerender(<NotesPanel />);
    expect(screen.getByRole("heading", { name: "Nothing to note" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
    expect(screen.getAllByText("The notes read the whole call and found nothing to write down.")).toHaveLength(1);
    h.empty = false;
  });
});
