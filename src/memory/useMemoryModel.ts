import { useCallback, useEffect, useState } from "react";
import type { MemorySettings } from "../lib/types";
import { getMemorySettings, setMemorySettings } from "../lib/ipc";
import { onMemorySettingsChanged } from "../lib/events";
import type { ModelValue } from "../models/ModelField";

const AUTOMATIC: ModelValue = { provider: null, model: null, effort: null };
const asValue = (s: Partial<MemorySettings> | null | undefined): ModelValue =>
  s && typeof s === "object" ? { provider: s.provider ?? null, model: s.model ?? null, effort: s.effort ?? null } : AUTOMATIC;

/** Which AI proposes memory. Follows the other window; a failure is said, not hidden. */
export function useMemoryModel(): { value: ModelValue; change: (v: ModelValue) => Promise<void>; error: string | null } {
  const [value, setValue] = useState<ModelValue>(AUTOMATIC);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    let off: (() => void) | undefined;
    getMemorySettings()
      .then((s) => !gone && setValue(asValue(s)))
      .catch(() => !gone && setError("Couldn't read the model for memory suggestions."));
    onMemorySettingsChanged((s) => setValue(asValue(s)))
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  const change = useCallback(async (v: ModelValue) => {
    const before = value;
    setValue(v);
    setError(null);
    try {
      setValue(asValue(await setMemorySettings({ provider: v.provider, model: v.model, effort: v.effort })));
    } catch {
      setValue(before);
      setError("Couldn't save the model. Try again.");
    }
  }, [value]);

  return { value, change, error };
}
