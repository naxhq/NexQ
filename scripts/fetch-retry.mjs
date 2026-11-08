// fetch() that tries again when GitHub's release downloads time out (HTTP 5xx
// or a dropped connection), which happens in bursts and used to fail whole CI
// and release runs. Answers that won't change, like a 404, fail at once.

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {{ attempts?: number, delayMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<Response>} the first successful response
 */
export async function fetchWithRetry(url, opts = {}) {
  const { attempts = 5, delayMs = 5000, fetchImpl = fetch, sleep = sleepFor } = opts;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(delayMs * 2 ** (attempt - 2));
    let res;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      lastError = `download failed: ${e.message}`;
      continue;
    }
    if (res.ok) return res;
    lastError = `download failed: HTTP ${res.status}`;
    if (res.status < 500 && res.status !== 429) throw new Error(lastError);
    console.warn(`[fetch] ${lastError}, attempt ${attempt} of ${attempts}`);
  }
  throw new Error(`${lastError} (${attempts} attempts)`);
}
