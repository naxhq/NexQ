import type { NotetakerSettings } from "../lib/types";
import { Segmented, Select, Switch } from "../ui";
import { ModelPicker } from "./ModelPicker";

export const CAP_CHOICES = [30000, 60000, 120000, 240000, 500000];

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  return String(n);
}

const LANGUAGES: Array<[string, string]> = [
  ["meeting", "The meeting's language"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="ui-section">{label}</div>
      {children}
    </div>
  );
}

/** Every notes setting, in one place (the panel's dialog and the Settings page share it). */
export function NotesSettingsForm({
  settings,
  onChange,
}: {
  settings: NotetakerSettings;
  onChange: (patch: Partial<NotetakerSettings>) => void;
}) {
  const caps = CAP_CHOICES.includes(settings.cap) ? CAP_CHOICES : [...CAP_CHOICES, settings.cap].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-4">
      <Switch
        checked={settings.enabled}
        onChange={(enabled) => onChange({ enabled })}
        label="Take live notes"
        description="Sends only the transcript of the call to the model you choose. Never your documents, folders or workspace."
      />
      {settings.enabled && (
        <Field label="Turn on for">
          <Segmented
            label="Turn on for"
            value={settings.scope}
            onChange={(scope) => onChange({ scope })}
            options={[
              { value: "meeting", label: "This meeting" },
              { value: "every", label: "Every meeting" },
            ]}
          />
        </Field>
      )}
      <Field label="Updates">
        <Segmented
          label="Updates"
          value={settings.update_mode}
          onChange={(update_mode) => onChange({ update_mode })}
          options={[
            { value: "automatic", label: "Automatic" },
            { value: "manual", label: "Manual" },
          ]}
        />
        <p className="ui-meta text-muted-foreground">Manual updates when you press Update now or N in the meeting window.</p>
      </Field>
      <Field label="Detail">
        <Segmented
          label="Detail"
          value={settings.detail}
          onChange={(detail) => onChange({ detail })}
          options={[
            { value: "brief", label: "Brief" },
            { value: "standard", label: "Standard" },
            { value: "detailed", label: "Detailed" },
          ]}
        />
      </Field>
      <Field label="Language of the notes">
        <Select
          label="Language of the notes"
          value={settings.language}
          onChange={(language) => onChange({ language })}
          options={LANGUAGES.map(([value, label]) => ({ value, label }))}
        />
      </Field>
      <Field label="Model">
        <ModelPicker
          idPrefix="notes"
          value={{ provider: settings.provider, model: settings.model, effort: settings.effort }}
          onChange={(c) => onChange(c)}
        />
      </Field>
      <Field label="Limit per meeting">
        <Select
          label="Limit per meeting"
          value={String(settings.cap)}
          onChange={(v) => onChange({ cap: Number(v) })}
          options={caps.map((c) => ({ value: String(c), label: `${formatTokens(c)} tokens` }))}
        />
        <p className="ui-meta text-muted-foreground">At the limit, notes pause and ask whether to keep going.</p>
      </Field>
      <Switch
        checked={settings.colors}
        onChange={(colors) => onChange({ colors })}
        label="Colour people and places"
        description="Dates and numbers are set in heavier type either way."
      />
    </div>
  );
}
