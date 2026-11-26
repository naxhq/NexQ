import { Fragment, useEffect } from "react";
import { AlertCircle, AlertTriangle, BookOpen, Loader2, Lock, RotateCcw, Wrench } from "lucide-react";
import {
  findSourcesSession,
  holdsKnowledge,
  holdsTools,
  pillCard,
  pillState,
  type PillKind,
  type PillState,
} from "../lib/sourcePills";
import { retrySourcesSession } from "../lib/ipc";
import { onWorkspacesChanged } from "../lib/events";
import { useAgentStore } from "../stores/agentStore";
import { LIVE_KEY, meetingKeyOf, pillsOf, useAssistSourcesStore } from "../stores/assistSourcesStore";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSourcesStore } from "../stores/sourcesStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { showToast } from "../stores/toastStore";
import { Tooltip } from "../ui";
import { CHIP_BASE, CHIP_OFF } from "../overlay/chipStyles";

interface SourcePillsProps {
  /** `live`: the overlay's Fast with-sources session. `past`: that meeting's Deep one. */
  scope: "live" | "past";
  meetingId?: string | null;
}

const ON_STYLE = {
  knowledge: "bg-highlight/20 text-highlight ring-1 ring-highlight/30 shadow-sm shadow-highlight/10",
  tools: "bg-primary/20 text-primary ring-1 ring-primary/30 shadow-sm shadow-primary/10",
} as const;

const LABEL: Record<PillKind, string> = { knowledge: "Knowledge", tools: "Tools" };

function styleOf(kind: PillKind, state: PillState): string {
  switch (state) {
    case "on":
    case "loading":
      return ON_STYLE[kind];
    case "error":
      return "bg-destructive/10 text-destructive ring-1 ring-destructive/25";
    case "unavailable":
      return `${CHIP_OFF} cursor-not-allowed`;
    default:
      return CHIP_OFF;
  }
}

/**
 * The Knowledge and Tools pills: what your next answer may use of this meeting's workspace.
 * Knowledge is its Library (documents, notes, folders) and works with every provider; Tools are
 * its MCP servers and need a subscription CLI agent. Each shows only when the workspace holds
 * something of its kind, and a pill that is off is a lock: nothing of it goes into the answer.
 */
export function SourcePills({ scope, meetingId = null }: SourcePillsProps) {
  const provider = useConfigStore((s) => s.llmProvider);
  const config = useSourcesStore((s) => s.config);
  const resources = useContextStore((s) => s.resources);
  const activeId = useMeetingStore((s) => s.activeMeeting?.id ?? null);
  const key = scope === "past" ? meetingKeyOf(meetingId) : activeId ?? LIVE_KEY;
  const info = useAssistSourcesStore((s) => s.info[key]);
  const toggles = useAssistSourcesStore((s) => s.pills[key]) ?? pillsOf(key);
  const refresh = useAssistSourcesStore((s) => s.refresh);
  const setPill = useAssistSourcesStore((s) => s.setPill);
  const sessions = useAgentStore((s) => s.sessions);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === info?.workspace_id)?.name ?? null);

  useEffect(() => {
    useAgentStore.getState().init();
  }, []);

  // What the meeting's workspace holds: read when the pills appear and whenever the Library, the saved
  // sources, the loaded documents or the provider change.
  const askedFor = scope === "past" ? meetingId : activeId;
  useEffect(() => {
    void refresh(askedFor);
  }, [refresh, askedFor, config, resources, provider]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    onWorkspacesChanged(() => void refresh(askedFor))
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [refresh, askedFor]);

  const session = findSourcesSession(sessions, scope, scope === "past" ? meetingId : activeId);
  const held = { knowledge: holdsKnowledge(info), tools: holdsTools(info) };
  const on = { knowledge: toggles.library, tools: toggles.tools };
  const states = {
    knowledge: pillState("knowledge", { provider, held: held.knowledge, on: on.knowledge, session }),
    tools: pillState("tools", { provider, held: held.tools, on: on.tools, session }),
  };
  const shown = (["knowledge", "tools"] as const).filter((k) => states[k] !== "hidden");
  if (shown.length === 0 || !info) return null;

  const detail = session?.detail ?? null;
  const notice = session?.state === "ready" || session?.state === "busy" ? session.sources_notice : null;
  const failing = shown.some((k) => states[k] === "error");

  const spoken = (kind: PillKind) => {
    const card = pillCard(kind, info, provider);
    const base = `${card.title}${workspaceName ? ` in ${workspaceName}` : ""}: ${card.includes}`;
    if (states[kind] === "unavailable") return `${base}. ${card.limit ?? ""}`.trim();
    if (states[kind] === "error" && detail) return `${base}. ${detail}`;
    if (notice) return `${base}. ${notice}`;
    return base;
  };

  const retry = () => {
    retrySourcesSession().catch((e) => showToast(e instanceof Error ? e.message : String(e), "error"));
  };

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Knowledge and tools for your next answer">
      {shown.map((kind) => {
        const state = states[kind];
        const unavailable = state === "unavailable";
        const Icon = kind === "knowledge" ? BookOpen : Wrench;
        const card = pillCard(kind, info, provider);
        return (
          <Fragment key={kind}>
            <Tooltip
              delay={250}
              content={
                <PillCard
                  title={card.title}
                  workspace={workspaceName}
                  includes={card.includes}
                  on={card.on}
                  off={card.off}
                  limit={card.limit}
                  state={state}
                  detail={state === "error" ? detail : notice}
                />
              }
            >
              <button
                type="button"
                role="switch"
                data-chip=""
                aria-checked={unavailable ? false : on[kind]}
                aria-disabled={unavailable || undefined}
                aria-description={spoken(kind)}
                onClick={() => {
                  if (!unavailable) setPill(askedFor, kind === "knowledge" ? "library" : "tools", !on[kind]);
                }}
                className={`${CHIP_BASE} ${styleOf(kind, state)}`}
              >
                {state === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : state === "error" ? (
                  <AlertCircle className="h-3 w-3" aria-hidden="true" />
                ) : unavailable ? (
                  <Lock className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Icon className="h-3 w-3" aria-hidden="true" />
                )}
                <span>{LABEL[kind]}</span>
                {notice && state !== "error" && !unavailable && <AlertTriangle className="h-3 w-3 text-warning" aria-hidden="true" />}
              </button>
            </Tooltip>
          </Fragment>
        );
      })}
      {failing && (
        <>
          {detail && (
            <span className="max-w-[16rem] truncate text-meta text-destructive/90" title={detail}>
              {detail}
            </span>
          )}
          <button
            type="button"
            onClick={retry}
            className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-meta font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        </>
      )}
      {!failing && notice && (
        <span className="max-w-[16rem] truncate text-meta text-warning" title={notice}>
          {notice}
        </span>
      )}
    </div>
  );
}

/**
 * What a pill says on hover or keyboard focus: what it covers in this workspace, what on and off
 * do, and what this provider can't do. Read-only (it never takes the pointer), drawn inside the window.
 */
function PillCard({
  title,
  workspace,
  includes,
  on,
  off,
  limit,
  state,
  detail,
}: {
  title: string;
  workspace: string | null;
  includes: string;
  on: string;
  off: string;
  limit: string | null;
  state: PillState;
  detail: string | null;
}) {
  const unavailable = state === "unavailable";
  return (
    <div className="flex w-[15.5rem] flex-col gap-1.5 py-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.8125rem] font-semibold text-foreground">{title}</span>
        {workspace && <span className="min-w-0 truncate text-muted-foreground">{workspace}</span>}
      </div>
      <p className="text-foreground/90">{includes}</p>
      {!unavailable && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
          <dt className="font-medium text-foreground">On</dt>
          <dd>{on}</dd>
          <dt className="font-medium text-foreground">Off</dt>
          <dd>{off}</dd>
        </dl>
      )}
      {limit && (
        <p className="border-t border-border pt-1.5 text-muted-foreground">{limit}</p>
      )}
      {detail && <p className="border-t border-border pt-1.5 text-warning">{detail}</p>}
    </div>
  );
}
