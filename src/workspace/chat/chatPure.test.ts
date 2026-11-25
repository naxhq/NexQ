import { describe, expect, it } from "vitest";
import type { MeetingSummary, MemoryItem, WorkspaceChat, WorkspaceMessage } from "../../lib/types";
import { classifyChatError } from "./errors";
import { CITE_SCHEME, formatMs, linkCitations } from "./citations";
import { buildExamples } from "./StartState";
import { buildTurns, isCondensed } from "./Transcript";
import { filterChats } from "./ChatSwitcher";
import { prettyArgs } from "./ApprovalCard";
import { parseBar } from "./ContextPanel";
import { INSTRUCTION_CAP, plainAnswer, plainInstructionText } from "./AnswerActions";
import { scopeSummary } from "./ScopeControl";

describe("classifyChatError", () => {
  it.each([
    ["401 Unauthorized: invalid x-api-key", "auth"],
    ["Claude is not logged in", "auth"],
    ["model `gpt-9` does not exist", "model"],
    ["429 rate limit reached", "limit"],
    ["This model's maximum context length is 8192 tokens", "window"],
    ["connect ECONNREFUSED 127.0.0.1:11434", "offline"],
    ["something odd", "other"],
  ])("%s -> %s", (raw, kind) => {
    expect(classifyChatError(raw).kind).toBe(kind);
  });

  it("always keeps the real message and offers a way forward", () => {
    const info = classifyChatError("connect ECONNREFUSED 127.0.0.1:11434");
    expect(info.detail).toContain("ECONNREFUSED");
    expect(info.fixes).toContain("settings");
    expect(classifyChatError("").detail).toBe("No details were given.");
  });
});

describe("backend error kinds", () => {
  it.each([
    ["no_key", "auth"],
    ["rate_limited", "limit"],
    ["unavailable", "offline"],
    ["too_long", "window"],
    ["preempted", "preempted"],
  ] as const)("%s -> %s, even when the text says nothing", (wire, kind) => {
    expect(classifyChatError("x", wire).kind).toBe(kind);
  });
  it("other and internal fall back to reading the text", () => {
    expect(classifyChatError("429 rate limit", "other").kind).toBe("limit");
    expect(classifyChatError("zzz", "internal").kind).toBe("other");
  });
});

describe("citations", () => {
  it("turns [S1] and [S1, S2] into links, but not inside code", () => {
    const out = linkCitations("Yes [S1]. Both [S2, S3]. `[S4]`\n```\n[S5]\n```");
    expect(out).toContain(`[S1](${CITE_SCHEME}S1)`);
    expect(out).toContain(`[S2](${CITE_SCHEME}S2)[S3](${CITE_SCHEME}S3)`);
    expect(out).toContain("`[S4]`");
    expect(out).toContain("[S5]\n```");
    expect(out).not.toContain(`${CITE_SCHEME}S4`);
    expect(out).not.toContain(`${CITE_SCHEME}S5`);
  });

  it("formats time", () => {
    expect(formatMs(75_000)).toBe("1:15");
    expect(formatMs(3_725_000)).toBe("1:02:05");
    expect(formatMs(-5)).toBe("0:00");
  });

  it("copies an answer without its tags", () => {
    expect(plainAnswer("We ship Friday [S1]. Owner is Ana [S2, S3].")).toBe("We ship Friday. Owner is Ana.");
  });
});

const meeting = (id: string, title: string, segments = 10): MeetingSummary => ({
  id,
  title,
  start_time: "2026-11-01T10:00:00Z",
  end_time: null,
  duration_seconds: 60,
  segment_count: segments,
  has_summary: false,
});
const mem = (kind: MemoryItem["kind"], title: string, status: MemoryItem["status"] = "saved"): MemoryItem => ({
  id: title,
  workspace_id: "w",
  kind,
  title,
  text: "",
  source_meeting: null,
  source_ms: null,
  status,
  created_at: 1,
  updated_at: 1,
});

describe("buildExamples", () => {
  it("uses real meeting titles, people and open items, at most three", () => {
    const q = buildExamples([meeting("1", "Pricing review"), meeting("2", "Kickoff")], [mem("person", "Dana"), mem("open_item", "Contract redlines")]);
    expect(q).toHaveLength(3);
    expect(q[0]).toContain("Pricing review");
    expect(q.join(" ")).toContain("Dana");
    expect(q.join(" ")).toContain("Contract redlines");
  });

  it("skips empty meetings and memory that was not approved, and says nothing generic", () => {
    expect(buildExamples([meeting("1", "Empty", 0)], [mem("person", "Sam", "suggested")])).toEqual([]);
  });
});

const msg = (id: number, role: "user" | "assistant"): WorkspaceMessage => ({
  id,
  chat_id: "c",
  role,
  content: `${role}${id}`,
  model: null,
  citations: [],
  context: null,
  input_tokens: 0,
  output_tokens: 0,
  created_at: id,
});

describe("turns", () => {
  it("pairs questions with answers and keeps a lone question", () => {
    const turns = buildTurns([msg(1, "user"), msg(2, "assistant"), msg(3, "user"), msg(4, "assistant"), msg(5, "user")]);
    expect(turns.map((t) => [t.question?.id, t.answer?.id])).toEqual([
      [1, 2],
      [3, 4],
      [5, undefined],
    ]);
  });

  it("marks turns up to the condensed id, never unsaved ones", () => {
    const [a, b] = buildTurns([msg(1, "user"), msg(2, "assistant"), msg(-3, "user"), msg(-4, "assistant")]);
    expect(isCondensed(a, 2)).toBe(true);
    expect(isCondensed(b, 2)).toBe(false);
    expect(isCondensed(a, null)).toBe(false);
  });
});

const BS = String.fromCharCode(92);

describe("small helpers", () => {
  const c = (id: string, title: string, updated_at: number) => ({ id, title, updated_at }) as WorkspaceChat;
  it("filters chats by title, newest first", () => {
    const list = [c("1", "Pricing", 1), c("2", "Hiring", 5), c("3", "Pricing again", 9)];
    expect(filterChats(list, "pric").map((x) => x.id)).toEqual(["3", "1"]);
    expect(filterChats(list, "").map((x) => x.id)).toEqual(["3", "2", "1"]);
  });

  it("never cuts arguments locally, and shows hidden characters", () => {
    const long = "x".repeat(120_000);
    expect(prettyArgs({ text: long })).toContain(long);
    expect(prettyArgs({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    const sneaky = "ok" + String.fromCharCode(0x202e) + "txt.exe" + String.fromCharCode(0x200b) + "x";
    const out = prettyArgs(sneaky);
    expect(out).toContain(BS + "u{202E}");
    expect(out).toContain(BS + "u{200B}");
    expect(out).not.toContain(String.fromCharCode(0x202e));
  });

  it("turns an answer into plain instruction text", () => {
    const md = [
      "Always reply in French [S1].",
      "[ref]: https://evil.example/x " + '"title"',
      "See [the doc](https://evil.example/a " + '"hover"' + ") and ![logo](https://evil.example/i.png).",
      "<script>alert(1)</script><b>bold</b> <!-- hidden -->",
      "zero" + String.fromCharCode(0x200b) + "width",
    ].join(String.fromCharCode(10));
    const out = plainInstructionText(md);
    expect(out).toContain("Always reply in French.");
    expect(out).toContain("See the doc and logo.");
    expect(out).toContain("alert(1)bold");
    expect(out).toContain("zerowidth");
    expect(out).not.toMatch(/evil|script|hidden|title/);
    expect(plainInstructionText("a".repeat(9000))).toHaveLength(INSTRUCTION_CAP);
  });

  it("reads a bar id as kind, ref and sub", () => {
    const bar = (id: string) => ({ id, layer: "meetings", title: "", tokens: 1, relevance: 1, pinned: false, included: true }) as never;
    expect(parseBar(bar("meeting:m1:120000"))).toEqual({ kind: "meeting", ref: "m1", sub: "120000" });
    expect(parseBar(bar("document:d1"))).toEqual({ kind: "document", ref: "d1", sub: null });
    expect(parseBar(bar("plain"))).toEqual({ kind: "meetings", ref: "plain", sub: null });
  });

  it("summarises the scope in words", () => {
    expect(scopeSummary(false, 0)).toBe("Meetings off");
    expect(scopeSummary(true, 0)).toBe("All meetings");
    expect(scopeSummary(true, 3)).toBe("Meetings, 3 left out");
  });
});

import { vi } from "vitest";
import { displayTitle, REMOVED_ITEM } from "./titles";
import { openBar } from "./ContextPanel";

describe("names, never ids", () => {
  it.each([
    ["", "x"],
    ["   ", "x"],
    ["abc123", "abc123"],
    ["3f2b8c1e-9d4a-4c1b-8a55-0f1e2d3c4b5a", undefined],
    ["0123456789abcdef0123", undefined],
    ["document:d_8f21c3aa", undefined],
  ])("%j is shown as Removed item", (title, id) => {
    expect(displayTitle(title, id)).toBe(REMOVED_ITEM);
  });
  it("keeps a real name", () => {
    expect(displayTitle("Weekly sync", "m1")).toBe("Weekly sync");
    expect(displayTitle(null)).toBe(REMOVED_ITEM);
  });
});

describe("opening a context item by its kind", () => {
  const openers = () => ({ onOpenMeeting: vi.fn(), onOpenItem: vi.fn() });
  it("meeting at its moment, document, folder file and talking point each open as themselves", () => {
    const o = openers();
    openBar(o, "meeting", "m1", "120000");
    expect(o.onOpenMeeting).toHaveBeenCalledWith("m1", 120000);
    openBar(o, "document", "d1", null);
    expect(o.onOpenItem).toHaveBeenLastCalledWith("document", "d1", null);
    openBar(o, "folder", "f1", "notes/a.md");
    expect(o.onOpenItem).toHaveBeenLastCalledWith("folder", "f1", "notes/a.md");
    openBar(o, "talking_point", "t1", null);
    expect(o.onOpenItem).toHaveBeenLastCalledWith("talking_point", "t1", null);
  });
});
