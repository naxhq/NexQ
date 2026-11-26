import { showToast } from "../stores/toastStore";

/** Copy text; says so, or says why not. Never throws. */
export async function copyText(text: string, done = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(done, "success");
    return true;
  } catch {
    showToast("Could not copy. Select the text and copy it instead.", "error");
    return false;
  }
}
