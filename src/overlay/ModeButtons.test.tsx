import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/userAction", () => ({
  runUserAction: vi.fn(() => Promise.resolve()),
  actionLabel: (mode: string) => mode,
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import { ModeButtons } from "./ModeButtons";
import { cancelGeneration } from "../lib/ipc";
import { runUserAction } from "../lib/userAction";
import { useQuestionStore } from "../stores/questionStore";
import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";
import { DEFAULT_IMAGE_QUESTION } from "./sendAsk";

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

function automaticAnswerRunning() {
  useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
  useQuestionStore.getState().setAutoAnswer({
    requestId: "auto-1", segmentId: "line", question: "Why?", early: false, done: Promise.resolve(),
  });
  vi.mocked(cancelGeneration).mockImplementation(async () => useStreamStore.getState().endStream(0));
}

beforeEach(() => {
  vi.mocked(runUserAction).mockClear();
  vi.mocked(cancelGeneration).mockReset().mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  useStreamStore.getState().resetForMeeting();
  useQuestionStore.getState().clear();
});

describe("ModeButtons Ask box with a pasted image", () => {
  const input = () => screen.getByLabelText("Ask a question") as HTMLInputElement;
  const openAsk = () => fireEvent.click(button(/^Ask/));
  const chips = () => screen.queryByRole("group", { name: "Attached images" });

  async function pasteImage(content = "a") {
    const file = new File([content], "shot.png", { type: "image/png" });
    fireEvent.paste(input(), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "",
      },
    });
    await screen.findByRole("group", { name: "Attached images" });
  }

  beforeEach(() => {
    useConfigStore.setState({ llmProvider: "claude_cli" });
    useToastStore.setState({ toasts: [] });
    vi.stubGlobal("createImageBitmap", async () => ({ width: 100, height: 100, close: () => {} }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a captured screenshot opens the Ask box with the image attached, and sends nothing", async () => {
    const { deliverScreenshot } = await import("../lib/screenCapture");
    render(<ModeButtons />);
    expect(screen.queryByLabelText("Ask a question")).toBeNull();
    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));
    await screen.findByRole("group", { name: "Attached images" });
    expect(input()).toBeTruthy();
    expect(vi.mocked(runUserAction)).not.toHaveBeenCalled();
  });

  it("puts the cursor in the Ask box for a screenshot, also when the box was already open", async () => {
    const { deliverScreenshot } = await import("../lib/screenCapture");
    render(<ModeButtons />);
    openAsk();
    // Focus is somewhere else (the user clicked away, or the window was behind).
    input().blur();
    expect(document.activeElement).not.toBe(input());
    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));
    await screen.findByRole("group", { name: "Attached images" });
    expect(document.activeElement).toBe(input());
  });

  it("takes a screenshot that arrived before the Ask box existed", async () => {
    const { SCREENSHOT_EVENT, deliverScreenshot } = await import("../lib/screenCapture");
    // Something (e.g. the overlay switching layouts) claimed it while the Ask box was on its way.
    const claim = (e: Event) => e.preventDefault();
    window.addEventListener(SCREENSHOT_EVENT, claim);
    deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" }));
    window.removeEventListener(SCREENSHOT_EVENT, claim);
    render(<ModeButtons />);
    await screen.findByRole("group", { name: "Attached images" });
    expect(input()).toBeTruthy();
  });

  it("keeps a screenshot taken while the question is on its way, and drops only what was sent", async () => {
    const { deliverScreenshot } = await import("../lib/screenCapture");
    let resolveAnswer!: () => void;
    vi.mocked(runUserAction).mockImplementationOnce(() => new Promise<void>((resolve) => (resolveAnswer = resolve)));
    render(<ModeButtons />);
    openAsk();
    fireEvent.change(input(), { target: { value: "what is this?" } });
    await pasteImage("sent");
    fireEvent.click(button(/^Send question/));
    await waitFor(() => expect(runUserAction).toHaveBeenCalled());
    expect(vi.mocked(runUserAction).mock.calls[0][2]).toEqual({ images: [{ media_type: "image/png", data: btoa("sent") }] });

    // A screenshot arrives while the answer is still pending.
    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));
    await act(async () => resolveAnswer());

    const group = await screen.findByRole("group", { name: "Attached images" });
    const sources = [...group.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources).toEqual([`data:image/png;base64,${btoa("shot")}`]);
  });

  it("says the Ask box opens later while the user's own answer is running, then shows the screenshot with the cursor in it", async () => {
    const { deliverScreenshot } = await import("../lib/screenCapture");
    useStreamStore.getState().startStream("AskQuestion", "m", "p", { requestId: "mine-1" });
    render(<ModeButtons />);
    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Screenshot added. Ask opens when this answer finishes.", type: "info" }),
    ]);
    expect(screen.queryByLabelText("Ask a question")).toBeNull();

    act(() => useStreamStore.getState().endStream(0));
    expect(await screen.findByRole("group", { name: "Attached images" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("refuses a screenshot when the running Ask request holds every image slot, with no false 'added'", async () => {
    const { deliverScreenshot } = await import("../lib/screenCapture");
    let resolveAnswer!: () => void;
    vi.mocked(runUserAction).mockImplementationOnce(() => new Promise<void>((resolve) => (resolveAnswer = resolve)));
    render(<ModeButtons />);
    openAsk();
    fireEvent.change(input(), { target: { value: "what are these?" } });
    for (const name of ["a", "b", "c"]) await pasteImage(name);
    await waitFor(() => expect(chips()!.querySelectorAll("img")).toHaveLength(3));
    fireEvent.click(button(/^Send question/));
    await waitFor(() => expect(runUserAction).toHaveBeenCalled());

    useToastStore.setState({ toasts: [] });
    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(["You can attach up to 3 images"]);
    expect(messages.join()).not.toMatch(/Screenshot added/);

    // Once the answer is in, its slots are free again.
    await act(async () => resolveAnswer());
    expect(chips()).toBeNull();
    act(() => deliverScreenshot(new File(["shot2"], "screen.png", { type: "image/png" })));
    expect(await screen.findByRole("group", { name: "Attached images" })).toBeTruthy();
  });

  it("an empty box with an image sends the default question with the image", async () => {
    render(<ModeButtons />);
    openAsk();
    await pasteImage("a");
    fireEvent.click(button(/^Send question/));
    await waitFor(() =>
      expect(runUserAction).toHaveBeenCalledWith("AskQuestion", DEFAULT_IMAGE_QUESTION, {
        images: [{ media_type: "image/png", data: btoa("a") }],
      }),
    );
  });

  it("clears the text and the image once the answer came", async () => {
    render(<ModeButtons />);
    openAsk();
    fireEvent.change(input(), { target: { value: "what is this?" } });
    await pasteImage();
    fireEvent.click(button(/^Send question/));
    await waitFor(() => expect(runUserAction).toHaveBeenCalled());
    await act(async () => {});
    openAsk();
    expect(input().value).toBe("");
    expect(chips()).toBeNull();
  });

  it("keeps the typed text and the image when the send fails", async () => {
    vi.mocked(runUserAction).mockRejectedValueOnce("Images work only with Claude (subscription).");
    render(<ModeButtons />);
    openAsk();
    fireEvent.change(input(), { target: { value: "what is this?" } });
    await pasteImage();
    fireEvent.click(button(/^Send question/));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "Images work only with Claude (subscription).",
      ),
    );
    openAsk();
    expect(input().value).toBe("what is this?");
    expect(chips()).not.toBeNull();
  });

  it("doesn't show the images of a request that is still running", async () => {
    let finish!: () => void;
    vi.mocked(runUserAction).mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    render(<ModeButtons />);
    openAsk();
    await pasteImage();
    fireEvent.click(button(/^Send question/));
    await waitFor(() => expect(runUserAction).toHaveBeenCalled());
    openAsk();
    expect(chips()).toBeNull();
    await act(async () => finish());
    expect(chips()).toBeNull();
  });

  it("starts each meeting with an empty Ask box", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    render(<ModeButtons />);
    openAsk();
    fireEvent.change(input(), { target: { value: "left over" } });
    await pasteImage();
    act(() => useMeetingStore.setState({ activeMeeting: { id: "m2" } as never }));
    expect(screen.queryByLabelText("Ask a question")).toBeNull();
    openAsk();
    expect(input().value).toBe("");
    expect(chips()).toBeNull();
    act(() => useMeetingStore.setState({ activeMeeting: null }));
  });

  it("keeps keys pressed on a thumbnail's remove button from the meeting shortcuts", async () => {
    render(<ModeButtons />);
    openAsk();
    await pasteImage();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove image 1" }), { key: " ", code: "Space" });
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove image 1" }), { key: "Escape" });
    expect(screen.queryByLabelText("Ask a question")).toBeNull();
    window.removeEventListener("keydown", onWindowKey);
  });

  it("names the paste shortcut only with Claude (subscription)", () => {
    const { unmount } = render(<ModeButtons />);
    openAsk();
    expect(input().placeholder).toBe("Ask or paste a screenshot");
    unmount();
    useConfigStore.setState({ llmProvider: "openai" });
    render(<ModeButtons />);
    openAsk();
    expect(input().placeholder).toBe("Ask about the meeting...");
  });
});

describe("ModeButtons while an answer runs", () => {
  it("another action stops an automatic answer and runs", async () => {
    automaticAnswerRunning();
    render(<ModeButtons />);
    const recap = button(/^Recap/);
    expect(recap.disabled).toBe(false);

    fireEvent.click(recap);
    await waitFor(() => expect(runUserAction).toHaveBeenCalledWith("Recap", undefined));
    expect(cancelGeneration).toHaveBeenCalledWith("auto-1");
  });

  it("the running action's own button still just stops it", async () => {
    automaticAnswerRunning();
    render(<ModeButtons />);
    fireEvent.click(button(/^Assist/));
    await waitFor(() => expect(cancelGeneration).toHaveBeenCalled());
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("an answer you asked for keeps the other actions locked", () => {
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "yours" });
    render(<ModeButtons />);
    expect(button(/^Recap/).disabled).toBe(true);
    fireEvent.click(button(/^Recap/));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
  });
});
