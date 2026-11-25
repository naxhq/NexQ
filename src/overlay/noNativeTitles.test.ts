import { describe, expect, it } from "vitest";

// A native `title` is drawn by Windows itself, so it can show up in a screen share. The meeting
// window uses the ui Tooltip instead. This scans the sources for a `title=` on a plain element.

// Files where an older native title is still allowed, with the reason. Keep this list empty if you can.
const ALLOWED: Record<string, string> = {};

async function sources(): Promise<{ file: string; text: string }[]> {
  // @ts-expect-error the node types are not part of the app's build
  const fs = await import("node:fs");
  // @ts-expect-error the node types are not part of the app's build
  const path = await import("node:path");
  const roots = ["src/overlay", "src/components/ServiceStatusBar.tsx", "src/live-notes", "src/live-brief", "src/talking-points"];
  const out: { file: string; text: string }[] = [];
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    } else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) {
      out.push({ file: p.split(String.fromCharCode(92)).join("/"), text: fs.readFileSync(p, "utf8") });
    }
  };
  roots.forEach(walk);
  return out;
}

/** Opening tags of lowercase (plain DOM) elements that carry a `title=` attribute at the top level of the tag. */
function nativeTitles(text: string): number[] {
  const hits: number[] = [];
  const open = /<([a-z][a-z0-9]*)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = "";
    let found = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || (c === "'" && depth === 0)) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === ">" ) break;
      else if (depth === 0 && /\stitle=/.test(text.slice(i - 1, i + 7)) && /\s/.test(text[i - 1] ?? "")) found = true;
    }
    if (found) hits.push(text.slice(0, m.index).split("\n").length);
  }
  return hits;
}

describe("no native title tooltips in the meeting window", () => {
  it("finds a title attribute on a plain element (the scan itself works)", () => {
    expect(nativeTitles('<div>\n<button title="x" onClick={() => a > 1}>y</button></div>')).toEqual([2]);
    expect(nativeTitles('<Dialog title="x"><span aria-label="t">z</span></Dialog>')).toEqual([]);
  });

  it("has none in overlay, the footer, live notes, brief or talking points", async () => {
    const bad: string[] = [];
    for (const { file, text } of await sources()) {
      if (ALLOWED[file]) continue;
      for (const line of nativeTitles(text)) bad.push(`${file}:${line}`);
    }
    expect(bad).toEqual([]);
  });
});
