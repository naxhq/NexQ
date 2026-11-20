import { Fragment, useEffect, useId } from "react";
import { AlertCircle, AlertTriangle, BookOpen, Loader2, RotateCcw, Wrench } from "lucide-react";
import { findSourcesSession, pillState, type PillState } from "../lib/sourcePills";
import { retrySourcesSession } from "../lib/ipc";
import { useAgentStore } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { enabledKinds, useSourcesStore } from "../stores/sourcesStore";
import { showToast } from "../stores/toastStore";

interface SourcePillsProps {
  /** `live`: the overlay's Fast with-sources session. `past`: that meeting's Deep one. */
  scope: "live" | "past";
  meetingId?: string | null;
}

const ON_STYLE = {
  notes: "bg-highlight/20 text-highlight ring-1 ring-highlight/30 shadow-sm shadow-highlight/10",
  tools: "bg-primary/20 text-primary ring-1 ring-primary/30 shadow-sm shadow-primary/10",
} as const;

const PILL_BASE =
  "flex items-center gap-1 min-h-6 rounded-lg px-2 py-1 text-meta font-medium transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function styleOf(kind: "notes" | "tools", state: PillState): string {
  switch (state) {
    case "on":
    case "loading":
      return ON_STYLE[kind];
    case "error":
      return "bg-destructive/10 text-destructive ring-1 ring-destructive/25";
    default:
      return "bg-transparent text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground";
  }
}

/**
 * The Notes and Tools pills: which sources the next answer you ask for may
 * use. Shown only for a kind that is set up, and only on the Claude subscription.
 */
export function SourcePills({ scope, meetingId = null }: SourcePillsProps) {
  const provider = useConfigStore((s) => s.llmProvider);
  const config = useSourcesStore((s) => s.config);
  const toggles = useSourcesStore((s) => s.toggles);
  const setToggles = useSourcesStore((s) => s.setToggles);
  const sessions = useAgentStore((s) => s.sessions);
  const baseId = useId();

  useEffect(() => {
    useAgentStore.getState().init();
  }, []);

  const kinds = enabledKinds(config);
  const session = findSourcesSession(sessions, scope, meetingId);
  const states = {
    notes: pillState("notes", { provider, enabled: kinds.notes, on: toggles.notes, session }),
    tools: pillState("tools", { provider, enabled: kinds.tools, on: toggles.tools, session }),
  };
  const shown = (["notes", "tools"] as const).filter((k) => states[k] !== "hidden");
  if (shown.length === 0) return null;

  const detail = session?.detail ?? null;
  const notice = session?.state === "ready" || session?.state === "busy" ? session.sources_notice : null;
  const failing = shown.some((k) => states[k] === "error");

  const behind = {
    notes: config.notes_folders.filter((f) => f.enabled).map((f) => f.label),
    tools: config.mcp_servers
      .filter((s) => s.enabled && !s.needs_sign_in && s.tools.some((t) => t.allowed))
      .map((s) => s.label),
  };
  const tooltip = (kind: "notes" | "tools") => {
    const base = `${kind === "notes" ? "Notes" : "Tools"}: ${behind[kind].join(", ")}`;
    if (states[kind] === "error" && detail) return `${base}. ${detail}`;
    if (notice) return `${base}. ${notice}`;
    return base;
  };

  const retry = () => {
    retrySourcesSession().catch((e) => showToast(e instanceof Error ? e.message : String(e), "error"));
  };

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Personal sources for your next answer">
      {shown.map((kind) => {
        const state = states[kind];
        const label = kind === "notes" ? "Notes" : "Tools";
        const Icon = kind === "notes" ? BookOpen : Wrench;
        return (
          <Fragment key={kind}>
          <button
            type="button"
            role="switch"
            aria-checked={toggles[kind]}
            title={tooltip(kind)}
            aria-describedby={`${baseId}-${kind}`}
            onClick={() => setToggles((t) => ({ ...t, [kind]: !t[kind] }))}
            className={`${PILL_BASE} ${styleOf(kind, state)}`}
          >
            {state === "loading" ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : state === "error" ? (
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Icon className="h-3 w-3" aria-hidden="true" />
            )}
            <span>{label}</span>
            {notice && state !== "error" && <AlertTriangle className="h-3 w-3 text-warning" aria-hidden="true" />}
          </button>
          <span id={`${baseId}-${kind}`} className="sr-only">
            {tooltip(kind)}
          </span>
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
