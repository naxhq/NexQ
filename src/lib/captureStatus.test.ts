import { describe, expect, it } from "vitest";
import { captureStatusToast } from "./captureStatus";
import type { AudioCaptureStatus } from "./types";

const status = (state: AudioCaptureStatus["state"], message: string): AudioCaptureStatus => ({
  side: "you",
  state,
  device: "Microphone (Realtek)",
  message,
});

describe("captureStatusToast", () => {
  it("stays quiet while reconnecting and after reconnecting to the same device", () => {
    expect(captureStatusToast(status("recovering", ""))).toBeNull();
    expect(captureStatusToast(status("recovered", ""))).toBeNull();
  });

  it("tells the user about a switch to another device", () => {
    const message = "Your microphone disconnected. Using Microphone (Realtek) for now.";
    expect(captureStatusToast(status("recovered", message))).toEqual({ message, type: "info" });
  });

  it("warns when a side didn't come back", () => {
    const message = "Your microphone disconnected and didn't come back. Pick a microphone in Audio & Devices to continue.";
    expect(captureStatusToast(status("lost", message))).toEqual({ message, type: "warning" });
  });
});
