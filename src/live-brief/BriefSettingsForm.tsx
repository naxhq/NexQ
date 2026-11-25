import type { BriefSettings } from "../lib/types";
import { Select } from "../ui";
import { ModelPicker } from "../live-notes/ModelPicker";
import { formatTokens } from "../live-notes/NotesSettingsForm";

export const BRIEF_CAP_CHOICES = [30000, 60000, 120000, 240000];

/** Every brief setting (the panel's dialog and the Settings page share it). */
export function BriefSettingsForm({ settings, onChange }: { settings: BriefSettings; onChange: (patch: Partial<BriefSettings>) => void }) {
  const caps = BRIEF_CAP_CHOICES.includes(settings.cap) ? BRIEF_CAP_CHOICES : [...BRIEF_CAP_CHOICES, settings.cap].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="ui-section">Model</div>
        <ModelPicker idPrefix="brief" value={{ provider: settings.provider, model: settings.model, effort: settings.effort }} onChange={(c) => onChange(c)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="ui-section">Limit per meeting</div>
        <Select
          label="Limit per meeting"
          value={String(settings.cap)}
          onChange={(v) => onChange({ cap: Number(v) })}
          options={caps.map((c) => ({ value: String(c), label: `${formatTokens(c)} tokens` }))}
        />
        <p className="ui-meta text-muted-foreground">At the limit, the brief pauses and asks whether to keep going.</p>
      </div>
    </div>
  );
}
