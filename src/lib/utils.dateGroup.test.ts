import { afterEach, describe, expect, it, vi } from "vitest";
import { getDateGroup } from "./utils";

const local = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month, day, hour, 0, 0).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe("getDateGroup", () => {
  it("uses local calendar days, not 24-hour blocks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 9, 0, 0));

    expect(getDateGroup(local(2026, 10, 23, 23))).toBe("Yesterday");
    expect(getDateGroup(local(2026, 10, 24, 0))).toBe("Today");
    expect(getDateGroup(local(2026, 10, 18, 23))).toBe("This Week");
    expect(getDateGroup(local(2026, 10, 17, 23))).toBe("Earlier");
  });

  it("counts the future as Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 9, 0, 0));

    expect(getDateGroup(local(2026, 10, 25, 8))).toBe("Today");
  });

  it("keeps the edges whole across a daylight-saving change", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 30, 12, 0, 0));

    expect(getDateGroup(local(2026, 2, 29, 23))).toBe("Yesterday");
    expect(getDateGroup(local(2026, 2, 24, 23))).toBe("This Week");
    expect(getDateGroup(local(2026, 2, 23, 23))).toBe("Earlier");
  });
});
