import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingSettingsPopover } from "./ReadingSettingsPopover";
import { DEFAULT_READING } from "../../stores/talkingPointsStore";

afterEach(cleanup);

describe("reading settings values", () => {
  it("are spin buttons with value text, not live regions that speak at every step", async () => {
    const onChange = vi.fn();
    const { container } = render(<ReadingSettingsPopover reading={DEFAULT_READING} onChange={onChange} onClose={() => undefined} />);
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("output")).toBeNull();
    const size = screen.getByRole("spinbutton", { name: "Text size" });
    expect(size).toHaveAttribute("aria-valuenow", "26");
    expect(size).toHaveAttribute("aria-valuetext", "26 pixels");
    expect(size).toHaveAttribute("aria-valuemin", "14");
    expect(size).toHaveAttribute("aria-valuemax", "56");
    expect(screen.getByRole("spinbutton", { name: "Speed" })).toHaveAttribute("aria-valuetext", "140 words a minute");
    expect(screen.getByRole("spinbutton", { name: "Line spacing" })).toHaveAttribute("aria-valuetext", "1.5 times the text size");
    size.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenCalledWith({ fontSize: 28 });
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 24 });
  });
});
