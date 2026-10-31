// Saving the last transcript lines when a meeting ends. A failed write is
// retried briefly; the caller keeps the meeting open if lines remain unsaved,
// so the transcript is never cleared before it reached the database.

export async function saveSegmentsWithRetry<T>(
  segments: T[],
  save: (segment: T) => Promise<void>,
  onSaved: (segment: T) => void,
  attempts = 3,
  delayMs = 300
): Promise<number> {
  let failed = 0;
  for (const segment of segments) {
    // Once a line failed every attempt the database is likely unavailable:
    // try the rest once each, so End doesn't wait on retries for every line.
    const tries = failed > 0 ? 1 : attempts;
    let saved = false;
    for (let attempt = 1; attempt <= tries && !saved; attempt++) {
      try {
        await save(segment);
        onSaved(segment);
        saved = true;
      } catch (err) {
        console.error(`[endMeetingSave] Failed to save segment (attempt ${attempt}/${tries}):`, err);
        if (attempt < tries) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (!saved) failed++;
  }
  return failed;
}

export function unsavedTranscriptError(failed: number): Error {
  return new Error(
    `${failed} transcript line${failed === 1 ? "" : "s"} could not be saved. The meeting is still open — press End again.`
  );
}
