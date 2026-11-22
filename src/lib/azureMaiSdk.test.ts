import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Speech from "microsoft-cognitiveservices-speech-sdk";
import { MODEL, runMaiSession, type MaiStart, type MaiTransport } from "./azureMaiSdk";

const reason = { RecognizingSpeech: 1, RecognizedSpeech: 2, NoMatch: 3 };
const cancel = { Error: 1, EndOfStream: 2 };
const code = { AuthenticationFailure: 1, Forbidden: 8, BadRequestParameters: 2, ConnectionFailure: 4 };

function controlledSdk() {
  const sessions: FakeRecognizer[] = [];
  const configs: { setModel: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; speechRecognitionLanguage?: string }[] = [];
  const streams: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  class FakeRecognizer {
    recognizing?: (sender: unknown, event: { result: unknown }) => void;
    recognized?: (sender: unknown, event: { result: unknown }) => void;
    sessionStarted?: () => void;
    sessionStopped?: () => void;
    canceled?: (sender: unknown, event: unknown) => void;
    authorizationToken?: string;
    close = vi.fn((done: () => void) => done());
    startContinuousRecognitionAsync = vi.fn();
    constructor() { sessions.push(this); }
    result(text: string, isFinal = false, offset = 100_000, duration = 200_000) {
      (isFinal ? this.recognized : this.recognizing)?.(undefined, {
        result: { reason: isFinal ? reason.RecognizedSpeech : reason.RecognizingSpeech, text, offset, duration },
      });
    }
    fail(errorCode = code.ConnectionFailure, errorDetails = "") {
      this.canceled?.(undefined, { reason: cancel.Error, errorCode, errorDetails });
    }
    end() {
      this.canceled?.(undefined, { reason: cancel.EndOfStream });
      this.sessionStopped?.();
    }
  }
  const closeConnection = vi.fn((done: () => void) => done());
  const waveFormat = vi.fn();
  const fromAuthorizationToken = vi.fn(() => {
    const config = { setModel: vi.fn(), close: vi.fn() };
    configs.push(config);
    return config;
  });
  const sdk = {
    SpeechConfig: { fromAuthorizationToken },
    AudioInputStream: { createPushStream: () => {
      const stream = { write: vi.fn(), close: vi.fn() };
      streams.push(stream);
      return stream;
    } },
    AudioStreamFormat: { getWaveFormatPCM: waveFormat },
    AudioConfig: { fromStreamInput: () => ({ close: vi.fn() }) },
    SpeechRecognizer: FakeRecognizer,
    Connection: { fromRecognizer: () => ({ closeConnection }) },
    ResultReason: reason, CancellationReason: cancel, CancellationErrorCode: code,
  } as unknown as typeof Speech;
  return { sdk, sessions, configs, streams, waveFormat, fromAuthorizationToken, closeConnection };
}

function transport() {
  let next!: (chunk: ArrayBuffer | number[]) => void;
  const events: Parameters<MaiTransport["send"]>[0][] = [];
  const ipc = {
    token: vi.fn(async () => "short-lived-token"),
    read: vi.fn(() => new Promise<ArrayBuffer | number[]>((resolve) => { next = resolve; })),
    send: vi.fn(async (event: (typeof events)[number]) => { events.push(event); }),
  };
  return {
    ipc, events,
    chunk(timestamp: number, sample: number, fallback = false) {
      const buffer = new ArrayBuffer(10);
      const view = new DataView(buffer);
      view.setBigUint64(0, BigInt(timestamp), true);
      view.setInt16(8, sample, true);
      next(fallback ? Array.from(new Uint8Array(buffer)) : buffer);
    },
    end() { next(new ArrayBuffer(0)); },
  };
}

const start: MaiStart = { id: "1", region: "swedencentral", language: null, probe: false };
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("MAI Speech SDK worker", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("streams raw PCM, replaces interim guesses, and drains a genuine final after EOF", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, events, chunk, end } = transport();
    const running = runMaiSession({ ...start, language: "uk-UA" }, ipc, mock.sdk);
    await tick();
    const [recognizer] = mock.sessions;
    expect(mock.fromAuthorizationToken).toHaveBeenCalledWith("short-lived-token", "swedencentral");
    expect(mock.configs[0].setModel).toHaveBeenCalledWith(MODEL);
    expect(mock.configs[0].speechRecognitionLanguage).toBe("uk-UA");
    expect(mock.waveFormat).toHaveBeenCalledWith(16_000, 16, 1);
    recognizer.sessionStarted!();
    chunk(1_700_000_000_000, -2);
    await tick();
    const [stream] = mock.streams;
    expect(Array.from(new Int16Array(stream.write.mock.calls[0][0]))).toEqual([-2]);
    recognizer.result("Hello");
    recognizer.result("Hello");
    recognizer.result("Hello everyone");
    end();
    await tick();
    const { calls } = stream.write.mock;
    expect(calls[calls.length - 1][0].byteLength).toBe(38_400);
    expect(stream.close).not.toHaveBeenCalled();
    recognizer.result("Hello everyone.", true);
    recognizer.result("Hello everyone.", true);
    await tick();
    expect(stream.close).toHaveBeenCalledTimes(1);
    recognizer.end();
    await running;
    expect(events).toEqual([
      { kind: "connected" },
      { kind: "transcript", text: "Hello", isFinal: false, timestampMs: 1_700_000_000_010, durationMs: 20, language: "uk-UA" },
      expect.objectContaining({ text: "Hello everyone", isFinal: false }),
      expect.objectContaining({ text: "Hello everyone.", isFinal: true }),
      { kind: "closed" },
    ]);
    expect(recognizer.close).toHaveBeenCalledOnce();
  });

  it("backs off, discards offline audio, and starts a fresh session with a fresh token", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, events, chunk, end } = transport();
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    mock.sessions[0].sessionStarted!();
    chunk(1_000, 1);
    await tick();
    mock.sessions[0].result("stale guess");
    mock.sessions[0].fail();
    await tick();
    expect(events.map((e) => e.kind)).toEqual(["connected", "transcript", "clear_interim", "reconnecting"]);
    chunk(1_200, 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.sessions).toHaveLength(2);
    expect(ipc.token).toHaveBeenCalledTimes(2);
    mock.sessions[1].sessionStarted!();
    expect(mock.streams[1].write).not.toHaveBeenCalled();
    chunk(2_100, 3);
    await tick();
    expect(Array.from(new Int16Array(mock.streams[1].write.mock.calls[0][0]))).toEqual([3]);
    expect(mock.configs[1].speechRecognitionLanguage).toBeUndefined();
    end();
    await tick();
    mock.sessions[1].end();
    await running;
  });

  it("accepts postMessage PCM and Azure hypotheses with missing timing fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_320);
    const mock = controlledSdk();
    const { ipc, events, chunk, end } = transport();
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    const [recognizer] = mock.sessions;
    recognizer.sessionStarted!();
    chunk(1_700_000_000_000, 17, true);
    await tick();
    expect(Array.from(new Int16Array(mock.streams[0].write.mock.calls[0][0]))).toEqual([17]);
    recognizer.result("first guess", false, NaN, NaN);
    await vi.advanceTimersByTimeAsync(500);
    recognizer.result("revised guess", false, NaN);
    recognizer.result("Confirmed.", true);
    end();
    await tick();
    recognizer.end();
    await running;
    const hypotheses = events.filter((e) => e.kind === "transcript" && !e.isFinal);
    expect(hypotheses).toHaveLength(2);
    expect(hypotheses[0]).toMatchObject({ durationMs: null });
    expect(hypotheses.map((e) => "timestampMs" in e && e.timestampMs)).toEqual([1_700_000_000_020, 1_700_000_000_020]);
  });

  it("re-anchors after a clock jump instead of flooding the SDK with silence", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, chunk, end } = transport();
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    mock.sessions[0].sessionStarted!();
    chunk(1_000, 1);
    await tick();
    chunk(600_000, 2);
    await tick();
    expect(mock.streams[0].write).toHaveBeenCalledTimes(1);
    expect(mock.sessions).toHaveLength(2);
    mock.sessions[1].sessionStarted!();
    chunk(600_010, 3);
    await tick();
    expect(Array.from(new Int16Array(mock.streams[1].write.mock.calls[0][0]))).toEqual([3]);
    end();
    await tick();
    mock.sessions[1].end();
    await running;
  });

  it("isolates the two parties and cleans up both independent recognizers", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const you = transport();
    const them = transport();
    const youRun = runMaiSession({ ...start, id: "you" }, you.ipc, mock.sdk);
    const themRun = runMaiSession({ ...start, id: "them" }, them.ipc, mock.sdk);
    await tick();
    mock.sessions.forEach((s) => s.sessionStarted!());
    you.chunk(1_000, 1);
    them.chunk(1_000, 2);
    await tick();
    mock.sessions[0].result("you");
    mock.sessions[1].result("them");
    you.end();
    await tick();
    mock.sessions[0].end();
    await youRun;
    expect(mock.sessions[1].close).not.toHaveBeenCalled();
    them.end();
    await tick();
    mock.sessions[1].end();
    await themRun;
    expect(you.events.filter((e) => e.kind === "transcript").map((e) => e.text)).toEqual(["you"]);
    expect(them.events.filter((e) => e.kind === "transcript").map((e) => e.text)).toEqual(["them"]);
  });

  it("does not retry invalid credentials or leak raw service diagnostics", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, events } = transport();
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    mock.sessions[0].fail(code.AuthenticationFailure, "secret-bearing service error");
    await running;
    expect(events).toEqual([{ kind: "failed", reason: "credentials" }, { kind: "closed" }]);
    expect(ipc.token).toHaveBeenCalledOnce();
  });

  it("tests the selected model with silence and waits for Azure to finish the turn", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, events } = transport();
    const running = runMaiSession({ ...start, probe: true }, ipc, mock.sdk);
    await tick();
    mock.sessions[0].sessionStarted!();
    await tick();
    expect(mock.streams[0].write.mock.calls[0][0].byteLength).toBe(32_000);
    expect(events).toEqual([]);
    mock.sessions[0].end();
    await running;
    expect(ipc.read).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "verified" }, { kind: "closed" }]);
  });

  it("rejects an unavailable model even after the service connected", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, events } = transport();
    const running = runMaiSession({ ...start, probe: true }, ipc, mock.sdk);
    await tick();
    mock.sessions[0].sessionStarted!();
    mock.sessions[0].fail(code.ConnectionFailure, "Unknown speech.context.model.name");
    await running;
    expect(events).toEqual([{ kind: "failed", reason: "model" }, { kind: "closed" }]);
  });

  it("stops during backoff without creating another recognizer", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, end } = transport();
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    mock.sessions[0].fail();
    await tick();
    end();
    await running;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.sessions).toHaveLength(1);
  });

  it("refreshes the short-lived token without interrupting an active recognizer", async () => {
    vi.useFakeTimers();
    const mock = controlledSdk();
    const { ipc, end } = transport();
    ipc.token.mockResolvedValueOnce("initial").mockResolvedValueOnce("refreshed");
    const running = runMaiSession(start, ipc, mock.sdk);
    await tick();
    const [recognizer] = mock.sessions;
    recognizer.sessionStarted!();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(recognizer.authorizationToken).toBe("refreshed");
    expect(mock.sessions).toHaveLength(1);
    end();
    await tick();
    recognizer.end();
    await running;
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(ipc.token).toHaveBeenCalledTimes(2);
  });
});
