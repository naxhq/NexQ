import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbIntegrityFinding } from "../lib/types";

const get = vi.fn();
let push: ((f: DbIntegrityFinding) => void) | null = null;
vi.mock("../lib/ipc", () => ({ getDbIntegrity: () => get() }));
vi.mock("../lib/events", () => ({
  onDbIntegrityProblem: (h: (f: DbIntegrityFinding) => void) => {
    push = h;
    return Promise.resolve(() => {});
  },
}));

import { DatabaseDamageNotice, damageText } from "./DatabaseDamageNotice";

const finding = (copies = 1): DbIntegrityFinding => ({
  message: "A check of your meetings file found damage.",
  details: ["row 3 missing"],
  checked_at: 1,
  folder: "C:/data/NexQ",
  copies: Array.from({ length: copies }, (_, i) => ({ name: `nexq-backup-${i}.db`, created_at: 1, bytes: 10, meetings: 2 })),
});

beforeEach(() => {
  get.mockReset();
  push = null;
});

describe("database damage notice", () => {
  it("shows nothing when the check found nothing", async () => {
    get.mockResolvedValue(null);
    const { container } = render(<DatabaseDamageNotice />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("says there is damage, that work goes on, where the copies are, and closes", async () => {
    get.mockResolvedValue(finding(2));
    render(<DatabaseDamageNotice />);
    expect(await screen.findByText("Your meetings file has some damage")).toBeTruthy();
    expect(screen.getByText(/keeps working with it and has changed nothing/)).toBeTruthy();
    expect(screen.getByText(/2 copies of your meetings exist.*C:\/data\/NexQ/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByText("Your meetings file has some damage")).toBeNull();
  });

  it("appears when the check finishes while the app is open", async () => {
    get.mockResolvedValue(null);
    render(<DatabaseDamageNotice />);
    await act(async () => {});
    act(() => push?.(finding(0)));
    expect(await screen.findByText(/No copy of your meetings was found yet/)).toBeTruthy();
  });

  it("names one copy in the singular", () => {
    expect(damageText(finding(1)).lines[1]).toMatch(/^A copy of your meetings exists/);
  });
});
