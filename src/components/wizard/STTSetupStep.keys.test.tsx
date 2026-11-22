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
});
