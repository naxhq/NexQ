import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Info, Square } from "lucide-react";
import { Segmented, Select, buttonClass } from "../../ui";
import { formatTokens } from "../../voiceprint";
import { cliEffortLabel, cliModelLabel, isCliAgent } from "../../lib/cliAgents";
import type { ContextDepth, WorkspaceChat } from "../../lib/types";
import type { ChatSession } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import { ScopeControl } from "./ScopeControl";
import { CAPABILITY_TEXT, TOOLS_OFF_TEXT, capabilityOf, providerLabel, toolsOffInChat, type ModelChoice, type Selection } from "./models";

export const DEPTHS: Array<{ value: ContextDepth; label: string; text: string }> = [
  { value: "lean", label: "Lean", text: "Quick and cheap. Looks at about 8k tokens of your material." },
  { value: "balanced", label: "Balanced", text: "For most questions. Up to 24k tokens, and it stops when nothing more is relevant." },
  { value: "deep", label: "Deep", text: "Searches widely, up to 80k tokens. Slower, and it costs more." },
];

const MAX_ROWS_PX = 200;

export interface ComposerProps {
  workspaceId: string;
  chat: WorkspaceChat | null;
  session: ChatSession;
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** This chat is writing an answer. */
  writing: boolean;
  stopping: boolean;
  /** Another chat is writing and a meeting is running: one at a time. */
  waitingForOther: boolean;
  meetingActive: boolean;
  /** The workspace has folders or servers the answer could read. */
  hasLibrary: boolean;
  selection: Selection;
  onPickModel: (choice: ModelChoice) => void;
  onEffort: (effort: string) => void;
  onDepth: (depth: ContextDepth) => void;
  ensureChat: () => Promise<string | null>;
  onOpenSettings: () => void;
  autoFocusKey: string;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="ui-meta flex items-start gap-1.5 text-muted-foreground">
      <Info className="mt-[0.2em] h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The question box and what shapes the answer: model, effort, depth, which meetings, and an
 * estimate of what would be sent. Enter sends, Shift+Enter adds a line. It grows with the text.
 */
export function Composer(p: ComposerProps) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const uid = useId();
  const { selection, session } = p;
  const depth = p.chat?.depth ?? "balanced";
  const depthInfo = DEPTHS.find((d) => d.value === depth) ?? DEPTHS[1];
  const report = session.preview;
  const cap = capabilityOf(selection.provider);
  const offTools = toolsOffInChat(selection.provider);
  const smallWindow = !!report && report.window > 0 && report.window < 8000;
  const canSend = !p.writing && !p.waitingForOther && p.draft.trim().length > 0;

  // Grows to its text, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_ROWS_PX ? "auto" : "hidden";
  }, [p.draft]);

  // The composer is the focus: on a new chat, and when a chat opens.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, [p.autoFocusKey]);

  const send = () => {
    if (!canSend) return;
    p.onSend(p.draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const estimate = report
    ? `About ${formatTokens(report.used)} tokens of ${formatTokens(report.budget)}`
    : session.previewing
      ? "Estimating"
      : session.previewFailed
        ? "No estimate"
        : "";

  return (
    <div className={cn(COLUMN, "px-0")}>
      <div className="space-y-1 pb-2">
        {p.meetingActive && <Notice>A meeting is running. Answers here take turns, one at a time, so live answers stay fast.</Notice>}
        {p.waitingForOther && !p.writing && <Notice>Another answer is still being written. Yours can go once it ends.</Notice>}
        {offTools && p.hasLibrary && (
          <Notice>
            {providerLabel(selection.provider)} can't ask before it runs a tool yet. {TOOLS_OFF_TEXT}; it still reads folders and answers from your meetings.
          </Notice>
        )}
        {cap === "passages" && p.hasLibrary && (
          <Notice>{providerLabel(selection.provider)} can't open folders or use tools. It answers from the passages found in your meetings and documents.</Notice>
        )}
        {smallWindow && report && <Notice>This model's window is small ({report.window.toLocaleString()} tokens), so answers see less of your material.</Notice>}
      </div>
      <div className="rounded-xl border border-border bg-card shadow-[0_1px_0_rgba(0,0,0,0.12)] focus-within:border-ring/60">
        <label htmlFor={`${uid}-q`} className="sr-only">
          Ask about this workspace
        </label>
        <textarea
          id={`${uid}-q`}
          ref={box}
          data-chat-composer
          rows={2}
          value={p.draft}
          onChange={(e) => {
            p.onDraft(e.target.value);
            if (!p.chat) void p.ensureChat();
          }}
          onKeyDown={onKeyDown}
          placeholder="Ask about your meetings, documents and notes"
          aria-describedby={`${uid}-hint`}
          className="ui-body block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <p id={`${uid}-hint`} className="sr-only">
          Enter sends. Shift and Enter adds a line.
        </p>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-2 pt-1">
          <ModelPicker
            value={{ provider: selection.provider, model: selection.model }}
            label="Model"
            onPick={p.onPickModel}
            onOpenSettings={p.onOpenSettings}
            disabled={p.writing}
            buttonClassName="ui-meta inline-flex h-7 max-w-[15rem] items-center gap-1.5 rounded-md px-2 font-medium text-foreground/90 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
          >
            <span className="truncate">{selectionText(selection)}</span>
            <span className="shrink-0 font-normal text-muted-foreground">{CAPABILITY_TEXT[cap]}</span>
            <PickerCaret />
          </ModelPicker>
          {selection.efforts.length > 0 && selection.effort && (
            <Select
              label="Effort"
              value={selection.effort}
              onChange={p.onEffort}
              disabled={p.writing}
              options={selection.efforts.map((e) => ({ value: e, label: isCliAgent(selection.provider) ? cliEffortLabel(e) : e }))}
              className="ui-meta !h-7 !w-auto"
            />
          )}
          <ScopeControl workspaceId={p.workspaceId} chat={p.chat} excluded={session.excluded} ensureChat={p.ensureChat} disabled={p.writing} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-2 py-2">
          <div className="min-w-0">
            <Segmented
              label="Depth"
              value={depth}
              onChange={p.onDepth}
              options={DEPTHS.map((d) => ({ value: d.value, label: d.label, disabled: p.writing }))}
            />
          </div>
          <p className="ui-meta min-w-0 flex-1 basis-40 text-muted-foreground" aria-live="polite">
            {depthInfo.text}
          </p>
          <span className="ui-meta min-w-[9rem] text-right tabular-nums text-muted-foreground" aria-live="polite">
            {estimate}
          </span>
          {p.writing ? (
            <button
              type="button"
              onClick={p.onStop}
              disabled={p.stopping}
              className={cn(buttonClass.base, buttonClass.quiet, "gap-1.5")}
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              {p.stopping ? "Stopping" : "Stop"}
            </button>
          ) : (
            <button type="button" onClick={send} disabled={!canSend} className={cn(buttonClass.base, buttonClass.primary)}>
              Ask
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function selectionText(sel: Selection): string {
  const base = providerLabel(sel.provider);
  const model = isCliAgent(sel.provider) ? cliModelLabel(sel.provider, sel.model) : sel.model || "Default";
  return sel.effort ? `${base} ${model}, ${cliEffortLabel(sel.effort)}` : `${base} ${model}`;
}
