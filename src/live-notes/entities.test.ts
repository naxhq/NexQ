import { describe, expect, it } from "vitest";
import { entitiesOf, parseInline, plainText, retag } from "./entities";

describe("entity tags", () => {
  it("splits text into plain runs and entities of every kind", () => {
    const parts = parseInline("{{p:Ana}} met {{o:Acme}} in {{l:Berlin}} on {{d:May 3}} for {{n:$40k}}.");
    expect(parts).toEqual([
      { entity: "person", text: "Ana" },
      { text: " met " },
      { entity: "org", text: "Acme" },
      { text: " in " },
      { entity: "place", text: "Berlin" },
      { text: " on " },
      { entity: "date", text: "May 3" },
      { text: " for " },
      { entity: "number", text: "$40k" },
      { text: "." },
    ]);
  });

  it("keeps markup as text: nothing is ever interpreted as HTML", () => {
    const evil = "{{p:<img src=x onerror=alert(1)>}} and <script>boom()</script>";
    const parts = parseInline(evil);
    expect(parts[0]).toEqual({ entity: "person", text: "<img src=x onerror=alert(1)>" });
    expect(plainText(evil)).toBe("<img src=x onerror=alert(1)> and <script>boom()</script>");
  });

  it("treats unknown letters as plain text and drops stray or cut-off tags", () => {
    expect(plainText("{{x:Thing}} here")).toBe("Thing here");
    expect(parseInline("{{x:Thing}}")).toEqual([{ text: "Thing" }]);
    expect(plainText("cut off {{p:Ana")).toBe("cut off Ana");
    expect(plainText("a }} b {{ c")).toBe("a  b  c");
    expect(plainText("{{p:}} empty")).toBe(" empty");
  });

  it("tolerates spaces and capital letters in tags", () => {
    expect(entitiesOf("{{ P : Ana }}")).toEqual([{ kind: "person", value: "Ana" }]);
  });

  it("puts tags back after an edit so colours survive", () => {
    const original = "{{p:Ana}} flies to {{l:Berlin}}";
    expect(retag("Ana flies to Berlin on Monday", original)).toBe("{{p:Ana}} flies to {{l:Berlin}} on Monday");
    expect(retag("Ana flies to Paris", original)).toBe("{{p:Ana}} flies to Paris");
    expect(retag("Anastasia flies", "{{p:Ana}} flies")).toBe("Anastasia flies");
  });

  it("never lets an edit smuggle in tags of its own", () => {
    expect(retag("hello {{p:Eve}}", "hi")).toBe("hello p:Eve");
  });
});
