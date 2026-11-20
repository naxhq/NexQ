import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_EXIT_MS, toastDurationMs, useToastStore } from "../stores/toastStore";
import { ToastContainer } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("toastDurationMs", () => {
  it("is 4 s plus about 60 ms a character, capped at 10 s", () => {
    expect(toastDurationMs("")).toBe(4000);
    expect(toastDurationMs("x".repeat(50))).toBe(7000);
    expect(toastDurationMs("x".repeat(500))).toBe(10_000);
  });
});

describe("ToastContainer", () => {
  it("keeps a sticky toast until its key is dismissed, and replaces one with the same key", async () => {
    render(<ToastContainer />);
    const { setStickyToast, dismissByKey } = useToastStore.getState();
    act(() => setStickyToast("capture-you", "Reconnecting your microphone…", "warning"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("Reconnecting your microphone…")).toBeInTheDocument();

    act(() => setStickyToast("capture-you", "Your microphone disconnected.", "warning"));
    // The replaced toast plays its exit, then leaves.
    expect(screen.getByText("Reconnecting your microphone…").closest("[role=alert]")).toHaveClass("toast-exit");
    await act(() => vi.advanceTimersByTimeAsync(TOAST_EXIT_MS));
    expect(screen.queryByText("Reconnecting your microphone…")).toBeNull();
    expect(screen.getByText("Your microphone disconnected.")).toBeInTheDocument();
    expect(useToastStore.getState().toasts).toHaveLength(1);

    act(() => dismissByKey("capture-you"));
    expect(screen.getByText("Your microphone disconnected.").closest("[role=alert]")).toHaveClass("toast-exit");
    await act(() => vi.advanceTimersByTimeAsync(TOAST_EXIT_MS));
    expect(screen.queryByText("Your microphone disconnected.")).toBeNull();
  });

  const show = (message: string) => act(() => useToastStore.getState().addToast(message, "error"));

  it("keeps a long message on screen longer than a short one", async () => {
    const short = "Saved";
    const long = "x".repeat(60); // 7.6 s
    render(<ToastContainer />);
    show(short);
    show(long);
    await act(() => vi.advanceTimersByTimeAsync(toastDurationMs(short) + 300));
    expect(screen.queryByText(short)).toBeNull();
    expect(screen.getByText(long)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(toastDurationMs(long)));
    expect(screen.queryByText(long)).toBeNull();
  });

  it("stops the countdown while hovered and resumes with the time left", async () => {
    const message = "Heads up"; // 4.48 s
    render(<ToastContainer />);
    show(message);
    const toast = screen.getByRole("alert");

    await act(() => vi.advanceTimersByTimeAsync(3000));
    fireEvent.mouseEnter(toast);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(message)).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    await act(() => vi.advanceTimersByTimeAsync(1000)); // 1 s of the 1.48 s left
    expect(screen.getByText(message)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByText(message)).toBeNull();
  });

  it("resumes when the window loses focus while the pointer is on the toast", async () => {
    const message = "Heads up";
    render(<ToastContainer />);
    show(message);
    fireEvent.mouseEnter(screen.getByRole("alert"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(message)).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("blur")); });
    await act(() => vi.advanceTimersByTimeAsync(toastDurationMs(message) + 300));
    expect(screen.queryByText(message)).toBeNull();
  });

  it("stops the countdown while the toast has keyboard focus", async () => {
    const message = "Heads up";
    render(<ToastContainer />);
    show(message);
    const button = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => button.focus());
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(message)).toBeInTheDocument();
    act(() => button.blur());
    await act(() => vi.advanceTimersByTimeAsync(toastDurationMs(message) + 300));
    expect(screen.queryByText(message)).toBeNull();
  });
});
