import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }) }));

import { shouldToastMaterial } from "./materialNotice";
import { CitationChip } from "./chat/Prose";
import { useSourcesStore } from "../stores/sourcesStore";
import { mockBackend } from "./testUtils";
import type { WorkspaceCitation } from "../lib/types";
import * as ipc from "../lib/ipc";

afterEach(() => cleanup());

describe("material that could not be used", () => {
  it("speaks in exactly one window: the meeting window during a meeting, else the launcher", () => {
    expect(shouldToastMaterial("overlay", true, "m1")).toBe(true);
    expect(shouldToastMaterial("launcher", true, "m1")).toBe(false);
    expect(shouldToastMaterial("launcher", false, "m1")).toBe(true);
    expect(shouldToastMaterial("overlay", false, "m1")).toBe(false);
    expect(shouldToastMaterial("launcher", true, null)).toBe(true);
    expect(shouldToastMaterial("overlay", true, null)).toBe(false);
    expect(shouldToastMaterial("", true, "m1")).toBe(false);
  });
});

describe("citations whose source left the workspace", () => {
  const base: WorkspaceCitation = { tag: "S1", kind: "document", ref_id: "d1", sub_ref: null, title: "plan.pdf", start_ms: null, snippet: "x" };

  it("shows a muted chip with the reason, and opens nothing", () => {
    const open = vi.fn();
    render(<CitationChip tag="S1" live={false} citation={{ ...base, ref_id: "", title: "Removed source", snippet: "Removed from the workspace" }} onOpen={open} />);
    const chip = screen.getByRole("note", { name: "Source S1: Removed from the workspace" });
    expect(chip).toHaveAttribute("tabindex", "0");
    chip.click();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Source S1/ })).toBeNull();
  });

  it("is still a button when the source is there", () => {
    const open = vi.fn();
    render(<CitationChip tag="S1" live={false} citation={base} onOpen={open} />);
    screen.getByRole("button", { name: /Source S1/ }).click();
    expect(open).toHaveBeenCalledWith(base);
  });
});

describe("pushing personal sources", () => {
  it("says loaded only after the config was read from disk", async () => {
    const b = mockBackend();
    useSourcesStore.setState({ loaded: false });
    await useSourcesStore.getState().setConfig(useSourcesStore.getState().config);
    expect("loaded" in b.called("set_personal_sources")[0].args).toBe(false);
    useSourcesStore.setState({ loaded: true });
    await useSourcesStore.getState().setConfig(useSourcesStore.getState().config);
    expect(b.called("set_personal_sources")[1].args.loaded).toBe(true);
  });

  it("the old assembled-context wrapper is gone", () => {
    expect("getAssembledContext" in ipc).toBe(false);
  });
});
