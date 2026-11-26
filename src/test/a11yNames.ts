// A small accessible-name check for tests (no axe dependency): every control, dialog, menu and
// list a person can reach has a real name, and no name is a generated id (":r2q:") or empty.

const GENERATED = /^:[a-z0-9]+:$/i;

const CONTROL_ROLES = [
  "button", "switch", "radio", "checkbox", "combobox", "listbox", "menu", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "tab", "tablist", "dialog", "alertdialog", "slider", "textbox", "searchbox",
  "radiogroup", "separator", "img",
];

// Groups and containers must be named on purpose (aria-label or a title): their text is not their name.
const NAMED_ON_PURPOSE = ["tablist", "radiogroup", "menu", "listbox", "dialog", "alertdialog"];

const NATIVE = "button, a[href], input, select, textarea, img";

function hiddenFromUsers(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true") return true;
    if (n.getAttribute("role") === "presentation" || n.getAttribute("role") === "none") return true;
  }
  return false;
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The name a screen reader would speak (an approximation of the accessible name computation). */
export function accessibleName(el: Element): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    return by
      .split(/\s+/)
      .map((id) => textOf(el.ownerDocument.getElementById(id)))
      .join(" ")
      .trim();
  }
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const t = [...labels].map(textOf).join(" ").trim();
    if (t) return t;
  }
  if (NAMED_ON_PURPOSE.includes(el.getAttribute("role") ?? "")) return "";
  if (el.tagName === "IMG") return el.getAttribute("alt")?.trim() ?? "";
  const role = el.getAttribute("role");
  // Inputs that are not text-like take their name from a label, not from their (empty) content.
  if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return el.getAttribute("title")?.trim() || el.getAttribute("placeholder")?.trim() || "";
  if (role === "separator") return "";
  const own = textOf(el);
  return own || el.getAttribute("title")?.trim() || "";
}

export interface Unnamed {
  what: string;
  why: "empty" | "generated id" | "dangling aria-labelledby";
}

/** Every reachable control, dialog, menu or list under `root` whose name is empty or a generated id. */
export function unnamedControls(root: ParentNode = document.body): Unnamed[] {
  const found: Unnamed[] = [];
  const seen = new Set<Element>();
  const roleSel = CONTROL_ROLES.map((r) => `[role="${r}"]`).join(",");
  for (const el of root.querySelectorAll(`${NATIVE},${roleSel}`)) {
    if (seen.has(el) || hiddenFromUsers(el)) continue;
    seen.add(el);
    if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "submit")) continue;
    // A decorative svg-only icon inside a named button is not a control.
    if (el.tagName === "IMG" && el.getAttribute("role") !== "img" && el.getAttribute("alt") === "") continue;
    // A separator between menu items is a rule, not a control; the resize handles carry labels.
    if (el.getAttribute("role") === "separator" && el.getAttribute("aria-orientation") !== "vertical") continue;
    const name = accessibleName(el);
    const what = `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${el.outerHTML.slice(0, 110)}`;
    const by = el.getAttribute("aria-labelledby");
    if (by && by.split(/\s+/).some((id) => !el.ownerDocument.getElementById(id))) found.push({ what, why: "dangling aria-labelledby" });
    else if (!name) found.push({ what, why: "empty" });
    else if (GENERATED.test(name) || GENERATED.test(el.getAttribute("aria-label") ?? "")) found.push({ what, why: "generated id" });
  }
  return found;
}
