import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointSaid, TranscriptSegment } from "../../lib/types";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { DEFAULT_READING, type ReadingSettings } from "../../stores/talkingPointsStore";
import { marksToSaid, saidToMarks, followAvailability, VoiceBridge } from "./voice";
import { usePrompter } from "./usePrompter";
import { groupLines } from "./measure";
import { rankNotes } from "./Switcher";
import { docBlocks, docFromText } from "../doc/model";

const seg = (id: string, text: string, o: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  text,
  speaker: "User",
  timestamp_ms: 0,
  is_final: true,
  confidence: 0.9,
  ...o,
});

describe("VoiceBridge", () => {
  const sink = () => ({ onInterim: vi.fn(), onFinal: vi.fn() });

  it("passes on the You side only, interims and finals, once per change", () => {
    const s = sink();
    const b = new VoiceBridge([s]);
    b.push([seg("1", "hello there", { is_final: false })]);
    b.push([seg("1", "hello there", { is_final: false })]); // no change
    b.push([seg("1", "hello there everyone", { is_final: false })]);
    b.push([seg("1", "hello there everyone", { is_final: true })]);
    b.push([seg("2", "their words", { speaker: "Them" }), seg("3", "interviewer", { speaker: "Interviewer" }), seg("4", "who", { speaker: "Unknown" })]);
    expect(s.onInterim.mock.calls.map((c) => c[0])).toEqual(["hello there", "hello there everyone"]);
    expect(s.onFinal.mock.calls.map((c) => c[0])).toEqual(["hello there everyone"]);
    expect(s.onInterim.mock.calls.concat(s.onFinal.mock.calls).every((c) => c[1] === "1")).toBe(true);
  });

  it("a final line that keeps growing is passed as its longer text", () => {
    const s = sink();
    const b = new VoiceBridge([s]);
    b.push([seg("1", "first part")]);
    b.push([seg("1", "first part", { pending_text: "first part and more" })]);
    expect(s.onFinal.mock.calls.map((c) => c[0])).toEqual(["first part", "first part and more"]);
  });

  it("does not replay what was said before it started listening", () => {
    const s = sink();
    const b = new VoiceBridge([s]);
    const old = [seg("1", "old words")];
    b.prime(old);
    b.push(old);
    expect(s.onFinal).not.toHaveBeenCalled();
    b.push([...old, seg("2", "new words")]);
    expect(s.onFinal).toHaveBeenCalledTimes(1);
  });

  it("ignores empty text", () => {
    const s = sink();
    new VoiceBridge([s]).push([seg("1", "   ")]);
    expect(s.onFinal).not.toHaveBeenCalled();
  });
});

describe("followAvailability", () => {
  it("is available online with the mic open", () => {
    expect(followAvailability({ audioMode: "online", mutedYou: false, youEngine: "deepgram" })).toEqual({ ok: true });
  });
  it("says why when it is not", () => {
    const a = followAvailability({ audioMode: "in_person", mutedYou: false, youEngine: "x" });
    expect(a).toMatchObject({ ok: false, reason: "in_person" });
    const b = followAvailability({ audioMode: "online", mutedYou: true, youEngine: "x" });
    expect(b).toMatchObject({ ok: false, reason: "muted" });
    const c = followAvailability({ audioMode: "online", mutedYou: false, youEngine: "none" });
    expect(c).toMatchObject({ ok: false, reason: "no_engine" });
    for (const r of [a, b, c]) expect(r.ok === false && r.message.length > 20).toBe(true);
  });
  it("in-person wins over the other reasons", () => {
    expect(followAvailability({ audioMode: "in_person", mutedYou: true, youEngine: "none" })).toMatchObject({ reason: "in_person" });
  });
});

describe("said-it persistence", () => {
  it("round trips manual and voice marks", () => {
    const said: PointSaid[] = [
      { block_id: "a", by: "voice", ticked: true },
      { block_id: "b", by: "manual", ticked: true },
      { block_id: "c", by: "manual", ticked: false },
    ];
    const marks = saidToMarks(said);
    expect(marks).toEqual({ a: "auto", b: "manual_on", c: "manual_off" });
    expect(marksToSaid(marks)).toEqual(said);
    expect(saidToMarks(null)).toEqual({});
  });
});

describe("groupLines", () => {
  it("starts a new line when a token begins below the line, and at a new block", () => {
    const b = (block: number, top: number) => ({ block, top, bottom: top + 20 });
    const lines = groupLines([b(0, 0), b(0, 1), b(0, 0), b(0, 24), b(0, 24), null, b(1, 60), b(1, 60)]);
    expect(lines.map((l) => [l.startToken, l.endToken])).toEqual([
      [0, 3],
      [3, 6],
      [6, 8],
    ]);
  });
});

describe("rankNotes", () => {
  const notes = [
    { id: "a", title: "Opening", text: "welcome", sort: 0 },
    { id: "b", title: "Pricing", text: "the opening offer", sort: 1 },
    { id: "c", title: "Close", text: "thanks", sort: 2 },
  ];
  it("puts recent notes first, then the rest in order", () => {
    expect(rankNotes(notes, ["c", "a"], "").map((n) => n.id)).toEqual(["c", "a", "b"]);
  });
  it("filters on the title first, then on the text", () => {
    expect(rankNotes(notes, [], "open").map((n) => n.id)).toEqual(["a", "b"]);
    expect(rankNotes(notes, [], "zzz")).toEqual([]);
  });
});

// -- the engine with scripted speech ----------------------------------------------------------

const NOTE = [
  "Welcome everyone to the quarterly review.",
  "First, revenue grew twelve percent compared with last year.",
  "Second, we hired fourteen engineers across three product teams.",
].join("\n\n");

function setup(over: Partial<ReadingSettings> = {}, avail: Parameters<typeof followAvailability>[0] = { audioMode: "online", mutedYou: false, youEngine: "deepgram" }) {
  const doc = docFromText(NOTE.replace(/\n\n/g, "\n"));
  const onSaidChange = vi.fn();
  const scrollRef = { current: document.createElement("div") };
  const contentRef = { current: document.createElement("div") };
  const reading: ReadingSettings = { ...DEFAULT_READING, mode: "voice", saidIt: true, ...over };
  const hook = renderHook(
    (p: { reading: ReadingSettings; avail: typeof avail }) =>
      usePrompter({
        doc,
        noteKey: "n1",
        scrollRef,
        contentRef,
        reading: p.reading,
        availability: followAvailability(p.avail),
        onSaidChange,
        reducedMotion: true,
      }),
    { initialProps: { reading, avail } },
  );
  return { hook, doc, onSaidChange, ids: docBlocks(doc).map((b) => b.id) };
}

const store = () => useTranscriptStore.getState();

beforeEach(() => {
  store().clearSegments();
});
afterEach(() => {
  store().clearSegments();
});

function say(id: string, text: string, o: Partial<TranscriptSegment> = {}) {
  act(() => store().updateInterimSegment(seg(id, text, o)));
}

describe("usePrompter with scripted speech", () => {
  it("starts with everything left to say", () => {
    const { hook } = setup();
    expect(hook.result.current.leftToSay).toBe(3);
    expect(hook.result.current.totalBlocks).toBe(3);
    expect(hook.result.current.followState).not.toBe("following");
  });

  it("ticks a block when the user says it, follows the place, counts what is left", () => {
    const { hook, ids, onSaidChange } = setup();
    say("u1", "welcome everyone to the", { is_final: false });
    say("u1", "welcome everyone to the quarterly review", { is_final: true });
    expect(hook.result.current.states.get(ids[0])).toBe("autosaid");
    expect(hook.result.current.leftToSay).toBe(2);
    expect(onSaidChange).toHaveBeenCalled();
    const last = onSaidChange.mock.calls[onSaidChange.mock.calls.length - 1][0] as PointSaid[];
    expect(last).toEqual([{ block_id: ids[0], by: "voice", ticked: true }]);
    say("u2", "first revenue grew twelve percent", { is_final: false });
    expect(hook.result.current.followState).toBe("following");
    expect(hook.result.current.currentBlockId).toBe(ids[1]);
    expect(hook.result.current.followPosition).toBeGreaterThan(5);
    expect(hook.result.current.states.get(ids[1])).toBe("current");
    expect(hook.result.current.states.get(ids[2])).toBe("ahead");
  });

  it("never reacts to the other side", () => {
    const { hook, ids } = setup();
    say("t1", "welcome everyone to the quarterly review first revenue grew twelve percent", { speaker: "Them" });
    say("t2", "second we hired fourteen engineers across three product teams", { speaker: "Interviewer" });
    expect(hook.result.current.leftToSay).toBe(3);
    expect(hook.result.current.followState).not.toBe("following");
    expect(hook.result.current.states.get(ids[0])).not.toBe("said");
  });

  it("ignores interim guesses that are later taken back", () => {
    const { hook, ids } = setup();
    say("u1", "welcome everyone to the", { is_final: false });
    say("u1", "banana smoothie recipe", { is_final: false });
    expect(hook.result.current.states.get(ids[0])).not.toBe("said");
  });

  it("a click on a tick overrides the voice, and survives later speech", () => {
    const { hook, ids } = setup();
    act(() => hook.result.current.toggleSaid(ids[2]));
    expect(hook.result.current.states.get(ids[2])).toBe("said");
    expect(hook.result.current.leftToSay).toBe(2);
    act(() => hook.result.current.toggleSaid(ids[2]));
    expect(hook.result.current.states.get(ids[2])).not.toBe("said");
    say("u1", "second we hired fourteen engineers across three product teams");
    expect(hook.result.current.states.get(ids[2])).not.toBe("said"); // manual untick wins
    expect(hook.result.current.leftToSay).toBe(3);
  });

  it("when muted, nothing is followed or ticked", () => {
    const { hook, ids } = setup({}, { audioMode: "online", mutedYou: true, youEngine: "x" });
    say("u1", "welcome everyone to the quarterly review");
    expect(hook.result.current.followState).toBe("off");
    expect(hook.result.current.states.get(ids[0])).not.toBe("said");
    expect(hook.result.current.leftToSay).toBe(3);
  });

  it("in an in-person meeting there is no You side to follow", () => {
    const { hook } = setup({}, { audioMode: "in_person", mutedYou: false, youEngine: "x" });
    say("u1", "welcome everyone to the quarterly review");
    expect(hook.result.current.followState).toBe("off");
    expect(hook.result.current.leftToSay).toBe(3);
  });

  it("unmuting starts listening again", () => {
    const { hook, ids } = setup({}, { audioMode: "online", mutedYou: true, youEngine: "x" });
    hook.rerender({ reading: { ...DEFAULT_READING, mode: "voice", saidIt: true }, avail: { audioMode: "online", mutedYou: false, youEngine: "x" } });
    say("u1", "welcome everyone to the quarterly review");
    expect(hook.result.current.states.get(ids[0])).toBe("autosaid");
  });

  it("said-it can be switched off and then nothing ticks or settles", () => {
    const { hook, ids } = setup({ saidIt: false });
    say("u1", "welcome everyone to the quarterly review");
    expect(hook.result.current.states.get(ids[0])).not.toBe("said");
    expect([...hook.result.current.states.values()].includes("said")).toBe(false);
  });

  it("voice following can be off while said-it still ticks (manual mode)", () => {
    const { hook, ids } = setup({ mode: "manual" });
    say("u1", "welcome everyone to the quarterly review");
    expect(hook.result.current.states.get(ids[0])).toBe("autosaid");
    expect(hook.result.current.followState).toBe("off");
  });

  it("saved ticks come back when the note opens", () => {
    const doc = docFromText("one two three\ntwo more words here");
    const ids = docBlocks(doc).map((b) => b.id);
    const hook = renderHook(() =>
      usePrompter({
        doc,
        noteKey: "n2",
        scrollRef: { current: null },
        contentRef: { current: null },
        reading: { ...DEFAULT_READING },
        availability: { ok: true },
        savedSaid: [{ block_id: ids[0], by: "manual", ticked: true }],
      }),
    );
    expect(hook.result.current.states.get(ids[0])).toBe("said");
    expect(hook.result.current.leftToSay).toBe(1);
  });

  it("only the newest lines are walked, so a long meeting stays cheap", () => {
    setup();
    const t0 = performance.now();
    for (let i = 0; i < 400; i++) act(() => store().updateInterimSegment(seg(`x${i}`, `filler words number ${i}`)));
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

