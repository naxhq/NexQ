import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderOffers } from "./ReaderOffers";
import type { PrompterState } from "./prompterTypes";

const base = (over: Partial<PrompterState>) =>
  ({
    suggestion: null,
    canGoBack: false,
    yielding: false,
    goToSuggestion: vi.fn(),
    goBack: vi.fn(),
    resume: vi.fn(),
    ...over,
  }) as unknown as PrompterState;

const sg = (edge: "top" | "bottom") => ({ blockId: "b", text: "the budget", edge });

function slotOf(container: HTMLElement, offer: string) {
  return container.querySelector(`[data-offer="${offer}"]`)?.closest("[data-offer-slot], .tp-offers-top");
}

describe("the offers over the reader share one bottom action area", () => {
  it("Resume and a bottom Go to are never in the same slot, and Resume takes the primary one", () => {
    const { container } = render(<ReaderOffers p={base({ yielding: true, suggestion: sg("bottom"), canGoBack: true })} readingMode="auto" />);
    const resume = slotOf(container, "resume")!;
    const goto = slotOf(container, "goto")!;
    const back = slotOf(container, "back")!;
    expect(resume.getAttribute("data-offer-slot")).toBe("primary");
    expect(goto).not.toBe(resume);
    expect(back).not.toBe(resume);
    expect(goto).not.toBe(back);
    expect(container.querySelectorAll('[data-offer-slot="primary"] button')).toHaveLength(1);
  });

  it("each slot holds at most one chip", () => {
    const { container } = render(<ReaderOffers p={base({ yielding: true, suggestion: sg("bottom"), canGoBack: true })} readingMode="auto" />);
    for (const slot of container.querySelectorAll("[data-offer-slot]")) expect(slot.querySelectorAll("button")).toHaveLength(1);
  });

  it("a Go to at the top edge floats at the top, away from the bottom column", () => {
    const { container } = render(<ReaderOffers p={base({ yielding: true, suggestion: sg("top") })} readingMode="auto" />);
    expect(slotOf(container, "goto")?.classList.contains("tp-offers-top")).toBe(true);
    expect(container.querySelector('[data-offer-slot="primary"] [data-offer="resume"]')).not.toBeNull();
  });

  it("without a pause, Back or Go to takes the primary slot; Resume is hidden in manual mode", () => {
    const a = render(<ReaderOffers p={base({ canGoBack: true, suggestion: sg("bottom") })} readingMode="auto" />);
    expect(a.container.querySelector('[data-offer-slot="primary"] [data-offer="back"]')).not.toBeNull();
    a.unmount();
    const b = render(<ReaderOffers p={base({ yielding: true })} readingMode="manual" />);
    expect(b.container.querySelector('[data-offer="resume"]')).toBeNull();
  });
});
