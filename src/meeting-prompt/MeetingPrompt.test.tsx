import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prompt window's own connections: a call arriving, and config.json on disk.
const window_ = vi.hoisted(() => ({
  onCall: (_info: unknown) => {},
  saved: {} as Record<string, unknown>,
}));
vi.mock("../lib/events", () => ({
  emitStartDetectedMeeting: () => Promise.resolve(),
  onDetectedMeetingEnded: () => Promise.resolve(() => {}),
  onMeetingDetected: (handler: (info: unknown) => void) => {
    window_.onCall = handler;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../lib/ipc", () => ({
  dismissMeetingPrompt: () => Promise.resolve(),
  getDetectedMeeting: () => Promise.resolve(null),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async (key: string) => window_.saved[key], set: async () => {} }),
}));

import { MeetingPrompt, MeetingPromptWindow } from "./MeetingPrompt";
import { useScenarioStore } from "../stores/scenarioStore";
import type { MeetingPromptInfo, ScenarioTemplate } from "../lib/types";

const boardReview = {
  id: "custom_1",
  name: "Board review",
  description: "Custom scenario",
  is_custom: true,
} as ScenarioTemplate;

const info = (over: Partial<MeetingPromptInfo["meeting"]> = {}, secs = 60): MeetingPromptInfo => ({
  meeting: { app: "zoom", app_name: "Zoom", title: null, ...over },
  auto_dismiss_secs: secs,
  default_scenario: "interview",
});

afterEach(() => {
  useScenarioStore.setState({ customScenarios: [] });
  window_.saved = {};
});

describe("MeetingPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 15, 2));
  });
  afterEach(() => vi.useRealTimers());

  it("offers custom scenarios after the built-ins, by keyboard too", () => {
    useScenarioStore.setState({ customScenarios: [boardReview] });
    const onStart = vi.fn();
    render(<MeetingPrompt info={info()} onStart={onStart} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Meeting type/ }));
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveTextContent("Board review");

    fireEvent.keyDown(window, { key: "End" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Meeting type: Board review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start NexQ/ }));
    expect(onStart).toHaveBeenCalledWith(expect.any(String), "custom_1");
  });

  it("opens on a custom default scenario", () => {
    useScenarioStore.setState({ customScenarios: [boardReview] });
    render(<MeetingPrompt info={{ ...info(), default_scenario: "custom_1" }} onStart={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: "Meeting type: Board review" })).toBeInTheDocument();
  });

  it("starts as Team Meeting when its default scenario was deleted", () => {
    const onStart = vi.fn();
    render(<MeetingPrompt info={{ ...info(), default_scenario: "custom_deleted" }} onStart={onStart} onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: "Meeting type: Team Meeting" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start NexQ/ }));
    expect(onStart).toHaveBeenCalledWith(expect.any(String), "team_meeting");
  });

  it("starts a meeting named after the call, with the default scenario", () => {
    const onStart = vi.fn();
    render(<MeetingPrompt info={info({ title: "Weekly sync" })} onStart={onStart} onDismiss={() => {}} />);
    expect(screen.getByText("Zoom meeting detected")).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting name")).toHaveValue("Weekly sync");
    fireEvent.click(screen.getByRole("button", { name: /Start NexQ/ }));
    expect(onStart).toHaveBeenCalledWith("Weekly sync — Meeting 2026-10-23 15:02", "interview");
  });

  it("uses the app's name without a title, and an edited name and type when given", () => {
    const onStart = vi.fn();
    render(<MeetingPrompt info={info()} onStart={onStart} onDismiss={() => {}} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStart).toHaveBeenLastCalledWith("Zoom — Meeting 2026-10-23 15:02", "interview");

    fireEvent.change(screen.getByLabelText("Meeting name"), { target: { value: "Board review" } });
    fireEvent.click(screen.getByRole("button", { name: /Meeting type/ }));
    fireEvent.click(screen.getByRole("option", { name: /Team Meeting/ }));
    fireEvent.click(screen.getByRole("button", { name: /Start NexQ/ }));
    expect(onStart).toHaveBeenLastCalledWith("Board review — Meeting 2026-10-23 15:02", "team_meeting");
  });

  it("goes away after the timeout, but not while hovered; Escape dismisses", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info({}, 2)} onStart={() => {}} onDismiss={onDismiss} />);
    const card = screen.getByRole("dialog");
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(2100));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("stays until the call ends when the timeout is off", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info({}, 0)} onStart={() => {}} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(600_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("picks the meeting type from its menu with the keyboard, making room for it", () => {
    const onStart = vi.fn();
    const onMenuToggle = vi.fn();
    render(<MeetingPrompt info={info()} onStart={onStart} onDismiss={() => {}} onMenuToggle={onMenuToggle} />);
    const chevron = screen.getByRole("button", { name: "Meeting type: Interview" });
    fireEvent.click(chevron);
    expect(onMenuToggle).toHaveBeenLastCalledWith(true);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Interview");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Interview/ }));

    fireEvent.keyDown(window, { key: "ArrowDown" }); // Webinar
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onMenuToggle).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled(); // Enter chose, it didn't start

    fireEvent.click(screen.getByRole("button", { name: /Start NexQ/ }));
    expect(onStart).toHaveBeenLastCalledWith("Zoom — Meeting 2026-10-23 15:02", "webinar");
  });

  it("Escape closes the open menu without dismissing the prompt", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info()} onStart={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Meeting type/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("MeetingPromptWindow", () => {
  it("reads the saved scenarios again for each call, since it stays open between calls", async () => {
    render(<MeetingPromptWindow />);
    window_.saved.customScenarios = [boardReview];
    await act(async () => {
      window_.onCall({ ...info(), default_scenario: "custom_1" });
    });
    expect(await screen.findByRole("button", { name: "Meeting type: Board review" })).toBeInTheDocument();
  });
});
