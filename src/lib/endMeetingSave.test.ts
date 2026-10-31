import { describe, expect, it } from "vitest";
import { saveSegmentsWithRetry, unsavedTranscriptError } from "./endMeetingSave";

describe("saveSegmentsWithRetry", () => {
  it("retries a failing write and keeps saving the other lines", async () => {
    const calls: string[] = [];
    const saved: string[] = [];
    let flaky = 0;
    const failed = await saveSegmentsWithRetry(
      ["a", "b", "c"],
      async (s) => {
        calls.push(s);
        if (s === "a" && flaky++ === 0) throw new Error("db locked");
        if (s === "b") throw new Error("disk full");
      },
      (s) => saved.push(s),
      3,
      0
    );
    expect(failed).toBe(1);
    expect(saved).toEqual(["a", "c"]);
    expect(calls).toEqual(["a", "a", "b", "b", "b", "c"]);
  });

  it("tries the rest once each after a line failed every attempt", async () => {
    const calls: string[] = [];
    const failed = await saveSegmentsWithRetry(
      ["a", "b", "c"],
      async (s) => {
        calls.push(s);
        throw new Error("database unavailable");
      },
      () => {},
      3,
      0
    );
    expect(failed).toBe(3);
    expect(calls).toEqual(["a", "a", "a", "b", "c"]);
  });

  it("reports nothing when every line is saved", async () => {
    expect(await saveSegmentsWithRetry([1, 2], async () => {}, () => {}, 3, 0)).toBe(0);
  });

  it("explains that the meeting stays open", () => {
    expect(unsavedTranscriptError(2).message).toContain("2 transcript lines could not be saved");
  });
});
