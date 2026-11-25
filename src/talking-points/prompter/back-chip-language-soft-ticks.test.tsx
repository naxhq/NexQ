import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READING } from "../../stores/talkingPointsStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { usePrompter, BACK_CHIP_MS, type FollowerLike } from "./usePrompter";
import { detectLanguage, languageFromCode, languageNote, resolveLanguage } from "./language";
import { DocView } from "../reader/DocView";
import { docBlocks, docFromText } from "../doc/model";

const lines = Array.from({ length: 6 }, (_, i) => Array.from({ length: 12 }, (_, k) => `word${i}x${k}`).join(" "));
const doc = docFromText(lines.join("\n"));
const ids = docBlocks(doc).map((b) => b.id);

function setup() {
  let snap = { position: 2, confidence: 0.9, state: "following" as const, suggestion: null as null };
  const seek = vi.fn();
  const f: FollowerLike = {
    onInterim: () => undefined,
    onFinal: () => undefined,
    snapshot: () => snap,
    seek,
    reset: () => undefined,
    setIndex: () => undefined,
  };
  const hook = renderHook(() =>
    usePrompter({
      doc,
      noteKey: "n",
      scrollRef: { current: null },
      contentRef: { current: null },
      reading: { ...DEFAULT_READING, mode: "voice" },
      availability: { ok: true },
      follower: f,
      reducedMotion: true,
    }),
  );
  return { hook, seek, move: (position: number) => (snap = { ...snap, position }) };
}
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("Back to where I was", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers a way back after a big automatic move, for eight seconds", () => {
    const { hook, move } = setup();
    tick(800); // baseline
    expect(hook.result.current.canGoBack).toBe(false);
    move(40);
    tick(800);
    expect(hook.result.current.canGoBack).toBe(true);
    tick(BACK_CHIP_MS + 100);
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("also for a move to a block that is not next door, but not for small steps", () => {
    const { hook, move } = setup();
    tick(800);
    move(11); // same block, a few words on
    tick(800);
    expect(hook.result.current.canGoBack).toBe(false);
    move(24); // only 13 words on, but two blocks further
    tick(800);
    expect(hook.result.current.canGoBack).toBe(true);
  });

  it("going back returns to the old place and makes the follower hold there", () => {
    const { hook, seek, move } = setup();
    tick(800);
    move(60);
    tick(800);
    act(() => hook.result.current.goBack());
    expect(seek).toHaveBeenCalledWith(2);
    expect(hook.result.current.canGoBack).toBe(false);
    expect(hook.result.current.currentBlockId).toBe(ids[0]);
    // the follower still says 60 for a moment: that is not a new big move
    tick(800);
    expect(hook.result.current.canGoBack).toBe(true); // it moved again by itself: offer again
  });
});

describe("language honesty", () => {
  it("says nothing for English and French, and plain words for the rest", () => {
    expect(languageNote("en")).toBeNull();
    expect(languageNote("fr")).toBeNull();
    expect(languageNote(null)).toBeNull();
    for (const [l, name] of [["es", "Spanish"], ["pt", "Portuguese"], ["ar", "Arabic"], ["de", "German"]] as const) {
      expect(languageNote(l)).toBe(`Ticks may be missed in ${name}.`);
    }
    for (const [l, name] of [["ja", "Japanese"], ["zh", "Chinese"], ["ko", "Korean"]] as const) {
      expect(languageNote(l)).toBe(`Ticks often miss rephrased lines in ${name}.`);
    }
  });

  it("reads the language from the You side's setting first", () => {
    expect(languageFromCode("ja-JP")).toBe("ja");
    expect(languageFromCode("zh-CN")).toBe("zh");
    expect(languageFromCode("auto")).toBeNull();
    expect(languageFromCode("")).toBeNull();
    expect(resolveLanguage("fr-FR", "こんにちは")).toBe("fr");
    expect(resolveLanguage("auto", "こんにちは世界")).toBe("ja");
  });

  it("falls back to the note's script and common words", () => {
    expect(detectLanguage("会議の目的は売上の確認です")).toBe("ja");
    expect(detectLanguage("분기 매출을 검토합니다")).toBe("ko");
    expect(detectLanguage("我们今天讨论季度收入")).toBe("zh");
    expect(detectLanguage("مرحبا بكم في الاجتماع الفصلي")).toBe("ar");
    expect(detectLanguage("Wir sind heute hier und wir sprechen über die Zahlen mit der Gruppe")).toBe("de");
    expect(detectLanguage("Nosotros vamos a hablar de los números para el equipo con una idea")).toBe("es");
    expect(detectLanguage("Vamos falar para o time com uma ideia que não é de todos os dias")).toBe("pt");
    expect(detectLanguage("We are going to review the numbers and the plan for the team")).toBe("en");
    expect(detectLanguage("ok")).toBeNull();
  });
});

describe("auto ticks are softer than manual ones", () => {
  afterEach(cleanup);
  it("marks voice ticks differently from hand ticks", () => {
    const states = new Map([[ids[0], "autosaid" as const], [ids[1], "said" as const]]);
    const { container, getAllByRole } = render(<DocView doc={doc} states={states} ticks />);
    expect(container.querySelector(`[data-block-id="${ids[0]}"]`)).toHaveAttribute("data-state", "autosaid");
    const ticks = getAllByRole("button", { name: /^Said it:/ });
    expect(ticks[0]).toHaveAttribute("data-auto");
    expect(ticks[0].getAttribute("aria-label")).toContain("heard by voice");
    expect(ticks[0]).toHaveAttribute("aria-pressed", "true");
    expect(ticks[1]).not.toHaveAttribute("data-auto");
    expect(ticks[1]).toHaveAttribute("aria-pressed", "true");
  });

  it("the hook reports voice ticks as autosaid and a click as said", () => {
    const store = useTranscriptStore.getState();
    store.clearSegments();
    const d = docFromText("Welcome everyone to the quarterly review\nRevenue grew twelve percent compared with last year");
    const bid = docBlocks(d).map((b) => b.id);
    const hook = renderHook(() =>
      usePrompter({
        doc: d,
        noteKey: "m",
        scrollRef: { current: null },
        contentRef: { current: null },
        reading: { ...DEFAULT_READING, mode: "manual" },
        availability: { ok: true },
      }),
    );
    act(() =>
      store.updateInterimSegment({ id: "u1", text: "welcome everyone to the quarterly review", speaker: "User", timestamp_ms: 0, is_final: true, confidence: 1 }),
    );
    expect(hook.result.current.states.get(bid[0])).toBe("autosaid");
    act(() => hook.result.current.toggleSaid(bid[1]));
    expect(hook.result.current.states.get(bid[1])).toBe("said");
    act(() => hook.result.current.toggleSaid(bid[0])); // unticking a wrong voice tick
    expect(hook.result.current.states.get(bid[0])).not.toMatch(/said/);
  });
});
