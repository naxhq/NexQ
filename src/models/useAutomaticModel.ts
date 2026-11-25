import { useEffect, useState } from "react";
import type { AutomaticModel } from "../lib/types";
import { getAutomaticModel } from "../lib/ipc";
import { plainError } from "../lib/plainError";
import { onAutomaticModelUpdated } from "../lib/events";
import { useConfigStore } from "../stores/configStore";

/**
 * What "Automatic" means right now, from the backend ("OpenAI · gpt-5-nano (cheapest)"),
 * for a provider or the active one when null. Read again when that provider's model list
 * lands (`automatic_model_updated`) and when the active provider or model changes.
 * `model` is null while loading or when nothing is set up.
 */
export function useAutomaticModel(provider: string | null): { model: AutomaticModel | null; error: string | null } {
  const [state, setState] = useState<{ model: AutomaticModel | null; error: string | null }>({ model: null, error: null });
  const activeProvider = useConfigStore((s) => s.llmProvider);
  const activeModel = useConfigStore((s) => s.llmModel);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    onAutomaticModelUpdated((e) => {
      // A list for the provider we show, or for the active one when we follow it.
      if (alive && (provider === null || e.provider === provider || e.provider === activeProvider)) setTick((n) => n + 1);
    })
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [provider, activeProvider]);

  useEffect(() => {
    let alive = true;
    getAutomaticModel(provider)
      .then((m) => alive && setState({ model: m, error: null }))
      .catch((e) => alive && setState({ model: null, error: plainError(e, "Could not look up the automatic model.") }));
    return () => {
      alive = false;
    };
  }, [provider, tick, activeProvider, activeModel]);
  return state;
}
