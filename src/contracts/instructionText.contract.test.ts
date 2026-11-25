// The dialog and the backend clean instruction text by the same rules. These vectors are read
// here and by the Rust test `instruction_text_tests`: change one side and the other fails.
import { describe, expect, it } from "vitest";
import vectors from "./vectors/instruction_text.json";
import { sanitizeInstructionText } from "../workspace/chat/instructionText";

describe("instruction text vectors", () => {
  it("has the cases that matter", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors)("$name", ({ input, output }) => {
    expect(sanitizeInstructionText(input)).toBe(output);
    // the cleaned text is a fixed point: cleaning it again changes nothing (the backend relies on this)
    expect(sanitizeInstructionText(output)).toBe(output);
  });
});
