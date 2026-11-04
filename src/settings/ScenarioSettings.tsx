// AI Scenario settings — manage built-in & custom scenarios with prompt editing.

import { useState, useCallback } from "react";
import { useScenarioStore } from "../stores/scenarioStore";
import { BUILT_IN_SCENARIOS } from "../lib/scenarios";
import type { AIScenario, ScenarioTemplate } from "../lib/types";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Plus,
  Copy,
  Trash2,
  Edit2,
  Check,
  X,
} from "lucide-react";

// ── Prompt field metadata ──
const PROMPT_FIELDS: {
  key: keyof Pick<ScenarioTemplate, "system_prompt" | "summary_prompt" | "question_detection_prompt">;
  label: string;
  description: string;
}[] = [
  { key: "system_prompt", label: "System Prompt", description: "Instructions for the AI's role and behavior during the meeting" },
  { key: "summary_prompt", label: "Summary Prompt", description: "Structure and focus for post-meeting summaries" },
  { key: "question_detection_prompt", label: "Question Detection", description: "Rules for detecting and prioritizing questions from transcript" },
];

// ── Collapsible Prompt Card ──
function PromptCard({
  label,
  description,
  value,
  defaultValue,
  isModified,
  onSave,
  onReset,
}: {
  label: string;
  description: string;
  value: string;
  defaultValue: string | undefined;
  isModified: boolean;
  onSave: (value: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function handleEdit() {
    setDraft(value);
    setEditing(true);
    setOpen(true);
  }

  function handleSave() {
    onSave(draft);
    setEditing(false);
  }

  function handleCancel() {
    setDraft(value);
    setEditing(false);
  }

  function handleReset() {
    onReset();
    setEditing(false);
  }

  const preview = value.length > 120 ? value.slice(0, 120) + "…" : value;

  return (
    <div className="rounded-xl border border-border/30 bg-card/40 overflow-hidden">
      {/* Card header */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-accent/20 transition-colors duration-150"
        onClick={() => !editing && setOpen((o) => !o)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`transition-transform duration-150 text-muted-foreground/60 ${open ? "rotate-90" : ""}`}>
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">{label}</span>
              {isModified && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Modified
                </span>
              )}
            </div>
            <p className="mt-0.5 text-meta text-muted-foreground/60">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 ml-2" onClick={(e) => e.stopPropagation()}>
          {isModified && defaultValue !== undefined && (
            <button
              onClick={handleReset}
              title="Reset to default"
              className="rounded p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/40 transition-colors duration-150 cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={handleEdit}
            title="Edit prompt"
            className="rounded p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/40 transition-colors duration-150 cursor-pointer"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expandable content */}
      {open && (
        <div className="border-t border-border/20 px-4 py-3">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                className="w-full resize-y rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 font-mono leading-relaxed"
                autoFocus
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors duration-150 cursor-pointer shadow-sm shadow-primary/20"
                >
                  <Check className="h-3 w-3" />
                  Save
                </button>
              </div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground/80 font-mono leading-relaxed">
              {preview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Create Custom Scenario Dialog ──
function CreateScenarioDialog({
  onConfirm,
  onCancel,
  mode,
  initialName,
}: {
  onConfirm: (name: string) => void;
  onCancel: () => void;
  mode: "create" | "clone";
  initialName: string;
}) {
  const [name, setName] = useState(initialName);

  return (
    <div className="rounded-xl border border-border/30 bg-card/60 p-4 shadow-lg">
      <p className="mb-3 text-xs font-medium text-foreground">
        {mode === "clone" ? "Clone scenario as:" : "New scenario name:"}
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Sales Call, 1:1 Meeting"
        className="w-full rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 mb-3"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={() => name.trim() && onConfirm(name.trim())}
          disabled={!name.trim()}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer shadow-sm shadow-primary/20"
        >
          {mode === "clone" ? "Clone" : "Create"}
        </button>
      </div>
    </div>
  );
}

// ── Main Component ──

export function ScenarioSettings() {
  const activeScenarioId = useScenarioStore((s) => s.activeScenarioId);
  const customScenarios = useScenarioStore((s) => s.customScenarios);
  const scenarioOverrides = useScenarioStore((s) => s.scenarioOverrides);
  const setActiveScenario = useScenarioStore((s) => s.setActiveScenario);
  const updatePrompt = useScenarioStore((s) => s.updatePrompt);
  const resetScenarioOverrides = useScenarioStore((s) => s.resetScenarioOverrides);
  const createCustomScenario = useScenarioStore((s) => s.createCustomScenario);
  const updateCustomScenario = useScenarioStore((s) => s.updateCustomScenario);
  const deleteCustomScenario = useScenarioStore((s) => s.deleteCustomScenario);
  const cloneScenario = useScenarioStore((s) => s.cloneScenario);

  const [showCreate, setShowCreate] = useState(false);
  const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);

  const allScenarios: ScenarioTemplate[] = [
    ...BUILT_IN_SCENARIOS,
    ...customScenarios,
  ];

  const activeTemplate = allScenarios.find((s) => s.id === activeScenarioId)
    ?? BUILT_IN_SCENARIOS[0];

  // For built-ins, merge with overrides to get current values
  const builtInBase = BUILT_IN_SCENARIOS.find((s) => s.id === activeScenarioId);
  const overrides = scenarioOverrides[activeScenarioId] ?? {};
  const currentTemplate: ScenarioTemplate = activeTemplate.is_custom
    ? activeTemplate
    : { ...activeTemplate, ...overrides };

  function getFieldValue(field: keyof Pick<ScenarioTemplate, "system_prompt" | "summary_prompt" | "question_detection_prompt">) {
    return currentTemplate[field];
  }

  function getDefaultValue(field: keyof Pick<ScenarioTemplate, "system_prompt" | "summary_prompt" | "question_detection_prompt">) {
    if (activeTemplate.is_custom) return undefined;
    return builtInBase?.[field];
  }

  function isFieldModified(field: keyof Pick<ScenarioTemplate, "system_prompt" | "summary_prompt" | "question_detection_prompt">) {
    if (activeTemplate.is_custom) return false;
    return field in overrides;
  }

  const hasAnyOverride = Object.keys(overrides).length > 0;

  const handleCreateCustom = useCallback((name: string) => {
    const newScenario: ScenarioTemplate = {
      id: `custom_${Date.now()}`,
      name,
      description: "Custom scenario",
      system_prompt: "You are an AI meeting assistant.",
      summary_prompt: "Summarize this meeting with key points and action items.",
      question_detection_prompt: "Detect questions from participants that need follow-up.",
      is_custom: true,
    };
    createCustomScenario(newScenario);
    setActiveScenario(newScenario.id as AIScenario);
    setShowCreate(false);
  }, [createCustomScenario, setActiveScenario]);

  const handleClone = useCallback((name: string) => {
    if (!cloneSourceId) return;
    const cloned = cloneScenario(cloneSourceId, name);
    if (cloned) {
      setActiveScenario(cloned.id as AIScenario);
    }
    setCloneSourceId(null);
  }, [cloneSourceId, cloneScenario, setActiveScenario]);

  return (
    <div className="space-y-5">

      {/* ── Scenario Selector ── */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Active Scenario</label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Shapes how the AI interprets the meeting context
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Clone button */}
            <button
              onClick={() => { setCloneSourceId(activeScenarioId); setShowCreate(false); }}
              title="Clone this scenario"
              className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5" />
              Clone
            </button>
            {/* New custom */}
            <button
              onClick={() => { setShowCreate(true); setCloneSourceId(null); }}
              className="flex items-center gap-1.5 rounded-lg bg-primary/10 border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors duration-150 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Create Custom
            </button>
          </div>
        </div>

        {/* Scenario pills */}
        <div className="flex flex-wrap gap-2 mb-4">
          {allScenarios.map((scenario) => (
            <button
              key={scenario.id}
              onClick={() => setActiveScenario(scenario.id as AIScenario)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-95 cursor-pointer ${
                activeScenarioId === scenario.id
                  ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/10"
                  : "border-border/30 text-muted-foreground/70 hover:border-border/60 hover:bg-accent/40 hover:text-foreground"
              }`}
            >
              {scenario.name}
              {scenario.is_custom && (
                <span className="ml-1.5 text-[10px] text-muted-foreground/50">custom</span>
              )}
            </button>
          ))}
        </div>

        {/* Active scenario info */}
        <div className="rounded-lg border border-border/20 bg-background/40 px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{currentTemplate.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/70">{currentTemplate.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {hasAnyOverride && !currentTemplate.is_custom && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Modified
                </span>
              )}
              {currentTemplate.is_custom && (
                <>
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                    Custom
                  </span>
                  <button
                    onClick={() => {
                      deleteCustomScenario(activeScenarioId);
                    }}
                    title="Delete this custom scenario"
                    className="rounded p-1 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors duration-150 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              {hasAnyOverride && !currentTemplate.is_custom && (
                <button
                  onClick={() => resetScenarioOverrides(activeScenarioId)}
                  title="Reset all overrides to default"
                  className="flex items-center gap-1 rounded-lg border border-border/30 bg-secondary/30 px-2 py-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors duration-150 cursor-pointer"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset all
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Inline dialogs */}
        {showCreate && (
          <div className="mt-3">
            <CreateScenarioDialog
              mode="create"
              initialName=""
              onConfirm={handleCreateCustom}
              onCancel={() => setShowCreate(false)}
            />
          </div>
        )}
        {cloneSourceId && (
          <div className="mt-3">
            <CreateScenarioDialog
              mode="clone"
              initialName={`${currentTemplate.name} (copy)`}
              onConfirm={handleClone}
              onCancel={() => setCloneSourceId(null)}
            />
          </div>
        )}
      </div>

      {/* ── Prompt Editing ── */}
      <div className="space-y-2">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          Prompts
        </h3>
        {PROMPT_FIELDS.map((field) => (
          <PromptCard
            key={field.key}
            label={field.label}
            description={field.description}
            value={getFieldValue(field.key)}
            defaultValue={getDefaultValue(field.key)}
            isModified={isFieldModified(field.key)}
            onSave={(val) => {
              if (currentTemplate.is_custom) {
                updateCustomScenario({ ...currentTemplate, [field.key]: val });
              } else {
                updatePrompt(activeScenarioId, field.key, val);
              }
            }}
            onReset={() => {
              if (!currentTemplate.is_custom) {
                // Remove this specific override
                const state = useScenarioStore.getState();
                const existing = { ...state.scenarioOverrides[activeScenarioId] };
                delete existing[field.key];
                if (Object.keys(existing).length === 0) {
                  resetScenarioOverrides(activeScenarioId);
                } else {
                  updatePrompt(activeScenarioId, field.key, getDefaultValue(field.key) ?? "");
                  // Immediately re-reset since updatePrompt would re-add it — use resetOverrides instead
                  resetScenarioOverrides(activeScenarioId);
                }
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
