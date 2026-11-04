import { useState, useEffect, useCallback, useMemo } from "react";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import type { ActionConfig, InstructionPresets } from "../lib/types";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Trash2,
  Plus,
  MessageSquare,
  Zap,
  Layers,
  Sparkles,
  HelpCircle,
  X,
} from "lucide-react";

// ─── Constants ───────────────────────────────────────────

const BUILT_IN_MODES = [
  "Assist",
  "WhatToSay",
  "Shorten",
  "FollowUp",
  "Recap",
  "AskQuestion",
];

const ACTION_DESCRIPTIONS: Record<string, string> = {
  Assist: "Auto-responds when a question is detected from other participants",
  WhatToSay: "Suggests what you should say next, written in first person",
  Shorten: "Condenses the last response into a brief, speakable version",
  FollowUp: "Suggests questions you could ask the other participants",
  Recap: "Summarizes the entire meeting so far with key points and action items",
  AskQuestion: "You type a free-form question and the AI answers from context",
};

const TONE_OPTIONS = [
  { label: "Professional", value: "Professional" },
  { label: "Casual", value: "Casual" },
  { label: "Formal", value: "Formal" },
  { label: "Friendly", value: "Friendly" },
  { label: "Direct", value: "Direct" },
];

const FORMAT_OPTIONS = [
  { label: "Bullet Points", value: "bullets" },
  { label: "Paragraphs", value: "paragraphs" },
  { label: "Numbered List", value: "numbered" },
  { label: "One-liner", value: "oneliner" },
];

const LENGTH_OPTIONS = [
  { label: "Brief", value: "brief" },
  { label: "Standard", value: "standard" },
  { label: "Detailed", value: "detailed" },
];

const OPINION_OPTIONS = [
  { label: "Factual only", value: null },
  { label: "Add my take", value: "add" },
];


/** Help content for each setting — shown via HelpButton/HelpPanel toggle */
const HELP: Record<string, { title: string; body: string }> = {
  tone: {
    title: "Tone",
    body: "Sets the conversational voice of AI responses.\n\nProfessional \u2014 client-facing meetings & formal settings\nCasual \u2014 team standups & internal syncs\nFormal \u2014 board presentations & executive briefs\nFriendly \u2014 1-on-1s & coaching sessions\nDirect \u2014 rapid Q&A & time-constrained calls\n\nClick a selected chip again to deselect.",
  },
  format: {
    title: "Format",
    body: "Controls how AI structures its output.\n\nBullet Points \u2014 ideal for action items, meeting notes\nParagraphs \u2014 best for narrative summaries & explanations\nNumbered Lists \u2014 great for step-by-step procedures\nOne-liner \u2014 ultra-concise, glanceable suggestions",
  },
  length: {
    title: "Length",
    body: "Adjusts response verbosity.\n\nBrief (1-2 sentences) \u2014 fast-paced calls, overlay readability\nStandard (3-5 sentences) \u2014 balanced detail for most meetings\nDetailed \u2014 thorough analysis when you have time to read",
  },
  opinion: {
    title: "Perspective",
    body: "Controls whether the AI adds its own analysis.\n\nFactual only \u2014 answers are grounded strictly in transcript/memory context, no interpretation (default)\nAdd my take \u2014 appends a short '## My Take' section with the AI's own analysis, interpretation, or recommendation after the factual answer",
  },
  instructions: {
    title: "Additional Instructions",
    body: "Free-form text injected into every AI prompt. Use this for:\n\n\u2022 Role context (e.g. \"I'm a Product Manager\")\n\u2022 Domain-specific terminology or acronyms\n\u2022 Additional formatting or style rules\n\nCombined with the preset selections above. Clear this field if it duplicates preset text.",
  },
  questionDetection: {
    title: "Question Detection",
    body: "When enabled, questions from the other party appear as cards in the overlay. Click a card to get an answer to that question.\n\nTurn OFF to hide the cards. You can still trigger actions manually with the overlay buttons.",
  },
  autoTrigger: {
    title: "Auto-Answer",
    body: "When enabled, NexQ answers the newest detected question on its own, once the other party has been quiet for a moment. With Cartesia or Deepgram Flux it answers as soon as they finish speaking.\n\nAsk for anything yourself to stop an automatic answer and get yours instead. Turn OFF to keep the question cards and choose which ones to answer. Needs Question Detection.",
  },
  temperature: {
    title: "Temperature",
    body: "Controls AI creativity and randomness.\n\nLow (0.0\u20130.3) \u2014 precise, consistent, factual. Best for technical discussions, data review, and compliance topics.\nMedium (0.4\u20130.6) \u2014 balanced blend of accuracy and variety.\nHigh (0.7\u20131.0) \u2014 varied, creative. Useful for brainstorming and ideation sessions.",
  },
  transcriptWindow: {
    title: "Transcript Window",
    body: "How many minutes of recent conversation the AI reads before responding.\n\nShort (1-5 min) \u2014 focused on the immediate topic, faster responses. Good for quick meetings.\nLong (10-30 min) \u2014 broader context for complex, multi-topic discussions that reference earlier points.",
  },
};

// ─── Helpers ─────────────────────────────────────────────

function secsToMin(secs: number): number {
  return Math.round(secs / 60);
}

function minToSecs(min: number): number {
  return min * 60;
}

function formatWindowDisplay(seconds: number | null): string {
  if (seconds === null) return "Default";
  if (seconds === 0) return "All";
  return `${secsToMin(seconds)} min`;
}

/** Section header with icon badge */
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-primary/80">{title}</h3>
        <p className="text-meta text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

/** Toggleable help icon — matches ContextStrategySettings pattern */
function HelpButton({
  id,
  activeId,
  onToggle,
}: {
  id: string;
  activeId: string | null;
  onToggle: (id: string | null) => void;
}) {
  const isOpen = activeId === id;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(isOpen ? null : id);
      }}
      className={`inline-flex items-center justify-center rounded-full border transition-colors ${
        isOpen
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/40 text-muted-foreground/60 hover:border-border/60 hover:text-muted-foreground"
      } h-[18px] w-[18px]`}
      title="Show explanation"
    >
      {isOpen ? <X className="h-2.5 w-2.5" /> : <HelpCircle className="h-2.5 w-2.5" />}
    </button>
  );
}

/** Expandable help panel — matches ContextStrategySettings pattern */
function HelpPanel({ id }: { id: string }) {
  const content = HELP[id];
  if (!content) return null;
  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 space-y-1">
      <p className="text-xs font-semibold text-primary/80">{content.title}</p>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
        {content.body}
      </p>
    </div>
  );
}

/** Hint under a control the Claude CLI path ignores. */
function CliUnusedHint() {
  return <p className="mt-1 text-meta text-muted-foreground/70">Not used with Claude CLI</p>;
}

/** Small toggle switch (h-5 w-9) */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────

export function AIActionsSettings() {
  const configs = useAIActionsStore((s) => s.configs);
  const loadConfigs = useAIActionsStore((s) => s.loadConfigs);
  const updateGlobalDefaults = useAIActionsStore((s) => s.updateGlobalDefaults);
  const updateActionConfig = useAIActionsStore((s) => s.updateActionConfig);
  const resetActionPrompt = useAIActionsStore((s) => s.resetActionPrompt);
  const addCustomAction = useAIActionsStore((s) => s.addCustomAction);
  const removeCustomAction = useAIActionsStore((s) => s.removeCustomAction);
  const setInstructionPresets = useAIActionsStore((s) => s.setInstructionPresets);
  const setCustomInstructions = useAIActionsStore((s) => s.setCustomInstructions);
  // Claude CLI sessions get the transcript as deltas and run without
  // temperature or tools, so those controls don't apply.
  const cliActive = useConfigStore((s) => s.llmProvider === "claude_cli");

  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const [showNewActionForm, setShowNewActionForm] = useState(false);
  const [newActionName, setNewActionName] = useState("");
  const [newActionPrompt, setNewActionPrompt] = useState("");
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  useEffect(() => {
    loadConfigs();
  }, []);

  const toggleExpanded = useCallback((mode: string) => {
    setExpandedActions((prev) => ({ ...prev, [mode]: !prev[mode] }));
  }, []);

  const toggleOverride = useCallback((mode: string) => {
    setExpandedOverrides((prev) => ({ ...prev, [mode]: !prev[mode] }));
  }, []);

  const handlePresetToggle = useCallback(
    (category: keyof InstructionPresets, value: string) => {
      const current = configs.instructionPresets[category];
      const newPresets: InstructionPresets = {
        ...configs.instructionPresets,
        [category]: current === value ? null : value,
      };
      setInstructionPresets(newPresets);
    },
    [configs.instructionPresets, setInstructionPresets]
  );

  const handleOpinionChange = useCallback(
    (value: string | null) => {
      setInstructionPresets({ ...configs.instructionPresets, opinion: value });
    },
    [configs.instructionPresets, setInstructionPresets]
  );

  const handleCustomInstructionsChange = useCallback(
    (text: string) => {
      setCustomInstructions(text);
    },
    [setCustomInstructions]
  );

  const handleGlobalDefaultChange = useCallback(
    (key: string, value: number | boolean) => {
      updateGlobalDefaults({ [key]: value });
    },
    [updateGlobalDefaults]
  );

  const handleActionToggleVisible = useCallback(
    (mode: string, visible: boolean) => {
      updateActionConfig(mode, { visible });
    },
    [updateActionConfig]
  );

  const handleActionPromptChange = useCallback(
    (mode: string, systemPrompt: string) => {
      updateActionConfig(mode, { systemPrompt, isDefaultPrompt: false });
    },
    [updateActionConfig]
  );

  const handleResetPrompt = useCallback(
    (mode: string) => {
      resetActionPrompt(mode);
    },
    [resetActionPrompt]
  );

  const handleContextToggle = useCallback(
    (mode: string, key: string, value: boolean) => {
      updateActionConfig(mode, { [key]: value });
    },
    [updateActionConfig]
  );

  const handleOverrideChange = useCallback(
    (mode: string, key: string, value: number | null) => {
      updateActionConfig(mode, { [key]: value });
    },
    [updateActionConfig]
  );

  const handleAddCustomAction = useCallback(() => {
    if (!newActionName.trim() || !newActionPrompt.trim()) return;
    addCustomAction(newActionName.trim(), newActionPrompt.trim());
    setNewActionName("");
    setNewActionPrompt("");
    setShowNewActionForm(false);
  }, [newActionName, newActionPrompt, addCustomAction]);

  const handleRemoveCustomAction = useCallback(
    (mode: string) => {
      removeCustomAction(mode);
    },
    [removeCustomAction]
  );

  const toggleHelp = useCallback((id: string | null) => {
    setOpenHelp((prev) => (prev === id ? null : id));
  }, []);

  const builtInActions = useMemo(() => {
    return BUILT_IN_MODES.map((mode) => configs.actions[mode]).filter(Boolean);
  }, [configs.actions]);

  const customActions = useMemo(() => {
    return Object.values(configs.actions).filter((a) => !a.isBuiltIn);
  }, [configs.actions]);

  const instructionTokens = useMemo(() => {
    const chars = configs.customInstructions.length;
    return Math.ceil(chars / 4);
  }, [configs.customInstructions]);

  const presetSummary = useMemo(() => {
    const parts: string[] = [];
    const p = configs.instructionPresets;
    if (p.tone) parts.push(`${p.tone} tone.`);
    if (p.format) {
      const fm: Record<string, string> = {
        bullets: "Use bullet points.", paragraphs: "Use paragraphs.",
        numbered: "Use a numbered list.", oneliner: "Keep it to one line.",
      };
      parts.push(fm[p.format] || `Use ${p.format} format.`);
    }
    if (p.length) {
      const lm: Record<string, string> = {
        brief: "Brief responses.", standard: "Standard length responses.",
        detailed: "Detailed responses.",
      };
      parts.push(lm[p.length] || `${p.length} responses.`);
    }
    if (p.opinion === "add") {
      parts.push("Adds a 'My Take' section with the AI's own analysis.");
    }
    return parts.join(" ");
  }, [configs.instructionPresets]);

  const globalWindowMin = secsToMin(configs.globalDefaults.transcriptWindowSeconds);

  return (
    <div className="space-y-5">
      {/* ═══ Two-column grid: Response Style │ Behavior + Context ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ─── Left Column: Response Style ─── */}
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <SectionHeader
            icon={MessageSquare}
            title="Response Style"
            subtitle="How the AI formats and phrases its answers"
          />

          <div className="space-y-4">
            {/* Tone */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Tone
                <HelpButton id="tone" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "tone" && <HelpPanel id="tone" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TONE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("tone", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.tone === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Format */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Format
                <HelpButton id="format" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "format" && <HelpPanel id="format" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("format", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.format === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Length */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Length
                <HelpButton id="length" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "length" && <HelpPanel id="length" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {LENGTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("length", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.length === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Perspective */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Perspective
                <HelpButton id="opinion" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "opinion" && <HelpPanel id="opinion" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {OPINION_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => handleOpinionChange(opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      (configs.instructionPresets.opinion ?? null) === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Active preset summary */}
            {presetSummary && (
              <div className="rounded-lg border border-primary/10 bg-primary/5 px-3 py-2 flex items-center gap-2">
                <span className="text-meta font-semibold text-primary/80 uppercase tracking-wider shrink-0">
                  Active
                </span>
                <span className="text-xs text-foreground/80">{presetSummary}</span>
              </div>
            )}

            <div className="h-px bg-border/20" />

            {/* Additional Instructions */}
            <div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  Additional Instructions
                  <HelpButton id="instructions" activeId={openHelp} onToggle={toggleHelp} />
                </label>
                <div className="flex items-center gap-3 text-meta text-muted-foreground/70">
                  <span>{configs.customInstructions.length} chars</span>
                  <span>~{instructionTokens} tokens</span>
                </div>
              </div>
              {openHelp === "instructions" && <HelpPanel id="instructions" />}
              <textarea
                rows={3}
                value={configs.customInstructions}
                onChange={(e) => handleCustomInstructionsChange(e.target.value)}
                placeholder="Add extra instructions beyond the presets above..."
                className="mt-2 w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
        </div>

        {/* ─── Right Column: Behavior + Context ─── */}
        <div className="space-y-5">
          {/* AI Behavior */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <SectionHeader
              icon={Zap}
              title="AI Behavior"
              subtitle="Control automation and response characteristics"
            />

            <div className="space-y-4">
              {/* Question Detection */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    Question Detection
                    <HelpButton id="questionDetection" activeId={openHelp} onToggle={toggleHelp} />
                  </label>
                  <Toggle
                    checked={configs.globalDefaults.questionDetection}
                    onChange={(v) => handleGlobalDefaultChange("questionDetection", v)}
                    label="Toggle question detection"
                  />
                </div>
                {openHelp === "questionDetection" && <HelpPanel id="questionDetection" />}
              </div>

              {/* Auto-Answer: only answers questions detection found */}
              <div>
                <fieldset
                  disabled={!configs.globalDefaults.questionDetection}
                  className={`min-w-0 ${configs.globalDefaults.questionDetection ? "" : "opacity-50"}`}
                >
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      Auto-Answer
                      <HelpButton id="autoTrigger" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <Toggle
                      checked={configs.globalDefaults.autoTrigger}
                      onChange={(v) => handleGlobalDefaultChange("autoTrigger", v)}
                      label="Toggle auto-answer"
                    />
                  </div>
                </fieldset>
                {openHelp === "autoTrigger" && <HelpPanel id="autoTrigger" />}
              </div>

              <div className="h-px bg-border/20" />

              {/* Temperature */}
              <div>
                <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      Temperature
                      <HelpButton id="temperature" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="rounded-md bg-secondary/50 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground">
                      {configs.globalDefaults.temperature.toFixed(1)}
                    </span>
                  </div>
                  {openHelp === "temperature" && <HelpPanel id="temperature" />}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={configs.globalDefaults.temperature}
                    onChange={(e) =>
                      handleGlobalDefaultChange("temperature", Number(e.target.value))
                    }
                    aria-label="Temperature"
                    className="mt-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                  <div className="mt-1 flex justify-between text-meta text-muted-foreground/70">
                    <span>Precise 0.0</span>
                    <span>Creative 1.0</span>
                  </div>
                </fieldset>
                {cliActive && <CliUnusedHint />}
              </div>
            </div>
          </div>

          {/* Context Window */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <SectionHeader
              icon={Layers}
              title="Context Window"
              subtitle="What data the AI considers when responding"
            />

            <div className="space-y-4">
              {/* Transcript Window */}
              <div>
                <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      Transcript Window
                      <HelpButton id="transcriptWindow" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="rounded-md bg-secondary/50 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground">
                      {globalWindowMin} min
                    </span>
                  </div>
                  {openHelp === "transcriptWindow" && <HelpPanel id="transcriptWindow" />}
                  <input
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={globalWindowMin}
                    onChange={(e) =>
                      handleGlobalDefaultChange(
                        "transcriptWindowSeconds",
                        minToSecs(Number(e.target.value))
                      )
                    }
                    aria-label="Transcript Window"
                    className="mt-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                  <div className="mt-1 flex justify-between text-meta text-muted-foreground/70">
                    <span>1 min</span>
                    <span>30 min</span>
                  </div>
                </fieldset>
                {cliActive && <CliUnusedHint />}
              </div>

              <div className="h-px bg-border/20" />

              {/* RAG Chunks — reference to Context Strategy */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    RAG Chunks
                  </label>
                  <span className="text-xs text-muted-foreground/60">
                    Set in Context Strategy
                  </span>
                </div>
                <p className="mt-1 text-meta text-muted-foreground/50">
                  Document chunks per query are controlled by "Results to Retrieve (top-K)" in Context Strategy. Per-action overrides available in each action's Override Defaults.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ Actions (full width) ═══ */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-4">
        <SectionHeader
          icon={Sparkles}
          title="Actions"
          subtitle="Built-in and custom AI action modes"
        />

        {/* Built-in Actions */}
        <div>
          <h4 className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
            Built-in ({builtInActions.length})
          </h4>
          <div className="rounded-lg border border-border/20 divide-y divide-border/20 overflow-hidden">
            {builtInActions.map((action) => (
              <ActionCard
                key={action.mode}
                action={action}
                description={ACTION_DESCRIPTIONS[action.mode]}
                isExpanded={!!expandedActions[action.mode]}
                isOverrideExpanded={!!expandedOverrides[action.mode]}
                onToggleExpand={() => toggleExpanded(action.mode)}
                onToggleOverride={() => toggleOverride(action.mode)}
                onToggleVisible={(v) => handleActionToggleVisible(action.mode, v)}
                onPromptChange={(p) => handleActionPromptChange(action.mode, p)}
                onResetPrompt={() => handleResetPrompt(action.mode)}
                onContextToggle={(k, v) => handleContextToggle(action.mode, k, v)}
                onOverrideChange={(k, v) => handleOverrideChange(action.mode, k, v)}
                showReset={true}
                cliActive={cliActive}
              />
            ))}
          </div>
        </div>

        {/* Custom Actions */}
        <div className="mt-5">
          <h4 className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
            Custom ({customActions.length})
          </h4>

          {customActions.length > 0 && (
            <div className="rounded-lg border border-border/20 divide-y divide-border/20 overflow-hidden">
              {customActions.map((action) => (
                <ActionCard
                  key={action.mode}
                  action={action}
                  isExpanded={!!expandedActions[action.mode]}
                  isOverrideExpanded={!!expandedOverrides[action.mode]}
                  onToggleExpand={() => toggleExpanded(action.mode)}
                  onToggleOverride={() => toggleOverride(action.mode)}
                  onToggleVisible={(v) => handleActionToggleVisible(action.mode, v)}
                  onPromptChange={(p) => handleActionPromptChange(action.mode, p)}
                  onResetPrompt={undefined}
                  onContextToggle={(k, v) => handleContextToggle(action.mode, k, v)}
                  onOverrideChange={(k, v) => handleOverrideChange(action.mode, k, v)}
                  showReset={false}
                  cliActive={cliActive}
                  onDelete={() => handleRemoveCustomAction(action.mode)}
                />
              ))}
            </div>
          )}

          {customActions.length === 0 && !showNewActionForm && (
            <p className="py-2 text-center text-meta text-muted-foreground/60">
              No custom actions yet
            </p>
          )}

          {showNewActionForm && (
            <div className="rounded-lg border border-border/40 bg-secondary/20 p-3.5 space-y-2.5">
              <input
                type="text"
                value={newActionName}
                onChange={(e) => setNewActionName(e.target.value)}
                placeholder="Action name"
                className="w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <textarea
                rows={3}
                value={newActionPrompt}
                onChange={(e) => setNewActionPrompt(e.target.value)}
                placeholder="System prompt for this action..."
                className="w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleAddCustomAction}
                  disabled={!newActionName.trim() || !newActionPrompt.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
                <button
                  onClick={() => {
                    setShowNewActionForm(false);
                    setNewActionName("");
                    setNewActionPrompt("");
                  }}
                  className="rounded-lg border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!showNewActionForm && (
            <button
              onClick={() => setShowNewActionForm(true)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/50 py-2 text-xs font-medium text-muted-foreground cursor-pointer transition-colors duration-150 hover:border-primary/30 hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Custom Action
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action Card ─────────────────────────────────────────

interface ActionCardProps {
  action: ActionConfig;
  description?: string;
  isExpanded: boolean;
  isOverrideExpanded: boolean;
  onToggleExpand: () => void;
  onToggleOverride: () => void;
  onToggleVisible: (visible: boolean) => void;
  onPromptChange: (prompt: string) => void;
  onResetPrompt: (() => void) | undefined;
  onContextToggle: (key: string, value: boolean) => void;
  onOverrideChange: (key: string, value: number | null) => void;
  showReset: boolean;
  /** Claude CLI is active: web search, transcript window and temperature don't apply. */
  cliActive: boolean;
  onDelete?: () => void;
}

function ActionCard({
  action,
  description,
  isExpanded,
  isOverrideExpanded,
  onToggleExpand,
  onToggleOverride,
  onToggleVisible,
  onPromptChange,
  onResetPrompt,
  onContextToggle,
  onOverrideChange,
  showReset,
  cliActive,
  onDelete,
}: ActionCardProps) {
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.();
    },
    [onDelete]
  );

  const windowDisplayMin =
    action.transcriptWindowSeconds !== null
      ? action.transcriptWindowSeconds === 0
        ? 0
        : secsToMin(action.transcriptWindowSeconds)
      : null;

  return (
    <div>
      {/* Compact header row */}
      <button
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-secondary/20"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/70 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/70 shrink-0" />
        )}
        <span className="text-xs font-medium text-foreground shrink-0">
          {action.name}
        </span>
        <span className="text-meta text-muted-foreground/60 shrink-0">
          {action.mode}
        </span>
        {description && (
          <span className="hidden sm:inline text-meta text-muted-foreground/60 truncate">
            &mdash; {description}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {onDelete && (
            <button
              onClick={handleDeleteClick}
              className="rounded-md p-1 text-muted-foreground/60 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete ${action.name}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <Toggle
            checked={action.visible}
            onChange={(v) => onToggleVisible(v)}
            label={`Toggle ${action.name} visibility`}
          />
        </div>
      </button>

      {/* Expanded configuration */}
      {isExpanded && (
        <div className="border-t border-border/20 bg-secondary/10 px-3.5 py-3.5 space-y-3.5">
          {/* Purpose */}
          {description && (
            <p className="text-xs text-muted-foreground/80 italic">
              {description}
            </p>
          )}

          {/* System Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                System Prompt
              </label>
              {showReset && onResetPrompt && (
                <button
                  onClick={onResetPrompt}
                  disabled={action.isDefaultPrompt}
                  className="flex items-center gap-1 text-meta font-medium text-muted-foreground transition-colors duration-150 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </button>
              )}
            </div>
            <textarea
              rows={3}
              value={action.systemPrompt}
              onChange={(e) => onPromptChange(e.target.value)}
              className="w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </div>

          {/* Context Sources — two-column grid */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Context Sources
            </label>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {[
                { key: "includeTranscript", label: "Transcript", checked: action.includeTranscript },
                { key: "includeRagChunks", label: "RAG Chunks", checked: action.includeRagChunks },
                { key: "includeCustomInstructions", label: "Custom Instructions", checked: action.includeCustomInstructions },
                { key: "includeDetectedQuestion", label: "Detected Question", checked: action.includeDetectedQuestion },
                { key: "webSearch", label: "Web Search", checked: action.webSearch },
              ].map(({ key, label, checked }) => {
                const unused = cliActive && key === "webSearch";
                return (
                  <label
                    key={key}
                    title={unused ? "Not used with Claude CLI" : undefined}
                    className={`flex items-center gap-2 ${unused ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={unused}
                      onChange={(e) => onContextToggle(key, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border/50 accent-primary"
                    />
                    <span className="text-xs text-foreground">{label}</span>
                  </label>
                );
              })}
            </div>
            {cliActive && (
              <p className="mt-1.5 text-meta text-muted-foreground/70">Web Search: not used with Claude CLI</p>
            )}
          </div>

          {/* Override Defaults (Collapsible) */}
          <div>
            <button
              onClick={onToggleOverride}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {isOverrideExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Override Defaults
            </button>

            {isOverrideExpanded && (
              <div className="mt-2.5 space-y-3 rounded-lg border border-border/30 bg-secondary/10 p-3">
                {/* Transcript Window Override */}
                <div>
                  <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-meta font-medium text-muted-foreground">
                        Transcript Window
                      </label>
                      <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-meta font-medium tabular-nums text-foreground">
                        {formatWindowDisplay(action.transcriptWindowSeconds)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={action.transcriptWindowSeconds !== null}
                          onChange={(e) =>
                            onOverrideChange(
                              "transcriptWindowSeconds",
                              e.target.checked ? 120 : null
                            )
                          }
                          className="h-3 w-3 rounded border-border/50 accent-primary"
                        />
                        <span className="text-meta text-muted-foreground">Override</span>
                      </label>
                      {action.transcriptWindowSeconds !== null && (
                        <input
                          type="range"
                          min={0}
                          max={30}
                          step={1}
                          value={windowDisplayMin ?? 2}
                          onChange={(e) => {
                            const min = Number(e.target.value);
                            onOverrideChange(
                              "transcriptWindowSeconds",
                              min === 0 ? 0 : minToSecs(min)
                            );
                          }}
                          className="flex-1 cursor-pointer accent-primary"
                        />
                      )}
                    </div>
                    {action.transcriptWindowSeconds !== null && (
                      <div className="mt-1 flex justify-between text-meta text-muted-foreground/60">
                        <span>All</span>
                        <span>30 min</span>
                      </div>
                    )}
                  </fieldset>
                  {cliActive && <CliUnusedHint />}
                </div>

                {/* RAG Top-K Override */}
                <div className="flex items-center justify-between">
                  <label className="text-meta font-medium text-muted-foreground">
                    RAG Top-K
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={action.ragTopK !== null}
                        onChange={(e) =>
                          onOverrideChange("ragTopK", e.target.checked ? 5 : null)
                        }
                        className="h-3 w-3 rounded border-border/50 accent-primary"
                      />
                      <span className="text-meta text-muted-foreground">Override</span>
                    </label>
                    {action.ragTopK !== null && (
                      <select
                        value={action.ragTopK}
                        onChange={(e) =>
                          onOverrideChange("ragTopK", Number(e.target.value))
                        }
                        className="rounded border border-border/50 bg-secondary/30 px-2 py-1 text-meta text-foreground focus:border-primary/50 focus:outline-none"
                      >
                        {[3, 5, 7, 10, 15, 20].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* Temperature Override */}
                <div>
                  <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-meta font-medium text-muted-foreground">
                        Temperature
                      </label>
                      <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-meta font-medium tabular-nums text-foreground">
                        {action.temperature === null
                          ? "Default"
                          : action.temperature.toFixed(1)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={action.temperature !== null}
                          onChange={(e) =>
                            onOverrideChange("temperature", e.target.checked ? 0.3 : null)
                          }
                          className="h-3 w-3 rounded border-border/50 accent-primary"
                        />
                        <span className="text-meta text-muted-foreground">Override</span>
                      </label>
                      {action.temperature !== null && (
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={action.temperature}
                          onChange={(e) =>
                            onOverrideChange("temperature", Number(e.target.value))
                          }
                          className="flex-1 cursor-pointer accent-primary"
                        />
                      )}
                    </div>
                  </fieldset>
                  {cliActive && <CliUnusedHint />}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
