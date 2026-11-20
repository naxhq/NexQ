import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourcesModal } from "./SourcesModal";
import { SourcesGuideModal } from "./SourcesGuideModal";

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

  it("Escape closes only the dialog, not the Settings page behind it", () => {
    const behind = vi.fn();
    const onKeyBehind = (e: KeyboardEvent) => e.key === "Escape" && behind();
    window.addEventListener("keydown", onKeyBehind);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
    // Other keys still reach it.
    window.addEventListener("keydown", behind);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(behind).toHaveBeenCalled();
    window.removeEventListener("keydown", onKeyBehind);
    window.removeEventListener("keydown", behind);
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

  it("the tools guide says a new server is checked right away", () => {
    render(<SourcesGuideModal kind="tools" onClose={() => {}} />);
    expect(screen.getByText(/NexQ checks it right away/)).toBeInTheDocument();
    expect(screen.queryByText(/press Check/)).toBeNull();
  });
});
