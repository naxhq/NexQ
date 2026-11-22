import { act, cleanup, render, screen } from "@testing-library/react";
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
import { DemoPicker } from "./demo/DemoPicker";
import { useDemoStore } from "./demo/demoStore";
import { useMeetingStore } from "./stores/meetingStore";
import { useConfigStore } from "./stores/configStore";
import { resetLauncherAutoStart } from "./launcher/LauncherView";

beforeAll(() => {
  mockWindows("launcher");
  mockIPC((cmd, args) => {
    if (cmd === "plugin:store|load") return 1;
    if (cmd === "plugin:store|get") {
      const { key } = args as { key: string };
      return key === "firstRunCompleted" ? [true, true] : [null, false];
    }
    if (cmd === "list_meetings") return "[]";
    if (cmd === "start_meeting") return JSON.stringify({ id: "real-1", title: "Real call" });
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
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false, meetingStarting: false });
  useConfigStore.setState({ startOnLogin: false });
  resetLauncherAutoStart();
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

  it("draws the overlay UI in the launcher during a demo and returns to the launcher on exit", async () => {
    render(<App />);
    await act(async () => {
      launchDemo(liveInterviewScenario, "screenshot");
    });
    // Overlay controls are in the DOM, the launcher is not
    expect(await screen.findByLabelText("End meeting")).toBeTruthy();
    expect(screen.queryByText("Start Meeting")).toBeNull();

    await act(async () => {
      exitDemo();
    });
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(useMeetingStore.getState().currentView).toBe("launcher");
    expect(useMeetingStore.getState().activeMeeting).toBeNull();
    await vi.waitFor(() => {
      expect(screen.queryByLabelText("End meeting")).toBeNull();
    });
    expect(showMeetingOverlay).not.toHaveBeenCalled();
  });

  it("a real meeting started during a demo ends the demo and goes to the overlay window", async () => {
    render(<App />);
    await act(async () => {
      launchDemo(liveInterviewScenario, "screenshot");
    });
    await act(async () => {
      await useMeetingStore.getState().startMeetingFlow("Real call", "online");
    });
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    // The real meeting survives: Exit Demo did not restore the pre-demo snapshot over it
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("real-1");
    await vi.waitFor(() => {
      expect(showMeetingOverlay).toHaveBeenCalled();
      expect(useMeetingStore.getState().currentView).toBe("launcher");
    });
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("real-1");
  });
});

describe("demo picker while a real meeting runs", () => {
  it("refuses to start a demo", async () => {
    useMeetingStore.setState({
      activeMeeting: { id: "real-1", title: "Real call" } as never,
      isRecording: true,
    });
    useDemoStore.getState().openPicker();
    render(<DemoPicker />);

    expect(await screen.findByText(/A meeting is running/)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start Demo" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    start.click();
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("real-1");
    useDemoStore.getState().closePicker();
  });
});

describe("start on login and demos", () => {
  it("does not start a recording again when the launcher comes back after a demo", async () => {
    const original = useMeetingStore.getState().startMeetingFlow;
    const startMeetingFlow = vi.fn(() => Promise.resolve());
    useMeetingStore.setState({ startMeetingFlow });
    useConfigStore.setState({ startOnLogin: true });
    try {
      render(<App />);
      await vi.waitFor(() => expect(startMeetingFlow).toHaveBeenCalledTimes(1));

      // The demo draws the overlay inline, so the launcher unmounts and remounts on exit
      await act(async () => {
        launchDemo(liveInterviewScenario, "screenshot");
      });
      expect(await screen.findByLabelText("End meeting")).toBeTruthy();
      await act(async () => {
        exitDemo();
      });
      await vi.waitFor(() => expect(screen.queryByLabelText("End meeting")).toBeNull());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(startMeetingFlow).toHaveBeenCalledTimes(1);
    } finally {
      useMeetingStore.setState({ startMeetingFlow: original });
    }
  });
});

describe("demo while a real meeting is starting", () => {
  it("is refused until the start settles, and the real meeting is not overwritten", async () => {
    const flow = useMeetingStore.getState().startMeetingFlow("Real call", "online");
    // activeMeeting is not set yet, but the start is under way
    expect(useMeetingStore.getState().meetingStarting).toBe(true);
    expect(useMeetingStore.getState().activeMeeting).toBeNull();

    launchDemo(liveInterviewScenario, "screenshot");
    expect(useDemoStore.getState().isDemoActive).toBe(false);

    await act(async () => {
      await flow;
    });
    expect(useMeetingStore.getState().meetingStarting).toBe(false);
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("real-1");
    expect(useDemoStore.getState().isDemoActive).toBe(false);
  });

  it("clears the starting flag when the start fails", async () => {
    mockIPC((cmd) => {
      if (cmd === "start_meeting") throw new Error("boom");
      return [];
    }, { shouldMockEvents: true });
    try {
      await expect(useMeetingStore.getState().startMeetingFlow("x", "online")).rejects.toBeTruthy();
      expect(useMeetingStore.getState().meetingStarting).toBe(false);
    } finally {
      mockIPC((cmd, args) => {
        if (cmd === "plugin:store|load") return 1;
        if (cmd === "plugin:store|get") {
          const { key } = args as { key: string };
          return key === "firstRunCompleted" ? [true, true] : [null, false];
        }
        if (cmd === "list_meetings") return "[]";
        if (cmd === "start_meeting") return JSON.stringify({ id: "real-1", title: "Real call" });
        if (cmd === "get_rag_status" || cmd === "get_token_budget") return "null";
        return [];
      }, { shouldMockEvents: true });
    }
  });

  it("disables Start Demo in the picker", async () => {
    useMeetingStore.setState({ meetingStarting: true });
    useDemoStore.getState().openPicker();
    render(<DemoPicker />);
    const start = (await screen.findByRole("button", { name: "Start Demo" })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    useDemoStore.getState().closePicker();
  });
});
