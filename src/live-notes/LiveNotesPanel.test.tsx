import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotetakerSettings, NotetakerState } from "../lib/types";
import { sampleDoc } from "./fixtures";
import { ns } from "./testing";

vi.mock("../lib/ipc", () => ({
  getAutomaticModel: async () => null,
  cliAgentStatus: async () => null,
  getApiKey: async () => null,
  getLLMProviders: async () => ["openai", "groq"],
  listModels: async () => [],
  cliAgentModels: async () => [],
  searchWorkspace: async () => [],
}));
vi.mock("../lib/events", async () => {
  const hotkeys = await import("../lib/hotkeys");
  return {
    onNotesUpdateRequested: (handler: () => void) => {
      window.addEventListener(hotkeys.NOTES_UPDATE_EVENT, handler);
      return () => window.removeEventListener(hotkeys.NOTES_UPDATE_EVENT, handler);
    },
  };
});

import { NotesPanel, statusWords } from "./LiveNotesPanel";
import { EMPTY_ENTRY, useLiveNotesStore, DEFAULT_NOTETAKER_SETTINGS } from "../stores/liveNotesStore";
import { useMeetingStore } from "../stores/meetingStore";
import { NOTES_UPDATE_EVENT } from "../lib/hotkeys";

const calls = vi.hoisted(() => [] as string[]);

function seed(opts: { settings?: Partial<NotetakerSettings>; run?: Partial<NotetakerState> | null; doc?: boolean; error?: string | null }) {
  const spy = (name: string) => vi.fn(async () => void calls.push(name));
  useLiveNotesStore.setState({
    entries: { m1: { ...EMPTY_ENTRY, doc: opts.doc === false ? { version: 1, blocks: [] } : structuredClone(sampleDoc) } },
    settings: { ...DEFAULT_NOTETAKER_SETTINGS, enabled: true, ...opts.settings },
    runs: opts.run === null ? {} : { m1: ns(opts.run?.status ?? "running", opts.run?.can, { tokens_used: 42000, ...opts.run }) },
    watchSettings: async () => () => {},
    error: opts.error ?? null,
    // The panel attaches on mount; the store's own attach is replaced so no IPC is needed.
    attach: async () => () => {},
    updateNow: spy("update_now") as never,
    keepGoing: spy("keep_going") as never,
    stop: spy("stop") as never,
    start: spy("start") as never,
    tryAgain: spy("try_again") as never,
    pause: spy("pause") as never,
    resume: spy("resume") as never,
    turnOn: (async (scope: string) => void calls.push(`turn_on:${scope}`)) as never,
    patchSettings: (async (p: object) => void calls.push(`patch:${JSON.stringify(p)}`)) as never,
  });
}

beforeEach(() => {
  calls.length = 0;
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Sync" } as never });
});

describe("statusWords", () => {
  const on = { ...DEFAULT_NOTETAKER_SETTINGS, enabled: true };
  const run = (status: NotetakerState["status"]): NotetakerState => ns(status);
  it("says the state in words", () => {
    expect(statusWords(run("running"), on).word).toBe("Taking notes");
    expect(statusWords(run("waiting"), on).word).toBe("Waiting for speech");
    expect(statusWords(null, on).word).toBe("Waiting for speech");
    expect(statusWords(run("paused"), on).word).toBe("Paused");
    expect(statusWords(run("capped"), on).word).toBe("Paused");
    expect(statusWords(run("error"), on).word).toBe("Stopped");
    expect(statusWords(run("finished"), on).word).toBe("Stopped");
    expect(statusWords(run("running"), { ...on, enabled: false }).word).toBe("Off");
    expect(statusWords(run("waiting"), { ...on, update_mode: "manual" }).word).toBe("Waiting for you");
  });
});

describe("NotesPanel", () => {
  it("first run explains what it does and what it sends, then turns on with the chosen scope", async () => {
    seed({ settings: { enabled: false }, doc: false, run: null });
    render(<NotesPanel />);
    expect(screen.getByText("Live notes: Off")).toBeInTheDocument();
    expect(screen.getByText(/sends only the transcript/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Every meeting" }));
    await userEvent.click(screen.getByRole("button", { name: "Turn on notes" }));
    expect(calls).toEqual(["turn_on:every"]);
  });

  it("shows the status, the page, the token meter and the shortcut", () => {
    seed({});
    render(<NotesPanel />);
    expect(screen.getByText("Live notes: Taking notes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch plan" })).toBeInTheDocument();
    expect(screen.getByText("42k of 120k tokens")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Notes tokens used" })).toHaveAttribute("aria-valuenow", "42000");
    expect(screen.getByRole("button", { name: /Update now/ })).toHaveTextContent("N");
  });

  it("updates now from the button and from the N key, but not while a run is going", async () => {
    seed({ run: { status: "waiting" } });
    render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: /Update now/ }));
    act(() => void window.dispatchEvent(new Event(NOTES_UPDATE_EVENT)));
    expect(calls).toEqual(["update_now", "update_now"]);

    calls.length = 0;
    act(() => useLiveNotesStore.setState({ runs: { m1: ns("running") } }));
    expect(screen.getByRole("button", { name: /Update now/ })).toBeDisabled();
    act(() => void window.dispatchEvent(new Event(NOTES_UPDATE_EVENT)));
    expect(calls).toEqual([]);
  });

  it("asks Keep taking notes? at the cap, with Keep going and Stop", async () => {
    seed({ run: { status: "capped", tokens_used: 120000, cap: 120000 } });
    render(<NotesPanel />);
    expect(screen.getByText("Live notes: Paused")).toBeInTheDocument();
    const prompt = screen.getByRole("group", { name: "Keep taking notes?" });
    expect(prompt).toHaveTextContent("120k tokens");
    expect(screen.queryByRole("button", { name: /Update now/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls).toEqual(["keep_going", "stop"]);
  });

  it("explains a plan limit with a way to fix it", async () => {
    seed({ run: { status: "paused", can: ["try_again"], reason: "Your plan limit was reached until 4 pm." } });
    render(<NotesPanel />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Notes paused");
    expect(alert).toHaveTextContent("Your plan limit was reached until 4 pm.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls).toEqual(["try_again"]);
    await userEvent.click(screen.getByRole("button", { name: "Change model" }));
    expect(await screen.findByRole("dialog", { name: "Live notes settings" })).toBeInTheDocument();
  });

  it("shows a stopped run and a failed command in words", () => {
    seed({ run: { status: "error", reason: "The model did not answer three times." }, error: "Could not reach the app." });
    render(<NotesPanel />);
    expect(screen.getByText("Live notes: Stopped")).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText("Could not reach the app.")).toBeInTheDocument();
  });

  it("offers the model, detail and colour choices from the options menu", async () => {
    seed({});
    render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Notes options" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Colour people and places" }));
    expect(calls).toEqual(['patch:{"colors":false}']);
    await userEvent.click(screen.getByRole("button", { name: "Notes options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Model, detail and limit" }));
    const dialog = await screen.findByRole("dialog", { name: "Live notes settings" });
    expect(dialog).toHaveTextContent("Automatic");
    expect(dialog).toHaveTextContent("Detailed");
    expect(dialog).toHaveTextContent("tokens");
  });

  it("shows an empty page with a hint before the first notes arrive", () => {
    seed({ doc: false, run: { status: "waiting" } });
    render(<NotesPanel />);
    expect(screen.getByRole("heading", { name: "Nothing yet" })).toBeInTheDocument();
  });

  it("offers Undo after a change", async () => {
    seed({});
    useLiveNotesStore.setState({ entries: { m1: { ...EMPTY_ENTRY, doc: structuredClone(sampleDoc), undoStack: [{ label: "Delete", edits: [] }] } }, undo: (async () => void calls.push("undo")) as never });
    render(<NotesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Undo delete" }));
    expect(calls).toEqual(["undo"]);
  });

  it("speaks its state once, in a status region, and the heading is not live", () => {
    seed({});
    const { container } = render(<NotesPanel />);
    expect(screen.getByRole("heading", { name: "Live notes" })).toBeInTheDocument();
    expect(screen.getByText("Live notes: Taking notes", { selector: "[role='status']" })).toBeInTheDocument();
    expect(container.querySelector("h2[aria-live]")).toBeNull();
  });
});
