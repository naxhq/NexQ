import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Record the order of overlay.show / launcher.hide calls. Mocks come first,
// before the module under test imports its deps.
const calls: string[] = [];

const overlay = {
  show: vi.fn(async () => { calls.push("overlay.show"); }),
  unminimize: vi.fn(async () => { calls.push("overlay.unminimize"); }),
  setFocus: vi.fn(async () => { calls.push("overlay.setFocus"); }),
};
const launcher = {
  hide: vi.fn(async () => { calls.push("launcher.hide"); }),
};

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: async (label: string) => (label === "overlay" ? overlay : launcher),
  },
}));

const getStealth = vi.fn(() => false);
vi.mock("../stores/configStore", () => ({
  useConfigStore: { getState: () => ({ stealthMode: getStealth() }) },
}));

vi.mock("./logger", () => ({ logToFile: () => {} }));

beforeEach(() => {
  calls.length = 0;
  overlay.show.mockClear();
  overlay.unminimize.mockClear();
  overlay.setFocus.mockClear();
  launcher.hide.mockClear();
  getStealth.mockReturnValue(false);
});

afterEach(() => {
  vi.resetModules();
});

describe("showOverlayWindow", () => {
  it("non-stealth: shows the overlay first, then hides the launcher (avoids a blank frame)", async () => {
    getStealth.mockReturnValue(false);
    const { showOverlayWindow } = await import("./windows");
    await showOverlayWindow();
    expect(overlay.show).toHaveBeenCalledTimes(1);
    expect(launcher.hide).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("overlay.show");
    expect(calls[calls.length - 1]).toBe("launcher.hide");
  });

  it("stealth: hides the launcher first, then shows the overlay (avoids a launcher-flash)", async () => {
    getStealth.mockReturnValue(true);
    const { showOverlayWindow } = await import("./windows");
    await showOverlayWindow();
    expect(launcher.hide).toHaveBeenCalledTimes(1);
    expect(overlay.show).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("launcher.hide");
    expect(calls.indexOf("overlay.show")).toBeGreaterThan(calls.indexOf("launcher.hide"));
  });

  it("stealth: never calls launcher.hide more than once", async () => {
    getStealth.mockReturnValue(true);
    const { showOverlayWindow } = await import("./windows");
    await showOverlayWindow();
    expect(launcher.hide).toHaveBeenCalledTimes(1);
  });
});
