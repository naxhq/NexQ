import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { RecapBlock, recapDate } from "./RecapBlock";
import { MeetingCard } from "../MeetingCard";
import * as ipc from "../../lib/ipc";
import { loadFixture } from "../../contracts/loadFixture";
import { meeting, mockBackend } from "../../workspace/testUtils";

afterEach(() => cleanup());

describe("contract: recap commands", () => {
  it("sends the fixture's arguments and reads its answer", async () => {
    const result = loadFixture<{ text: string; model: string | null; created_at: number }>("get_meeting_recap_result");
    const b = mockBackend({ get_meeting_recap: result, delete_meeting_recap: null });
    const got = await ipc.getMeetingRecap("m1");
    expect(b.called("get_meeting_recap")[0].args).toEqual(loadFixture("get_meeting_recap"));
    expect(got).toEqual(result);
    await ipc.deleteMeetingRecap("m1");
    expect(b.called("delete_meeting_recap")[0].args).toEqual(loadFixture("delete_meeting_recap"));
    mockBackend({ get_meeting_recap: loadFixture("get_meeting_recap_none_result") });
    expect(await ipc.getMeetingRecap("m1")).toBeNull();
  });
});

describe("the meeting row", () => {
  const row = (over: object) => render(<MeetingCard meeting={meeting(over)} onSelect={() => {}} onDelete={() => {}} onRename={() => {}} />);
  it("says Recap when there is one and no summary", () => {
    row({ has_recap: true, has_summary: false });
    expect(screen.getByRole("button", { name: /^Meeting:/ })).toHaveTextContent("Recap");
  });
  it("says Summary, not Recap, when both exist; says neither when neither", () => {
    row({ has_recap: true, has_summary: true });
    expect(screen.getByRole("button", { name: /^Meeting:/ })).not.toHaveTextContent("Recap");
    expect(screen.getByRole("button", { name: /^Meeting:/ })).toHaveTextContent("Summary");
    cleanup();
    row({});
    expect(screen.getByRole("button", { name: /^Meeting:/ })).not.toHaveTextContent(/Recap|Summary/);
  });
});

describe("the recap in meeting details", () => {
  beforeEach(() => localStorage.clear());

  it("shows it read-only with its date, and nothing when there is none", async () => {
    const created = Date.UTC(2026, 10, 12, 12);
    mockBackend({ get_meeting_recap: { text: "Budget talk. Agreed at 5k.", model: null, created_at: created } });
    render(<RecapBlock meetingId="m1" />);
    const section = await screen.findByRole("region", { name: "AI recap" });
    expect(within(section).getByRole("heading", { name: `AI recap, ${recapDate(created)}` })).toBeInTheDocument();
    expect(section).toHaveTextContent("Budget talk. Agreed at 5k.");
    expect(within(section).queryByRole("textbox")).toBeNull();
    cleanup();
    mockBackend({ get_meeting_recap: null });
    render(<RecapBlock meetingId="m1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "AI recap" })).toBeNull();
  });

  it("asks before deleting, and says it isn't written again", async () => {
    const b = mockBackend({ get_meeting_recap: { text: "A recap.", model: null, created_at: Date.now() }, delete_meeting_recap: null, list_meetings: "[]" });
    render(<RecapBlock meetingId="m1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("It isn't written again");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(b.called("delete_meeting_recap")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete recap" }));
    await waitFor(() => expect(b.called("delete_meeting_recap")[0]?.args).toMatchObject({ meetingId: "m1" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "AI recap" })).toBeNull());
  });
});
