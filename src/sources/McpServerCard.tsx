import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2, Pencil, Wrench, X } from "lucide-react";
import type { McpServer } from "../lib/types";
import { SourceSwitch } from "./SourceSwitch";

interface McpServerCardProps {
  server: McpServer;
  checking: boolean;
  onToggle: (enabled: boolean) => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToolToggle: (toolName: string, allowed: boolean) => void;
  /** Open the tool list (a new server's first successful Check). */
  autoOpen?: boolean;
}

export const NEEDS_SIGN_IN_TEXT = "Needs sign-in, not supported yet";

/** `node s.js` or the URL. */
function summaryOf(server: McpServer): string {
  const t = server.transport;
  return t.type === "stdio" ? [t.command, ...t.args].join(" ") : t.url;
}

function statusOf(server: McpServer, checking: boolean): { text: string; tone: "ok" | "bad" | "quiet" } {
  if (checking) return { text: "Checking…", tone: "quiet" };
  if (server.needs_sign_in) return { text: NEEDS_SIGN_IN_TEXT, tone: "bad" };
  const c = server.last_check;
  if (!c) return { text: server.enabled ? "Not checked" : "Not checked yet. Check it to switch it on", tone: "quiet" };
  if (c.ok) return { text: `Ready with ${c.tool_count} ${c.tool_count === 1 ? "tool" : "tools"}`, tone: "ok" };
  return { text: `Failed: ${c.error ?? "the server did not start"}`, tone: "bad" };
}

export function McpServerCard({ server, checking, onToggle, onCheck, onEdit, onRemove, onToolToggle, autoOpen = false }: McpServerCardProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  const statusId = useId();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = statusOf(server, checking);
  const ready = !!server.last_check?.ok && !server.needs_sign_in;
  // Off until a Check works; one that is on can always be switched off.
  const cantEnable = !server.enabled && !ready;
  const allowed = server.tools.filter((t) => t.allowed).length;
  const toolsId = `mcp-tools-${server.id}`;

  return (
    <div
      className={`rounded-xl border bg-secondary/20 p-3 transition-colors hover:bg-secondary/30 ${
        status.tone === "bad" ? "border-destructive/30" : "border-border/40"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Wrench className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{server.label}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={summaryOf(server)}>
            {summaryOf(server)}
          </div>
          <div
            id={statusId}
            role="status"
            className={`mt-1 flex items-center gap-1.5 text-xs ${
              status.tone === "ok" ? "text-success" : status.tone === "bad" ? "text-destructive" : "text-muted-foreground/80"
            }`}
          >
            {checking && <Loader2 className="h-3 w-3 animate-spin" />}
            <span>{status.text}</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 pt-0.5">
          <SourceSwitch
            checked={server.enabled}
            disabled={cantEnable}
            onChange={onToggle}
            describedBy={statusId}
            label={`Use ${server.label}`}
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-11">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || server.needs_sign_in}
          className="cursor-pointer rounded-md border border-border/50 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Check
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${server.label}`}
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmRemove) onRemove();
            else {
              setConfirmRemove(true);
              setTimeout(() => setConfirmRemove(false), 3000);
            }
          }}
          aria-label={confirmRemove ? `Confirm removing ${server.label}` : `Remove ${server.label}`}
          className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
            confirmRemove ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          }`}
        >
          {confirmRemove ? "Remove?" : <><X className="h-3 w-3" />Remove</>}
        </button>
        {server.tools.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={toolsId}
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <span>
              {allowed} of {server.tools.length} tools allowed
            </span>
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {open && server.tools.length > 0 && (
        <ul id={toolsId} className="mt-2 space-y-1 pl-11">
          {server.tools.map((t) => (
            <li key={t.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-accent/20">
              <span className="truncate font-mono text-xs text-foreground/90">{t.name}</span>
              <SourceSwitch checked={t.allowed} onChange={(next) => onToolToggle(t.name, next)} label={`Allow ${t.name}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
