import { afterEach, describe, expect, it } from "vitest";
import {
  NOTES_UPDATE_EVENT,
  OVERLAY_SINGLE_KEYS,
  forwardChordToEditor,
  hotkeyConflict,
  isActivatableTarget,
  isTypingTarget,
  keyBelongsToFocusedControl,
  overlaySingleKey,
  DEFAULT_HOTKEYS,
} from "./hotkeys";

function el(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTypingTarget", () => {
  it("knows inputs, textareas, selects, contenteditable (also inside) and role=textbox", () => {
    expect(isTypingTarget(el("<input />"))).toBe(true);
    expect(isTypingTarget(el("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(el("<select></select>"))).toBe(true);
    expect(isTypingTarget(el('<div contenteditable="true"><p id="p">x</p></div>').querySelector("#p"))).toBe(true);
    expect(isTypingTarget(el('<div contenteditable="plaintext-only"></div>'))).toBe(true);
    expect(isTypingTarget(el('<div role="textbox"></div>'))).toBe(true);
    expect(isTypingTarget(el('<div role="combobox"></div>'))).toBe(true);
  });
  it("does not treat plain elements, buttons or contenteditable=false as text boxes", () => {
    expect(isTypingTarget(el("<div></div>"))).toBe(false);
    expect(isTypingTarget(el("<button></button>"))).toBe(false);
    expect(isTypingTarget(el('<div contenteditable="false"></div>'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("keyBelongsToFocusedControl", () => {
  it("leaves every key to a text box", () => {
    const input = el("<input />");
    for (const key of ["1", "b", " ", "n"]) {
      expect(keyBelongsToFocusedControl({ target: input, key })).toBe(true);
    }
  });
  it("leaves Space (only) to a focused button, link, menu item, tab or switch", () => {
    for (const html of [
      "<button></button>",
      '<a href="#x">x</a>',
      '<div role="menuitem"></div>',
      '<div role="tab"></div>',
      '<div role="switch"></div>',
      '<div role="option"></div>',
    ]) {
      const t = el(html);
      expect(isActivatableTarget(t)).toBe(true);
      expect(keyBelongsToFocusedControl({ target: t, key: " ", code: "Space" })).toBe(true);
      expect(keyBelongsToFocusedControl({ target: t, key: "1", code: "Digit1" })).toBe(false);
    }
  });
  it("does not hold back keys on the page itself", () => {
    expect(keyBelongsToFocusedControl({ target: document.body, key: " ", code: "Space" })).toBe(false);
  });
  it("falls back to the focused element for window-level events", () => {
    const input = el("<input />") as HTMLInputElement;
    input.focus();
    expect(keyBelongsToFocusedControl({ target: window, key: "1" })).toBe(true);
  });
});

describe("forwardChordToEditor", () => {
  it("does nothing without a focused editor", () => {
    el("<button>b</button>").focus();
    expect(forwardChordToEditor("b")).toBe(false);
  });
  it("sends Ctrl+B to the focused contenteditable", () => {
    const editor = el('<div contenteditable="true" tabindex="0"></div>');
    editor.focus();
    const seen: KeyboardEvent[] = [];
    editor.addEventListener("keydown", (e) => seen.push(e));
    expect(forwardChordToEditor("b")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].ctrlKey).toBe(true);
    expect(seen[0].key).toBe("b");
    expect(seen[0].code).toBe("KeyB");
  });
  it("is not fooled by an input: Ctrl+B there still switches windows", () => {
    el("<input />").focus();
    expect(forwardChordToEditor("b")).toBe(false);
  });
});

describe("N = update notes", () => {
  it("is a registered overlay single key with its own event", () => {
    expect(overlaySingleKey("n")?.id).toBe("notes");
    expect(OVERLAY_SINGLE_KEYS.some((k) => k.key === "N")).toBe(true);
    expect(NOTES_UPDATE_EVENT).toBe("nexq:notes-update");
  });
  it("can not be given to an action key (same rule as B, S, K, M)", () => {
    expect(hotkeyConflict("N", "mode_assist", DEFAULT_HOTKEYS, {}, false)).toBe("Update notes now");
  });
});
