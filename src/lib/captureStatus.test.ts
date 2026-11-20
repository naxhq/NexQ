import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureStatusHandler, RECONNECT_NOTICE_AFTER_MS } from "./captureStatus";
import { TOAST_EXIT_MS, useToastStore } from "../stores/toastStore";
import type { AudioCaptureStatus, CaptureSide } from "./types";

const status = (
  state: AudioCaptureStatus["state"],
  message = "",
  side: CaptureSide = "you",
): AudioCaptureStatus => ({ side, state, device: "Microphone (Realtek)", message });

/** What is on screen: toasts that aren't playing their exit. */
const shown = () =>
  useToastStore
    .getState()
    .toasts.filter((t) => !t.leaving)
    .map((t) => [t.message, t.type, t.sticky ?? false]);

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("capture status toasts", () => {
  it("stays quiet while reconnecting briefly and after reconnecting to the same device", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS - 1);
    handle(status("recovered"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS * 2);
    expect(shown()).toEqual([]);
  });

  it("tells the user about a switch to another device", () => {
    const { handle } = createCaptureStatusHandler();
    const message = "Your microphone disconnected. Using Microphone (Realtek) for now.";
    handle(status("recovering"));
    handle(status("recovered", message));
    expect(shown()).toEqual([[message, "info", false]]);
  });

  it("replaces a side's switch toast in place, so the screen shows the latest", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("recovered", "Your microphone disconnected. Using Realtek for now."));
    vi.advanceTimersByTime(2000);
    handle(status("recovered", "Now using Headset as your microphone."));
    handle(status("recovered", "Now listening on Speakers for the other side.", "them"));
    expect(shown().map((t) => t[0])).toEqual([
      "Now using Headset as your microphone.",
      "Now listening on Speakers for the other side.",
    ]);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(useToastStore.getState().toasts).toHaveLength(2); // the replaced one has left
  });

  it("keeps a reconnecting note up after 3 s until the side is back", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("recovering"));
    handle(status("recovering", "", "them"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    expect(shown()).toEqual([
      ["Reconnecting your microphone…", "warning", true],
      ["Reconnecting the other side's audio…", "warning", true],
    ]);
    vi.advanceTimersByTime(60_000);
    expect(shown()).toHaveLength(2);

    handle(status("recovered"));
    expect(shown()).toEqual([
      ["Reconnecting the other side's audio…", "warning", true],
      ["Your microphone is back.", "info", false],
    ]);
  });

  it("a switch after a long reconnect shows the switch, not just 'back'", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    const message = "Your microphone disconnected. Using Realtek for now.";
    handle(status("recovered", message));
    expect(shown()).toEqual([[message, "info", false]]);
  });

  it("keeps a lost side's toast up and replaces it with the recovery", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    const lost =
      "Your microphone disconnected. NexQ reconnects it when it's back, or pick another microphone in Audio & Devices.";
    handle(status("lost", lost));
    expect(shown()).toEqual([[lost, "warning", true]]);
    vi.advanceTimersByTime(120_000);
    expect(shown()).toHaveLength(1);

    const back = "Headset is back as your microphone.";
    handle(status("recovered", back));
    expect(shown()).toEqual([[back, "info", false]]);
  });

  it("doesn't start a reconnecting note for a side that is already lost", () => {
    const { handle } = createCaptureStatusHandler();
    handle(status("lost", "gone"));
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    expect(shown()).toEqual([["gone", "warning", true]]);
  });
});

describe("reset (capture stopped)", () => {
  it("takes down a lost side's toast", () => {
    const { handle, reset } = createCaptureStatusHandler();
    handle(status("lost", "gone"));
    handle(status("recovered", "Now listening on Speakers for the other side.", "them"));
    expect(shown()).toHaveLength(2); // a lost microphone, a switched output
    reset();
    expect(shown()).toEqual([]);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("forgets the state: the next reconnect starts from scratch", () => {
    const { handle, reset } = createCaptureStatusHandler();
    handle(status("lost", "gone"));
    reset();
    // A new meeting: a reconnect held for 3 s shows its note again...
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    expect(shown()).toEqual([["Reconnecting your microphone…", "warning", true]]);
    reset();
    // ...and a short reconnect is silent, as it was before the first meeting.
    handle(status("recovering"));
    handle(status("recovered"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS * 2);
    expect(shown()).toEqual([]);
  });

  it("cancels the pending 3 s note", () => {
    const { handle, reset } = createCaptureStatusHandler();
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS - 1);
    reset();
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS * 2);
    expect(shown()).toEqual([]);
  });
});
