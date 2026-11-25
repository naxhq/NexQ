import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CONTEXT_LAYER_NAMES, ContextWave, formatTokens, type ContextSelection } from "../../voiceprint";
import type { ContextBar, ContextReport, ItemPref } from "../../lib/types";
import { readWaveOpen, useWorkspaceChatStore, writeWaveOpen } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { openItem, openMeeting, type ChatOpeners } from "./open";
import { displayTitle } from "./titles";

/** A bar's id is "<kind>:<ref>[:<sub>]" (a bare id is its own ref). */
export function parseBar(bar: ContextBar): { kind: string; ref: string; sub: string | null } {
  const parts = bar.id.split(":");
  if (parts.length === 1) return { kind: bar.layer, ref: parts[0], sub: null };
  return { kind: parts[0], ref: parts[1], sub: parts.length > 2 ? parts.slice(2).join(":") : null };
}
/** The meeting or item a bar stands for. */
export const refOfBar = (bar: ContextBar) => parseBar(bar).ref;

export type WaveSubject = "estimate" | "answer" | "live";

const HEADINGS: Record<WaveSubject, string> = {
  estimate: "What the next answer will see",
  answer: "What the last answer saw",
  live: "What this answer is seeing",
};

// At rest the wave is a strip: only the bars (hover or focus reads one). The summary line, the
// readout and the layer legend come with the expanded view.
const STRIP_ONLY = "[&_section>div:first-child]:hidden [&_[role=status]]:hidden [&_ul]:hidden";

/**
 * The context wave for the current question, as a 22 px strip over the composer. Click it (or
 * a bar) to expand: legend, notes and the items of a layer, where a meeting can be left out and
 * any item pinned or left out for this chat. Remembered.
 */
export function ContextPanel({
  report,
  subject,
  estimating,
  failed,
  workspaceId,
  chatId,
  excluded,
  itemPrefs,
  openers,
  short = false,
}: {
  report: ContextReport | null;
  subject: WaveSubject;
  estimating: boolean;
  failed: boolean;
  workspaceId: string;
  chatId: string | null;
  excluded: string[];
  /** Saved pins and exclusions (they persist across reloads). */
  itemPrefs: ItemPref[];
  openers: ChatOpeners;
  /** The pane is short: only the one-line strip, never the expanded view. */
  short?: boolean;
}) {
  const [wanted, setOpen] = useState(readWaveOpen);
  const open = wanted && !short;
  const [selection, setSelection] = useState<ContextSelection | null>(null);
  const id = useId();
  const set = (next: boolean) => {
    if (short) return;
    writeWaveOpen(next);
    setOpen(next);
  };
  // Bars with no usable name read "Removed item", never an id.
  const bars = useMemo(() => report?.bars.map((b) => ({ ...b, title: displayTitle(b.title, b.id) })) ?? [], [report]);
  const numbers = report ? `${formatTokens(report.used)} of ${formatTokens(report.budget)}` : estimating ? "Estimating" : failed ? "No estimate" : "";

  return (
    <section aria-label="Context" className="pb-1.5">
      <div className={COLUMN}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => set(!open)}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            aria-label={`${HEADINGS[subject]}: ${numbers || "nothing yet"}`}
            className="ui-meta inline-flex h-[22px] shrink-0 items-center gap-1 rounded text-muted-foreground outline-none transition-colors hover:text-foreground ui-focus ui-focus-sm"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
            Context
          </button>
          {!open && report && (
            <div className={cn("h-[22px] min-w-0 flex-1 overflow-hidden", STRIP_ONLY)}>
              <ContextWave
                bars={bars}
                window={report.window}
                budget={report.budget}
                height={22}
                onSelect={(sel) => {
                  setSelection(sel);
                  set(true);
                }}
              />
            </div>
          )}
          {(open || !report) && <span className="flex-1" />}
          <span className="ui-meta shrink-0 tabular-nums text-muted-foreground" aria-live="polite">
            {numbers}
          </span>
        </div>
        {open && (
          <div id={`${id}-body`} className="pb-1 pt-1">
            <p className="ui-meta pb-1 font-medium text-foreground">{HEADINGS[subject]}</p>
            {report ? (
              <>
                <ContextWave bars={bars} window={report.window} budget={report.budget} height={52} onSelect={setSelection} />
                <p className="ui-meta mt-1.5 text-muted-foreground">
                  {report.strategy === "full" ? "Everything included fit." : "Picked the most relevant material."} The model's window is {formatTokens(report.window)}.
                  {report.omitted > 0 ? ` ${report.omitted} smaller ${report.omitted === 1 ? "item was" : "items were"} left out.` : ""}
                </p>
                {report.notices.map((n) => (
                  <p key={n} className="ui-meta mt-0.5 text-foreground/80">
                    {n}
                  </p>
                ))}
              </>
            ) : (
              <p className="ui-meta py-2 text-muted-foreground">{failed ? "The estimate isn't available right now." : estimating ? "Estimating what would be sent." : "Start typing to see what would be sent."}</p>
            )}
            <PrefList prefs={itemPrefs} chatId={chatId} />
            {selection && (
              <Inspector
                selection={selection}
                workspaceId={workspaceId}
                chatId={chatId}
                excluded={excluded}
                itemPrefs={itemPrefs}
                openers={openers}
                onClose={() => setSelection(null)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Opens what a bar stands for, by its own kind: a meeting at its moment, a document, a folder file or a talking point. */
export function openBar(openers: ChatOpeners, kind: string, ref: string, sub: string | null) {
  if (kind === "meeting" || kind === "meetings" || kind === "transcript") {
    const at = sub !== null && /^\d+$/.test(sub) ? Number(sub) : null;
    return openMeeting(openers, ref, at);
  }
  if (kind === "talking_point" || kind === "talking_points") return openItem(openers, "talking_point", ref, sub);
  if (kind === "folder" || kind === "folders") return openItem(openers, "folder", ref, sub);
  return openItem(openers, "document", ref, sub);
}

function saved_title(prefs: ItemPref[], kind: string, ref: string): string | undefined {
  return prefs.find((p) => p.kind === kind && p.ref_id === ref)?.title;
}

const rowBtn =
  "ui-meta rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent ui-focus ui-focus-sm";

function Inspector({
  selection,
  workspaceId,
  chatId,
  excluded,
  itemPrefs,
  openers,
  onClose,
}: {
  selection: ContextSelection;
  workspaceId: string;
  chatId: string | null;
  excluded: string[];
  itemPrefs: ItemPref[];
  openers: ChatOpeners;
  onClose: () => void;
}) {
  const shown = selection.bars.slice(0, 12);
  const store = useWorkspaceChatStore;
  return (
    <div role="region" aria-label={`${CONTEXT_LAYER_NAMES[selection.layer]} items`} className="mt-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between">
        <p className="ui-section text-foreground">{CONTEXT_LAYER_NAMES[selection.layer]}</p>
        <button type="button" onClick={onClose} className={cn(rowBtn, "text-muted-foreground")}>
          Close
        </button>
      </div>
      <ul className="mt-1 divide-y divide-border/50">
        {shown.map((bar) => {
          const { kind, ref, sub } = parseBar(bar);
          const meeting = bar.layer === "meetings";
          const left = excluded.includes(ref);
          const saved = itemPrefs.find((p) => p.kind === kind && p.ref_id === ref)?.pref;
          const pinned = bar.pinned || saved === "pin";
          const kept = saved === "exclude";
          const fixed = bar.layer === "instructions" || bar.layer === "conversation";
          return (
            <li key={bar.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
              <span className="ui-body min-w-0 flex-1 truncate text-foreground">{displayTitle(bar.title || saved_title(itemPrefs, kind, ref), bar.id)}</span>
              <span className="ui-meta tabular-nums text-muted-foreground">
                {formatTokens(bar.tokens)} tokens{pinned ? ", pinned" : ""}{kept ? ", left out" : bar.included ? "" : ", didn't fit"}
              </span>
              {!fixed && (
                <button
                  type="button"
                  onClick={() => openBar(openers, kind, ref, sub)}
                  className={rowBtn}
                >
                  Open
                </button>
              )}
              {!fixed && chatId && (
                <button
                  type="button"
                  onClick={() => void store.getState().setItemPref(chatId, kind, ref, pinned ? "default" : "pin")}
                  className={rowBtn}
                >
                  {pinned ? "Unpin" : "Pin"}
                </button>
              )}
              {meeting && chatId && (
                <button type="button" onClick={() => void store.getState().setMeetingIncluded(workspaceId, chatId, ref, left)} className={rowBtn}>
                  {left ? "Use in this chat" : "Leave out of this chat"}
                </button>
              )}
              {!meeting && !fixed && chatId && (
                <button type="button" onClick={() => void store.getState().setItemPref(chatId, kind, ref, kept ? "default" : "exclude")} className={rowBtn}>
                  {kept ? "Use in this chat" : "Leave out of this chat"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {selection.bars.length > shown.length && <p className="ui-meta mt-1 text-muted-foreground">{selection.bars.length - shown.length} more.</p>}
    </div>
  );
}

/** The pins and exclusions saved for this chat, by name (never by id); each can be put back. */
function PrefList({ prefs, chatId }: { prefs: ItemPref[]; chatId: string | null }) {
  const set = prefs.filter((p) => p.pref === "pin" || p.pref === "exclude");
  if (set.length === 0) return null;
  return (
    <ul aria-label="Pinned and left out" className="mt-2 space-y-0.5">
      {set.map((p) => (
        <li key={`${p.kind}:${p.ref_id}`} className="flex items-center gap-2">
          <span className="ui-body min-w-0 flex-1 truncate text-foreground">{displayTitle(p.title, p.ref_id)}</span>
          <span className="ui-meta text-muted-foreground">{p.pref === "pin" ? "Pinned" : "Left out"}</span>
          {chatId && (
            <button
              type="button"
              onClick={() => void useWorkspaceChatStore.getState().setItemPref(chatId, p.kind, p.ref_id, "default")}
              className={rowBtn}
            >
              {p.pref === "pin" ? "Unpin" : "Use again"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
