import { describe, expect, it } from "vitest";
import { resizeRect, type Rect } from "./resizeRect";

const start: Rect = { x: 100, y: 50, width: 500, height: 700 };
const min = { width: 400, height: 480 };

describe("resizeRect", () => {
  it("grows and shrinks the east and south edges in place", () => {
    expect(resizeRect(start, "e", 30, 999, min)).toEqual({ x: 100, y: 50, width: 530, height: 700 });
    expect(resizeRect(start, "s", 999, -40, min)).toEqual({ x: 100, y: 50, width: 500, height: 660 });
  });

  it("keeps the opposite edge put when dragging west or north", () => {
    // Dragging the west edge left by 20 widens the window and moves it left.
    expect(resizeRect(start, "w", -20, 0, min)).toEqual({ x: 80, y: 50, width: 520, height: 700 });
    // Dragging the north edge down by 10 shortens it from the top.
    expect(resizeRect(start, "n", 0, 10, min)).toEqual({ x: 100, y: 60, width: 500, height: 690 });
  });

  it("combines both axes at a corner", () => {
    expect(resizeRect(start, "nw", -10, -10, min)).toEqual({ x: 90, y: 40, width: 510, height: 710 });
    expect(resizeRect(start, "se", 10, 10, min)).toEqual({ x: 100, y: 50, width: 510, height: 710 });
    expect(resizeRect(start, "ne", 10, -10, min)).toEqual({ x: 100, y: 40, width: 510, height: 710 });
    expect(resizeRect(start, "sw", -10, 10, min)).toEqual({ x: 90, y: 50, width: 510, height: 710 });
  });

  it("stops at the minimum size without moving the opposite edge", () => {
    // East: can't go below the minimum width.
    expect(resizeRect(start, "e", -300, 0, min).width).toBe(400);
    // West past the minimum: the right edge (x + width = 600) stays at 600.
    const west = resizeRect(start, "w", 300, 0, min);
    expect(west.width).toBe(400);
    expect(west.x + west.width).toBe(600);
    // North past the minimum: the bottom edge (y + height = 750) stays at 750.
    const north = resizeRect(start, "n", 0, 500, min);
    expect(north.height).toBe(480);
    expect(north.y + north.height).toBe(750);
  });
});
