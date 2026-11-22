import { act, cleanup, render } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

// The launcher asks the separate overlay window to show a real meeting; the
// spy tells us whether it did.
const showMeetingOverlay = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./lib/windows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/windows")>()),
  showMeetingOverlay,
}));

import App from "./App";
import { launchDemo, exitDemo } from "./demo/demoEngine";
import { liveInterviewScenario } from "./demo/scenarios/liveInterview";
import { useMeetingStore } from "./stores/meetingStore";

beforeAll(() => {
  mockWindows("launcher");
  mockIPC((cmd, args) => {
    if (cmd === "plugin:store|load") return 1;
    if (cmd === "plugin:store|get") {
      const { key } = args as { key: string };
      return key === "firstRunCompleted" ? [true, true] : [null, false];
    }
    if (cmd === "list_meetings") return "[]";
    if (cmd === "get_rag_status" || cmd === "get_token_budget") return "null";
    return [];
  }, { shouldMockEvents: true });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  exitDemo();
  cleanup();
  showMeetingOverlay.mockClear();
  useMeetingStore.getState().stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
});

describe("demo mode in the launcher window", () => {
  it("stays on the overlay view and does not hand off to the overlay window", async () => {
    render(<App />);
    // A real meeting asking for the overlay is still sent to the overlay window
    // (this also proves the launcher's window label has resolved).
    await act(async () => {
      useMeetingStore.setState({ currentView: "overlay" });
    });
    await vi.waitFor(() => {
      expect(useMeetingStore.getState().currentView).toBe("launcher");
      expect(showMeetingOverlay).toHaveBeenCalled();
    });
    showMeetingOverlay.mockClear();

    await act(async () => {
      launchDemo(liveInterviewScenario, "screenshot");
    });
    // Give the launcher's effects time to (wrongly) bounce the view back
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(useMeetingStore.getState().currentView).toBe("overlay");
    expect(showMeetingOverlay).not.toHaveBeenCalled();
  });
});
