import { beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportToMarkdown, saveExportFile } from "./export";
import { useScenarioStore } from "../stores/scenarioStore";
import type { Meeting, ScenarioTemplate } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("../stores/toastStore", () => ({ showToast: vi.fn() }));

const exportTitle = (defaultName: string) => saveExportFile({
  defaultName,
  extension: "md",
  filterLabel: "Markdown",
  content: "Meeting notes",
});

describe("Markdown export's scenario", () => {
  const markdown = (ai_scenario: Meeting["ai_scenario"]) =>
    exportToMarkdown({ id: "m-1", title: "Standup", start_time: "2026-10-19T13:00:00Z", transcript: [], ai_interactions: [], ai_scenario } as unknown as Meeting);

  it("reads a built-in scenario's id as words", () => {
    expect(markdown("team_meeting")).toContain("**Scenario:** team meeting");
  });

  it("uses a custom scenario's name", () => {
    useScenarioStore.setState({
      customScenarios: [{ id: "custom_1", name: "Board review", is_custom: true } as ScenarioTemplate],
    });
    expect(markdown("custom_1")).toContain("**Scenario:** Board review");
    useScenarioStore.setState({ customScenarios: [] });
  });
});

describe("export filenames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(save).mockResolvedValue(null);
  });

  it.each([
    "项目讨论 2026", "專案會議", "日本語の会議", "한국어 회의",
    "Réunion café", "Cafe\u0301", "Обсуждение", "اجتماع ١٢٣",
    "Sprint_42 - review", "Release v2.3 (final) — notes, 100%! 🎉",
  ])("preserves valid filename characters in %s", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith({
      defaultPath: `${title}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  });

  it("removes path separators, reserved punctuation and control characters", async () => {
    await exportTitle('项目<>:"/\\|?*\u0000\u0001\u001f讨论');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "项目讨论.md" }));
  });

  it.each(["", "   ", '<>:"/\\|?*', ".", "..", "... "])("falls back for an empty sanitized title %j", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "meeting.md" }));
  });

  it("removes trailing dots and spaces", async () => {
    await exportTitle("  项目讨论. . ");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "项目讨论.md" }));
  });

  it.each(["CON", "prn", "Aux", "NUL", "COM1", "LPT9", "COM¹", "LPT²", "con.notes"])("escapes Windows device name %s", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `_${title}.md` }));
  });

  it("writes to the Unicode path selected by the user", async () => {
    vi.mocked(save).mockResolvedValue("/exports/项目讨论.md");
    expect(await exportTitle("项目讨论")).toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith("/exports/项目讨论.md", "Meeting notes");
  });
});
