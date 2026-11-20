import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { ClaudeCodeMcpServer, FormPair, McpServer, McpServerForm } from "../lib/types";
import {
  checkMcpServer,
  classifySecretNames,
  discardPendingMcpServers,
  importClaudeCodeMcpServers,
  importMcpServersJson,
  listClaudeCodeMcpServers,
  saveMcpServerForm,
} from "../lib/ipc";
import { SourcesModal } from "./SourcesModal";
import { addMcpServers, errorText, replaceMcpServer } from "./sourcesActions";
import { NEEDS_SIGN_IN_TEXT } from "./McpServerCard";

type Tab = "json" | "form" | "claude";

interface AddMcpServerDialogProps {
  onClose: () => void;
  /** Called after servers were added or an edit was saved. */
  onAdded?: (servers: McpServer[]) => void;
  /** Edit this server (the form only). */
  editing?: McpServer;
}

/** The backend's wording when an edit needs its secrets typed again. */
const SECRETS_AGAIN = /^Enter the secrets again/i;

const inputClass =
  "w-full rounded-lg border border-border/50 bg-background/50 px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/30";
const labelClass = "mb-1 block text-xs font-medium text-foreground";

/** The form of an existing server, with its secrets blank (they are not kept here). */
function formOf(s: McpServer): { form: McpServerForm } {
  return {
    form: {
      id: s.id,
      key: s.key,
      label: s.label,
      transport: s.transport,
      env: s.env.map((e) => ({ name: e.name, value: e.secret ? "" : (e.value ?? "") })),
      headers: s.transport.type === "http" ? s.transport.header_names.map((name) => ({ name, value: "" })) : [],
    },
  };
}

export function AddMcpServerDialog({ onClose, onAdded, editing }: AddMcpServerDialogProps) {
  const [tab, setTab] = useState<Tab>("json");
  const edit = editing ? formOf(editing).form : null;

  // ── Paste JSON ──
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // ── Form ──
  const [label, setLabel] = useState(edit?.label ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(edit?.transport.type ?? "stdio");
  const [command, setCommand] = useState(edit?.transport.type === "stdio" ? edit.transport.command : "");
  const [argsText, setArgsText] = useState(edit?.transport.type === "stdio" ? edit.transport.args.join("\n") : "");
  const [url, setUrl] = useState(edit?.transport.type === "http" ? edit.transport.url : "");
  const [env, setEnv] = useState<FormPair[]>(edit?.env ?? []);
  const [headers, setHeaders] = useState<FormPair[]>(edit?.headers ?? []);
  const [formError, setFormError] = useState<string | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Claude Code import ──
  const [ccServers, setCcServers] = useState<ClaudeCodeMcpServer[] | null>(null);
  const [ccError, setCcError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState<"json" | "form" | "check" | "claude" | null>(null);

  useEffect(() => {
    if (tab !== "claude" || ccServers || ccError) return;
    listClaudeCodeMcpServers()
      .then(setCcServers)
      .catch((e) => setCcError(errorText(e)));
  }, [tab, ccServers, ccError]);

  const tabs: Array<{ id: Tab; label: string }> = editing
    ? [{ id: "form", label: "Settings" }]
    : [
        { id: "json", label: "Paste JSON" },
        { id: "form", label: "Form" },
        { id: "claude", label: "Import from Claude Code" },
      ];
  const activeTab: Tab = editing ? "form" : tab;

  // Which variable names hold a secret is the backend's call. A name it hasn't
  // answered for yet is hidden like a secret until it has.
  const [secretFlags, setSecretFlags] = useState<Record<string, boolean>>({});
  const envNames = env.map((p) => p.name.trim()).filter(Boolean);
  const envNamesKey = envNames.join("|");
  useEffect(() => {
    const unknown = envNames.filter((n) => !(n in secretFlags));
    if (unknown.length === 0) return;
    classifySecretNames(unknown)
      .then((flags) =>
        setSecretFlags((prev) => ({ ...prev, ...Object.fromEntries(unknown.map((n, i) => [n, flags[i] === true])) })),
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envNamesKey]);

  const finish = async (servers: McpServer[], replace = false) => {
    try {
      if (replace) for (const s of servers) await replaceMcpServer(s);
      else await addMcpServers(servers);
    } catch (e) {
      // Not saved: the backend must not keep their keys.
      if (!replace) void discardPendingMcpServers(servers.map((s) => s.id)).catch(() => {});
      throw e;
    }
    onAdded?.(servers);
    onClose();
  };

  const submitJson = async () => {
    setBusy("json");
    setJsonError(null);
    try {
      const servers = await importMcpServersJson(json);
      await finish(servers);
    } catch (e) {
      setJsonError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const buildForm = (): McpServerForm => ({
    id: edit?.id ?? null,
    key: edit?.key ?? null,
    label: label.trim(),
    transport:
      kind === "stdio"
        ? { type: "stdio", command: command.trim(), args: argsText.split(/\r?\n/).map((a) => a.trim()).filter(Boolean) }
        : { type: "http", url: url.trim(), header_names: headers.map((h) => h.name.trim()).filter(Boolean) },
    env: env.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), value: p.value })),
    headers: kind === "http" ? headers.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), value: p.value })) : [],
  });

  const formReady = label.trim() !== "" && (kind === "stdio" ? command.trim() !== "" : url.trim() !== "");

  const submitForm = async () => {
    setBusy("form");
    setFormError(null);
    setSecretsError(null);
    try {
      const saved = await saveMcpServerForm(buildForm());
      await finish([saved], !!editing);
    } catch (e) {
      const text = errorText(e);
      if (SECRETS_AGAIN.test(text)) setSecretsError(text);
      else setFormError(text);
    } finally {
      setBusy(null);
    }
  };

  const checkForm = async () => {
    setBusy("check");
    setCheckResult(null);
    try {
      const result = await checkMcpServer(edit?.id ?? null, buildForm());
      const c = result.last_check;
      setCheckResult(
        c?.ok
          ? { ok: true, text: `Ready with ${c.tool_count} ${c.tool_count === 1 ? "tool" : "tools"}` }
          : { ok: false, text: `Failed: ${c?.error ?? "the server did not start"}` },
      );
    } catch (e) {
      setCheckResult({ ok: false, text: `Failed: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const submitClaude = async () => {
    setBusy("claude");
    setCcError(null);
    try {
      const servers = await importClaudeCodeMcpServers([...picked]);
      await finish(servers);
    } catch (e) {
      setCcError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const primaryButton =
    "cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <SourcesModal title={editing ? `Edit ${editing.label}` : "Add a tool server"} onClose={onClose} wide>
      {!editing && (
        <div role="tablist" aria-label="How to add a server" className="mb-4 flex rounded-lg border border-border/50 bg-secondary/30 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                tab === t.id ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {activeTab === "json" && (
        <div role="tabpanel" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Paste the <span className="font-mono">mcpServers</span> JSON from the server's README. You can paste more than one server.
          </p>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            aria-label="Server JSON"
            rows={9}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "notes": { "command": "node", "args": ["server.js"] }\n  }\n}'}
            className={`${inputClass} resize-none font-mono`}
          />
          {jsonError && (
            <p role="alert" className="text-xs text-destructive">
              {jsonError}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={submitJson} disabled={!json.trim() || busy === "json"} className={primaryButton}>
              {busy === "json" ? "Adding…" : "Add servers"}
            </button>
          </div>
        </div>
      )}

      {activeTab === "form" && (
        <div role="tabpanel" className="space-y-3">
          <div>
            <label htmlFor="mcp-form-label" className={labelClass}>
              Name
            </label>
            <input id="mcp-form-label" value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} placeholder="Mira" />
          </div>

          <div className="flex rounded-lg border border-border/50 bg-secondary/30 p-0.5" role="radiogroup" aria-label="Server type">
            {(["stdio", "http"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                disabled={!!editing && editing.transport.type !== k}
                onClick={() => setKind(k)}
                className={`flex-1 cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  kind === k ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {k === "stdio" ? "Command" : "URL"}
              </button>
            ))}
          </div>

          {kind === "stdio" ? (
            <>
              <div>
                <label htmlFor="mcp-form-command" className={labelClass}>
                  Command
                </label>
                <input id="mcp-form-command" value={command} onChange={(e) => setCommand(e.target.value)} className={`${inputClass} font-mono`} placeholder="node" />
              </div>
              <div>
                <label htmlFor="mcp-form-args" className={labelClass}>
                  Arguments, one per line
                </label>
                <textarea
                  id="mcp-form-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  className={`${inputClass} resize-none font-mono`}
                  placeholder={"server.js\n--read-only"}
                />
              </div>
            </>
          ) : (
            <div>
              <label htmlFor="mcp-form-url" className={labelClass}>
                URL
              </label>
              <input id="mcp-form-url" value={url} onChange={(e) => setUrl(e.target.value)} className={`${inputClass} font-mono`} placeholder="https://example.com/mcp" />
            </div>
          )}

          <PairList
            title={kind === "http" ? "Headers" : "Environment variables"}
            addLabel={kind === "http" ? "Add header" : "Add variable"}
            pairs={kind === "http" ? headers : env}
            onChange={kind === "http" ? setHeaders : setEnv}
            isSecret={(name) => kind === "http" || (name.trim() !== "" && secretFlags[name.trim()] !== false)}
            keepHint={!!editing}
            invalidSecrets={!!secretsError}
          />

          {secretsError && (
            <p role="alert" className="text-xs text-destructive">
              {secretsError}
            </p>
          )}
          {formError && (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          )}
          {/* Always in the page, so a screen reader announces what lands in it. */}
          <p
            role="status"
            className={checkResult ? `text-xs ${checkResult.ok ? "text-success" : "text-destructive"}` : "sr-only"}
          >
            {checkResult?.text}
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={checkForm}
              disabled={!formReady || busy !== null}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "check" && <Loader2 className="h-3 w-3 animate-spin" />}
              Check these settings
            </button>
            <button type="button" onClick={submitForm} disabled={!formReady || busy !== null} className={primaryButton}>
              {busy === "form" ? "Saving…" : editing ? "Save" : "Add server"}
            </button>
          </div>
        </div>
      )}

      {activeTab === "claude" && (
        <div role="tabpanel" className="space-y-3">
          <p className="text-xs text-muted-foreground">Pick the servers from your Claude Code setup to copy into NexQ.</p>
          {!ccServers && !ccError && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Looking…
            </div>
          )}
          {ccServers && ccServers.length === 0 && <p className="text-xs text-muted-foreground">No servers found in Claude Code.</p>}
          {ccServers && ccServers.length > 0 && (
            <ul className="space-y-1.5">
              {ccServers.map((s) => {
                const blocked = s.unsupported !== null;
                const note = s.unsupported ?? (s.needs_sign_in ? NEEDS_SIGN_IN_TEXT : null);
                return (
                  <li key={s.name}>
                    <label
                      className={`flex items-start gap-2.5 rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 ${
                        blocked ? "opacity-60" : "cursor-pointer hover:bg-secondary/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={blocked}
                        checked={picked.has(s.name)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(s.name);
                          else next.delete(s.name);
                          setPicked(next);
                        }}
                        aria-label={s.name}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">{s.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{s.summary}</span>
                        {note && <span className="mt-0.5 block text-xs text-destructive">{note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {ccError && (
            <p role="alert" className="text-xs text-destructive">
              {ccError}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={submitClaude} disabled={picked.size === 0 || busy === "claude"} className={primaryButton}>
              {busy === "claude" ? "Importing…" : "Import selected"}
            </button>
          </div>
        </div>
      )}
    </SourcesModal>
  );
}

interface PairListProps {
  title: string;
  addLabel: string;
  pairs: FormPair[];
  onChange: (pairs: FormPair[]) => void;
  isSecret: (name: string) => boolean;
  /** Editing: a blank secret keeps its saved value. */
  keepHint: boolean;
  /** The backend asked for the secrets again: mark the blank ones. */
  invalidSecrets: boolean;
}

function PairList({ title, addLabel, pairs, onChange, isSecret, keepHint, invalidSecrets }: PairListProps) {
  const set = (i: number, patch: Partial<FormPair>) => onChange(pairs.map((p, at) => (at === i ? { ...p, ...patch } : p)));
  return (
    <fieldset>
      <legend className={labelClass}>{title}</legend>
      <div className="space-y-1.5">
        {pairs.map((p, i) => {
          const secret = isSecret(p.name);
          const missing = invalidSecrets && secret && p.value === "";
          return (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={p.name}
                onChange={(e) => set(i, { name: e.target.value })}
                aria-label={`${title} name ${i + 1}`}
                placeholder="NAME"
                className={`${inputClass} w-2/5 font-mono`}
              />
              <input
                value={p.value}
                onChange={(e) => set(i, { value: e.target.value })}
                type={secret ? "password" : "text"}
                autoComplete="off"
                aria-label={`${title} value ${i + 1}`}
                aria-invalid={missing || undefined}
                placeholder={secret ? (keepHint ? "Saved. Leave blank to keep it" : "Kept in Windows Credential Manager") : "value"}
                className={`${inputClass} flex-1 font-mono ${missing ? "border-destructive/60" : ""}`}
              />
              <button
                type="button"
                onClick={() => onChange(pairs.filter((_, at) => at !== i))}
                aria-label={`Remove ${title.toLowerCase()} ${i + 1}`}
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onChange([...pairs, { name: "", value: "" }])}
        className="mt-1.5 flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        {addLabel}
      </button>
    </fieldset>
  );
}
