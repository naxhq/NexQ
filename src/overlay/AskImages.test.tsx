import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskImageChips, IMAGES_NEED_CLAUDE, askPlaceholder, useAskImages } from "./AskImages";
import { MAX_IMAGES } from "../lib/imageAttachments";
import { useConfigStore } from "../stores/configStore";
import { useToastStore } from "../stores/toastStore";

beforeEach(() => {
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useToastStore.setState({ toasts: [] });
  // jsdom can't decode images: every pasted file is a small 100x100 picture.
  vi.stubGlobal("createImageBitmap", async () => ({ width: 100, height: 100, close: () => {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const png = (name: string) => new File([name], `${name}.png`, { type: "image/png" });

/** A paste event whose clipboard holds `files` and, optionally, text. */
function paste(files: File[], text = "") {
  const preventDefault = vi.fn();
  const clipboardData = {
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
  return { event: { clipboardData, preventDefault } as unknown as React.ClipboardEvent, preventDefault };
}

describe("useAskImages", () => {
  it("attaches a pasted screenshot and takes over the paste", async () => {
    const { result } = renderHook(() => useAskImages());
    const { event, preventDefault } = paste([png("a")]);
    await act(async () => result.current.onPaste(event));
    expect(preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(result.current.images).toHaveLength(1));
    expect(result.current.images[0].media_type).toBe("image/png");
  });

  it("announces an attached image politely", async () => {
    const { result } = renderHook(() => useAskImages());
    await act(async () => result.current.onPaste(paste([png("a")]).event));
    await waitFor(() => expect(result.current.announcement).toBe("Image attached (1 of 3)"));
  });

  it("with another provider takes the paste, attaches nothing and warns", async () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { result } = renderHook(() => useAskImages());
    expect(result.current.canAttach).toBe(false);
    const { event, preventDefault } = paste([png("a")]);
    await act(async () => result.current.onPaste(event));
    expect(preventDefault).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.images).toHaveLength(0);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: IMAGES_NEED_CLAUDE, type: "warning" }),
    ]);
  });

  it("with another provider still lets a text paste through", async () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { result } = renderHook(() => useAskImages());
    const { event, preventDefault } = paste([png("cells")], "A1\tB1");
    await act(async () => result.current.onPaste(event));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("mentions screenshots in the placeholder only when images can be attached", () => {
    expect(askPlaceholder(true)).toBe("Ask or paste a screenshot");
    expect(askPlaceholder(true).length).toBeLessThanOrEqual(26);
    expect(askPlaceholder(false)).toBe("Ask about the meeting...");
  });

  it("lets text through when the clipboard has text and a picture (Excel, Word, web)", async () => {
    const { result } = renderHook(() => useAskImages());
    const { event, preventDefault } = paste([png("cells")], "A1\tB1");
    await act(async () => result.current.onPaste(event));
    expect(preventDefault).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.images).toHaveLength(0);
  });

  it("still attaches the image when the clipboard text is only whitespace", async () => {
    const { result } = renderHook(() => useAskImages());
    await act(async () => result.current.onPaste(paste([png("a")], "  \n").event));
    await waitFor(() => expect(result.current.images).toHaveLength(1));
  });

  it("ignores a paste with no image", () => {
    const { result } = renderHook(() => useAskImages());
    const { event, preventDefault } = paste([], "just text");
    act(() => result.current.onPaste(event));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(result.current.images).toHaveLength(0);
  });

  it("never holds more than the limit when pastes come in quick succession", async () => {
    const { result } = renderHook(() => useAskImages());
    await act(async () => {
      // Two pastes before the first read finishes.
      result.current.onPaste(paste([png("a"), png("b")]).event);
      result.current.onPaste(paste([png("c"), png("d")]).event);
    });
    await waitFor(() => expect(result.current.images).toHaveLength(MAX_IMAGES));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.images).toHaveLength(MAX_IMAGES);
  });

  it("attaches files from the capture shortcut the same way, with the same limit", async () => {
    const { result } = renderHook(() => useAskImages());
    await act(async () => result.current.attach([png("a"), png("b")]));
    await waitFor(() => expect(result.current.images).toHaveLength(2));
    await act(async () => result.current.attach([png("c"), png("d")]));
    await waitFor(() => expect(result.current.images).toHaveLength(3));
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: `You can attach up to ${MAX_IMAGES} images`, type: "error" }),
    ]);
  });

  it("refuses captured files with another provider", async () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { result } = renderHook(() => useAskImages());
    await act(async () => result.current.attach([png("a")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.images).toHaveLength(0);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: IMAGES_NEED_CLAUDE, type: "warning" }),
    ]);
  });

  it("frees the slot of a removed image", async () => {
    const { result } = renderHook(() => useAskImages());
    await act(async () => result.current.onPaste(paste([png("a"), png("b"), png("c")]).event));
    await waitFor(() => expect(result.current.images).toHaveLength(3));
    act(() => result.current.remove(0));
    expect(result.current.images).toHaveLength(2);
    await act(async () => result.current.onPaste(paste([png("d")]).event));
    await waitFor(() => expect(result.current.images).toHaveLength(3));
  });
});

describe("AskImageChips", () => {
  it("groups the attachments and gives each remove button a 24px target", () => {
    const onRemove = vi.fn();
    render(<AskImageChips images={[{ media_type: "image/png", data: "AAAA" }]} onRemove={onRemove} />);
    expect(screen.getByRole("group", { name: "Attached images" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "Remove image 1" });
    expect(button.className).toMatch(/\bh-6\b/);
    expect(button.className).toMatch(/\bw-6\b/);
    button.click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
