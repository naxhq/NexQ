import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptPanel } from "./TranscriptPanel";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import type { Meeting, TranscriptSegment } from "../lib/types";

vi.mock("../hooks/useAudioLevel", () => ({ useAudioLevel: () => ({ micLevel: 0, systemLevel: 0 }) }));
vi.mock("./NoTranscriptBanner", () => ({ NoTranscriptBanner: () => null }));
vi.mock("./SpeakerNamingBanner", () => ({ SpeakerNamingBanner: () => null }));

const segment = (id: string, text: string, timestamp_ms: number): TranscriptSegment => ({
  id, text, speaker: "Them", speaker_id: "them", timestamp_ms, is_final: true, confidence: 1,
});
const ids = () => useTranscriptStore.getState().selectedSegmentIds;
const click = (text: string, mods = {}) => fireEvent.click(screen.getByText(text), mods);

beforeEach(() => {
  useTranscriptStore.getState().clearSegments();
  useTranscriptStore.setState({ autoScroll: false, searchQuery: "", segments: [
    segment("a", "First question?", 1000),
    segment("b", "Second question?", 10000),
    segment("c", "Third question?", 20000),
  ] });
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting, isRecording: false });
});
afterEach(cleanup);

describe("transcript bubble selection", () => {
  it("leaves no reserved status row above search when nothing is selected", () => {
    const { container } = render(<TranscriptPanel />);
    const panel = container.firstElementChild!;
    const flowChildren = panel.childElementCount;
    const search = screen.getByRole("textbox", { name: "Search transcript" });
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    click("First question?");
    expect(screen.getByRole("status").textContent).toContain("1 selected");
    expect(panel.childElementCount).toBe(flowChildren);
    const scroll = container.querySelector("[data-scroll-container]")!;
    expect(screen.getByRole("status").parentElement).toBe(scroll.parentElement);
    click("First question?");
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search transcript" })).toBe(search);
  });

  it("supports replacement, Ctrl/Cmd toggle and Shift range selection", () => {
    render(<TranscriptPanel />);
    expect(screen.queryAllByRole("button", { name: /^Select transcript by/ })).toHaveLength(0);
    click("First question?");
    expect(ids()).toEqual(["a"]);
    click("First question?");
    expect(ids()).toEqual([]);
    click("First question?");
    click("Third question?", { ctrlKey: true });
    expect(ids()).toEqual(["a", "c"]);
    click("First question?", { metaKey: true });
    expect(ids()).toEqual(["c"]);
    click("First question?");
    click("Third question?", { shiftKey: true });
    expect(ids()).toEqual(["a", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear transcript selection" }));
    expect(ids()).toEqual([]);
    click("Third question?", { shiftKey: true });
    expect(ids()).toEqual(["c"]);
  });

  it("selects all originals in a merged bubble without absorbing new speech", () => {
    useTranscriptStore.setState({ segments: [segment("a", "First", 1000), segment("b", "Second", 2000)] });
    render(<TranscriptPanel />);
    click("First Second");
    expect(ids()).toEqual(["a", "b"]);
    act(() => useTranscriptStore.getState().appendSegment(segment("c", "Later", 2500)));
    expect(ids()).toEqual(["a", "b"]);
    expect(screen.getByText("Later").closest("[data-segment-id]")?.getAttribute("data-selected")).toBe("false");
    expect(screen.getByText("First Second").closest("[data-segment-id]")?.getAttribute("data-selected")).toBe("true");
  });

  it("does not select on nested controls or while highlighting text", () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: /Bookmark this line/ })[0]);
    expect(ids()).toEqual([]);
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "First" } as Selection);
    click("First question?");
    expect(ids()).toEqual([]);
    selection.mockRestore();
  });

  it("clears selection when the meeting changes", () => {
    render(<TranscriptPanel />);
    click("First question?");
    act(() => useMeetingStore.setState({ activeMeeting: { id: "next" } as Meeting }));
    expect(ids()).toEqual([]);
  });

  it("prevents native Shift-click text extension so range selection still works", () => {
    render(<TranscriptPanel />);
    click("First question?");
    const text = screen.getByText("Third question?");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true, button: 0 });
    fireEvent(text, down);
    expect(down.defaultPrevented).toBe(true);
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "native range" } as Selection);
    click("Third question?", { shiftKey: true });
    expect(ids()).toEqual(["a", "b", "c"]);
    selection.mockRestore();
  });
});
