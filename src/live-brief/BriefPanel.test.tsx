import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BriefSheet } from "../lib/types";

const hits = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../lib/ipc", () => ({
  getLLMProviders: async () => [],
  listModels: async () => [],
  cliAgentModels: async () => [],
  searchWorkspace: async () => hits.list,
}));

import { BriefPanel, OPEN_SOURCE_EVENT, briefStatusWords } from "./BriefPanel";
import { Age, formatAge } from "./Age";
import { DEFAULT_BRIEF_SETTINGS, useLiveBriefStore } from "../stores/liveBriefStore";
import { useMeetingStore } from "../stores/meetingStore";

const calls = vi.hoisted(() => [] as string[]);

const sheet = (over: Partial<BriefSheet> = {}): BriefSheet => ({
  now: "Pricing for the Berlin launch",
  facts: [
    { text: "The Berlin plan was set at 40k in March.", source: "Launch notes", passage_id: 7 },
    { text: "Support is covered by Omar.", source: "Weekly sync, 3 Mar", passage_id: 9 },
  ],
  earlier: ["Hiring timeline", "Venue options"],
  generated_at: Date.now() - 12_000,
  ...over,
});

function seed(over: Record<string, unknown> = {}) {
  const spy = (name: string) => vi.fn(async () => void calls.push(name));
  useLiveBriefStore.setState({
    meetingId: "m1",
    sheet: sheet(),
    hidden: false,
    run: { meeting_id: "m1", status: "idle", tokens_used: 1000, cap: 60000 },
    settings: { ...DEFAULT_BRIEF_SETTINGS, enabled: true },
    error: null,
    attach: async () => () => {},
    refresh: spy("refresh") as never,
    pause: spy("pause") as never,
    resume: spy("resume") as never,
    keepGoing: spy("keep_going") as never,
    turnOn: spy("turn_on") as never,
    turnOff: spy("turn_off") as never,
    ...over,
  });
}

beforeEach(() => {
  calls.length = 0;
  hits.list = [];
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Sync", workspace_id: "w1" } as never });
});
afterEach(() => vi.useRealTimers());

describe("BriefPanel", () => {
  it("shows the topic line, facts with source chips, earlier points folded, and the age", () => {
    seed();
    render(<BriefPanel />);
    expect(screen.getByRole("heading", { name: "Listening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pricing for the Berlin launch" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Facts about this topic" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open source: Launch notes" })).toBeInTheDocument();
    expect(screen.getByText("12 s ago")).toBeInTheDocument();
    const earlier = screen.getByText(/Earlier points \(2\)/).closest("details")!;
    expect(earlier.open).toBe(false);
    expect(screen.getByText(/Answers use this brief/)).toBeInTheDocument();
  });

  it("shows at most six facts and never renders markup from the model", () => {
    const facts = Array.from({ length: 9 }, (_, i) => ({ text: i === 0 ? "<img src=x onerror=alert(1)>" : `Fact ${i}`, source: `Doc ${i}`, passage_id: i }));
    seed({ sheet: sheet({ facts }) });
    const { container } = render(<BriefPanel />);
    expect(within(screen.getByRole("list", { name: "Facts about this topic" })).getAllByRole("listitem")).toHaveLength(6);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("says when the sheet is too old for answers", () => {
    seed({ sheet: sheet({ generated_at: Date.now() - 5 * 60_000 }) });
    render(<BriefPanel />);
    expect(screen.getByText(/Too old for answers/)).toBeInTheDocument();
  });

  it("after a topic change hides the old sheet and says it is finding the new one", () => {
    seed({ sheet: null, hidden: true });
    render(<BriefPanel />);
    expect(screen.getByRole("heading", { name: "Finding what’s known about the new topic" })).toBeInTheDocument();
    expect(screen.queryByText("Pricing for the Berlin launch")).toBeNull();
  });

  it("starts by explaining itself and what it sends, then turns on", async () => {
    seed({ sheet: null, settings: { ...DEFAULT_BRIEF_SETTINGS, enabled: false }, run: null });
    render(<BriefPanel />);
    expect(screen.getByRole("heading", { name: "Brief is off" })).toBeInTheDocument();
    expect(screen.getByText(/Live answers use it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on the brief" }));
    expect(calls).toEqual(["turn_on"]);
  });

  it("refreshes, pauses and resumes", async () => {
    seed();
    const { unmount } = render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "Pause the brief" }));
    expect(calls).toEqual(["refresh", "pause"]);
    unmount();
    calls.length = 0;
    seed({ run: { meeting_id: "m1", status: "paused", tokens_used: 1, cap: 10 } });
    render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Resume the brief" }));
    expect(calls).toEqual(["resume"]);
  });

  it("asks Keep the brief going? at its cap", async () => {
    seed({ run: { meeting_id: "m1", status: "capped", tokens_used: 60000, cap: 60000 } });
    render(<BriefPanel />);
    expect(screen.getByRole("group", { name: "Keep the brief going?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(calls).toEqual(["keep_going"]);
  });

  it("explains a pause with a way to fix it", () => {
    seed({ run: { meeting_id: "m1", status: "paused", tokens_used: 1, cap: 10, reason: "The plan limit was reached." } });
    render(<BriefPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("The plan limit was reached.");
    expect(screen.getByRole("button", { name: "Change model" })).toBeInTheDocument();
  });

  it("opens a source: the host hears which passage", async () => {
    hits.list = [{ id: 7, kind: "transcript", ref_id: "m-old", sub_ref: null, title: "Launch notes", start_ms: 5000, end_ms: 9000, text: "", tokens: 1, occurred_at: null, score: 1 }];
    seed();
    const heard: Array<{ kind: string; ref_id: string }> = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_SOURCE_EVENT, on);
    render(<BriefPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Open source: Launch notes" }));
    window.removeEventListener(OPEN_SOURCE_EVENT, on);
    expect(heard).toEqual([expect.objectContaining({ kind: "transcript", ref_id: "m-old" })]);
  });
});

describe("briefStatusWords", () => {
  it("says the state in words", () => {
    expect(briefStatusWords(undefined, false)).toBe("Brief is off");
    expect(briefStatusWords("running", true)).toBe("Looking");
    expect(briefStatusWords("idle", true)).toBe("Listening");
    expect(briefStatusWords("capped", true)).toBe("Paused");
    expect(briefStatusWords("error", true)).toBe("Stopped");
  });
});

describe("Age", () => {
  it("formats ages", () => {
    expect(formatAge(1000)).toBe("just now");
    expect(formatAge(12_000)).toBe("12 s ago");
    expect(formatAge(125_000)).toBe("2 min ago");
    expect(formatAge(2 * 3_600_000)).toBe("2 h ago");
  });

  it("ticks on its own without rendering the sheet again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const renders = vi.fn();
    // The parent is rendered once; the span re-renders by itself.
    const at = Date.now() - 12_000;
    function Parent() {
      renders();
      return <Age at={at} />;
    }
    render(<Parent />);
    expect(screen.getByText("12 s ago")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByText("15 s ago")).toBeInTheDocument();
    expect(renders).toHaveBeenCalledTimes(1);
  });
});
