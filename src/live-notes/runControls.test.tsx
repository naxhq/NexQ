import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotetakerSettings, NotetakerState, RunAction } from "../lib/types";
import { sampleDoc } from "./fixtures";

vi.mock("../lib/ipc", () => ({
  getLLMProviders: async () => [],
  listModels: async () => [],
  cliAgentModels: async () => [],
  cliAgentStatus: async () => null,
  getApiKey: async () => null,
  getWorkspace: async () => ({ brief_enabled: true }),
  getAutomaticModel: async () => h.automatic,
}));
vi.mock("../lib/events", async () => {
  const hotkeys = await import("../lib/hotkeys");
  return {
    onAutomaticModelUpdated: async () => () => {},
    onNotesUpdateRequested: (h: () => void) => {
      window.addEventListener(hotkeys.NOTES_UPDATE_EVENT, h);
      return () => window.removeEventListener(hotkeys.NOTES_UPDATE_EVENT, h);
    },
  };
});

import { NotesPanel } from "./LiveNotesPanel";
import { BriefPanel } from "../live-brief/BriefPanel";
import { Countdown } from "./RunStatusHeader";
import { countdownText, notCoveredText, endedWords, can, modelLine } from "./runState";
import { ns, bs } from "./testing";
import { DEFAULT_NOTETAKER_SETTINGS, EMPTY_ENTRY, useLiveNotesStore } from "../stores/liveNotesStore";
import { DEFAULT_BRIEF_SETTINGS, useLiveBriefStore } from "../stores/liveBriefStore";
import { useMeetingStore } from "../stores/meetingStore";

const calls = vi.hoisted(() => [] as string[]);
let updateArgs: string[] = [];
const h = vi.hoisted(() => ({ automatic: null as null | { provider: string; model: string; effort: string | null; label: string } }));
const spy = (name: string) => vi.fn(async () => void calls.push(name));

const run = (status: NotetakerState["status"], can: RunAction[], over: Partial<NotetakerState> = {}): NotetakerState => ns(status, can, over);

function notes(state: NotetakerState, settings: Partial<NotetakerSettings> = {}, blocks = true) {
  useLiveNotesStore.setState({
    entries: { m1: { ...EMPTY_ENTRY, doc: blocks ? structuredClone(sampleDoc) : { version: 1, blocks: [] } } },
    settings: { ...DEFAULT_NOTETAKER_SETTINGS, enabled: true, cap: 120000, ...settings },
    runs: { m1: state },
    deadlines: {},
    error: null,
    attach: async () => () => {},
    watchSettings: async () => () => {},
    updateNow: (async (id?: string) => void (calls.push("update"), (updateArgs = id ? [id] : []))) as never,
    pause: spy("pause") as never,
    resume: spy("resume") as never,
    start: spy("start") as never,
    tryAgain: spy("try_again") as never,
    keepGoing: spy("keep_going") as never,
    stop: spy("stop") as never,
  });
}

beforeEach(() => {
  calls.length = 0;
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Sync", workspace_id: "w1" } as never, elapsedMs: 0 });
});
afterEach(() => vi.useRealTimers());

describe("buttons come from `can`", () => {
  it("shows exactly the actions the backend allows, whatever the token count says", async () => {
    notes(run("on", ["update", "pause"], { tokens_used: 999_999 }));
    render(<NotesPanel />);
    expect(screen.getByRole("button", { name: /Update now/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Keep taking notes?" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Notes options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause notes" }));
    expect(calls).toEqual(["pause"]);
  });

  it("disables Update now only while a model call is in flight", () => {
    notes(run("running", []));
    render(<NotesPanel />);
    expect(screen.getByRole("button", { name: /Update now/ })).toBeDisabled();
  });

  it("offers Resume after a pause and Start notes again after the notes stopped", async () => {
    notes(run("paused", ["resume"]));
    const { unmount } = render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    unmount();
    notes(run("finished", ["start"]));
    render(<NotesPanel />);
    expect(screen.queryByRole("button", { name: /Update now/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start notes again" }));
    expect(calls).toEqual(["resume", "start"]);
  });

  it("Try again and Change model both work after an error or a plan limit", async () => {
    notes(run("error", ["try_again"], { reason: "Plan limit reached until 4 pm.", error_kind: "plan_limit" }));
    render(<NotesPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("Plan limit reached until 4 pm.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Change model" }));
    expect(await screen.findByRole("dialog", { name: "Live notes settings" })).toBeInTheDocument();
    expect(calls).toEqual(["try_again"]);
  });

  it("the N key does nothing unless the backend allows an update", () => {
    notes(run("paused", ["resume"]));
    render(<NotesPanel />);
    act(() => void window.dispatchEvent(new Event("nexq:notes-update")));
    expect(calls).toEqual([]);
  });

  it("the cap prompt comes from the backend's `keep_going`", async () => {
    notes(run("capped", ["keep_going"], { tokens_used: 1 }));
    render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(calls).toEqual(["keep_going"]);
  });
});

describe("countdown", () => {
  it("counts down from a deadline, one text node a second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    render(<Countdown deadline={Date.now() + 12_000} />);
    expect(screen.getByText("next update in 12 s")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByText("next update in 9 s")).toBeInTheDocument();
  });

  it("does not tick while the window is hidden", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    render(<Countdown deadline={Date.now() + 30_000} />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  it("is shown by the panel from next_in_ms", () => {
    vi.useFakeTimers();
    notes(run("waiting", ["update"], { next_in_ms: 20_000 }));
    useLiveNotesStore.setState({ deadlines: { m1: Date.now() + 20_000 } });
    render(<NotesPanel />);
    expect(screen.getByText(/next update in 20 s/)).toBeInTheDocument();
  });

  it("is pure and plain", () => {
    expect(countdownText(10_000, 0)).toBe("next update in 10 s");
    expect(countdownText(0, 5000)).toBe("updating soon");
    expect(countdownText(300_000, 0)).toBe("next update in 5 min");
  });
});

describe("the model it will use", () => {
  it("names the backend's automatic model before turning on", async () => {
    h.automatic = { provider: "claude_cli", model: "haiku", effort: null, label: "Claude Haiku (cheapest)" };
    notes(run("off", ["start"]), { enabled: false }, false);
    render(<NotesPanel />);
    expect(await screen.findByText("Automatic, uses Claude Haiku (cheapest)")).toBeInTheDocument();
  });
  it("says what a chosen one is", () => {
    expect(modelLine({ provider: "ollama", label: "Ollama llama3" }, null)).toBe("Uses Ollama llama3");
    expect(modelLine({ provider: null, label: "" }, { label: "OpenAI gpt-5-nano (cheapest)" })).toBe("Automatic, uses OpenAI gpt-5-nano (cheapest)");
  });
});

describe("not covered, from the backend's range", () => {
  const range = { from_ms: 120_000, to_ms: 2_400_000 };

  it("shows the range in the panel after the meeting ended, and Update notes runs on that meeting", async () => {
    notes(run("finished", ["update", "start"], { not_covered: range }));
    const { rerender } = render(<NotesPanel />);
    act(() => useMeetingStore.setState({ activeMeeting: null as never }));
    rerender(<NotesPanel />);
    expect(screen.getByText("Not covered: 2:00 to 40:00")).toBeInTheDocument();
    expect(screen.getByText("Live notes: Stopped early")).toBeInTheDocument();
    const update = screen.getByRole("button", { name: "Update notes" });
    await userEvent.click(update);
    expect(updateArgs).toEqual(["m1"]);
  });

  it("shows progress while the update runs", () => {
    notes(run("running", [], { not_covered: range }));
    render(<NotesPanel />);
    expect(screen.getByRole("button", { name: "Updating" })).toBeDisabled();
  });

  it("says nothing when there is nothing uncovered", () => {
    notes(run("on", ["update"]));
    render(<NotesPanel />);
    expect(screen.queryByText(/Not covered/)).toBeNull();
  });

  it("words", () => {
    expect(notCoveredText(range)).toBe("Not covered: 2:00 to 40:00");
    expect(notCoveredText(null)).toBeNull();
    expect(endedWords({ status: "capped" })).toBe("Stopped at the limit");
    expect(endedWords({ status: "error" })).toBe("Stopped by an error");
    expect(endedWords({ status: "finished", not_covered: range })).toBe("Stopped early");
    expect(endedWords({ status: "finished", not_covered: null })).toBe("Finished");
  });
});

describe("`can` is what the backend says", () => {
  it("reads only the list", () => {
    expect(can({ status: "capped", can: ["keep_going"] }, "keep_going")).toBe(true);
    expect(can({ status: "on", can: ["pause"] }, "update")).toBe(false);
    expect(can(null, "update")).toBe(false);
    expect(can({ status: "on" }, "update")).toBe(false);
  });
});

describe("brief panel", () => {
  function brief(state: NotetakerState) {
    useLiveBriefStore.setState({
      meetingId: "m1",
      workspaceEnabled: true,
      settings: { ...DEFAULT_BRIEF_SETTINGS },
      run: state,
      deadline: null,
      sheet: null,
      error: null,
      attach: async () => () => {},
      watchSettings: async () => () => {},
      refresh: spy("refresh") as never,
      pause: spy("pause") as never,
      resume: spy("resume") as never,
      tryAgain: spy("try_again") as never,
      keepGoing: spy("keep_going") as never,
    });
  }

  it("pauses and resumes without turning off", async () => {
    brief(run("on", ["update", "pause"]));
    const { unmount } = render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Brief options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause the brief" }));
    expect(screen.getByText("Brief: On")).toBeInTheDocument();
    unmount();
    brief(run("paused", ["resume"]));
    render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Resume the brief" }));
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("recovers after an error from the panel", async () => {
    brief(run("error", ["try_again"], { reason: "The model did not answer." }));
    render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls).toEqual(["try_again"]);
  });

  it("offers only the actions the backend allows", async () => {
    brief(run("on", ["update", "pause"], { tokens_used: 999_999 }));
    const { unmount } = render(<BriefPanel />);
    expect(screen.queryByRole("button", { name: "Resume the brief" })).toBeNull();
    unmount();
    brief(run("paused", ["resume"]));
    render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Brief options" }));
    expect(screen.queryByRole("menuitem", { name: "Pause the brief" })).toBeNull();
  });
});

describe("after Stop, at the end, and when the limit changes", () => {
  it("with notes on the page and the notes off, offers Turn on notes", async () => {
    notes(run("off", ["start"]), { enabled: false }, true);
    const turnOn = vi.fn(async () => void calls.push("turn_on"));
    useLiveNotesStore.setState({ turnOn: turnOn as never });
    render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Turn on notes" }));
    expect(turnOn).toHaveBeenCalledWith("meeting");
  });

  it("after the meeting ends, keeps the notes on show and offers no run controls", () => {
    notes(run("finished", ["start", "update"]));
    const { rerender } = render(<NotesPanel />);
    act(() => useMeetingStore.setState({ activeMeeting: null as never }));
    rerender(<NotesPanel />);
    expect(screen.getByText("Live notes: Finished")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch plan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update now|Start notes again/ })).toBeNull();
  });

  it("the footer follows a changed limit at once", () => {
    notes(run("on", ["update"], { cap: 120000, tokens_used: 42000 }), { cap: 240000 });
    render(<NotesPanel />);
    expect(screen.getByText(/42k of 240k tokens/)).toBeInTheDocument();
  });

  it("shows the backend's reason when Update now has nothing new, as a notice", () => {
    notes(run("on", ["update"]));
    useLiveNotesStore.setState({ notice: "Nothing new to add yet." });
    render(<NotesPanel />);
    expect(screen.getByText("Nothing new to add yet.")).toBeInTheDocument();
    expect(screen.getByText("Not updated")).toBeInTheDocument();
  });
});
