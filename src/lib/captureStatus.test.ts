import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCaptureStatusHandler,
  RECONNECT_NOTICE_AFTER_MS,
  SWITCH_TOAST_INTERVAL_MS,
} from "./captureStatus";
import { useToastStore } from "../stores/toastStore";
import type { AudioCaptureStatus, CaptureSide } from "./types";

const status = (
  state: AudioCaptureStatus["state"],
  message = "",
  side: CaptureSide = "you",
): AudioCaptureStatus => ({ side, state, device: "Microphone (Realtek)", message });

const shown = () => useToastStore.getState().toasts.map((t) => [t.message, t.type, t.sticky ?? false]);

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("capture status toasts", () => {
  it("stays quiet while reconnecting briefly and after reconnecting to the same device", () => {
    const handle = createCaptureStatusHandler();
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS - 1);
    handle(status("recovered"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS * 2);
    expect(shown()).toEqual([]);
  });

  it("tells the user about a switch to another device", () => {
    const handle = createCaptureStatusHandler();
    const message = "Your microphone disconnected. Using Microphone (Realtek) for now.";
    handle(status("recovering"));
    handle(status("recovered", message));
    expect(shown()).toEqual([[message, "info", false]]);
  });

  it("shows at most one switch toast per side every 10 s", () => {
    const handle = createCaptureStatusHandler();
    handle(status("recovered", "Now using A as your microphone."));
    vi.advanceTimersByTime(SWITCH_TOAST_INTERVAL_MS - 1);
    handle(status("recovered", "Now using B as your microphone."));
    handle(status("recovered", "Now listening on C for the other side.", "them"));
    expect(shown().map((t) => t[0])).toEqual([
      "Now using A as your microphone.",
      "Now listening on C for the other side.",
    ]);
    vi.advanceTimersByTime(1);
    handle(status("recovered", "Now using D as your microphone."));
    expect(shown().map((t) => t[0])).toContain("Now using D as your microphone.");
  });

  it("keeps a reconnecting notice up after 3 s until the side is back", () => {
    const handle = createCaptureStatusHandler();
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

  it("keeps a lost side's toast up, replaces the notice, and shows the recovery even inside the 10 s", () => {
    const handle = createCaptureStatusHandler();
    handle(status("recovered", "Now using A as your microphone.")); // starts the 10 s window
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    const lost = "Your microphone disconnected. NexQ reconnects it when it's back, or pick another microphone in Audio & Devices.";
    handle(status("lost", lost));
    expect(shown().filter((t) => t[2])).toEqual([[lost, "warning", true]]);
    vi.advanceTimersByTime(120_000);
    expect(shown().filter((t) => t[2])).toHaveLength(1);

    const back = "Headset is back as your microphone.";
    handle(status("recovered", back));
    expect(shown().filter((t) => t[2])).toEqual([]);
    expect(shown().map((t) => t[0])).toContain(back);
  });

  it("doesn't start a reconnecting notice for a side that is already lost", () => {
    const handle = createCaptureStatusHandler();
    handle(status("lost", "gone"));
    handle(status("recovering"));
    vi.advanceTimersByTime(RECONNECT_NOTICE_AFTER_MS);
    expect(shown()).toEqual([["gone", "warning", true]]);
  });
});
