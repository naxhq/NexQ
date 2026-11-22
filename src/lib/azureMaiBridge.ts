import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { MaiStart } from "./azureMaiSdk";

/** Register before React starts. The launcher hosts the SDK even when hidden
 * during a meeting; opening a Settings / overlay view never restarts it. */
export async function registerAzureMaiSdk(): Promise<void> {
  if (!isTauri() || getCurrentWebviewWindow().label !== "launcher") return;
  const starts = new Channel<MaiStart>((start) => {
    const { id } = start;
    void (async () => {
      try {
        const [{ runMaiSession }, sdk] = await Promise.all([
          import("./azureMaiSdk"),
          import("microsoft-cognitiveservices-speech-sdk"),
        ]);
        sdk.Recognizer.enableTelemetry(false);
        const run = () => runMaiSession(start, {
          token: () => invoke<string>("azure_mai_token", { id }),
          read: () => invoke<ArrayBuffer | number[]>("azure_mai_read", { id }),
          send: (event) => invoke<void>("azure_mai_event", { id, event }),
        }, sdk);
        // A hidden WebView2 launcher can be put to sleep. Keep it active only
        // while an SDK session is live (each party holds its own lock).
        if (navigator.locks) {
          await navigator.locks.request(`nexq-mai-${id}`, run);
        } else {
          await run();
        }
      } catch {
        // Do not forward SDK errors: some contain the authenticated URL.
        await invoke("azure_mai_event", { id, event: { kind: "failed", reason: "sdk" } }).catch(() => {});
      }
    })();
  });
  await invoke("azure_mai_register", { channel: starts });
}
