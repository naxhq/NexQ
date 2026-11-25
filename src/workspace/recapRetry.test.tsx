import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend } from "./testUtils";
import { LibraryFooter } from "./LibraryFooter";
import { retryOutcome } from "./RecapRetry";

afterEach(() => cleanup());

describe("recap retry", () => {
  it("says what happened", () => {
    expect(retryOutcome(3, null)).toBe("All recaps are written.");
    expect(retryOutcome(3, { count: 1, reason: null })).toBe("2 written, 1 still failed.");
    expect(retryOutcome(3, { count: 3, reason: "no key" })).toBe("They failed again.");
  });

  it("shows the failure in the Library footer and retries it for the workspace", async () => {
    let failed: unknown = { count: 3, reason: "no key" };
    const calls: string[] = [];
    mockBackend({
      get_index_status: () => ({ workspace_id: "w", state: "idle", done: 0, total: 0, skipped: [], ai_recaps: 2, ai_recaps_failed: failed ?? undefined }),
      retry_recaps: (a: Record<string, unknown>) => {
        calls.push(String(a.workspaceId));
        failed = undefined;
        return null;
      },
    });
    render(<LibraryFooter workspaceId="w" hasFolders={false} />);
    expect(await screen.findByText("3 recaps failed: no key.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("All recaps are written.")).toBeInTheDocument());
    expect(calls).toEqual(["w"]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    void vi;
  });
});
