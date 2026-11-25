import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, buttonClass, ColorSwatches, Select, Switch } from "../ui";
import { VoiceprintMark } from "../voiceprint";
import { useMeetingScenarios } from "../stores/scenarioStore";
import { GENERAL_ID, useWorkspaceStore } from "../stores/workspaceStore";
import type { AIScenario, WorkspaceDetail, WorkspaceSummary } from "../lib/types";
import { fieldClass, hintClass, labelClass } from "./styles";

export interface WorkspaceFormValues {
  name: string;
  color: string | null;
  description: string;
  instructions: string;
  include_general: boolean;
  keep_separate: boolean;
  default_scenario: AIScenario | null;
  makeDefault: boolean;
}

/** How many things General holds, said once, for the "Also use General" line. */
export function generalCounts(general: Pick<WorkspaceSummary, "item_count"> | undefined): string {
  const n = general?.item_count ?? 0;
  if (n === 0) return "General has no files or tools yet.";
  return `General has ${n} ${n === 1 ? "file or tool" : "files and tools"} you could use here. Its meetings and chats stay in General.`;
}

const NO_SCENARIO = "__none";

/**
 * One calm dialog for a new workspace or the settings of an existing one.
 * `workspace` null = create. Saving never closes on an error; the error shows in place.
 */
export function WorkspaceDialog({
  open,
  workspace,
  detail,
  onClose,
}: {
  open: boolean;
  workspace: WorkspaceSummary | null;
  detail: WorkspaceDetail | null;
  onClose: (saved?: WorkspaceDetail) => void;
}) {
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const create = useWorkspaceStore((s) => s.create);
  const update = useWorkspaceStore((s) => s.update);
  const makeDefault = useWorkspaceStore((s) => s.makeDefault);
  const scenarios = useMeetingScenarios();
  const general = workspaces.find((w) => w.id === GENERAL_ID);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const editing = workspace !== null;

  const initial = useMemo<WorkspaceFormValues>(
    () => ({
      name: workspace?.name ?? "",
      color: workspace?.color ?? null,
      description: workspace?.description ?? "",
      instructions: detail?.instructions ?? "",
      include_general: workspace?.include_general ?? false,
      keep_separate: workspace?.keep_separate ?? false,
      default_scenario: workspace?.default_scenario ?? null,
      makeDefault: workspace?.is_default ?? false,
    }),
    [workspace, detail],
  );
  const [v, setV] = useState<WorkspaceFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new workspace gets its id (and so its exact shape) when it is created; the preview shows a stand-in.
  const [draftId] = useState(() => `draft-${Math.random().toString(36).slice(2, 8)}`);

  // A fresh form every time it opens (and when the details arrive late).
  useEffect(() => {
    if (open) {
      setV(initial);
      setError(null);
      setBusy(false);
    }
  }, [open, initial]);

  const set = <K extends keyof WorkspaceFormValues>(key: K, value: WorkspaceFormValues[K]) => setV((cur) => ({ ...cur, [key]: value }));
  const isGeneral = workspace?.id === GENERAL_ID;
  const name = v.name.trim();
  const clash = workspaces.some((w) => w.id !== workspace?.id && w.name.trim().toLowerCase() === name.toLowerCase());
  const nameError = !name ? "Give it a name." : clash ? "Another workspace already has this name." : null;

  const scenarioOptions = useMemo(
    () => [
      { value: NO_SCENARIO, label: "No preset, use my usual" },
      ...scenarios.map((s) => ({ value: s.id, label: s.name, description: s.description })),
    ],
    [scenarios],
  );

  const save = async () => {
    if (nameError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = {
        name,
        color: v.color,
        description: v.description.trim(),
        instructions: v.instructions,
        // Keep separate never includes General: the switch is off and the field false.
        include_general: v.keep_separate ? false : v.include_general,
        keep_separate: v.keep_separate,
        default_scenario: v.default_scenario,
      };
      const saved = editing ? await update(workspace.id, patch) : await create(patch);
      if (v.makeDefault && !saved.is_default) await makeDefault(saved.id);
      onClose(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const title = !editing ? "New workspace" : isGeneral ? "General" : `Settings for ${workspace.name}`;
  const previewId = workspace?.id ?? draftId;

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      description={
        editing
          ? undefined
          : "A place for the meetings, chats and files of one job, client or course, kept apart from the rest."
      }
      size="lg"
      dismissible={!busy}
      initialFocusRef={nameRef}
      footer={
        <>
          <button type="button" className={`${buttonClass.base} ${buttonClass.quiet}`} onClick={() => onClose()} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${buttonClass.base} ${buttonClass.primary}`} onClick={save} disabled={busy || !!nameError}>
            {busy ? "Saving" : editing ? "Save" : "Create workspace"}
          </button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="ws-name" className={labelClass}>
              Name
            </label>
            <input
              id="ws-name"
              ref={nameRef}
              value={v.name}
              onChange={(e) => set("name", e.target.value)}
              maxLength={60}
              placeholder="Acme account, Interview prep, Biology 201"
              disabled={isGeneral}
              aria-invalid={!!name && !!nameError}
              aria-describedby={name && nameError ? "ws-name-err" : undefined}
              className={fieldClass}
            />
            {name && nameError && (
              <p id="ws-name-err" role="alert" className="ui-meta mt-1 text-destructive">
                {nameError}
              </p>
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center" aria-live="polite">
            <VoiceprintMark id={previewId} hue={v.color} size={28} label={`Preview of the mark, ${v.color ?? "no colour"}`} />
          </div>
        </div>

        <div>
          <span id="ws-colour-label" className={labelClass}>
            Colour
          </span>
          <ColorSwatches value={v.color} onChange={(c) => set("color", c)} label="Workspace colour" />
          {!editing && <p className={`${hintClass} mt-1.5`}>The shape of the mark is set when you create it.</p>}
        </div>

        <div>
          <label htmlFor="ws-desc" className={labelClass}>
            What is it for
          </label>
          <input
            id="ws-desc"
            value={v.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={160}
            placeholder="Optional, one line"
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="ws-instr" className={labelClass}>
            Instructions for the AI
          </label>
          <textarea
            id="ws-instr"
            value={v.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            rows={4}
            placeholder="How to work here: who the people are, what to focus on, the tone to use."
            className={`${fieldClass} resize-y`}
          />
          <p className={`${hintClass} mt-1`}>Read in every meeting and chat of this workspace, after your general instructions.</p>
        </div>

        <div>
          <span id="ws-scn-label" className={labelClass}>
            Starts as
          </span>
          <Select
            label="Default scenario"
            value={v.default_scenario ?? NO_SCENARIO}
            onChange={(val) => set("default_scenario", val === NO_SCENARIO ? null : (val as AIScenario))}
            options={scenarioOptions}
          />
          <p className={`${hintClass} mt-1`}>Meetings started here use this scenario unless you pick another.</p>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          {!isGeneral && (
            <Switch
              checked={v.include_general && !v.keep_separate}
              onChange={(c) => set("include_general", c)}
              disabled={v.keep_separate}
              label="Also use General"
              description={v.keep_separate ? "Off while this workspace is kept separate." : generalCounts(general)}
            />
          )}
          {!isGeneral && (
            <Switch
              checked={v.keep_separate}
              onChange={(c) => setV((cur) => ({ ...cur, keep_separate: c, include_general: c ? false : cur.include_general }))}
              label="Keep separate"
              description="Blocks borrowing in both directions and never mixes in General."
            />
          )}
          <Switch
            checked={v.makeDefault}
            onChange={(c) => set("makeDefault", c)}
            disabled={workspace?.is_default}
            label="Make default"
            description={
              workspace?.is_default
                ? "New meetings from the shortcut, the tray and call detection start here. Make another workspace the default to change this."
                : "New meetings from the shortcut, the tray and call detection start here."
            }
          />
        </div>

        {error && (
          <p role="alert" className="ui-body text-destructive">
            {error}
          </p>
        )}
        {/* The button above is outside the form: Enter in a field saves through the form. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        {unavailable && (
          <p className={hintClass}>Workspaces are not available right now, so changes may not be kept.</p>
        )}
      </form>
    </Dialog>
  );
}
