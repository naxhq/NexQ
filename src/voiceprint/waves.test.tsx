import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextBar, ContextLayerInfo } from "../lib/types";
import { ContextWave } from "./ContextWave";
import { MeetingWave } from "./MeetingWave";
import { VoiceprintMark } from "./VoiceprintMark";

afterEach(cleanup);

const BARS: ContextBar[] = [
  { id: "i1", layer: "instructions", title: "Instructions", tokens: 800, relevance: 1, pinned: true, included: true },
  { id: "m1", layer: "meetings", title: "Kickoff 3 Nov", tokens: 4200, relevance: 0.82, pinned: false, included: true },
  { id: "d1", layer: "documents", title: "Contract.pdf", tokens: 6100, relevance: 0.4, pinned: false, included: true },
  { id: "d2", layer: "documents", title: "Old draft.docx", tokens: 9000, relevance: 0.1, pinned: false, included: false },
];

describe("ContextWave", () => {
  it("labels every bar and all five layers", () => {
    render(<ContextWave bars={BARS} window={128000} budget={24000} />);
    expect(screen.getByRole("button", { name: /Meetings: Kickoff 3 Nov, 4,200 tokens, relevance 82 percent/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Instructions and memory: Instructions.*pinned/ })).toBeInTheDocument();
    const legend = within(screen.getByRole("list"));
    for (const name of ["Instructions and memory", "Meetings", "Documents", "Folders", "Conversation"]) {
      expect(legend.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.getByText(/Using 11.1k of 24k tokens/)).toBeInTheDocument();
    expect(screen.getByText(/1 found but cut/)).toBeInTheDocument();
  });

  it("says in the legend and the graph what a question will search, apart from what is sent", () => {
    const layers: ContextLayerInfo[] = [
      { layer: "meetings", available: 54_000, sources: 6, searched: true },
      { layer: "documents", available: 6100, sources: 1, searched: false },
      { layer: "folders", available: 1_200_000, sources: 638, searched: true },
    ];
    const { container } = render(<ContextWave bars={BARS} window={200000} budget={60000} used={11400} layers={layers} />);
    const legend = within(screen.getByRole("list"));
    expect(legend.getByRole("button", { name: /Folders.*searched when you ask · 1.2M indexed/ })).toBeInTheDocument();
    expect(legend.getByRole("button", { name: /Meetings.*4.2k sent · searched when you ask/ })).toBeInTheDocument();
    expect(legend.getByRole("button", { name: /Documents\s*6\.1k$/ })).toBeInTheDocument();
    // outlined hints only for the searched layers, and the number in the summary stays what is sent
    expect([...container.querySelectorAll("[data-wave-hint]")].map((e) => e.getAttribute("data-wave-hint"))).toEqual(["meetings", "folders"]);
    expect(screen.getByText(/Using 11.4k of 60k tokens/)).toBeInTheDocument();
  });

  it("moves between bars with the arrow keys, Home and End, one tab stop", async () => {
    const user = userEvent.setup();
    render(<ContextWave bars={BARS} window={128000} budget={24000} />);
    const group = screen.getByRole("group", { name: /Context graph/ });
    const bars = within(group).getAllByRole("button");
    expect(bars).toHaveLength(3);
    expect(bars.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    bars[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(bars[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(bars[2]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(bars[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(bars[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(bars[0]).toHaveFocus();
  });

  it("announces the focused bar and opens its items on Enter and on a legend click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ContextWave bars={BARS} window={128000} budget={24000} onSelect={onSelect} />);
    const group = screen.getByRole("group", { name: /Context graph/ });
    const second = within(group).getAllByRole("button")[1];
    act(() => second.focus());
    expect(screen.getByRole("status")).toHaveTextContent("Meetings: Kickoff 3 Nov");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ layer: "meetings", bars: [BARS[1]] });
    await user.click(within(screen.getByRole("list")).getByRole("button", { name: /^Documents/ }));
    expect(onSelect).toHaveBeenLastCalledWith({ layer: "documents", bars: [BARS[2]] });
  });

  it("offers the same data as a list, including what was cut", async () => {
    const user = userEvent.setup();
    render(<ContextWave bars={BARS} window={128000} budget={24000} />);
    await user.click(screen.getByRole("button", { name: "View as list" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getByText("Old draft.docx").closest("tr")).toHaveTextContent("Cut");
    await user.click(screen.getByRole("button", { name: "View as graph" }));
    expect(screen.getByRole("group", { name: /Context graph/ })).toBeInTheDocument();
  });

  it("copes with no items and with one", () => {
    const { rerender } = render(<ContextWave bars={[]} window={8000} budget={4000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing in the context yet");
    rerender(<ContextWave bars={[BARS[1]]} window={8000} budget={4000} />);
    expect(within(screen.getByRole("group", { name: /Context graph/ })).getAllByRole("button")).toHaveLength(1);
  });

  it("draws 400 items as a handful of bars you can still reach", () => {
    const many: ContextBar[] = Array.from({ length: 400 }, (_, i) => ({
      id: `x${i}`, layer: "folders", title: `File ${i}`, tokens: 30, relevance: (i % 10) / 10, pinned: false, included: true,
    }));
    render(<ContextWave bars={many} window={128000} budget={24000} />);
    const bars = within(screen.getByRole("group", { name: /Context graph/ })).getAllByRole("button");
    expect(bars.length).toBeLessThan(250);
    expect(bars.some((b) => /smaller items/.test(b.getAttribute("aria-label") ?? ""))).toBe(true);
  });
});

describe("MeetingWave", () => {
  const meetings = [
    { id: "b", title: "Second", date: "2026-03-10T10:00:00Z", duration_seconds: 1800 },
    { id: "a", title: "First", date: "2026-02-01T10:00:00Z", duration_seconds: 3600 },
    { id: "c", title: "Third", date: "2026-04-01T10:00:00Z", duration_seconds: null },
  ];

  it("has one bar per meeting, oldest first, named with title, date and length", () => {
    render(<MeetingWave meetings={meetings} onOpen={() => {}} />);
    const bars = within(screen.getByRole("group", { name: /3 meetings/ })).getAllByRole("button");
    expect(bars.map((b) => b.getAttribute("aria-label")?.split(",")[0])).toEqual(["First", "Second", "Third"]);
    expect(bars[0]).toHaveAccessibleName(/1 h/);
    expect(bars[2]).toHaveAccessibleName(/length unknown/);
  });

  it("opens a meeting on click and on Enter, and moves with arrows", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MeetingWave meetings={meetings} onOpen={onOpen} />);
    const bars = within(screen.getByRole("group")).getAllByRole("button");
    await user.click(bars[0]);
    expect(onOpen).toHaveBeenLastCalledWith("a");
    bars[0].focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("b");
  });

  it("shows title and date in a tooltip on focus, not a title attribute", async () => {
    render(<MeetingWave meetings={meetings} onOpen={() => {}} />);
    const first = within(screen.getByRole("group")).getAllByRole("button")[0];
    first.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("First");
    expect(first).not.toHaveAttribute("title");
  });

  it("is a flat line with no meetings", () => {
    const { container } = render(<MeetingWave meetings={[]} onOpen={() => {}} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("VoiceprintMark", () => {
  it("is hidden from screen readers unless it is given a label", () => {
    const { container, rerender } = render(<VoiceprintMark id="x" hue="teal" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("rect")).toHaveLength(7);
    rerender(<VoiceprintMark id="x" label="Acme" />);
    expect(screen.getByRole("img", { name: "Acme" })).toBeInTheDocument();
  });
});
