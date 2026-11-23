import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ProviderLogo, type CliLogoId } from "./ProviderLogos";

const IDS: CliLogoId[] = ["claude_cli", "gemini_cli", "antigravity_cli", "codex_cli"];

describe("ProviderLogo", () => {
  it.each(IDS)("renders an aria-hidden svg for %s", (id) => {
    const { container } = render(<ProviderLogo id={id} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.getAttribute("class")).toBe("h-4 w-4");
    expect(container.querySelector("path")).not.toBeNull();
  });

  it("applies a custom className", () => {
    const { container } = render(<ProviderLogo id="claude_cli" className="h-8 w-8" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("h-8 w-8");
  });

  it("uses unique gradient ids across Gemini instances", () => {
    const { container } = render(
      <>
        <ProviderLogo id="gemini_cli" />
        <ProviderLogo id="gemini_cli" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("linearGradient")).map((g) => g.id);
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6);
    for (const p of Array.from(container.querySelectorAll("path"))) {
      const m = p.getAttribute("fill")?.match(/^url\(#(.+)\)$/);
      if (m) expect(ids).toContain(m[1]);
    }
  });

  it("monochrome uses currentColor and no gradients", () => {
    for (const id of IDS) {
      const { container } = render(<ProviderLogo id={id} monochrome />);
      expect(container.querySelector("linearGradient")).toBeNull();
      for (const p of Array.from(container.querySelectorAll("path"))) {
        expect(p.getAttribute("fill")).toBe("currentColor");
      }
    }
  });
});
