import { useEffect, useMemo, useState } from "react";
import { ContextWave, formatTokens, CONTEXT_LAYER_NAMES, type ContextSelection } from "../voiceprint";
import { getContextBudget, listWorkspaceChats, previewChatContext } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import type { ContextBar, ContextBudget, ContextReport, WorkspaceDetail } from "../lib/types";

/** Used only until the backend has said what the default model gets (or when it cannot). */
export const ESTIMATE_BUDGET = 24_000;
export const ESTIMATE_WINDOW = 128_000;

/**
 * What a first answer would carry from the library alone: the instructions and
 * each readable file. A chat is made on the first question, so before that
 * this is the honest number; meetings and the conversation add to it later.
 */
export function libraryEstimate(detail: Pick<WorkspaceDetail, "instructions" | "items"> | undefined): ContextBar[] {
  if (!detail) return [];
  const bars: ContextBar[] = [];
  const instr = Math.ceil(detail.instructions.length / 4);
  if (instr > 0) bars.push({ id: "instructions", layer: "instructions", title: "Instructions", tokens: instr, relevance: 1, pinned: true, included: true });
  for (const i of detail.items) {
    if (i.kind === "server" || !i.tokens || i.status === "missing" || i.status === "off" || i.status === "error") continue;
    bars.push({
      id: `${i.kind}:${i.ref_id}`,
      layer: i.kind === "folder" ? "folders" : "documents",
      title: i.label?.trim() || i.name,
      tokens: i.tokens,
      relevance: 0.6,
      pinned: i.pinned,
      included: true,
    });
  }
  return bars;
}
import { hintClass } from "./styles";
import { IndexingNote } from "./IndexingNote";

/**
 * What an answer in this workspace would see, as the context wave (the old
 * token budget, now against the model's real window). Reads the newest chat's
 * estimate; without a chat there is nothing to estimate yet.
 */
export function ContextMeter({ workspaceId }: { workspaceId: string }) {
  const revision = useWorkspaceStore((s) => s.revision);
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const [state, setState] = useState<{ report: ContextReport | null; chat: boolean; error: string | null }>({
    report: null,
    chat: true,
    error: null,
  });
  const [selection, setSelection] = useState<ContextSelection | null>(null);
  const [fallback, setFallback] = useState<ContextBudget | null>(null);
  // The open chat's own estimate (the one over the composer, with the question being typed) is the
  // number to show, so the rail, the panel and the box say the same thing.
  const shared = useWorkspaceChatStore((s) => {
    const open = s.activeChat[workspaceId];
    return open ? s.sessions[open]?.preview ?? null : null;
  });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const chats = await listWorkspaceChats(workspaceId);
        if (!chats.length) {
          // No chat yet: draw the library against what the default model would get.
          const b = await getContextBudget("balanced").catch(() => null);
          if (live) {
            setFallback(b);
            setState({ report: null, chat: false, error: null });
          }
          return;
        }
        const report = await previewChatContext(chats[0].id);
        if (live) setState({ report, chat: true, error: null });
      } catch (e) {
        if (live) setState({ report: null, chat: true, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, revision]);

  useEffect(() => setSelection(null), [workspaceId]);

  const report = shared ?? state.report;
  const estimate = useMemo(() => libraryEstimate(detail), [detail]);
  const estimated = estimate.reduce((n, b) => n + b.tokens, 0);
  return (
    <section aria-label="What the AI would see" className="space-y-2">
      <h3 className="ui-section text-foreground">Context</h3>
      <IndexingNote workspaceId={workspaceId} />
      {state.error && <p className={`${hintClass} text-destructive`}>Couldn't estimate the context: {state.error}</p>}
      {!report && !state.error && !state.chat && (
        <>
          {estimate.length > 0 ? (
            <>
              <ContextWave bars={estimate} window={fallback?.window ?? ESTIMATE_WINDOW} budget={fallback?.budget ?? ESTIMATE_BUDGET} height={52} />
              <p className={hintClass}>
                About {formatTokens(estimated)} tokens from the instructions and files. Meetings and the conversation join in when you ask something.
              </p>
            </>
          ) : (
            <p className={hintClass}>No files or instructions yet. The first question shows how much of the AI's window it would use.</p>
          )}
        </>
      )}
      {!report && !state.error && state.chat && <p className={hintClass}>Estimating</p>}
      {report && (
        <>
          <ContextWave bars={report.bars} window={report.window} budget={report.budget} used={report.used} layers={report.layers} onSelect={setSelection} height={52} />
          {report.notices.map((n) => (
            <p key={n} className={hintClass}>
              {n}
            </p>
          ))}
          {selection && (
            <p className={`${hintClass} text-foreground`} aria-live="polite">
              {CONTEXT_LAYER_NAMES[selection.layer]}: {selection.bars.map((b) => b.title).join(", ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
