import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocView } from "./DocView";
import { markdownToDoc, docBlocks } from "../index";
import { usePrompter } from "../prompter/usePrompter";
import { DEFAULT_READING } from "../../stores/talkingPointsStore";
import { useTranscriptStore } from "../../stores/transcriptStore";

afterEach(cleanup);

const md = "# Opening\n\nWelcome everyone to the quarterly review.\n\n## Numbers\n\n- Revenue grew twelve percent\n- We hired fourteen engineers\n\n1. First step\n2. Second step";

describe("quiet ticks", () => {
  it("headings have no tick; paragraphs and list items do", () => {
    const doc = markdownToDoc(md);
    const { container } = render(<DocView doc={doc} ticks />);
    expect(container.querySelector("h1 .tp-tick, h2 .tp-tick")).toBeNull();
    const ticks = screen.getAllByRole("button", { name: /^Said it:/ });
    expect(ticks).toHaveLength(5); // 1 paragraph, 2 bullets, 2 numbered
  });

  it("a bullet's tick takes the dot's place; with Said it off there are normal bullets and no ticks", () => {
    const doc = markdownToDoc(md);
    const { container, rerender } = render(<DocView doc={doc} ticks />);
    expect(container.querySelector(".tp-read")).toHaveClass("tp-ticks");
    expect(container.querySelectorAll('p[data-list="bullet"] > .tp-tick')).toHaveLength(2);
    expect(container.querySelectorAll('p[data-list="ordered"] > .tp-tick')).toHaveLength(2);
    rerender(<DocView doc={doc} />);
    expect(container.querySelector(".tp-read")).not.toHaveClass("tp-ticks");
    expect(container.querySelector(".tp-tick")).toBeNull();
    expect(container.querySelector("ul")).not.toBeNull(); // plain bullets come from the list itself
  });

  it("manual reading is full contrast; auto and voice dim what is ahead and behind", () => {
    const doc = markdownToDoc("a b c\n\nd e f");
    const { container, rerender } = render(<DocView doc={doc} />);
    expect(container.querySelector(".tp-read")).toHaveAttribute("data-dim", "on");
    rerender(<DocView doc={doc} focusDim={false} />);
    expect(container.querySelector(".tp-read")).toHaveAttribute("data-dim", "off");
  });
});

describe("headings are structure", () => {
  it("are not counted in 'left to say' and cannot be ticked, even by voice", () => {
    const store = useTranscriptStore.getState();
    store.clearSegments();
    const doc = markdownToDoc("# Quarterly review\n\nWelcome everyone to the meeting today.\n\n## Revenue numbers\n\nRevenue grew twelve percent over last year.");
    const ids = docBlocks(doc);
    const hook = renderHook(() =>
      usePrompter({
        doc,
        noteKey: "h",
        scrollRef: { current: null },
        contentRef: { current: null },
        reading: { ...DEFAULT_READING, mode: "manual" },
        availability: { ok: true },
      }),
    );
    expect(hook.result.current.leftToSay).toBe(2);
    expect(hook.result.current.totalBlocks).toBe(2);
    act(() =>
      store.updateInterimSegment({ id: "u1", text: "quarterly review welcome everyone to the meeting today", speaker: "User", timestamp_ms: 0, is_final: true, confidence: 1 }),
    );
    expect(hook.result.current.leftToSay).toBe(1);
    expect(hook.result.current.states.get(ids[0].id)).not.toMatch(/said/);
    act(() => hook.result.current.toggleSaid(ids[2].id)); // even a stray click on a heading's id changes nothing visible
    expect(hook.result.current.states.get(ids[2].id)).not.toMatch(/said/);
    expect(hook.result.current.leftToSay).toBe(1);
  });
});
