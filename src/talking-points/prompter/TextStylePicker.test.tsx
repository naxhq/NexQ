import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextStylePicker } from "./TextStylePicker";
import { ReadingSettingsPopover } from "./ReadingSettingsPopover";
import { DEFAULT_READING, TEXT_STYLE_IDS } from "../../stores/talkingPointsStore";
import { TEXT_STYLES, FRAME_MS, PREVIEW_FRAMES } from "./textStyles";
import { DocView } from "../reader/DocView";
import { docFromText } from "../doc/model";

function motion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
beforeEach(() => motion(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const states = (card: HTMLElement) => [...card.querySelectorAll("[data-block-id]")].map((p) => p.getAttribute("data-state"));

describe("the text style cards", () => {
  it("offers one card per preset, all ids known to the store, as a radio group", () => {
    expect(TEXT_STYLES.map((s) => s.id)).toEqual([...TEXT_STYLE_IDS]);
    render(<TextStylePicker value="classic" onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /^Classic/ })).toHaveAttribute("aria-checked", "true");
  });

  it("choosing a card and the arrow keys change the value", async () => {
    const onChange = vi.fn();
    render(<TextStylePicker value="classic" onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: /^Highlight/ }));
    expect(onChange).toHaveBeenLastCalledWith("highlight");
    screen.getByRole("radio", { name: /^Classic/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("checked");
  });

  it("hovering or focusing a card plays a preview through the states; leaving stops it", () => {
    vi.useFakeTimers();
    render(<TextStylePicker value="classic" onChange={() => {}} />);
    const card = screen.getByRole("radio", { name: /^Focus/ });
    const still = states(card);
    expect(still).toEqual(expect.arrayContaining(["said", "past", "current", "ahead"]));
    fireEvent.pointerEnter(card);
    expect(states(card)).toEqual([...PREVIEW_FRAMES[0]]);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    expect(states(card)).toEqual([...PREVIEW_FRAMES[1]]);
    fireEvent.pointerLeave(card);
    expect(states(card)).toEqual(still);
    fireEvent.focus(card);
    act(() => void vi.advanceTimersByTime(FRAME_MS * 3));
    expect(states(card)).toEqual([...PREVIEW_FRAMES[3]]);
  });

  it("with reduced motion a hovered preview stays a still frame", () => {
    motion(true);
    vi.useFakeTimers();
    render(<TextStylePicker value="classic" onChange={() => {}} />);
    const card = screen.getByRole("radio", { name: /^Focus/ });
    const before = states(card);
    fireEvent.pointerEnter(card);
    act(() => void vi.advanceTimersByTime(FRAME_MS * 3));
    expect(states(card)).toEqual(before);
  });

  it("sits in the reading settings and saves the choice", async () => {
    const onChange = vi.fn();
    render(<ReadingSettingsPopover reading={DEFAULT_READING} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: /^High contrast/ }));
    expect(onChange).toHaveBeenCalledWith({ textStyle: "contrast" });
  });

  it("the reader carries the style, and draws Classic when none is given", () => {
    const doc = docFromText("One line");
    const a = render(<DocView doc={doc} textStyle="focus" />);
    expect(a.container.querySelector(".tp-read")).toHaveAttribute("data-style", "focus");
    a.unmount();
    const b = render(<DocView doc={doc} />);
    expect(b.container.querySelector(".tp-read")).toHaveAttribute("data-style", "classic");
  });
});
