import { useEffect, useState } from "react";
import type { AutomaticModel } from "../lib/types";
import { getAutomaticModel } from "../lib/ipc";

/**
 * What "Automatic" means right now, from the backend ("OpenAI · gpt-5-nano (cheapest)"),
 * for a provider or the active one when null. `null` while loading or when nothing is set up.
 */
export function useAutomaticModel(provider: string | null): { model: AutomaticModel | null; error: string | null } {
  const [state, setState] = useState<{ model: AutomaticModel | null; error: string | null }>({ model: null, error: null });
  useEffect(() => {
    let alive = true;
    getAutomaticModel(provider)
      .then((m) => alive && setState({ model: m, error: null }))
      .catch((e) => alive && setState({ model: null, error: typeof e === "string" ? e : e instanceof Error ? e.message : "Could not look up the automatic model." }));
    return () => {
      alive = false;
    };
  }, [provider]);
  return state;
}
