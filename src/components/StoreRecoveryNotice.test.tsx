import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const take = vi.fn();
vi.mock("../lib/ipc", () => ({ takeStoreRecovery: () => take() }));
import { StoreRecoveryNotice, recoveryText } from "./StoreRecoveryNotice";

afterEach(() => take.mockReset());

describe("settings recovery notice", () => {
  it("shows nothing when every file was fine", async () => {
    take.mockResolvedValue([]);
    const { container } = render(<StoreRecoveryNotice />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("says what was put back, where the damaged file is, and closes", async () => {
    take.mockResolvedValue([{ file: "config.json", kept_as: "config.json.corrupt-1", restored: true }]);
    render(<StoreRecoveryNotice />);
    expect(await screen.findByText("Settings restored")).toBeTruthy();
    expect(screen.getByText(/last good copy/)).toBeTruthy();
    expect(screen.getByText(/config\.json\.corrupt-1/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByText("Settings restored")).toBeNull();
  });

  it("says so when there was no good copy", () => {
    const t = recoveryText([{ file: "config.json", kept_as: null, restored: false }]);
    expect(t?.title).toBe("Some settings were reset");
    expect(t?.lines).toHaveLength(1);
  });
});
