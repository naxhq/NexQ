import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { InfoTip } from "../ui";
import { deriveNoteTitle } from "./addMaterial";
import { KIND_LOOK, libraryKindOf } from "./libraryKinds";
import { item } from "./testUtils";

afterEach(() => cleanup());

describe("the kinds of library item", () => {
  it("tells a note from a document by what the backend says the file is", () => {
    expect(libraryKindOf(item({ detail: "pdf" }))).toBe("document");
    expect(libraryKindOf(item({ detail: null }))).toBe("document");
    expect(libraryKindOf(item({ detail: "note" }))).toBe("note");
    expect(libraryKindOf(item({ kind: "folder", detail: "C:\notes" }))).toBe("folder");
    expect(libraryKindOf(item({ kind: "server", detail: "stdio" }))).toBe("tool");
  });

  it("gives each kind its own word and icon, and only text tokens the contrast guard covers", () => {
    const words = Object.values(KIND_LOOK).map((k) => k.word);
    expect(new Set(words).size).toBe(4);
    expect(new Set(Object.values(KIND_LOOK).map((k) => k.Icon)).size).toBe(4);
    for (const k of Object.values(KIND_LOOK)) {
      // Tints are made from the -text tokens (readable on their own 5, 10 and 20% tints), never from a fill colour.
      if (k.tile.includes("hsl(")) expect(k.tile).toMatch(/--(info|success|violet)-text\)\/0\.12/);
    }
  });
});

describe("a title for pasted text", () => {
  it("is its first line without the Markdown marks in front, on one line", () => {
    expect(deriveNoteTitle("## Budget talk\nmore")).toBe("Budget talk");
    expect(deriveNoteTitle("\n  \n- first   item\nsecond")).toBe("first item");
    expect(deriveNoteTitle("   ")).toBe("");
    expect(deriveNoteTitle("x".repeat(200))).toHaveLength(80);
  });
});

describe("the info button", () => {
  it("opens on keyboard focus, closes on Escape, and is a named button (no title attribute)", async () => {
    render(
      <InfoTip label="About the thing">Long explanation of the thing.</InfoTip>,
    );
    const btn = screen.getByRole("button", { name: "About the thing" });
    expect(btn).not.toHaveAttribute("title");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.tab();
    expect(btn).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Long explanation of the thing.");
    expect(btn).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
