import { describe, expect, it } from "vitest";
import { GENERIC_ERROR, messageOf, plainError } from "./plainError";

describe("plainError", () => {
  it("keeps the backend's own sentence", () => {
    expect(plainError("Usage limit reached, resets at 5pm")).toBe("Usage limit reached, resets at 5pm");
    expect(plainError(new Error("The database is busy"))).toBe("The database is busy");
  });

  it("never lets a JavaScript error reach the screen", () => {
    expect(plainError(new TypeError("Cannot read properties of null (reading 'meeting_id')"), "Live notes couldn't be read. Try again.")).toBe("Live notes couldn't be read. Try again.");
    expect(plainError(new ReferenceError("x is not defined"))).toBe(GENERIC_ERROR);
    expect(plainError(new Error("foo is not a function"))).toBe(GENERIC_ERROR);
    expect(plainError("Cannot read properties of undefined (reading 'length')")).toBe(GENERIC_ERROR);
    expect(plainError(new SyntaxError("Unexpected end of JSON input"))).toBe(GENERIC_ERROR);
  });

  it("says something when there is nothing to say", () => {
    expect(plainError(undefined)).toBe(GENERIC_ERROR);
    expect(plainError("")).toBe(GENERIC_ERROR);
    expect(plainError(new Error(""))).toBe(GENERIC_ERROR);
    expect(messageOf(new TypeError("nope"))).toBe(GENERIC_ERROR);
  });
});
