import type * as Speech from "microsoft-cognitiveservices-speech-sdk";

export const MODEL = "mai-transcribe-2-streaming";
const START_TIMEOUT_MS = 9_000;
const VAD_TAIL_SAMPLES = 19_200; // 1.2 seconds of silence, only on a normal stop
const VAD_TAIL_TIMEOUT_MS = 1_200;
const FINAL_TIMEOUT_MS = 1_700;
const TOKEN_REFRESH_MS = 8 * 60_000;
const PRECONNECT_BYTES = 16_000; // 500 ms, not a transcription batch

export interface MaiStart {
  id: string;
  region: string;
  language: string | null;
  probe: boolean;
}

type Failure = "credentials" | "model" | "network" | "sdk";
type Event =
  | { kind: "connected" | "reconnecting" | "clear_interim" | "closed" | "verified" }
  | { kind: "failed"; reason: Failure }
  | {
      kind: "transcript";
      text: string;
      isFinal: boolean;
      timestampMs: number;
      durationMs: number | null;
      language: string | null;
    };
export interface MaiTransport {
  token(): Promise<string>;
  read(): Promise<ArrayBuffer | number[]>;
  send(event: Event): Promise<void>;
}

interface Frame {
  timestamp: number;
  pcm: ArrayBuffer;
}

function decodeFrame(raw: ArrayBuffer): Frame {
  if (raw.byteLength < 8 || raw.byteLength % 2 !== 0) throw new Error("Invalid PCM frame");
  const view = new DataView(raw);
  return { timestamp: Number(view.getBigUint64(0, true)), pcm: raw.slice(8) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function deadline<T, F>(value: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function tokenFailure(error: unknown): Failure {
  return error === "credentials" || error === "sdk" ? error : "network";
}

function cancellation(sdk: typeof Speech, event: Speech.SpeechRecognitionCanceledEventArgs): Failure {
  // The browser SDK can hide the HTTP close status. Use the numeric code when
  // present, and classify known diagnostic strings without forwarding raw
  // errorDetails (which can contain the authenticated WebSocket URL).
  if (/unknown speech\.context\.model\.name|model.+(?:not (?:found|supported|available)|unavailable)/i.test(event.errorDetails)) {
    return "model";
  }
  if (event.errorCode === sdk.CancellationErrorCode.AuthenticationFailure ||
      event.errorCode === sdk.CancellationErrorCode.Forbidden ||
      /\b(401|403)\b/.test(event.errorDetails)) {
    return "credentials";
  }
  if (event.errorCode === sdk.CancellationErrorCode.BadRequestParameters) return "model";
  return "network";
}

type Outcome = Failure | "closed" | "verified" | "discontinuity";

function tickMs(ticks: number): number | undefined {
  return Number.isFinite(ticks) && ticks >= 0 ? Math.floor(ticks / 10_000) : undefined;
}

/** One launcher-owned SDK worker per Rust provider. A fresh recognizer is
 * created after terminal network errors. Audio from a dead session is never
 * replayed into another. Stop/mute/provider swap close the Rust PCM source. */
export async function runMaiSession(start: MaiStart, ipc: MaiTransport, sdk: typeof Speech): Promise<void> {
  const inputEnded = deferred<void>();
  let stopped = false;
  let writeFrame: ((frame: Frame) => void) | undefined;
  let warm: Frame[] = [];
  let warmBytes = 0;
  let keepWarm = !start.probe;
  let inputFailed = false;
  const stopInput = () => {
    stopped = true;
    keepWarm = false;
    warm = [];
    inputEnded.resolve();
  };

  // Keep transcript writes in callback order even if IPC dispatch times vary.
  let sends = Promise.resolve();
  const emit = (event: Event) => {
    sends = sends.then(() => ipc.send(event)).catch(stopInput);
  };

  if (!start.probe) {
    void (async () => {
      try {
        while (!stopped) {
          const payload = await ipc.read();
          // Tauri's postMessage fallback uses an array of bytes, not the
          // ArrayBuffer returned by its regular binary IPC transport.
          const raw = Array.isArray(payload) ? Uint8Array.from(payload).buffer : payload;
          if (raw.byteLength === 0 || stopped) break;
          const frame = decodeFrame(raw);
          if (writeFrame) {
            writeFrame(frame);
          } else if (keepWarm && frame.pcm.byteLength > 0 && frame.pcm.byteLength <= PRECONNECT_BYTES) {
            warm.push(frame);
            warmBytes += frame.pcm.byteLength;
            while (warmBytes > PRECONNECT_BYTES) warmBytes -= warm.shift()!.pcm.byteLength;
          }
        }
      } catch {
        inputFailed = true;
      } finally {
        stopInput();
      }
    })();
  }

  async function attempt(): Promise<{ outcome: Outcome; connectedMs: number }> {
    const done = deferred<Outcome>();
    let stream: Speech.PushAudioInputStream | undefined;
    let config: Speech.SpeechConfig | undefined;
    let recognizer: Speech.SpeechRecognizer | undefined;
    let readyAt: number | undefined;
    let streamOrigin: number | undefined;
    let streamSamples = 0;
    let inputClosed = false;
    let disposed = false;
    let failed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPartial: string | undefined;
    let lastFinal: string | undefined;
    let phraseStart: number | undefined;
    let tailFinal: (() => void) | undefined;
    const finish = (outcome: Outcome) => {
      failed = true;
      writeFrame = undefined;
      done.resolve(outcome);
    };
    const closeInput = () => {
      if (inputClosed) return;
      inputClosed = true;
      writeFrame = undefined;
      stream?.close();
    };

    let outcome: Outcome = "closed";
    try {
      const token = await Promise.race([
        ipc.token().then((value) => ({ value }), (error) => ({ failure: tokenFailure(error) })),
        inputEnded.promise.then(() => null),
      ]);
      if (!token) return { outcome, connectedMs: 0 };
      if ("failure" in token) return { outcome: token.failure, connectedMs: 0 };

      config = sdk.SpeechConfig.fromAuthorizationToken(token.value, start.region);
      config.setModel(MODEL);
      // Microsoft's MAI guide uses the model's default multilingual mode with
      // no language override. An explicit NexQ locale is passed as requested.
      if (start.language) config.speechRecognitionLanguage = start.language;
      stream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16_000, 16, 1));
      recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(stream));

      const ready = deferred<void>();
      const active = recognizer;
      const push = stream;
      function refreshLater() {
        refreshTimer = setTimeout(async () => {
          try {
            const freshToken = await ipc.token();
            if (disposed || failed || stopped) return;
            active.authorizationToken = freshToken;
            refreshLater();
          } catch (error) {
            if (!disposed && !failed && !stopped) finish(tokenFailure(error));
          }
        }, TOKEN_REFRESH_MS);
      }
      const report = (result: Speech.SpeechRecognitionResult, isFinal: boolean) => {
        if (failed || disposed || start.probe || streamOrigin === undefined) return;
        const text = result.text.trim();
        if (!text) {
          if (lastPartial !== undefined) emit({ kind: "clear_interim" });
          lastPartial = undefined;
          phraseStart = undefined;
          return;
        }
        // MAI can send a hypothesis with no timing fields. Keep it on the
        // same line until Azure returns the actual phrase start in its final.
        const offset = tickMs(result.offset);
        const timestamp = offset === undefined
          ? (phraseStart ??= Math.max(streamOrigin, Date.now() - 300))
          : streamOrigin + offset;
        if (isFinal) {
          // The SDK can assign the same request ID to several phrases, so it
          // does not identify a finalized phrase on its own.
          const identity = `${timestamp}:${text}`;
          if (identity === lastFinal) return;
          lastFinal = identity;
          lastPartial = undefined;
          phraseStart = undefined;
          tailFinal?.();
        } else {
          if (text === lastPartial) return;
          lastPartial = text;
        }
        emit({
          kind: "transcript", text, isFinal,
          timestampMs: timestamp,
          durationMs: tickMs(result.duration) ?? null,
          language: start.language,
        });
      };

      active.sessionStarted = () => {
        if (disposed || failed || inputClosed || readyAt !== undefined) return;
        readyAt = Date.now();
        ready.resolve();
        if (start.probe) {
          // Exercise recognition, not only WebSocket authentication. The
          // service must process the selected model and end the silence turn.
          push.write(new ArrayBuffer(16_000 * 2));
          closeInput();
          return;
        }
        emit({ kind: "connected" });
        if (stopped) return;
        writeFrame = ({ timestamp, pcm }) => {
          const samples = pcm.byteLength / 2;
          streamOrigin ??= Math.round(timestamp - samples / 16);
          const gap = Math.round((timestamp - streamOrigin) * 16) - streamSamples - samples;
          // The Rust loopback tick normally keeps us within one frame of
          // capture time. Re-anchor with a new recognizer after a suspend or
          // clock jump, rather than queuing seconds of silence repeatedly.
          if (gap > 16_000 || gap < -32_000) {
            finish("discontinuity");
            return;
          }
          if (gap >= 800) {
            push.write(new ArrayBuffer(gap * 2));
            streamSamples += gap;
          }
          if (samples > 0) {
            push.write(pcm);
            streamSamples += samples;
          }
        };
        for (const frame of warm) writeFrame(frame);
        warm = [];
        keepWarm = false;
        refreshLater();
      };
      active.speechStartDetected = (_, event) => {
        const offset = tickMs(event.offset);
        if (offset !== undefined && streamOrigin !== undefined) phraseStart = streamOrigin + offset;
      };
      active.recognizing = (_, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizingSpeech) report(event.result, false);
      };
      active.recognized = (_, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
          report(event.result, true);
        } else if (!disposed && !failed && lastPartial !== undefined && event.result.reason === sdk.ResultReason.NoMatch) {
          lastPartial = undefined;
          phraseStart = undefined;
          emit({ kind: "clear_interim" });
        }
      };
      active.canceled = (_, event) => {
        if (disposed || failed) return;
        if (event.reason === sdk.CancellationReason.Error) {
          finish(cancellation(sdk, event));
        } else if (inputClosed && event.reason === sdk.CancellationReason.EndOfStream) {
          finish(start.probe ? "verified" : "closed");
        } else {
          finish(stopped ? "closed" : "network");
        }
      };
      active.sessionStopped = () => {
        if (!disposed && !failed) finish(stopped ? "closed" : "network");
      };
      active.startContinuousRecognitionAsync(() => {}, () => finish("network"));

      const started = await deadline(Promise.race([
        ready.promise.then(() => "ready" as const),
        inputEnded.promise.then(() => "stopped" as const),
        done.promise,
      ]), START_TIMEOUT_MS, "network" as const);
      if (started === "ready") {
        outcome = start.probe
          ? await deadline(done.promise, 4_000, "network" as const)
          : await Promise.race([
            done.promise,
            inputEnded.promise.then(async () => {
              writeFrame = undefined;
              if (!inputFailed && !failed && streamOrigin !== undefined) {
                // MAI can end at EOF without ever confirming its open
                // hypothesis. Give service-side VAD a short silence tail
                // while the stream is still open; still never fake a final.
                push.write(new ArrayBuffer(VAD_TAIL_SAMPLES * 2));
                if (lastPartial !== undefined) {
                  const settled = deferred<void>();
                  tailFinal = settled.resolve;
                  await deadline(Promise.race([settled.promise, done.promise]), VAD_TAIL_TIMEOUT_MS, undefined);
                }
              }
              closeInput();
              return deadline(done.promise, FINAL_TIMEOUT_MS, "closed" as const);
            }),
          ]);
      } else {
        outcome = started === "stopped" ? "closed" : started;
      }
    } catch {
      outcome = "sdk";
    } finally {
      disposed = true;
      writeFrame = undefined;
      clearTimeout(refreshTimer);
      closeInput();
      // close() stops recognition and disposes the SDK connection. Bound
      // local cleanup in case the network dies while the SDK is draining.
      const active = recognizer;
      if (active) {
        if (outcome !== "verified" && (outcome !== "closed" || !failed)) {
          // Force a dead/unfinished connection closed before disposing the
          // recognizer; the SDK's normal stop can wait for a remote turn.end.
          try { sdk.Connection.fromRecognizer(active).closeConnection(() => {}, () => {}); } catch { /* already closed */ }
        }
        const closed = new Promise<void>((resolve) => active.close(resolve, () => resolve())).catch(() => {});
        await deadline(closed, 600, undefined);
      }
      // The AudioConfig here just wraps the push stream, which was closed
      // above. Closing the wrapper separately throws in SDK 1.53.0.
      config?.close();
    }
    return { outcome, connectedMs: readyAt === undefined ? 0 : Date.now() - readyAt };
  }

  try {
    let retries = 0;
    while (!stopped) {
      const { outcome, connectedMs } = await attempt();
      if (outcome === "verified") {
        emit({ kind: "verified" });
        break;
      }
      if (stopped || outcome === "closed") break;
      if (outcome === "discontinuity") {
        emit({ kind: "clear_interim" });
        emit({ kind: "reconnecting" });
        continue;
      }
      if (outcome !== "network" || start.probe) {
        emit({ kind: "failed", reason: outcome });
        break;
      }
      emit({ kind: "clear_interim" });
      emit({ kind: "reconnecting" });
      keepWarm = false;
      warm = [];
      if (connectedMs >= 10_000) retries = 0;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retries++, 5));
      await deadline(inputEnded.promise, delay, undefined);
    }
  } finally {
    if (inputFailed) emit({ kind: "failed", reason: "sdk" });
    stopInput();
    emit({ kind: "closed" });
    await sends;
  }
}
