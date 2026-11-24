import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionItemRow } from "./ActionItemsTab";
import type { ActionItem } from "../../lib/types";

const item: ActionItem = { id: "a1", text: "Email the client", timestamp_ms: 0, completed: false };

function renderRow(onEdit = vi.fn()) {
  render(
    <ActionItemRow
      item={item}
      meetingStartMs={0}
      onToggle={vi.fn()}
      onEdit={onEdit}
      onDelete={vi.fn()}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      isDragTarget={false}
    />,
  );
  return onEdit;
}

describe("ActionItemRow", () => {
  it("throws the edit away when the X is clicked", async () => {
    const user = userEvent.setup();
    const onEdit = renderRow();

    await user.dblClick(screen.getByText("Email the client"));
    const input = screen.getByDisplayValue("Email the client");
    await user.clear(input);
    await user.type(input, "Email the client twice");
    await user.click(screen.getByRole("button", { name: "Cancel edit" }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Email the client")).toBeInTheDocument();
  });

  it("saves the edit when the check is clicked", async () => {
    const user = userEvent.setup();
    const onEdit = renderRow();

    await user.dblClick(screen.getByText("Email the client"));
    const input = screen.getByDisplayValue("Email the client");
    await user.clear(input);
    await user.type(input, "Email the client twice");
    await user.click(screen.getByRole("button", { name: "Save edit" }));

    expect(onEdit).toHaveBeenCalledWith("a1", "Email the client twice");
  });
});
