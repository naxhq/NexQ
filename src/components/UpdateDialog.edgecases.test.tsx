import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const installUpdateNow = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  installUpdateNow: () => installUpdateNow(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

vi.mock("../lib/version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/version")>()),
  NEXQ_VERSION: "2.0.0",
}));

import { UpdateDialog } from "./UpdateDialog";
import { useUpdaterStore } from "../stores/updaterStore";

const state = () => useUpdaterStore.getState();

function changelog(markdown: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, text: async () => markdown }),
  );
}

function open(version: string) {
  state().setReady(version);
  render(<UpdateDialog />);
  act(() => state().setDialogOpen(true));
}

const heading = (version: string, date = "2026-11-05") =>
  `# [${version}](https://x/compare) (${date})\n\n`;
const item = (text: string) => `* **scope:** ${text} ([abc1234](https://x/commit))\n`;

const FALLBACK = /nothing new to call out/i;

describe("UpdateDialog with unusual release notes", () => {
  beforeEach(() => {
    state().reset();
    useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
    installUpdateNow.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a single change reads as one line, without a version heading", async () => {
    changelog(`${heading("2.1.0")}### Bug Fixes\n\n${item("the one fix")}`);
    open("2.1.0");

    await screen.findByText("The one fix");
    expect(screen.queryByText(/releases since/i)).toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("a release with no listed changes says so instead of leaving a blank box", async () => {
    changelog(heading("2.1.0"));
    open("2.1.0");

    await screen.findByText(FALLBACK);
    const install = screen.getByRole("button", { name: /install/i }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
  });

  it("a version the changelog doesn't have yet says the same", async () => {
    changelog(`${heading("1.9.0")}### Features\n\n${item("too old to show")}`);
    open("2.1.0");

    await screen.findByText(FALLBACK);
    expect(screen.queryByText("Too old to show")).toBeNull();
  });

  it("text that isn't a changelog says the same", async () => {
    changelog("<html>Rate limited</html>");
    open("2.1.0");
    await screen.findByText(FALLBACK);
  });

  it("skips empty releases in a jump, and still names the release that had changes", async () => {
    changelog(
      `${heading("2.2.0")}${heading("2.1.0", "2026-10-01")}### Features\n\n${item("older change")}`,
    );
    open("2.2.0");

    await screen.findByText("Older change");
    expect(screen.getByText("2.1.0")).toBeTruthy();
    expect(screen.queryByText("2.2.0", { selector: "section *" })).toBeNull();
    expect(screen.queryByText(FALLBACK)).toBeNull();
  });

  it("still gives the release date when the release itself lists nothing", async () => {
    changelog(heading("2.1.0"));
    open("2.1.0");
    await screen.findByText(FALLBACK);
    expect(screen.getByText(/Released Nov 5, 2026/)).toBeTruthy();
  });

  it("a long jump starts with the newest releases, says how many, and can show the rest", async () => {
    const releases = Array.from({ length: 40 }, (_, i) => {
      const v = `2.${40 - i}.0`;
      return `${heading(v)}### Features\n\n${item(`change in ${v}`)}`;
    }).join("");
    changelog(releases);
    open("2.40.0");

    await screen.findByText("Change in 2.40.0");
    expect(screen.getByText(/40 releases since yours/)).toBeTruthy();
    expect(screen.getByText("Change in 2.36.0")).toBeTruthy();
    expect(screen.queryByText("Change in 2.35.0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show 35 older releases" }));

    expect(screen.getByText("Change in 2.35.0")).toBeTruthy();
    expect(screen.getByText("Change in 2.1.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  });

  it("no button when every release already fits", async () => {
    const releases = Array.from({ length: 5 }, (_, i) => {
      const v = `2.${5 - i}.0`;
      return `${heading(v)}### Features\n\n${item(`change in ${v}`)}`;
    }).join("");
    changelog(releases);
    open("2.5.0");

    await screen.findByText("Change in 2.1.0");
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  });

  it("the footer stays reachable however long the notes are", async () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`change number ${i}`)).join("");
    changelog(`${heading("2.1.0")}### Features\n\n${many}`);
    open("2.1.0");

    await screen.findByText("Change number 199");
    const scroller = screen.getByText("Change number 199").closest("[data-update-notes]");
    expect(scroller?.className).toContain("overflow-y-auto");
    const footer = screen.getByRole("button", { name: /install/i }).closest("footer");
    expect(scroller?.contains(footer)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    await waitFor(() => expect(installUpdateNow).toHaveBeenCalledTimes(1));
  });

  it("the fade at the bottom shows only while there's more to scroll to", async () => {
    changelog(`${heading("2.1.0")}### Features\n\n${item("a change")}`);
    open("2.1.0");
    await screen.findByText("A change");

    const scroller = document.querySelector("[data-update-notes]") as HTMLElement;
    const fade = scroller.parentElement!.querySelector('[aria-hidden="true"]') as HTMLElement;
    const size = (scrollTop: number) => {
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
      scroller.scrollTop = scrollTop;
      fireEvent.scroll(scroller);
    };

    expect(fade.className).toContain("opacity-0");
    size(0);
    expect(fade.className).toContain("opacity-100");
    size(700);
    expect(fade.className).toContain("opacity-0");
  });

  it("repeated lines don't trip React", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    changelog(`${heading("2.1.0")}### Features\n\n${item("same text")}${item("same text")}`);
    open("2.1.0");

    expect((await screen.findAllByText("Same text")).length).toBe(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows markup in a note as text", async () => {
    changelog(`${heading("2.1.0")}### Features\n\n${item("<b>bold</b> stays literal")}`);
    open("2.1.0");
    await screen.findByText("<b>bold</b> stays literal");
  });
});
