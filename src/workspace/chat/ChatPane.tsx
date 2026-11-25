import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspaceChat, useChatPreview } from "../../hooks/useWorkspaceChat";
import { useMeetingStore } from "../../stores/meetingStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceChatStore } from "../../stores/workspaceChatStore";
import type { ContextDepth, ContextReport, WorkspaceCitation } from "../../lib/types";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { ChatSwitcher } from "./ChatSwitcher";
import { Composer } from "./Composer";
import { ContextPanel, type WaveSubject } from "./ContextPanel";
import { ExampleQuestions, StartHeading, useExamples } from "./StartState";
import { Transcript } from "./Transcript";
import type { TurnContext } from "./TurnView";
import { useSelection, type ModelChoice } from "./models";
import { openCitation, type ChatOpeners } from "./open";

export interface ChatPaneProps extends ChatOpeners {
  workspaceId: string;
  /** The Start meeting action, drawn by the parent (the strongest element of the start screen). */
  startAction?: ReactNode;
  className?: string;
}

const openProviderSettings = () => useMeetingStore.getState().openSettings("llm");

/**
 * The middle of the launcher: ask across a workspace. Answers keep running when you leave
 * (the store holds them), two chats can write at once, and nothing fails silently.
 */
export function ChatPane({ workspaceId, startAction, onOpenMeeting, onOpenItem, className }: ChatPaneProps) {
  const store = useWorkspaceChatStore;
  const root = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setWide(w === 0 || w >= 620);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const view = useWorkspaceChat(workspaceId);
  const { chat, chatId, session } = view;
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const meetingActive = useMeetingStore((s) => !!s.activeMeeting);
  const selection = useSelection(chat);
  const examples = useExamples(workspaceId);
  const busyIds = useWorkspaceChatStore((s) =>
    Object.entries(s.sessions)
      .filter(([, x]) => x.turn && (x.turn.status === "waiting" || x.turn.status === "streaming" || x.turn.status === "stopping"))
      .map(([id]) => id)
      .join(","),
  );
  const busyList = useMemo(() => (busyIds ? busyIds.split(",") : []), [busyIds]);

  useEffect(() => {
    if (!detail) Promise.resolve(useWorkspaceStore.getState().loadDetail(workspaceId)).catch(() => {});
  }, [workspaceId, detail]);

  const turn = session.turn;
  const writing = !!turn && (turn.status === "waiting" || turn.status === "streaming" || turn.status === "stopping");
  const stopping = turn?.status === "stopping";
  const openers = useMemo<ChatOpeners>(() => ({ onOpenMeeting, onOpenItem }), [onOpenMeeting, onOpenItem]);
  const hasLibrary = !!detail?.items.some((i) => i.kind === "folder" || i.kind === "server");

  // The estimate follows what is typed and everything that changes the context.
  const signature = [
    chat?.provider,
    chat?.model,
    chat?.effort,
    chat?.depth,
    chat?.include_meetings,
    session.excluded.join(","),
    session.messages.length,
  ].join("|");
  useChatPreview(chatId, view.draft, signature, !!chatId && !writing);

  // What this chat's model can use (and which tools are off, and why) follows the model and the workspace's library.
  const capSignature = [chat?.provider, chat?.model, chat?.effort, detail?.items.length].join("|");
  useEffect(() => {
    if (chatId) void store.getState().refreshCapabilities(chatId);
  }, [chatId, capSignature, store]);

  const ensureChat = useCallback(() => store.getState().ensureChat(workspaceId), [store, workspaceId]);

  const sendText = useCallback(
    async (text: string, opts?: { deeper?: boolean }) => {
      const id = await ensureChat();
      if (!id) return;
      // Settings still being saved (model, depth, meetings) settle first; if one failed, nothing is sent and the text stays.
      if (!(await store.getState().settleWrites(id))) return;
      store.getState().setDraft(id, "");
      store.getState().setDraft(`new:${workspaceId}`, "");
      await store.getState().ask(id, text, opts);
    },
    [ensureChat, store, workspaceId],
  );

  const pickModel = useCallback(
    async (choice: ModelChoice): Promise<boolean> => {
      const id = await ensureChat();
      return id ? store.getState().updateChat(id, { provider: choice.provider, model: choice.model, effort: null }) : false;
    },
    [ensureChat, store],
  );

  const patch = useCallback(
    async (p: { effort?: string; depth?: ContextDepth }): Promise<boolean> => {
      const id = await ensureChat();
      return id ? store.getState().updateChat(id, p) : false;
    },
    [ensureChat, store],
  );

  const ctx = useMemo<TurnContext>(
    () => ({
      workspaceId,
      chatId: chatId ?? "",
      current: { provider: selection.provider, model: selection.model },
      busy: writing,
      onOpenCitation: (c: WorkspaceCitation) => openCitation(openers, c),
      onAsk: (question, opts) => {
        void (async () => {
          // A model that didn't save stops the send: the answer must not come from another model.
          if (opts?.choice && !(await pickModel(opts.choice))) return;
          await sendText(question, { deeper: opts?.deeper });
        })();
      },
      onOpenSettings: openProviderSettings,
    }),
    [workspaceId, chatId, selection.provider, selection.model, writing, openers, pickModel, sendText],
  );

  const lastAnswerReport: ContextReport | null = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i--) if (session.messages[i].role === "assistant") return session.messages[i].context;
    return null;
  }, [session.messages]);

  let report: ContextReport | null;
  let subject: WaveSubject;
  if (writing && turn?.report) {
    report = turn.report;
    subject = "live";
  } else if (session.preview) {
    report = session.preview;
    subject = "estimate";
  } else {
    report = lastAnswerReport;
    subject = "answer";
  }

  const empty = !turn && session.messages.length === 0 && (!chatId || session.loaded) && !session.loading;
  const waitingForOther = meetingActive && view.anyBusy && !writing;

  return (
    <div ref={root} className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background", className)} data-workspace-chat>
      <ChatSwitcher workspaceId={workspaceId} chats={view.chats} chat={chat} busyIds={busyList} />

      {view.error && (
        <div role="alert" className={cn(COLUMN, "ui-body flex items-center gap-3 px-5 py-2 text-foreground")}>
          <span className="min-w-0 flex-1">Couldn't load the chats: {view.error}</span>
          <button type="button" onClick={() => void store.getState().loadChats(workspaceId)} className="ui-meta rounded px-2 py-1 font-medium underline underline-offset-2 outline-none ui-focus ui-focus-sm">
            Try again
          </button>
        </div>
      )}

      {empty ? (
        <div className="flex min-h-0 flex-[2] flex-col justify-end px-5">
          <div className={cn(COLUMN, "flex items-end justify-between gap-4 pb-1")}>
            <StartHeading workspace={workspace} />
            {startAction && <div className="shrink-0 pb-4">{startAction}</div>}
          </div>
        </div>
      ) : session.loadError ? (
        <div role="alert" className={cn(COLUMN, "ui-body flex-1 px-5 py-6 text-foreground")}>
          Couldn't open this chat: {session.loadError}{" "}
          <button type="button" onClick={() => chatId && void store.getState().loadMessages(chatId)} className="rounded font-medium underline underline-offset-2 outline-none ui-focus ui-focus-sm">
            Try again
          </button>
        </div>
      ) : chatId ? (
        <Transcript
          chatId={chatId}
          messages={session.messages}
          loaded={session.loaded}
          extras={session.extras}
          turn={turn}
          condensedUpto={chat?.condensed_upto ?? null}
          className="min-h-[50%] [@media(min-height:800px)]:min-h-[60%]"
          ctx={ctx}
          onDismissTurn={() => store.getState().dismissTurn(chatId)}
        />
      ) : (
        <div className="flex-1" />
      )}

      <div className="max-h-[42%] shrink-0 overflow-y-auto px-5 pb-3 pt-1">
        {!empty && (
          <ContextPanel
            report={report}
            subject={subject}
            estimating={session.previewing}
            failed={session.previewFailed}
            workspaceId={workspaceId}
            chatId={chatId}
            excluded={session.excluded}
            itemPrefs={session.itemPrefs}
            openers={openers}
          />
        )}
        <Composer
          workspaceId={workspaceId}
          chat={chat}
          session={session}
          draft={view.draft}
          onDraft={view.setDraft}
          onSend={(t) => void sendText(t)}
          onStop={() => chatId && void store.getState().stop(chatId)}
          writing={writing}
          stopping={!!stopping}
          waitingForOther={waitingForOther}
          meetingActive={meetingActive}
          hasLibrary={hasLibrary}
          selection={selection}
          onPickModel={(c) => void pickModel(c)}
          onEffort={(effort) => void patch({ effort })}
          onDepth={(depth) => void patch({ depth })}
          ensureChat={ensureChat}
          onOpenSettings={openProviderSettings}
          autoFocusKey={chatId ?? `new:${workspaceId}`}
          compact={!empty}
          showEstimate={wide}
          capabilities={session.capabilities}
        />
      </div>

      {empty && (
        <div className="min-h-0 flex-[3] px-5">
          <ExampleQuestions
            questions={examples}
            onPick={(q) => {
              view.setDraft(q);
              document.querySelector<HTMLElement>("[data-chat-composer]")?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
