import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourcesModal } from "./SourcesModal";

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <div style={{ transform: "translateX(0)" }} data-testid="transformed">
      <button>Opener</button>
      <SourcesModal title="Add" onClose={onClose}>
        <input aria-label="Name" />
        <button>Save</button>
      </SourcesModal>
    </div>
  );
}

describe("SourcesModal", () => {
  it("sits on document.body, so its backdrop covers the whole window", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    expect(screen.getByTestId("transformed").contains(dialog)).toBe(false);
    expect(dialog.closest("body")).not.toBeNull();
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("moves focus in, keeps Tab inside and closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("gives focus back to what had it when it closes", () => {
    const { rerender } = render(
      <div>
        <button>Opener</button>
      </div>,
    );
    screen.getByRole("button", { name: "Opener" }).focus();
    rerender(
      <div>
        <button>Opener</button>
        <SourcesModal title="Add" onClose={() => {}}>
          <input aria-label="Name" />
        </SourcesModal>
      </div>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
    rerender(
      <div>
        <button>Opener</button>
      </div>,
    );
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});
