import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { Select, Switch, Button, IconButton } from "../ui";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { MemoryKind } from "../lib/types";
import { cn } from "../lib/utils";
import { fieldClass, hintClass } from "../workspace/styles";
import { onMemoryChanged } from "../lib/events";
import { MEMORY_KINDS, UNSUPPORTED_TEXT, groupSaved, useMemoryStore, type MemoryRow } from "./memoryStore";
import { ModelField, describeModel } from "../models/ModelField";
import { useAutomaticModel } from "../models/useAutomaticModel";
import { useMemoryModel } from "./useMemoryModel";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const kindName = (k: MemoryKind) => MEMORY_KINDS.find((x) => x.kind === k)?.singular ?? k;

interface Draft {
  kind: MemoryKind;
  title: string;
  text: string;
}

/** Kind, title and text: used to add, to edit, and to edit a suggestion before saving it. */
function MemoryForm({
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: Draft;
  saveLabel: string;
  onSave: (d: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = useRef<HTMLInputElement | null>(null);
  useEffect(() => title.current?.focus(), []);
  const invalid = !d.title.trim() || !d.text.trim();

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(d);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Select
        label="Kind"
        value={d.kind}
        onChange={(v) => setD({ ...d, kind: v as MemoryKind })}
        options={MEMORY_KINDS.map((k) => ({ value: k.kind, label: k.singular }))}
      />
      <input
        ref={title}
        value={d.title}
        onChange={(e) => setD({ ...d, title: e.target.value })}
        maxLength={80}
        aria-label="Title"
        placeholder="A short name, like Priya Shah or Budget cap"
        className={fieldClass}
      />
      <textarea
        value={d.text}
        onChange={(e) => setD({ ...d, text: e.target.value })}
        rows={3}
        aria-label="What to remember"
        placeholder="What to remember"
        className={`${fieldClass} resize-y`}
      />
      {error && (
        <p role="alert" className="ui-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button  onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit"  disabled={invalid || busy}>
          {busy ? "Saving" : saveLabel}
        </Button>
      </div>
    </form>
  );
}

function SourceLink({ item }: { item: MemoryRow }) {
  const meetings = useMeetingStore((s) => s.recentMeetings);
  if (!item.source_meeting) return null;
  const title = meetings.find((m) => m.id === item.source_meeting)?.title ?? "the meeting";
  const at = item.source_ms != null ? ` at ${formatClock(item.source_ms)}` : "";
  return (
    <button
      type="button"
      onClick={() => useMeetingStore.getState().openMeetingAt(item.source_meeting!, item.source_ms)}
      className="ui-meta rounded text-left text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
    >
      From {title}
      {at}
    </button>
  );
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** One remembered fact, set like an index entry: the name in weight, the fact under it. */
function SavedRow({ item }: { item: MemoryRow }) {
  const edit = useMemoryStore((s) => s.edit);
  const forget = useMemoryStore((s) => s.forget);
  const [mode, setMode] = useState<"read" | "edit" | "forget">("read");

  if (mode === "edit") {
    return (
      <li>
        <MemoryForm
          initial={{ kind: item.kind, title: item.title, text: item.text }}
          saveLabel="Save"
          onSave={async (d) => {
            await edit(item, d);
            setMode("read");
          }}
          onCancel={() => setMode("read")}
        />
      </li>
    );
  }
  return (
    <li className="group py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="ui-body min-w-0 font-medium text-foreground">{item.title}</p>
        <span className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {mode === "forget" ? (
            <>
              <span className="ui-meta text-destructive">Forget it?</span>
              <button
                type="button"
                className="ui-meta rounded px-1 font-semibold text-destructive underline underline-offset-2"
                onClick={() => void forget(item).catch((e) => showToast(`Couldn't forget it: ${messageOf(e)}`, "error"))}
              >
                Forget
              </button>
              <button type="button" className="ui-meta rounded px-1 text-muted-foreground underline underline-offset-2" onClick={() => setMode("read")}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ui-meta rounded px-1 text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-label={`Edit ${item.title}`} onClick={() => setMode("edit")}>
                Edit
              </button>
              <button type="button" className="ui-meta rounded px-1 text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-label={`Forget ${item.title}`} onClick={() => setMode("forget")}>
                Forget
              </button>
            </>
          )}
        </span>
      </div>
      <p className="ui-body text-muted-foreground">{item.text}</p>
      <SourceLink item={item} />
    </li>
  );
}

/** A proposed fact: read it, mark it reviewed, edit then save, save, or dismiss. */
function SuggestionRow({ item, reviewed, onReviewed }: { item: MemoryRow; reviewed: boolean; onReviewed: (on: boolean) => void }) {
  const resolve = useMemoryStore((s) => s.resolve);
  const [editing, setEditing] = useState(false);
  const fail = (what: string) => (e: unknown) => showToast(`Couldn't ${what}: ${messageOf(e)}`, "error");

  if (editing) {
    return (
      <li>
        <MemoryForm
          initial={{ kind: item.kind, title: item.title, text: item.text }}
          saveLabel="Save"
          onSave={async (d) => {
            await resolve(item, "save", d);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li className="py-2">
      <p className="ui-meta text-muted-foreground">{kindName(item.kind)}</p>
      <p className="ui-body font-medium text-foreground">{item.title}</p>
      <p className="ui-body text-muted-foreground">{item.text}</p>
      {item.unsupported && (
        <p className="ui-meta mt-0.5 font-medium text-warning" role="note">
          {UNSUPPORTED_TEXT}
        </p>
      )}
      <SourceLink item={item} />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <label className="ui-meta flex cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={reviewed} onChange={(e) => onReviewed(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" aria-label={`Reviewed: ${item.title}`} />
          Reviewed
        </label>
        <span className="flex gap-1">
          <Button size="sm"  onClick={() => void resolve(item, "dismiss").catch(fail("dismiss it"))}>
            Dismiss
          </Button>
          <Button size="sm"
            
            onClick={() => {
              onReviewed(true);
              setEditing(true);
            }}>
            Edit
          </Button>
          <Button variant="primary" size="sm"  onClick={() => void resolve(item, "save").catch(fail("save it"))}>
            Save
          </Button>
        </span>
      </div>
    </li>
  );
}

/**
 * What the AI should remember about this workspace, kept as an index of facts
 * grouped by kind. After a meeting it can propose items; nothing is kept until
 * the person saves it. "Forget" really deletes.
 */
export function MemorySection({ workspaceId }: { workspaceId: string }) {
  const items = useMemoryStore((s) => s.byWorkspace[workspaceId]);
  const loadError = useMemoryStore((s) => s.loadError[workspaceId]);
  const suggest = useMemoryStore((s) => s.suggest[workspaceId]);
  const load = useMemoryStore((s) => s.load);
  const add = useMemoryStore((s) => s.add);
  const resolve = useMemoryStore((s) => s.resolve);
  const clearSuggest = useMemoryStore((s) => s.clearSuggest);
  const meetings = useMeetingStore((s) => s.recentMeetings);
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const update = useWorkspaceStore((s) => s.update);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void load(workspaceId);
    // Changes from either window, and the suggestions made after a meeting, reload the list.
    let stop: (() => void) | undefined;
    let gone = false;
    onMemoryChanged((e) => {
      if (e.workspace_id === workspaceId) void load(workspaceId);
    })
      .then((fn) => (gone ? fn() : (stop = fn)))
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId, load]);
  useEffect(() => {
    setQuery("");
    setAdding(false);
    setReviewed(new Set());
  }, [workspaceId]);

  const all = items ?? [];
  const suggested = all.filter((m) => m.status === "suggested");
  const groups = useMemo(() => groupSaved(all, query), [all, query]);
  const savedCount = all.filter((m) => m.status === "saved").length;
  const fromMeeting = suggested[0]?.source_meeting ? meetings.find((m) => m.id === suggested[0].source_meeting)?.title : undefined;
  const memoryModel = useMemoryModel();
  // Automatic means what the backend says it means right now ("Claude Haiku (cheapest)"), not a guess.
  const automatic = useAutomaticModel(memoryModel.value.provider).model;
  const modelName = describeModel(memoryModel.value, automatic);
  const reviewedItems = suggested.filter((m) => reviewed.has(m.id));

  const saveReviewed = async () => {
    for (const m of reviewedItems) {
      try {
        await resolve(m, "save");
      } catch (e) {
        showToast(`Couldn't save ${m.title}: ${messageOf(e)}`, "error");
        break;
      }
    }
  };

  return (
    <section aria-label="Memory" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="ui-section text-foreground">
          Memory <span className="ui-meta font-normal tabular-nums text-muted-foreground">{savedCount || ""}</span>
        </h3>
        <IconButton onClick={() => setAdding(true)}  aria-label="Add to memory">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>

      {suggest?.status === "running" && (
        <p role="status" className="ui-body flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Reading the meeting for things worth remembering
        </p>
      )}
      {suggest?.status === "failed" && (
        <div role="alert" className="ui-body text-destructive">
          <p>Couldn't get suggestions: {suggest.error}</p>
          <p className={`${hintClass} text-muted-foreground`}>Check the AI model in Settings, then try again from the meeting.</p>
          <button type="button" className="ui-meta mt-1 rounded underline underline-offset-2" onClick={() => clearSuggest(workspaceId)}>
            Dismiss
          </button>
        </div>
      )}
      {suggest?.status === "none" && suggested.length === 0 && (
        <p role="status" className="ui-body text-muted-foreground">
          Nothing new to remember was found in that meeting.{" "}
          <button type="button" className="ui-meta rounded underline underline-offset-2" onClick={() => clearSuggest(workspaceId)}>
            Dismiss
          </button>
        </p>
      )}

      {suggested.length > 0 && (
        <div className="rounded-lg border border-border px-3 py-1" role="group" aria-label="Suggestions">
          <div className="flex items-center justify-between gap-2 pt-1.5">
            <p className="ui-section text-foreground">
              {suggested.length} {suggested.length === 1 ? "suggestion" : "suggestions"}
              {fromMeeting ? ` from ${fromMeeting}` : ""}
            </p>
            <button
              type="button"
              disabled={reviewedItems.length === 0}
              onClick={() => void saveReviewed()}
              className="ui-meta rounded font-semibold underline underline-offset-2 outline-none ui-focus ui-focus-sm disabled:no-underline disabled:opacity-50"
            >
              Save all reviewed{reviewedItems.length ? ` (${reviewedItems.length})` : ""}
            </button>
          </div>
          <ul className="divide-y divide-border">
            {suggested.map((m) => (
              <SuggestionRow
                key={m.id}
                item={m}
                reviewed={reviewed.has(m.id)}
                onReviewed={(on) =>
                  setReviewed((cur) => {
                    const next = new Set(cur);
                    if (on) next.add(m.id);
                    else next.delete(m.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <MemoryForm
          initial={{ kind: "fact", title: "", text: "" }}
          saveLabel="Add"
          onSave={async (d) => {
            await add(workspaceId, d);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {loadError && (
        <p role="alert" className="ui-meta text-destructive">
          Couldn't load memory: {loadError}
        </p>
      )}

      {savedCount > 4 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memory" placeholder="Search memory" className={cn(fieldClass, "h-8 pl-8")} />
        </div>
      )}

      {groups.map((g) => (
        <div key={g.kind}>
          <h4 className="ui-meta mb-0.5 font-semibold text-foreground">{g.plural}</h4>
          <ul className="divide-y divide-border/60">
            {g.items.map((m) => (
              <SavedRow key={m.id} item={m} />
            ))}
          </ul>
        </div>
      ))}
      {savedCount === 0 && suggested.length === 0 && !adding && !suggest && (
        <p className="ui-body text-muted-foreground">Nothing remembered yet. Facts you save here are used in this workspace's answers, and nowhere else.</p>
      )}
      {savedCount > 0 && groups.length === 0 && <p className="ui-body text-muted-foreground">Nothing in memory matches that.</p>}

      <div className="pt-1">
        <Switch
          checked={!!detail?.suggest_memory}
          onChange={(on) => void update(workspaceId, { suggest_memory: on }).catch((e) => showToast(`Couldn't change it: ${messageOf(e)}`, "error"))}
          label="Suggest after meetings"
          description={`After a meeting here, its transcript goes to ${modelName} in up to 4 calls (a very long meeting keeps its start and end). It proposes up to 8 items. Nothing is kept until you save it.`}
        />
        <div className="mt-2 max-w-sm">
          <ModelField label="Model for memory suggestions" value={memoryModel.value} onChange={(v) => void memoryModel.change(v)} />
          {memoryModel.error && <p className="ui-meta mt-1 text-muted-foreground" role="alert">{memoryModel.error}</p>}
        </div>
      </div>
    </section>
  );
}
