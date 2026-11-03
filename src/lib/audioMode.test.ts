import { describe, expect, it } from "vitest";
import { skipYouStt } from "./audioMode";

describe("skipYouStt", () => {
  it("skips the You transcriber only in in-person meetings, where the room mic is Them", () => {
    expect(skipYouStt("in_person")).toBe(true);
    expect(skipYouStt("online")).toBe(false);
  });
});
