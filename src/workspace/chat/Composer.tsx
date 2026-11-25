import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Info, Square } from "lucide-react";
import { Segmented, Select, Button, buttonClasses } from "../../ui";
import { formatTokens } from "../../voiceprint";
import { cliEffortLabel, cliModelLabel, isCliAgent } from "../../lib/cliAgents";
import type { ChatCapabilities, ContextDepth, WorkspaceChat } from "../../lib/types";
import type { ChatSession } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { DEPTHS } from "./depths";
import { CapabilityNotes } from "./CapabilityNotes";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import { OptionsMenu } from "./OptionsMenu";
import { ScopeControl } from "./ScopeControl";
import { CAPABILITY_TEXT, TOOLS_OFF_TEXT, capabilityOf, providerLabel, toolsOffInChat, type ModelChoice, type Selection } from "./models";

export { DEPTHS } from "./depths";

const MAX_PX = 200;
const ONE_ROW_PX = 24;
const TWO_ROWS_PX = 48;

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
  /** A chat with messages: one quiet row, so the answers keep the room. */
  compact: boolean;
  /** What the backend says this chat can do (null until it answers, or on an older backend). */
  capabilities?: ChatCapabilities | null;
  /** false when the pane is narrower than 620 px. */
  showEstimate: boolean;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="ui-meta flex items-start gap-1.5 text-muted-foreground">
      <Info className="mt-[0.2em] h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function selectionText(sel: Selection): string {
  const base = providerLabel(sel.provider);
  const model = isCliAgent(sel.provider) ? cliModelLabel(sel.provider, sel.model) : sel.model || "Default";
  return `${base} ${model}`;
}

/**
 * The question box and what shapes the answer. Enter sends, Shift+Enter adds a line. At the
 * start it shows everything; in a chat with messages it is one row (model as quiet text,
 * depth, effort and meetings behind one button) that grows only while focused or filled.
 */
export function Composer(p: ComposerProps) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const uid = useId();
  const [hint, setHint] = useState(false);
  const { selection, session, compact } = p;
  const depth = p.chat?.depth ?? "balanced";
  const depthInfo = DEPTHS.find((d) => d.value === depth) ?? DEPTHS[1];
  const report = session.preview;
  const cap = capabilityOf(selection.provider);
  const offTools = toolsOffInChat(selection.provider);
  const smallWindow = !!report && report.window > 0 && report.window < 8000;
  const caps = p.capabilities ?? null;
  const canSend = !p.writing && !p.waitingForOther && p.draft.trim().length > 0;
  // One line while empty (even focused); two or more once there is text.
  const open = p.draft.length > 0;

  // The box's own width: a height is only measured when the text has a real width to wrap in,
  // and again whenever that width changes (a docked panel opening, a window resize).
  const [boxSize, setBoxSize] = useState("");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pane = el.closest("[data-workspace-chat]");
    const read = () => setBoxSize(`${Math.round(el.getBoundingClientRect().width)}x${Math.round(pane?.getBoundingClientRect().height ?? 0)}`);
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (pane) ro.observe(pane);
    return () => ro.disconnect();
  }, [compact]);

  // Grows to its text, then scrolls. In the compact row it stays one line until focused or filled.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const floor = compact ? (open ? TWO_ROWS_PX : ONE_ROW_PX) : TWO_ROWS_PX;
    // No width yet (hidden, or still laying out): keep to the floor and measure when it has one.
    if (typeof ResizeObserver !== "undefined" && el.getBoundingClientRect().width < 40) {
      el.style.height = `${floor}px`;
      el.style.overflowY = "hidden";
      return;
    }
    // A long draft never pushes Ask out of sight: the box may use about a fifth of the pane.
    const paneH = el.closest("[data-workspace-chat]")?.getBoundingClientRect().height || window.innerHeight;
    const max = Math.max(60, Math.min(MAX_PX, Math.round(paneH * 0.2)));
    el.style.height = "auto";
    const h = Math.min(Math.max(el.scrollHeight, floor), max);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [p.draft, compact, open, boxSize]);

  // The composer is the focus: on a new chat, and when a chat opens.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, [p.autoFocusKey]);

  const send = () => {
    if (canSend) p.onSend(p.draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const estimateText = report
    ? `About ${formatTokens(report.used)} tokens of ${formatTokens(report.budget)}`
    : session.previewing
      ? "Estimating"
      : session.previewFailed
        ? "No estimate"
        : "";

  // Narrow pane (under 620 px): the estimate steps aside.
  const estimate = p.showEstimate ? estimateText : "";

  const action = p.writing ? (
    <Button onClick={p.onStop} disabled={p.stopping} className="shrink-0 gap-1.5">
      <Square className="h-3 w-3 fill-current" aria-hidden="true" />
      {p.stopping ? "Stopping" : "Stop"}
    </Button>
  ) : (
    <Button variant="primary" onClick={send} disabled={!canSend} className="shrink-0">
      Ask
    </Button>
  );

  const textarea = (
    <>
      <label htmlFor={`${uid}-q`} className="sr-only">
        Ask about this workspace
      </label>
      <textarea
        id={`${uid}-q`}
        ref={box}
        data-chat-composer
        rows={1}
        value={p.draft}
        onChange={(e) => {
          p.onDraft(e.target.value);
          if (!p.chat) void p.ensureChat();
        }}
        onKeyDown={onKeyDown}
        placeholder={compact ? "Ask a follow-up" : "Ask about your meetings, documents and notes"}
        aria-describedby={`${uid}-hint`}
        className={cn(
          "ui-body block w-full min-w-0 resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70",
          compact ? "px-2 pb-0.5 pt-1.5" : "px-3.5 pb-1 pt-3",
        )}
      />
      <p id={`${uid}-hint`} className="sr-only">
        Enter sends. Shift and Enter adds a line.
      </p>
    </>
  );

  const modelPicker = (
    <ModelPicker
      value={{ provider: selection.provider, model: selection.model }}
      label="Model"
      onPick={p.onPickModel}
      onOpenSettings={p.onOpenSettings}
      disabled={p.writing}
      buttonClassName={cn(buttonClasses("ghost", "sm"), "ui-meta min-w-0 max-w-full px-2", !compact && "text-foreground/90")}
    >
      <span className="min-w-0 truncate">{selectionText(selection)}</span>
      {!compact && <span className="hidden min-w-0 truncate font-normal text-muted-foreground sm:inline">{CAPABILITY_TEXT[cap]}</span>}
      <PickerCaret />
    </ModelPicker>
  );

  const notices = (
    <div className={cn("space-y-1", compact ? "pb-1.5" : "pb-2")}>
      {p.meetingActive && <Notice>A meeting is running. Answers here take turns, one at a time, so live answers stay fast.</Notice>}
      {p.waitingForOther && !p.writing && <Notice>Another answer is still being written. Yours can go once it ends.</Notice>}
      {caps && <CapabilityNotes caps={caps} />}
      {!caps && offTools && p.hasLibrary && (
        <Notice>
          {providerLabel(selection.provider)} can't ask before it runs a tool yet. {TOOLS_OFF_TEXT}; it still reads folders and answers from your meetings.
        </Notice>
      )}
      {!caps && cap === "passages" && p.hasLibrary && (
        <Notice>{providerLabel(selection.provider)} can't open folders or use tools. It answers from the passages found in your meetings and documents.</Notice>
      )}
      {smallWindow && report && <Notice>This model's window is small ({report.window.toLocaleString()} tokens), so answers see less of your material.</Notice>}
    </div>
  );

  if (compact) {
    // The question has its own full-width line; the controls wrap under it and Ask never leaves the row.
    return (
      <div className={cn(COLUMN, "min-w-0")} data-composer="compact">
        {notices}
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card focus-within:border-ring/60">
          {textarea}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 px-2 pb-1.5 pt-1" data-composer-controls>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
              <div className="flex min-w-0 max-w-full">{modelPicker}</div>
              <div className="flex min-w-0 max-w-full">
                <OptionsMenu
                  workspaceId={p.workspaceId}
                  chat={p.chat}
                  excluded={session.excluded}
                  selection={selection}
                  disabled={p.writing}
                  onDepth={p.onDepth}
                  onEffort={p.onEffort}
                  ensureChat={p.ensureChat}
                />
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className="ui-meta min-w-0 truncate text-right tabular-nums text-muted-foreground" aria-live="polite">
                {estimate}
              </span>
              {action}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(COLUMN, "min-w-0")} data-composer="full">
      {notices}
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_0_rgba(0,0,0,0.12)] focus-within:border-ring/60">
        {textarea}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-2 pt-1">
          {modelPicker}
          {selection.efforts.length > 0 && selection.effort && (
            <span className="inline-flex items-center gap-1">
              <span className="ui-meta text-muted-foreground" aria-hidden="true">
                Effort:
              </span>
              <Select
                label="Effort"
                value={selection.effort}
                onChange={p.onEffort}
                disabled={p.writing}
                options={selection.efforts.map((e) => ({ value: e, label: isCliAgent(selection.provider) ? cliEffortLabel(e) : e }))}
                className="ui-meta !h-7 !w-auto"
              />
            </span>
          )}
          <ScopeControl workspaceId={p.workspaceId} chat={p.chat} excluded={session.excluded} ensureChat={p.ensureChat} disabled={p.writing} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-2 py-2">
          <div
            onFocus={() => setHint(true)}
            onBlur={() => setHint(false)}
            onMouseEnter={() => setHint(true)}
            onMouseLeave={() => setHint(false)}
            className="shrink-0"
          >
            <Segmented label="Depth" value={depth} onChange={p.onDepth} options={DEPTHS.map((d) => ({ value: d.value, label: d.label, disabled: p.writing }))} />
          </div>
          <span className="ui-meta ml-auto min-w-[9rem] text-right tabular-nums text-muted-foreground" aria-live="polite">
            {estimate}
          </span>
          {action}
        </div>
        {hint && (
          <p className="ui-meta border-t border-border/60 px-3 py-1.5 text-muted-foreground" aria-live="polite">
            {depthInfo.label}: {depthInfo.text}
          </p>
        )}
      </div>
    </div>
  );
}
