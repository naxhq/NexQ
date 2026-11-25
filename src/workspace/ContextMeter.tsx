import { useEffect, useState } from "react";
import { ContextWave, formatTokens, CONTEXT_LAYER_NAMES, type ContextSelection } from "../voiceprint";
import { listWorkspaceChats, previewChatContext } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { ContextReport } from "../lib/types";
import { hintClass } from "./styles";

/**
 * What an answer in this workspace would see, as the context wave (the old
 * token budget, now against the model's real window). Reads the newest chat's
 * estimate; without a chat there is nothing to estimate yet.
 */
export function ContextMeter({ workspaceId }: { workspaceId: string }) {
  const revision = useWorkspaceStore((s) => s.revision);
  const [state, setState] = useState<{ report: ContextReport | null; chat: boolean; error: string | null }>({
    report: null,
    chat: true,
    error: null,
  });
  const [selection, setSelection] = useState<ContextSelection | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const chats = await listWorkspaceChats(workspaceId);
        if (!chats.length) return live && setState({ report: null, chat: false, error: null });
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

  const { report } = state;
  return (
    <section aria-label="What the AI would see" className="space-y-2">
      <h3 className="ui-section text-foreground">Context</h3>
      {state.error && <p className={`${hintClass} text-destructive`}>Couldn't estimate the context: {state.error}</p>}
      {!report && !state.error && (
        <p className={hintClass}>{state.chat ? "Estimating" : "Once you start a chat here, this shows how much of the AI's window it would use."}</p>
      )}
      {report && (
        <>
          <ContextWave bars={report.bars} window={report.window} budget={report.budget} onSelect={setSelection} height={52} />
          <p className={hintClass}>
            {formatTokens(report.used)} of {formatTokens(report.budget)} tokens, in a window of {formatTokens(report.window)}.
          </p>
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
