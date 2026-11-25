import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "./loadFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { answerWorkspaceApproval } from "../lib/ipc";

// `answer_workspace_approval`: the arguments `invoke` passes are the ones the backend's type reads.
describe("answer_workspace_approval", () => {
  beforeEach(() => invoke.mockReset());

  it("sends exactly the fixture's arguments", async () => {
    invoke.mockResolvedValue(true);
    const fixture = loadFixture<{ approvalId: string; allow: boolean }>("answer_workspace_approval");
    await answerWorkspaceApproval(fixture.approvalId, fixture.allow);
    expect(invoke).toHaveBeenCalledWith("answer_workspace_approval", fixture);
  });
});
