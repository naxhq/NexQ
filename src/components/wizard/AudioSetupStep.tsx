// Wizard Step 2: Audio Setup — two-party device selection with smart suggestion.

import { useEffect, useState, useRef, useCallback } from "react";
import { useConfigStore } from "../../stores/configStore";
import {
  listAudioDevices,
  startAudioTest,
  stopAudioTest,
} from "../../lib/ipc";
import { useAudioLevel } from "../../hooks/useAudioLevel";
import type { AudioDevice, AudioDeviceList, MeetingAudioConfig } from "../../lib/types";
import {
  Mic,
  Volume2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Wand2,
} from "lucide-react";

export function AudioSetupStep() {
  const {
    meetingAudioConfig,
    setMeetingAudioConfig,
    micDeviceId,
    systemDeviceId,
    setMicDeviceId,
    setSystemDeviceId,
  } = useConfigStore();

  const { micLevel, micPeak, systemLevel, systemPeak } = useAudioLevel();

  const [devices, setDevices] = useState<AudioDeviceList>({
    inputs: [],
    outputs: [],
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<
    { device: AudioDevice; hasAudio: boolean }[]
  >([]);
  const [isTestingAudio, setIsTestingAudio] = useState(false);
  const [testCountdown, setTestCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build working config
  const config: MeetingAudioConfig = meetingAudioConfig ?? {
    you: {
      role: "You",
      device_id: micDeviceId ?? "default",
      is_input_device: true,
      stt_provider: "web_speech",
    },
    them: {
      role: "Them",
      device_id: systemDeviceId ?? "default",
      is_input_device: false,
      stt_provider: "whisper_cpp",
    },
    recording_enabled: false,
    preset_name: null,
  };

  // Load devices on mount
  useEffect(() => {
    loadDevices();
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      stopAudioTest().catch(() => {});
    };
  }, []);

  async function loadDevices() {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);

      // Auto-select defaults if nothing selected
      if (!config.you.device_id || config.you.device_id === "default") {
        const defaultInput = deviceList.inputs.find((d) => d.is_default);
        if (defaultInput) {
          updateConfig("you", defaultInput.id, true);
        }
      }
      if (!config.them.device_id || config.them.device_id === "default") {
        const defaultOutput = deviceList.outputs.find((d) => d.is_default);
        if (defaultOutput) {
          updateConfig("them", defaultOutput.id, false);
        }
      }
    } catch (err) {
      console.error("[AudioSetupStep] Failed to load devices:", err);
    } finally {
      setLoadingDevices(false);
    }
  }

  function updateConfig(party: "you" | "them", deviceId: string, isInput: boolean) {
    const updated: MeetingAudioConfig = {
      ...config,
      [party]: {
        ...config[party],
        device_id: deviceId,
        is_input_device: isInput,
      },
      preset_name: null,
    };
    setMeetingAudioConfig(updated);

    // Also update legacy fields for backward compat
    if (party === "you") setMicDeviceId(deviceId);
    if (party === "them") setSystemDeviceId(deviceId);
  }

  // Smart Source Suggestion: scan each device for audio activity
  const handleSmartScan = useCallback(async () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanResults([]);

    const allDevices = [...devices.inputs, ...devices.outputs];
    const results: { device: AudioDevice; hasAudio: boolean }[] = [];

    for (const device of allDevices) {
      try {
        await startAudioTest(device.id, device.is_input);
        // Wait 1.5 seconds to detect audio
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const detected = await stopAudioTest();
        results.push({ device, hasAudio: detected });
      } catch {
        results.push({ device, hasAudio: false });
      }
    }

    setScanResults(results);

    // Auto-suggest based on results
    const activeMic = results.find((r) => r.device.is_input && r.hasAudio);
    const activeOutput = results.find((r) => !r.device.is_input && r.hasAudio);

    if (activeMic) {
      updateConfig("you", activeMic.device.id, true);
    }
    if (activeOutput) {
      updateConfig("them", activeOutput.device.id, false);
    }

    setIsScanning(false);
  }, [isScanning, devices]);

  // Live audio test
  const handleLiveTest = useCallback(async () => {
    if (isTestingAudio) {
      if (countdownRef.current) clearInterval(countdownRef.current);
      countdownRef.current = null;
      await stopAudioTest().catch(() => {});
      setIsTestingAudio(false);
      setTestCountdown(0);
      return;
    }

    if (!config.you.device_id) return;

    try {
      await startAudioTest(config.you.device_id, true);
    } catch {
      return;
    }

    setIsTestingAudio(true);
    setTestCountdown(5);

    let remaining = 5;
    countdownRef.current = setInterval(async () => {
      remaining -= 1;
      setTestCountdown(remaining);
      if (remaining <= 0) {
        if (countdownRef.current) clearInterval(countdownRef.current);
        countdownRef.current = null;
        await stopAudioTest().catch(() => {});
        setIsTestingAudio(false);
        setTestCountdown(0);
      }
    }, 1000);
  }, [isTestingAudio, config.you.device_id]);

  return (
    <div className="flex flex-col items-center">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 shadow-md shadow-primary/10">
          <Mic className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Audio Setup</h2>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Choose audio sources for you and the other party.
        </p>
      </div>

      <div className="w-full max-w-lg space-y-5">
        {/* Smart Scan Button */}
        <button
          onClick={handleSmartScan}
          disabled={isScanning || loadingDevices}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3 text-sm font-semibold text-primary shadow-sm transition-all hover:bg-primary/10 hover:shadow-md disabled:opacity-50"
        >
          {isScanning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning devices...
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Smart Detect Sources
            </>
          )}
        </button>

        {/* Scan Results */}
        {scanResults.length > 0 && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 p-3.5 space-y-1.5">
            <p className="text-meta font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Scan Results
            </p>
            {scanResults.map((r) => (
              <div
                key={r.device.id}
                className="flex items-center gap-2 text-xs"
              >
                {r.device.is_input ? (
                  <Mic className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <Volume2 className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="flex-1 truncate text-foreground">
                  {r.device.name}
                </span>
                {r.hasAudio ? (
                  <span className="flex items-center gap-1 text-success">
                    <CheckCircle className="h-3 w-3" /> Active
                  </span>
                ) : (
                  <span className="text-muted-foreground/50">Silent</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* YOUR Source */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-primary/10 px-2 py-1 text-meta font-semibold uppercase tracking-wide text-primary">
              You
            </span>
            Audio Source
          </label>
          <select
            value={JSON.stringify([config.you.is_input_device, config.you.device_id])}
            onChange={(e) => {
              const [isInput, deviceId]: [boolean, string] = JSON.parse(e.target.value);
              updateConfig("you", deviceId, isInput);
            }}
            disabled={loadingDevices}
            className="w-full rounded-xl border border-border/40 bg-background px-4 py-3 text-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            <option value={JSON.stringify([true, "default"])}>
              {loadingDevices ? "Detecting devices..." : "Default microphone"}
            </option>
            {devices.inputs.length > 0 && (
              <optgroup label="Microphones">
                {devices.inputs.map((d) => (
                  <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
                    {d.name}{d.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {devices.outputs.length > 0 && (
              <optgroup label="Speakers / Output">
                {devices.outputs.map((d) => (
                  <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
                    {d.name}{d.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* THEIR Source */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-muted px-2 py-1 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
              Them
            </span>
            Audio Source
          </label>
          <select
            value={JSON.stringify([config.them.is_input_device, config.them.device_id])}
            onChange={(e) => {
              const [isInput, deviceId]: [boolean, string] = JSON.parse(e.target.value);
              updateConfig("them", deviceId, isInput);
            }}
            disabled={loadingDevices}
            className="w-full rounded-xl border border-border/40 bg-background px-4 py-3 text-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            <option value={JSON.stringify([false, "default"])}>
              {loadingDevices ? "Detecting devices..." : "Default output (loopback)"}
            </option>
            {devices.outputs.length > 0 && (
              <optgroup label="Speakers / Output">
                {devices.outputs.map((d) => (
                  <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
                    {d.name}{d.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {devices.inputs.length > 0 && (
              <optgroup label="Microphones">
                {devices.inputs.map((d) => (
                  <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
                    {d.name}{d.is_default ? " (Default)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Refresh */}
        <button
          onClick={loadDevices}
          disabled={loadingDevices}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3 w-3 ${loadingDevices ? "animate-spin" : ""}`} />
          Refresh devices
        </button>

        {/* Live Audio Test */}
        <div className="rounded-xl border border-border/40 bg-secondary/20 p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              Microphone Test
            </p>
            <button
              onClick={handleLiveTest}
              disabled={!config.you.device_id}
              className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                isTestingAudio
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {isTestingAudio ? (
                <>
                  <div className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                  Stop ({testCountdown}s)
                </>
              ) : (
                "Test Audio"
              )}
            </button>
          </div>

          {/* Level Meter */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-8 text-xs text-muted-foreground">Mic</span>
              <div
                className="relative h-4 flex-1 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Microphone audio level"
                aria-valuenow={Math.round(micLevel * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all duration-75 ${
                    micLevel > 0.8
                      ? "bg-destructive"
                      : micLevel > 0.5
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                  style={{ width: `${Math.min(micLevel, 1) * 100}%` }}
                />
                {micPeak > 0.01 && (
                  <div
                    className="absolute inset-y-0 w-0.5 bg-foreground/60"
                    style={{ left: `${Math.min(micPeak, 1) * 100}%` }}
                  />
                )}
              </div>
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(micLevel * 100)}
              </span>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              {isTestingAudio
                ? "Speak now to verify your microphone..."
                : 'Click "Test Audio" and speak to check'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
