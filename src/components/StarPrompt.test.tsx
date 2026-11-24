import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: (url: string) => shell.open(url) }));

const prompt = vi.hoisted(() => ({
  visible: true,
  acknowledge: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../hooks/useStarPrompt", () => ({
  useStarPrompt: () => prompt,
}));

import {
  StarPrompt,
  STAR_PROMPT_BODY,
  STAR_PROMPT_OPEN_FAILED,
  STAR_PROMPT_THANKS,
  STAR_PROMPT_TITLE,
} from "./StarPrompt";
import { useToastStore } from "../stores/toastStore";
import { NEXQ_NEW_ISSUE_URL, NEXQ_REPO_URL } from "../lib/links";

/** Text on the card, not the screen-reader copy of it. */
const onCard = (text: string) => screen.queryAllByText(text).filter((el) => el.getAttribute("role") !== "status");

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("StarPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prompt.visible = true;
    prompt.acknowledge.mockReset();
    prompt.close.mockReset();
    shell.open.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders nothing while it should not be visible", () => {
    prompt.visible = false;
    const { container } = render(<StarPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the title, body and exactly three actions, with no close button", () => {
    render(<StarPrompt />);
    const region = screen.getByRole("region", { name: STAR_PROMPT_TITLE });
    expect(STAR_PROMPT_TITLE).toBe("Is NexQ working for you?");
    expect(region).toHaveTextContent("It's free and open source. A star on GitHub helps other people find it.");
    expect(STAR_PROMPT_BODY).not.toMatch(/[—–]/);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Don't show again", "Send feedback", "Star on GitHub"]);
  });

  it("is a polite region, not an alert or a dialog, and does not take focus", () => {
    render(<StarPrompt />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(document.body).toHaveFocus();
  });

  it("announces itself politely after it appears", async () => {
    render(<StarPrompt />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await advance(200);
    expect(screen.getByRole("status")).toHaveTextContent(STAR_PROMPT_TITLE);
  });

  it("Star on GitHub opens the repo, saves the choice, says thanks, and closes after about 4 s", async () => {
    render(<StarPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
    await flush();

    expect(shell.open).toHaveBeenCalledWith(NEXQ_REPO_URL);
    expect(NEXQ_REPO_URL).toBe("https://github.com/naxhq/NexQ");
    expect(prompt.acknowledge).toHaveBeenCalled();
    expect(onCard(STAR_PROMPT_THANKS)).toHaveLength(1);
    expect(STAR_PROMPT_THANKS).toBe("Thanks. GitHub is open in your browser.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("region", { name: STAR_PROMPT_THANKS })).toBeInTheDocument();

    await advance(4_000 - 1);
    expect(prompt.close).not.toHaveBeenCalled();
    await advance(1 + 200);
    expect(prompt.close).toHaveBeenCalledTimes(1);
  });

  it("Send feedback opens the issue chooser and just closes", async () => {
    render(<StarPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await flush();

    expect(shell.open).toHaveBeenCalledWith(NEXQ_NEW_ISSUE_URL);
    expect(NEXQ_NEW_ISSUE_URL).toBe("https://github.com/naxhq/NexQ/issues/new/choose");
    expect(prompt.acknowledge).toHaveBeenCalled();
    expect(onCard(STAR_PROMPT_THANKS)).toHaveLength(0);
    await advance(250);
    expect(prompt.close).toHaveBeenCalledTimes(1);
  });

  it("Don't show again closes without opening anything", async () => {
    render(<StarPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));
    expect(prompt.acknowledge).toHaveBeenCalled();
    expect(shell.open).not.toHaveBeenCalled();
    await advance(250);
    expect(prompt.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the card and says so when the browser won't open, then lets them retry", async () => {
    shell.open.mockRejectedValueOnce(new Error("no browser"));
    render(<StarPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
    await flush();

    expect(onCard(STAR_PROMPT_OPEN_FAILED)).toHaveLength(1);
    expect(STAR_PROMPT_OPEN_FAILED).toBe("Couldn't open your browser.");
    expect(screen.getByRole("button", { name: "Star on GitHub" })).toBeInTheDocument();
    await advance(10_000);
    expect(prompt.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
    await flush();
    expect(shell.open).toHaveBeenCalledTimes(2);
    expect(onCard(STAR_PROMPT_THANKS)).toHaveLength(1);
    expect(onCard(STAR_PROMPT_OPEN_FAILED)).toHaveLength(0);
  });

  it("a failed feedback link keeps the card too", async () => {
    shell.open.mockRejectedValueOnce(new Error("no browser"));
    render(<StarPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await flush();
    await advance(1_000);
    expect(onCard(STAR_PROMPT_OPEN_FAILED)).toHaveLength(1);
    expect(prompt.close).not.toHaveBeenCalled();
  });

  it("opens the link once for a double click", async () => {
    render(<StarPrompt />);
    const star = screen.getByRole("button", { name: "Star on GitHub" });
    fireEvent.click(star);
    fireEvent.click(star);
    await flush();
    expect(shell.open).toHaveBeenCalledTimes(1);
  });

  it("Escape inside the card closes it and does not reach the app's Escape handler", async () => {
    const appHandler = vi.fn();
    window.addEventListener("keydown", appHandler);
    render(<StarPrompt />);
    const star = screen.getByRole("button", { name: "Star on GitHub" });
    star.focus();
    fireEvent.keyDown(star, { key: "Escape" });

    expect(appHandler).not.toHaveBeenCalled();
    expect(prompt.acknowledge).toHaveBeenCalled();
    await advance(250);
    expect(prompt.close).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", appHandler);
  });

  it("Escape elsewhere in the app leaves the card alone", async () => {
    const appHandler = vi.fn();
    window.addEventListener("keydown", appHandler);
    render(<StarPrompt />);
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(appHandler).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(prompt.close).not.toHaveBeenCalled();
    expect(screen.getByRole("region")).toBeInTheDocument();
    window.removeEventListener("keydown", appHandler);
  });

  it("other keys inside the card are not swallowed", () => {
    const appHandler = vi.fn();
    window.addEventListener("keydown", appHandler);
    render(<StarPrompt />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Send feedback" }), { key: "Tab" });
    expect(appHandler).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", appHandler);
  });

  it("stays above the toast stack while toasts are showing", async () => {
    const stack = document.createElement("div");
    stack.setAttribute("aria-label", "Notifications");
    stack.getBoundingClientRect = () => ({ height: 120 }) as DOMRect;
    document.body.appendChild(stack);
    useToastStore.setState({ toasts: [{ id: "t", message: "Saved", type: "success", createdAt: 0 }] });

    const { container } = render(<StarPrompt />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.bottom).toBe("146px");

    stack.remove();
    act(() => useToastStore.setState({ toasts: [] }));
    expect(wrapper.style.bottom).toBe("56px");
  });
});
