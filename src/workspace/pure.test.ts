import { describe, expect, it } from "vitest";
import { pickScenario } from "./scenarioOrder";
import { filterMeetings, groupMeetingsByDate } from "./meetingGroups";
import { MEDIUM_MIN, WIDE_MIN, clamp, shellModeFor } from "./layout";
import { moveInOrder } from "./order";
import { sortWorkspaces } from "./AllWorkspaces";
import { READING, itemStatus, itemTitle, sortItems } from "./libraryStatus";
import { extensionOf, supportedPaths } from "./addMaterial";
import { filterWorkspaces } from "./WorkspaceSwitcher";
import { borrowBlocker } from "./meetingScope";
import { describeContents } from "./DeleteWorkspaceDialog";
import { generalCounts } from "./WorkspaceDialog";
import { railOrder, shouldShowGeneralNote } from "../stores/workspaceStore";
import { describeAdd } from "../context/FileUpload";
import { item, meeting, ws } from "./testUtils";

describe("scenario order", () => {
  it("an explicit pick beats the workspace's, which beats the remembered and Start as", () => {
    expect(pickScenario({ explicit: "interview", workspaceDefault: "webinar", remembered: "lecture" })).toBe("interview");
    expect(pickScenario({ workspaceDefault: "webinar", remembered: "lecture", startAs: "interview" })).toBe("webinar");
    expect(pickScenario({ remembered: "lecture", startAs: "interview" })).toBe("lecture");
    expect(pickScenario({ startAs: "interview" })).toBe("interview");
    expect(pickScenario({})).toBe("team_meeting");
  });
});

describe("responsive rules", () => {
  it("three panels from 1100, a Library sheet from 820, marks only below", () => {
    expect(shellModeFor(WIDE_MIN)).toBe("wide");
    expect(shellModeFor(WIDE_MIN - 1)).toBe("medium");
    expect(shellModeFor(MEDIUM_MIN)).toBe("medium");
    expect(shellModeFor(MEDIUM_MIN - 1)).toBe("narrow");
  });
  it("clamps widths", () => {
    expect(clamp(10, 200, 360)).toBe(200);
    expect(clamp(999, 200, 360)).toBe(360);
  });
});

describe("meeting list helpers", () => {
  it("groups by day and keeps order inside a group", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 30 * 86400000).toISOString();
    const groups = groupMeetingsByDate([meeting({ id: "a" }), meeting({ id: "b", start_time: old }), meeting({ id: "c" })]);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Earlier"]);
    expect(groups[0].meetings.map((m) => m.id)).toEqual(["a", "c"]);
  });
  it("filters like the old dashboard did", () => {
    const list = [
      meeting({ id: "a", has_summary: true, audio_mode: "online" }),
      meeting({ id: "b", audio_mode: "in_person" }),
    ];
    const ids = (f: Parameters<typeof filterMeetings>[1]) => filterMeetings(list, f, new Set(["b"])).map((m) => m.id);
    expect(ids("all")).toEqual(["a", "b"]);
    expect(ids("favorites")).toEqual(["b"]);
    expect(ids("with_summary")).toEqual(["a"]);
    expect(ids("online")).toEqual(["a"]);
    expect(ids("in_person")).toEqual(["b"]);
  });
});

describe("workspace order", () => {
  const list = [
    ws({ id: "general", name: "General", sort: 0 }),
    ws({ id: "b", name: "Beta", sort: 2 }),
    ws({ id: "a", name: "Alpha", sort: 1, pinned: true }),
    ws({ id: "z", name: "Old", sort: 3, archived: true }),
  ];
  it("rail: pinned first, then General, then the rest; archived only on request", () => {
    expect(railOrder(list, false).map((w) => w.id)).toEqual(["a", "general", "b"]);
    expect(railOrder(list, true).map((w) => w.id)).toEqual(["a", "general", "b", "z"]);
  });
  it("sorts the index; pinned stay first and archived last in every order", () => {
    expect(sortWorkspaces(list, "name").map((w) => w.id)).toEqual(["a", "b", "general", "z"]);
    const busy = [ws({ id: "x", name: "X", meeting_count: 1 }), ws({ id: "y", name: "Y", meeting_count: 9 })];
    expect(sortWorkspaces(busy, "meetings").map((w) => w.id)).toEqual(["y", "x"]);
    const recent = [ws({ id: "x", name: "X", last_activity: 5 }), ws({ id: "y", name: "Y", last_activity: 50 })];
    expect(sortWorkspaces(recent, "activity").map((w) => w.id)).toEqual(["y", "x"]);
  });
  it("moves one place, stopping at the ends", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], "zzz", 1)).toEqual(["a", "b"]);
  });
  it("filters the switcher by name, then description", () => {
    const l = [{ name: "Acme", description: "client" }, { name: "Biology", description: "acme lab notes" }, { name: "Zed", description: "" }];
    expect(filterWorkspaces(l, "acme").map((w) => w.name)).toEqual(["Acme", "Biology"]);
    expect(filterWorkspaces(l, "").length).toBe(3);
  });
});

describe("the upgrade note", () => {
  const base = { loaded: true, noteSeen: false, unavailable: false };
  it("shows once, only to someone with a General that has things and no other workspace", () => {
    expect(shouldShowGeneralNote({ ...base, workspaces: [ws({ meeting_count: 3 })] })).toBe(true);
    expect(shouldShowGeneralNote({ ...base, workspaces: [ws()] })).toBe(false);
    expect(shouldShowGeneralNote({ ...base, workspaces: [ws({ meeting_count: 3 }), ws({ id: "x" })] })).toBe(false);
    expect(shouldShowGeneralNote({ ...base, noteSeen: true, workspaces: [ws({ meeting_count: 3 })] })).toBe(false);
    expect(shouldShowGeneralNote({ ...base, unavailable: true, workspaces: [ws({ meeting_count: 3 })] })).toBe(false);
  });
});

describe("library rows", () => {
  it("says each state in words", () => {
    expect(itemStatus(item()).text).toBe("Ready, 1.2k tokens");
    expect(itemStatus(item({ status: "missing" })).text).toMatch(/^Missing/);
    expect(itemStatus(item({ status: "off" })).text).toBe("Off in Settings");
    expect(itemStatus(item({ status: "indexing" }), { done: 3, total: 12 }).text).toBe("Indexing 3 of 12");
    expect(itemStatus(item({ status: "indexing", detail: READING })).text).toBe("Reading its text");
    expect(itemStatus(item({ kind: "folder" })).text).toBe("Indexed");
    const now = 10_000_000;
    expect(itemStatus(item({ kind: "folder" }), null, { folder_id: "f", files: 638, indexed_at: now - 600_000 }, now).text).toBe("Indexed · 638 files");
    expect(itemStatus(item({ kind: "folder" }), null, { folder_id: "f", files: 1, indexed_at: now - 600_000 }, now).text).toBe("Indexed · 1 file");
    expect(itemStatus(item({ kind: "folder" }), null, { folder_id: "f", files: 638, indexed_at: now - 5_000 }, now).text).toBe("Updated just now");
    expect(itemStatus(item({ kind: "folder", status: "indexing" }), { done: 120, total: 638 }, { folder_id: "f", files: 638, indexed_at: now }, now).text).toBe("Indexing 120 of 638");
    expect(itemStatus(item({ kind: "server" })).text).toBe("Ready");
  });
  it("uses the user's label and sorts pinned, then kind", () => {
    expect(itemTitle(item({ label: "The contract" }))).toBe("The contract");
    expect(itemTitle(item())).toBe("contract.pdf");
    const sorted = sortItems([
      item({ ref_id: "s", kind: "server", name: "Slack" }),
      item({ ref_id: "d", name: "b.pdf" }),
      item({ ref_id: "p", kind: "server", name: "Pinned", pinned: true }),
    ]);
    expect(sorted.map((i) => i.ref_id)).toEqual(["p", "d", "s"]);
  });
});

describe("adding files", () => {
  it("reads extensions and splits supported from the rest", () => {
    expect(extensionOf("C:\\a\\b\\Notes.MD")).toBe("md");
    expect(extensionOf("noext")).toBe("");
    expect(supportedPaths(["a.pdf", "b.png", "c.docx", "d"])).toEqual({ ok: ["a.pdf", "c.docx"], skipped: ["b.png", "d"] });
  });
  it("describes what happened in one line", () => {
    expect(describeAdd(2, 0, 0)).toBeNull();
    expect(describeAdd(0, 0, 0)).toBe("Nothing was added.");
    expect(describeAdd(1, 1, 2)).toMatch(/1 couldn't be read, 2 aren't/);
  });
});

describe("borrowing and wording", () => {
  it("explains why a workspace can't be borrowed", () => {
    const home = ws({ id: "h", name: "Home" });
    expect(borrowBlocker(home, ws({ id: "h" }))).toBe("This is its home");
    expect(borrowBlocker(home, ws({ id: "k", keep_separate: true }))).toBe("Kept separate");
    expect(borrowBlocker(ws({ id: "h", name: "Home", keep_separate: true }), ws({ id: "o" }))).toBe("Home is kept separate");
    expect(borrowBlocker(home, ws({ id: "a", archived: true }))).toBe("Archived");
    expect(borrowBlocker(home, ws({ id: "o" }))).toBeNull();
  });
  it("counts what a delete would touch and what General holds", () => {
    expect(describeContents({ meeting_count: 1, chat_count: 2 })).toBe("1 meeting and 2 chats");
    expect(generalCounts({ item_count: 0 })).toMatch(/no files/);
    expect(generalCounts({ item_count: 7 })).toMatch(/7 files and tools/);
  });
});
