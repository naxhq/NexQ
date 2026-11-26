import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useMeetingShortcuts } from "./useMeetingShortcuts";
import { useMeetingStore } from "../stores/meetingStore";

const actions = () => ({
  addBookmark: vi.fn(),
  toggleStats: vi.fn(),
  toggleBookmarks: vi.fn(),
  toggleMute: vi.fn(),
  closeAllPanels: vi.fn(),
  toggleDevLog: vi.fn(),
});

function pressOn(target: Element | Window, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("useMeetingShortcuts key guard", () => {
  let a: ReturnType<typeof actions>;
  let notes: Mock<() => void>;
  beforeEach(() => {
    a = actions();
    notes = vi.fn<() => void>();
    window.addEventListener("nexq:notes-update", notes);
    useMeetingStore.setState({ isRecording: true });
    renderHook(() => useMeetingShortcuts(a));
  });
  afterEach(() => {
    window.removeEventListener("nexq:notes-update", notes);
    document.body.innerHTML = "";
    cleanup();
    useMeetingStore.setState({ isRecording: false });
  });

  it("N asks for a notes update", () => {
    pressOn(window, "n");
    pressOn(window, "N");
    expect(notes).toHaveBeenCalledTimes(2);
  });

  it("types in a contenteditable (notes, talking points) without firing any key", () => {
    document.body.innerHTML = '<div contenteditable="true" id="e"><p id="p">x</p></div>';
    const p = document.getElementById("p")!;
    for (const k of ["b", "s", "k", "m", "n"]) pressOn(p, k);
    expect(a.addBookmark).not.toHaveBeenCalled();
    expect(a.toggleMute).not.toHaveBeenCalled();
    expect(a.toggleStats).not.toHaveBeenCalled();
    expect(a.toggleBookmarks).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
  });

  it("types in a role=textbox and in inputs without firing", () => {
    document.body.innerHTML = '<div role="textbox" id="r"></div><input id="i" />';
    pressOn(document.getElementById("r")!, "m");
    pressOn(document.getElementById("i")!, "n");
    expect(a.toggleMute).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
  });

  it("Escape still closes panels from inside an editor", () => {
    document.body.innerHTML = '<div contenteditable="true" id="e"></div>';
    pressOn(document.getElementById("e")!, "Escape");
    expect(a.closeAllPanels).toHaveBeenCalledTimes(1);
  });
});
