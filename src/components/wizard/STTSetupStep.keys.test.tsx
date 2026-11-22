import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ saved: {} as Record<string, boolean> }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  hasApiKey: async (provider: string) => keys.saved[provider] ?? false,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

import { STTSetupStep } from "./STTSetupStep";

beforeEach(() => {
  keys.saved = {};
});
afterEach(cleanup);

describe("first-run STT step: missing API key", () => {
  it("tells the user in one plain line when the selected engine has no saved key", async () => {
    render(<STTSetupStep />);
    // Them defaults to Deepgram, which has no key here
    const note = await screen.findByText(/Deepgram needs an API key/);
    expect(note.textContent).toContain("Settings > STT Providers");
    expect(note.textContent).toContain("download and activate Parakeet TDT");
    expect(note.textContent).toContain("Presets > Free");
    expect(note.textContent).toContain("465 MB");
  });

  it("shows no note when the key is saved", async () => {
    keys.saved.deepgram = true;
    render(<STTSetupStep />);
    await screen.findAllByRole("img", { name: "API key saved" });
    expect(screen.queryByText(/needs an API key/)).toBeNull();
  });

  it("gives the key status icons a text label", async () => {
    keys.saved.deepgram = true;
    render(<STTSetupStep />);
    expect((await screen.findAllByRole("img", { name: "API key saved" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "API key missing" }).length).toBeGreaterThan(0);
  });

  it("exposes the choices as radios with the selection checked", async () => {
    render(<STTSetupStep />);
    const groups = await screen.findAllByRole("radiogroup");
    expect(groups).toHaveLength(2);
    const them = groups[1];
    const radios = Array.from(them.querySelectorAll('[role="radio"]'));
    expect(radios.length).toBeGreaterThan(1);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);

    const groq = screen.getAllByRole("radio", { name: /Groq Whisper/ })[1];
    fireEvent.click(groq);
    expect(groq.getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText(/Groq Whisper needs an API key/)).toBeTruthy();
  });

  it("is one tab stop per group and arrow keys move and select", async () => {
    render(<STTSetupStep />);
    const groups = await screen.findAllByRole("radiogroup");
    const radios = (g: HTMLElement) => Array.from(g.querySelectorAll<HTMLElement>('[role="radio"]'));
    const them = groups[1];
    expect(radios(them).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(radios(them).find((r) => r.tabIndex === 0)!.textContent).toContain("Deepgram");

    radios(them)[0].focus();
    fireEvent.keyDown(radios(them)[0], { key: "ArrowDown" });
    expect(radios(them)[1].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios(them)[1]);
    expect(radios(them)[1].tabIndex).toBe(0);
    expect(radios(them)[0].tabIndex).toBe(-1);

    fireEvent.keyDown(radios(them)[1], { key: "ArrowUp" });
    expect(radios(them)[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios(them)[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios(them)[radios(them).length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios(them)[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(radios(them)[radios(them).length - 1]);
    expect(radios(them)[radios(them).length - 1].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(radios(them)[0]);

    // the You group has its own single stop and is unaffected
    expect(radios(groups[0]).filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });
});
