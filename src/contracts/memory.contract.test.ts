// The "Add to memory" payload must be what the backend accepts: every field of the
// fixture A4 generated from the Rust struct, and nothing the struct does not know.
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/create_memory.json";
import { newMemoryPayload } from "../memory/memoryStore";

// Rust `MemoryCreate`: the fields it knows (see workspace/types.rs).
const RUST_FIELDS = ["workspace_id", "kind", "title", "text", "source_meeting", "source_ms", "status", "unsupported"];
const REQUIRED = ["workspace_id", "kind", "title", "text", "unsupported"];

describe("create_memory", () => {
  const sent = newMemoryPayload("w1", { kind: "fact", title: "  Launch ", text: " Launch is in May " });

  it("sends only fields the backend knows, and every one it requires", () => {
    expect(Object.keys(sent).filter((k) => !RUST_FIELDS.includes(k))).toEqual([]);
    for (const k of REQUIRED) expect(sent).toHaveProperty(k);
  });

  it("covers every field of the backend's own example", () => {
    for (const k of Object.keys(fixture.input)) expect(sent).toHaveProperty(k);
    expect(sent.status).toBe("saved");
    expect(["person", "decision", "open_item", "fact", "preference"]).toContain(sent.kind);
  });

  it("trims what the person typed", () => {
    expect(sent.title).toBe("Launch");
    expect(sent.text).toBe("Launch is in May");
  });
});
