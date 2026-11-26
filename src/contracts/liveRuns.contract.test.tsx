// The backend's own examples (src/contracts/fixtures, written from the Rust structs) go
// through the real wrappers, events, stores and panels. Nothing here is hand-written payload.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import notetakerState from "./fixtures/notetaker_state.json";
import briefState from "./fixtures/brief_state.json";
import notetakerDoc from "./fixtures/notetaker_doc.json";
import notetakerSettings from "./fixtures/notetaker_settings_changed.json";
import briefSettings from "./fixtures/brief_settings_changed.json";
import memorySettings from "./fixtures/memory_settings_changed.json";
import getNotetakerState from "./fixtures/get_notetaker_state.json";
import getBriefState from "./fixtures/get_brief_state.json";
import getAutomaticModel from "./fixtures/get_automatic_model.json";
import notetakerPause from "./fixtures/notetaker_pause.json";
import notetakerResume from "./fixtures/notetaker_resume.json";
import briefPause from "./fixtures/brief_pause.json";
import briefResume from "./fixtures/brief_resume.json";
import notetakerDismiss from "./fixtures/notetaker_dismiss_moved.json";
import briefDismiss from "./fixtures/brief_dismiss_moved.json";
import saveEdit from "./fixtures/save_meeting_notes_edit.json";
import saveEditAdd from "./fixtures/save_meeting_notes_edit_add.json";
import saveEditDelete from "./fixtures/save_meeting_notes_edit_delete.json";
import notetakerFinished from "./fixtures/notetaker_state_finished.json";
import setNotetakerSettingsArgs from "./fixtures/set_notetaker_settings.json";
import setBriefSettingsArgs from "./fixtures/set_brief_settings.json";
import setMemorySettingsArgs from "./fixtures/set_memory_settings.json";

// Every fixture this suite relies on. A missing file fails the imports above and this list.
const REQUIRED = [
  "notetaker_state", "brief_state", "notetaker_doc", "notetaker_settings_changed", "brief_settings_changed", "memory_settings_changed",
  "get_notetaker_state", "get_brief_state", "get_automatic_model", "notetaker_pause", "notetaker_resume", "brief_pause", "brief_resume", "notetaker_dismiss_moved", "brief_dismiss_moved",
  "save_meeting_notes_edit", "save_meeting_notes_edit_add", "save_meeting_notes_edit_delete", "notetaker_state_finished", "set_notetaker_settings", "set_brief_settings", "set_memory_settings",
];
const present = Object.keys(import.meta.glob("./fixtures/*.json")).map((k) => k.replace("./fixtures/", "").replace(".json", ""));

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  answers: {} as Record<string, unknown>,
  listeners: new Map<string, Array<(e: { payload: unknown }) => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    h.calls.push([cmd, args]);
    return h.answers[cmd];
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.listeners.set(name, [...(h.listeners.get(name) ?? []), cb]);
    return () => h.listeners.set(name, (h.listeners.get(name) ?? []).filter((x) => x !== cb));
  },
  emit: async () => {},
}));
const hear = (name: string, payload: unknown) => (h.listeners.get(name) ?? []).forEach((cb) => cb({ payload }));

import * as ipc from "../lib/ipc";
import { NotesPanel } from "../live-notes/LiveNotesPanel";
import { BriefPanel } from "../live-brief/BriefPanel";
import { useLiveNotesStore } from "../stores/liveNotesStore";
import { useLiveBriefStore } from "../stores/liveBriefStore";
import { useMeetingStore } from "../stores/meetingStore";
import type { BriefState, NoteEdit, NotetakerSettings, NotetakerState } from "../lib/types";

beforeEach(() => {
  h.calls.length = 0;
  h.listeners.clear();
  h.answers = {
    get_notetaker_state: notetakerState,
    get_brief_state: briefState,
    get_meeting_notes: notetakerDoc.doc,
    get_notetaker_settings: { ...notetakerSettings, enabled: true },
    get_brief_settings: briefSettings,
    get_meeting_brief: null,
    get_workspace: { brief_enabled: true },
    get_automatic_model: null,
  };
  useLiveNotesStore.getState().reset();
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "t", workspace_id: "w1" } as never });
});

describe("fixtures", () => {
  it("every fixture the suite relies on exists", () => {
    expect(REQUIRED.filter((n) => !present.includes(n))).toEqual([]);
  });
});

describe("arguments the wrappers send equal the backend's own", () => {
  const sent = () => h.calls[h.calls.length - 1];
  it.each([
    ["get_notetaker_state", () => ipc.getNotetakerState("m1"), getNotetakerState],
    ["get_brief_state", () => ipc.getBriefState("m1"), getBriefState],
    ["get_automatic_model", () => ipc.getAutomaticModel(null), getAutomaticModel],
    ["notetaker_pause", () => ipc.notetakerPause("m1"), notetakerPause],
    ["notetaker_resume", () => ipc.notetakerResume("m1"), notetakerResume],
    ["brief_pause", () => ipc.briefPause("m1"), briefPause],
    ["brief_resume", () => ipc.briefResume("m1"), briefResume],
    ["notetaker_dismiss_moved", () => ipc.notetakerDismissMoved("m1"), notetakerDismiss],
    ["brief_dismiss_moved", () => ipc.briefDismissMoved("m1"), briefDismiss],
    ["set_notetaker_settings", () => ipc.setNotetakerSettings(setNotetakerSettingsArgs.patch as Partial<NotetakerSettings>), setNotetakerSettingsArgs],
    ["set_brief_settings", () => ipc.setBriefSettings(setBriefSettingsArgs.patch), setBriefSettingsArgs],
    ["set_memory_settings", () => ipc.setMemorySettings(setMemorySettingsArgs.patch), setMemorySettingsArgs],
  ] as Array<[string, () => Promise<unknown>, unknown]>)("%s", async (cmd, call, fixture) => {
    await call();
    expect(sent()).toEqual([cmd, fixture]);
  });

  it.each([
    ["update", saveEdit],
    ["add", saveEditAdd],
    ["delete", saveEditDelete],
  ] as const)("save_meeting_notes_edit (%s)", async (op, fixture) => {
    expect(fixture.edit.op).toBe(op);
    await ipc.saveMeetingNotesEdit(fixture.meetingId, fixture.edit as NoteEdit);
    expect(h.calls[h.calls.length - 1]).toEqual(["save_meeting_notes_edit", fixture]);
  });
});

describe("what the backend sends goes through the real stores", () => {
  it("notes: state, document and settings, by reading and by event", async () => {
    const off = await useLiveNotesStore.getState().attach("m1");
    await waitFor(() => expect(useLiveNotesStore.getState().runs.m1).toEqual(notetakerState));
    expect(useLiveNotesStore.getState().entries.m1.doc?.blocks).toHaveLength(notetakerDoc.doc.blocks.length);
    const next = { ...notetakerState, status: "paused", can: ["resume"], reason: "Usage limit reached" } as NotetakerState;
    hear("notetaker_state", next);
    expect(useLiveNotesStore.getState().runs.m1).toEqual(next);
    hear("notetaker_doc", { ...notetakerDoc, version: notetakerDoc.version + 1, doc: { ...notetakerDoc.doc, blocks: notetakerDoc.doc.blocks.slice(0, 1) } });
    expect(useLiveNotesStore.getState().entries.m1.doc?.blocks).toHaveLength(1);
    const offSettings = await useLiveNotesStore.getState().watchSettings();
    hear("notetaker_settings_changed", notetakerSettings);
    expect(useLiveNotesStore.getState().settings).toEqual(notetakerSettings);
    off();
    offSettings();
  });

  it("brief: state and settings", async () => {
    const off = await useLiveBriefStore.getState().attach("m1", "w1");
    await waitFor(() => expect(useLiveBriefStore.getState().run).toEqual(briefState));
    const offSettings = await useLiveBriefStore.getState().watchSettings();
    hear("brief_settings_changed", briefSettings);
    expect(useLiveBriefStore.getState().settings).toEqual(briefSettings);
    off();
    offSettings();
  });
});

describe("the panels offer exactly what `can` allows", () => {
  const label = { update: /Update now|Refresh/, resume: /^Resume/, start: /^Start (notes|the brief) again/ } as const;

  it("notes", async () => {
    await useLiveNotesStore.getState().attach("m1");
    await waitFor(() => expect(useLiveNotesStore.getState().runs.m1).toBeDefined());
    useLiveNotesStore.setState({ settings: { ...(notetakerSettings as NotetakerSettings), enabled: true } });
    render(<NotesPanel />);
    for (const [action, re] of Object.entries(label)) {
      const has = (notetakerState.can as string[]).includes(action);
      expect({ action, found: screen.queryAllByRole("button", { name: re }).length > 0 }).toEqual({ action, found: has });
    }
    expect(screen.getByText(/next update in \d+ s/)).toBeInTheDocument();
    // Pause lives in the options menu, and only when the backend allows it.
    await userEvent.click(screen.getByRole("button", { name: "Notes options" }));
    expect(!!screen.queryByRole("menuitem", { name: "Pause notes" })).toBe((notetakerState.can as string[]).includes("pause"));
  });

  it("brief, after a plan limit: Try again, and the reason in words", async () => {
    await useLiveBriefStore.getState().attach("m1", "w1");
    await waitFor(() => expect(useLiveBriefStore.getState().run).toBeTruthy());
    useLiveBriefStore.setState({ workspaceEnabled: true });
    render(<BriefPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(briefState.reason!);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    for (const [action, re] of Object.entries(label)) {
      const has = (briefState.can as string[]).includes(action);
      expect({ action, found: screen.queryAllByRole("button", { name: re }).length > 0 }).toEqual({ action, found: has });
    }
  });

  it("types match what Rust sends", () => {
    const n: NotetakerState = notetakerState as NotetakerState;
    const b: BriefState = briefState as BriefState;
    expect([typeof n.total_tokens, typeof b.total_tokens, Array.isArray(n.can), Array.isArray(b.can)]).toEqual(["number", "number", true, true]);
    expect(memorySettings).toHaveProperty("provider");
    // The finished state carries the range, and the others say there is none.
    expect(notetakerFinished.not_covered).toEqual({ from_ms: 120000, to_ms: 2400000 });
    expect(n.not_covered).toBeNull();
    expect(b.not_covered).toBeNull();
  });
});
