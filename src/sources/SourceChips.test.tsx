import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceChip } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const openSourceFile = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  openSourceFile: (...args: unknown[]) => openSourceFile(...args),
}));

import { SourceChips, dedupeChips } from "./SourceChips";
import { useToastStore } from "../stores/toastStore";

const note: SourceChip = { kind: "notes", label: "Dana.md", path: "D:\\V\\Dana.md" };
const tool: SourceChip = { kind: "tool", label: "Mira: person_brief", path: null };

beforeEach(() => {
  openSourceFile.mockReset();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => cleanup());

describe("dedupeChips", () => {
  it("keeps first-seen order", () => {
    expect(dedupeChips([note, tool, note])).toEqual([note, tool]);
    expect(dedupeChips([tool, note, tool, { ...note, path: "D:\\Other\\Dana.md" }])).toHaveLength(3);
  });
});

describe("SourceChips", () => {
  it("a notes chip is a button that opens the file; a tool chip is plain text", () => {
    openSourceFile.mockResolvedValue(undefined);
    render(<SourceChips chips={[note, tool]} />);
    fireEvent.click(screen.getByRole("button", { name: /Dana\.md/ }));
    expect(openSourceFile).toHaveBeenCalledWith("D:\\V\\Dana.md");
    expect(screen.getByText("Mira: person_brief").closest("button")).toBeNull();
  });

  it("toasts when the file can't be opened", async () => {
    openSourceFile.mockRejectedValue("That file is not inside one of your notes folders.");
    render(<SourceChips chips={[note]} />);
    fireEvent.click(screen.getByRole("button", { name: /Dana\.md/ }));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    expect(useToastStore.getState().toasts[0].message).toContain("That file is not inside one of your notes folders.");
  });

  it("renders nothing for no chips", () => {
    const { container } = render(<SourceChips chips={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
