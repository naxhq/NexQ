import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticeStack } from "./NoticeStack";

describe("NoticeStack", () => {
  it("holds every notice in one fixed column, oldest at the bottom (newest on top), scrolling when tall", () => {
    render(
      <NoticeStack>
        <p>first</p>
        <p>second</p>
      </NoticeStack>,
    );
    const stack = screen.getByLabelText("Notices");
    expect(stack).toContainElement(screen.getByText("first"));
    expect(stack).toContainElement(screen.getByText("second"));
    expect(stack.className).toContain("fixed");
    expect(stack.className).toContain("flex-col-reverse");
    expect(stack.className).toContain("overflow-y-auto");
    expect(stack.className).toContain("max-h-[calc(100vh-7rem)]");
  });

  it("gives way to the star card and update toast on the right (width shrinks with the window)", () => {
    render(<NoticeStack>x</NoticeStack>);
    expect(screen.getByLabelText("Notices").className).toContain("w-[clamp(15rem,calc(100vw-28.5rem),21.25rem)]");
  });
});
