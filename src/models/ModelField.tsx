import { useMemo } from "react";
import { Select } from "../ui";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import { providerLabel } from "./labels";
import { selectionLabel, useModelCatalog } from "./catalog";
import { useAutomaticModel } from "./useAutomaticModel";

export interface ModelValue {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

const DEFAULT_EFFORT = "__default";

/** The words for a choice: "Claude Sonnet", "Ollama llama3", or the automatic default. */
export function describeModel(v: ModelValue, automatic?: { label: string } | null): string {
  if (!v.provider) return automatic ? `Automatic: ${automatic.label}` : "Automatic";
  return v.model ? selectionLabel({ provider: v.provider, model: v.model }) : `${providerLabel(v.provider)}, its default model`;
}

/**
 * The one model field for notes, brief and anything else that needs "which AI":
 * the chat's picker (same list, same words), plus an automatic choice and effort.
 */
export function ModelField({ value, onChange, label = "Model" }: { value: ModelValue; onChange: (next: ModelValue) => void; label?: string }) {
  const current = value.provider ? { provider: value.provider, model: value.model ?? "" } : null;
  const sections = useModelCatalog(true, current);
  const automatic = useAutomaticModel(value.provider).model;
  const efforts = useMemo(() => {
    const m = sections.flatMap((s) => s.models).find((x) => current && x.provider === current.provider && x.model === current.model);
    return m?.efforts ?? [];
  }, [sections, current]);

  return (
    <div className="flex flex-col gap-2">
      <ModelPicker
        value={current}
        label={label}
        showCapabilities={false}
        onPick={(c) => onChange({ provider: c.provider, model: c.model || null, effort: null })}
        buttonClassName="ui-field ui-body inline-flex h-8 w-full items-center justify-between gap-2 rounded-lg px-3 text-left outline-none ui-focus"
      >
        <span className="min-w-0 truncate">{describeModel(value, automatic)}</span>
        <PickerCaret />
      </ModelPicker>
      {value.provider && (
        <button type="button" className="ui-meta self-start rounded text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground ui-focus" onClick={() => onChange({ provider: null, model: null, effort: null })}>
          Choose the model automatically
        </button>
      )}
      {efforts.length > 0 && (
        <Select
          label="Effort"
          value={value.effort ?? DEFAULT_EFFORT}
          options={[{ value: DEFAULT_EFFORT, label: "Default effort" }, ...efforts.map((e) => ({ value: e, label: e }))]}
          onChange={(v) => onChange({ ...value, effort: v === DEFAULT_EFFORT ? null : v })}
        />
      )}
    </div>
  );
}
