import { useEffect, useMemo, useRef, useState } from "react";
import { getIndexStatus } from "../lib/ipc";
import { Dialog, ColorSwatches, Select, Switch, Button } from "../ui";
import { VoiceprintMark } from "../voiceprint";
import { useMeetingScenarios } from "../stores/scenarioStore";
import { useAutomaticModel } from "../models/useAutomaticModel";
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
  recaps_with_ai: boolean;
}

/** How many things General holds, said once, for the "Also use General" line. */
export function generalCounts(general: Pick<WorkspaceSummary, "item_count"> | undefined): string {
  const n = general?.item_count ?? 0;
  if (n === 0) return "General has no files or tools yet.";
  return `General has ${n} ${n === 1 ? "file or tool" : "files and tools"} you could use here. Its meetings and chats stay in General.`;
}

const NO_SCENARIO = "__none";

/**
 * What the recaps switch does, exactly as the backend does it: when it runs, how many, never in a
 * meeting, which model, what is sent, and who reads a recap.
 */
export function recapsDescription(model: string): string {
  return `Off by default. After a meeting here ends, and for up to 5 meetings without one when this workspace opens, one AI call writes a short recap from the transcript. It never runs during a meeting, uses the cheapest model you have set up (${model}), and sends that meeting's transcript to it. Meetings that already have a summary are left alone. Chat reads recaps first when it looks across many meetings.`;
}

/** "12 meetings have an AI recap": the count from the index, said plainly. */
export function recapCountLine(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  if (count === 0) return "No meeting here has an AI recap yet.";
  return `${count} ${count === 1 ? "meeting has" : "meetings have"} an AI recap.`;
}

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
  const automatic = useAutomaticModel(null).model;
  const [recapCount, setRecapCount] = useState<number | null>(null);
  // How many meetings already have an AI recap (from the index; older backends do not say).
  const editedId = workspace?.id;
  useEffect(() => {
    if (!open || !editedId) return;
    let live = true;
    setRecapCount(null);
    getIndexStatus(editedId)
      .then((s) => live && setRecapCount(typeof s?.ai_recaps === "number" ? s.ai_recaps : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, editedId]);
  const recapLine = recapCountLine(recapCount);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const create = useWorkspaceStore((s) => s.create);
  const update = useWorkspaceStore((s) => s.update);
  const makeDefault = useWorkspaceStore((s) => s.makeDefault);
  const scenarios = useMeetingScenarios();
  const general = workspaces.find((w) => w.id === GENERAL_ID);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const editing = workspace !== null;
  // Only the detail of the workspace being edited counts: a late answer for another one is ignored.
  const matching = detail && workspace && detail.id === workspace.id ? detail : null;
  const detailPending = editing && !matching;

  const initial = useMemo<WorkspaceFormValues>(
    () => ({
      name: workspace?.name ?? "",
      color: workspace?.color ?? null,
      description: workspace?.description ?? "",
      instructions: matching?.instructions ?? "",
      include_general: workspace?.include_general ?? false,
      keep_separate: workspace?.keep_separate ?? false,
      default_scenario: workspace?.default_scenario ?? null,
      makeDefault: workspace?.is_default ?? false,
      recaps_with_ai: false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace?.id],
  );
  const [v, setV] = useState<WorkspaceFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new workspace is created with this id, so the preview is its real mark.
  const [draftId] = useState(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `draft-${Math.random().toString(36).slice(2, 10)}`));

  const instructionsTouched = useRef(false);

  // A fresh form every time it opens.
  useEffect(() => {
    if (open) {
      instructionsTouched.current = false;
      setV(initial);
      setError(null);
      setBusy(false);
    }
  }, [open, initial]);

  // The instructions arrive with the detail: they fill in unless the person already typed.
  useEffect(() => {
    if (open && matching && !instructionsTouched.current) setV((cur) => ({ ...cur, instructions: matching.instructions }));
    if (open && matching) setV((cur) => ({ ...cur, recaps_with_ai: matching.recaps_with_ai }));
  }, [open, matching]);

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
        // Keep separate never includes General: the switch is off and the field false.
        include_general: v.keep_separate ? false : v.include_general,
        keep_separate: v.keep_separate,
        default_scenario: v.default_scenario,
      };
      // Instructions are only sent once the matching detail is in: never an empty field that was just not loaded yet.
      const withInstructions = editing && !matching ? patch : { ...patch, instructions: v.instructions };
      // Recaps are a separate switch of the detail: sent only once it is loaded (a new workspace starts with it off).
      const withRecaps = editing && matching ? { ...withInstructions, recaps_with_ai: v.recaps_with_ai } : withInstructions;
      const saved = editing ? await update(workspace.id, withRecaps) : await create({ ...withInstructions, id: draftId });
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
          <Button  onClick={() => onClose()} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary"  onClick={save} disabled={busy || !!nameError}>
            {busy ? "Saving" : editing ? "Save" : "Create workspace"}
          </Button>
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
            onChange={(e) => {
              instructionsTouched.current = true;
              set("instructions", e.target.value);
            }}
            disabled={detailPending}
            rows={4}
            placeholder={detailPending ? "Loading" : "How to work here: who the people are, what to focus on, the tone to use."}
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
          {editing && (
            <Switch
              checked={v.recaps_with_ai}
              onChange={(c) => set("recaps_with_ai", c)}
              disabled={detailPending}
              label="Prepare recaps with AI"
              description={
                <>
                  {recapsDescription(automatic?.label ?? "the cheapest model")}
                  {recapLine && <span className="mt-1 block font-medium text-foreground">{recapLine}</span>}
                </>
              }
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
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} aria-label="Save" />
        {unavailable && (
          <p className={hintClass}>Workspaces are not available right now, so changes may not be kept.</p>
        )}
      </form>
    </Dialog>
  );
}
