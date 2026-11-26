import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

const drag = vi.hoisted(() => ({ handler: null as null | ((e: { payload: Record<string, unknown> }) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: (e: { payload: Record<string, unknown> }) => void) => {
      drag.handler = h;
      return () => {
        drag.handler = null;
      };
    },
  }),
}));
const picked = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => picked.paths }));

import { FileUpload, useTauriFileDrop } from "./FileUpload";
import { addFilesToWorkspace } from "../workspace/addMaterial";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { mockBackend, seedWorkspaces, ws } from "../workspace/testUtils";

function Probe({ onPaths }: { onPaths: (ok: string[], skipped: string[]) => void }) {
  const { dragging } = useTauriFileDrop(onPaths);
  return <p>{dragging ? "dragging" : "idle"}</p>;
}

const resource = (id: string) => JSON.stringify({ id, name: `${id}.pdf`, file_type: "pdf", file_path: `/${id}.pdf`, size_bytes: 1, token_count: 1, preview: "", loaded_at: "" });

beforeEach(() => {
  drag.handler = null;
  seedWorkspaces([ws(), ws({ id: "acme", name: "Acme", is_default: false })], "acme");
});
afterEach(() => cleanup());

describe("dropping files", () => {
  it("uses Tauri's drag-drop event (File.path is empty in WebView2) and shows the hover", async () => {
    const onPaths = vi.fn();
    render(<Probe onPaths={onPaths} />);
    await waitFor(() => expect(drag.handler).not.toBeNull());
    act(() => drag.handler!({ payload: { type: "enter", paths: ["a.pdf"], position: { x: 1, y: 1 } } }));
    expect(screen.getByText("dragging")).toBeInTheDocument();
    act(() => drag.handler!({ payload: { type: "leave" } }));
    expect(screen.getByText("idle")).toBeInTheDocument();
    act(() => drag.handler!({ payload: { type: "drop", paths: ["C:\\x\\a.PDF", "C:\\x\\pic.png", "notes.md"], position: { x: 1, y: 1 } } }));
    expect(onPaths).toHaveBeenCalledWith(["C:\\x\\a.PDF", "notes.md"], ["C:\\x\\pic.png"]);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("stops listening when it unmounts", async () => {
    const { unmount } = render(<Probe onPaths={() => {}} />);
    await waitFor(() => expect(drag.handler).not.toBeNull());
    unmount();
    await waitFor(() => expect(drag.handler).toBeNull());
  });
});

describe("adding files to a workspace", () => {
  it("loads each file for the workspace in one step and reports the ones that failed", async () => {
    const b = mockBackend({
      load_context_file: (a: Record<string, unknown>) => {
        if (String(a.filePath).includes("bad")) throw "Couldn't read bad.pdf";
        return resource("ok");
      },
      list_workspaces: [ws(), ws({ id: "acme", name: "Acme" })],
    });
    const result = await addFilesToWorkspace(["/good.pdf", "/bad.pdf"], "acme");
    expect(result.added).toBe(1);
    expect(result.failed).toEqual([{ path: "/bad.pdf", error: expect.stringContaining("bad.pdf") }]);
    expect(b.called("load_context_file")[0].args).toMatchObject({ filePath: "/good.pdf", workspaceId: "acme" });
    // The backend files it with the library entry: no second call for the membership.
    expect(b.called("add_workspace_item")).toHaveLength(0);
    expect(b.called("list_workspaces").length).toBeGreaterThan(0);
  });

  it("Choose files adds what was picked to the open workspace", async () => {
    const b = mockBackend({ load_context_file: resource("p1"), list_workspaces: [ws(), ws({ id: "acme", name: "Acme" })] });
    picked.paths = ["/p1.pdf", "/skip.exe"];
    render(<FileUpload />);
    await userEvent.click(screen.getByRole("button", { name: /Choose files/ }));
    await waitFor(() => expect(b.called("load_context_file")).toHaveLength(1));
    expect(b.called("load_context_file")[0].args).toMatchObject({ workspaceId: useWorkspaceStore.getState().openId });
    expect(await screen.findByRole("status")).toHaveTextContent(/isn't a PDF/);
  });
});
