import { afterEach, describe, expect, it } from "vitest";

// The "Said it" circles: a paragraph's shows on hover or focus, a bullet's replaces the dot and
// must be visible at rest. A rule once lost its opacity and the bullets had no mark.
async function css(): Promise<string> {
  // @ts-expect-error the node types are not part of the app's build
  const { readFileSync } = await import("node:fs");
  return readFileSync("src/talking-points/talkingPoints.css", "utf8");
}

describe("the Said it circles at rest", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("a bullet's circle is visible, a paragraph's is not", async () => {
    const style = document.createElement("style");
    style.textContent = await css();
    document.head.append(style);
    document.body.innerHTML = `
      <div class="tp-read tp-ticks">
        <ul><li><p data-block-id="b" data-list="bullet"><button class="tp-tick" id="bullet"></button>a bullet</p></li></ul>
        <p data-block-id="p"><button class="tp-tick" id="para"></button>a paragraph</p>
      </div>`;
    expect(getComputedStyle(document.getElementById("bullet")!).opacity).toBe("1");
    expect(getComputedStyle(document.getElementById("para")!).opacity).toBe("0");
  });
});
