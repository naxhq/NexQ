import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Brain, Loader2, MessageSquareQuote, Plus, User } from "lucide-react";
import { Select, Switch, Button, InfoTip, Dialog, ConfirmDialog, type MenuItemSpec } from "../ui";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { MemoryKind } from "../lib/types";
import { fieldClass, hintClass } from "../workspace/styles";
import { PanelAction, PanelSection } from "../workspace/PanelSection";
import { KindTile, PanelEmpty, PanelList, PanelRow, ShowAllDialog } from "../workspace/PanelRow";
import { cn } from "../lib/utils";
import { onMemoryChanged } from "../lib/events";
import { MEMORY_KINDS, UNSUPPORTED_TEXT, useMemoryStore, type MemoryRow } from "./memoryStore";
import { displayText, formatClock, memoryLook, oneLine, savedItems } from "./memoryDisplay";
import { ModelField, describeModel } from "../models/ModelField";
import { useAutomaticModel } from "../models/useAutomaticModel";
import { useMemoryModel } from "./useMemoryModel";
import { messageOf } from "../lib/plainError";

export { formatClock };

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
  titleRef,
}: {
  initial: Draft;
  saveLabel: string;
  onSave: (d: Draft) => Promise<void>;
  onCancel: () => void;
  /** Where focus starts (a dialog passes its own so the trap opens on the title). */
  titleRef?: MutableRefObject<HTMLInputElement | null>;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = useRef<HTMLInputElement | null>(null);
  const title = titleRef ?? own;
  useEffect(() => title.current?.focus(), [title]);
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
      className="space-y-2 py-1"
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
        rows={4}
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
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={invalid || busy}>
          {busy ? "Saving" : saveLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Where a remembered item came from. A suggestion made from a meeting says which one and the moment, and opens
 * the meeting there; something the person typed says "Added by you". Never the stored text, only the chip.
 */
export function Provenance({ item, onOpened, className }: { item: MemoryRow; onOpened?: () => void; className?: string }) {
  const meetings = useMeetingStore((s) => s.recentMeetings);
  const chip = "ui-meta inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground";
  if (!item.source_meeting) {
    return (
      <span className={cn(chip, className)}>
        <User className="h-3 w-3 shrink-0" aria-hidden="true" />
        Added by you
      </span>
    );
  }
  const meetingId = item.source_meeting;
  const title = meetings.find((m) => m.id === meetingId)?.title ?? "the meeting";
  const at = item.source_ms != null ? ` · ${formatClock(item.source_ms)}` : "";
  return (
    <button
      type="button"
      onClick={() => {
        useMeetingStore.getState().openMeetingAt(meetingId, item.source_ms);
        onOpened?.();
      }}
      className={cn(chip, "outline-none transition-colors hover:bg-accent hover:text-foreground ui-focus ui-focus-pill", className)}
    >
      <MessageSquareQuote className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        From {title}
        {at}
      </span>
    </button>
  );
}

/** One saved item opened: the whole text, where it came from, and Edit or Forget. Or the form, when it is being edited. */
function MemoryDialog({
  workspaceId,
  item,
  mode,
  onClose,
  onForget,
}: {
  workspaceId: string;
  item: MemoryRow | null;
  mode: "read" | "edit" | "add";
  onClose: () => void;
  onForget: (m: MemoryRow) => void;
}) {
  const edit = useMemoryStore((s) => s.edit);
  const add = useMemoryStore((s) => s.add);
  const [editing, setEditing] = useState(mode !== "read");
  const titleRef = useRef<HTMLInputElement | null>(null);

  if (mode === "add" || (editing && item)) {
    const adding = mode === "add";
    return (
      <Dialog open onClose={onClose} title={adding ? "Add to memory" : "Edit memory"} initialFocusRef={titleRef}>
        <MemoryForm
          titleRef={titleRef}
          initial={adding || !item ? { kind: "fact", title: "", text: "" } : { kind: item.kind, title: item.title, text: item.text }}
          saveLabel={adding ? "Add" : "Save"}
          onSave={async (d) => {
            if (adding) await add(workspaceId, d);
            else if (item) await edit(item, d);
            onClose();
          }}
          onCancel={onClose}
        />
      </Dialog>
    );
  }
  if (!item) return null;
  const look = memoryLook(item.kind);
  return (
    <Dialog
      open
      onClose={onClose}
      title={displayText(item.title)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onForget(item)}>
            Forget
          </Button>
          <Button variant="primary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className={cn("ui-meta flex items-center gap-1.5 font-medium", look.text)}>
          <KindTile look={look} />
          {look.word}
        </p>
        <p className="ui-body whitespace-pre-wrap text-foreground">{displayText(item.text)}</p>
        <Provenance item={item} onOpened={onClose} />
      </div>
    </Dialog>
  );
}

/** A proposed fact: read it, mark it reviewed, edit then save, save, or dismiss. */
function SuggestionRow({ item, reviewed, onReviewed }: { item: MemoryRow; reviewed: boolean; onReviewed: (on: boolean) => void }) {
  const resolve = useMemoryStore((s) => s.resolve);
  const [editing, setEditing] = useState(false);
  const fail = (what: string) => (e: unknown) => showToast(`Couldn't ${what}: ${messageOf(e)}`, "error");
  const look = memoryLook(item.kind);

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
      <div className="flex items-center gap-2">
        <KindTile look={look} />
        <p className="ui-body min-w-0 flex-1 truncate font-medium text-foreground">
          <span className="sr-only">{look.word}. </span>
          {displayText(item.title)}
        </p>
      </div>
      <div className="mt-0.5 pl-8">
        <p className="ui-body line-clamp-2 text-muted-foreground">{displayText(item.text)}</p>
        {item.unsupported && (
          <p className="ui-meta mt-0.5 font-medium text-warning" role="note">
            {UNSUPPORTED_TEXT}
          </p>
        )}
        <Provenance item={item} className="mt-1" />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 pl-8">
        <label className="ui-meta flex cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={reviewed} onChange={(e) => onReviewed(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" aria-label={`Reviewed: ${item.title}`} />
          Reviewed
        </label>
        <span className="flex gap-1">
          <Button size="sm" onClick={() => void resolve(item, "dismiss").catch(fail("dismiss it"))}>
            Dismiss
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onReviewed(true);
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button variant="primary" size="sm" onClick={() => void resolve(item, "save").catch(fail("save it"))}>
            Save
          </Button>
        </span>
      </div>
    </li>
  );
}

/** One saved item on the panel's shared row: its tag, its name, one line of its text, and a menu with Edit and Forget. */
function SavedRow({ item, onOpen, onEdit, onForget }: { item: MemoryRow; onOpen: () => void; onEdit: () => void; onForget: () => void }) {
  const look = memoryLook(item.kind);
  const title = displayText(item.title);
  const items: MenuItemSpec[] = [
    { id: "edit", label: "Edit", onSelect: onEdit },
    { id: "forget", label: "Forget", danger: true, separatorBefore: true, onSelect: onForget },
  ];
  return (
    <PanelRow
      look={look}
      title={title}
      openLabel={`${title}, ${look.word}`}
      onOpen={onOpen}
      menuLabel={`Actions for ${title}`}
      menuItems={items}
      meta={
        <>
          <span className={cn("shrink-0 font-medium", look.text)}>{look.word}</span>
          <span className="min-w-0 flex-1 truncate">{oneLine(item.text)}</span>
        </>
      }
    />
  );
}

/**
 * What the AI should remember about this workspace: a compact list of facts, each with a small tag for its
 * kind. A row opens the whole text and where it came from. After a meeting the AI can propose items; nothing
 * is kept until the person saves it. "Forget" really deletes.
 */
export function MemorySection({ workspaceId }: { workspaceId: string }) {
  const items = useMemoryStore((s) => s.byWorkspace[workspaceId]);
  const loadError = useMemoryStore((s) => s.loadError[workspaceId]);
  const suggest = useMemoryStore((s) => s.suggest[workspaceId]);
  const load = useMemoryStore((s) => s.load);
  const forget = useMemoryStore((s) => s.forget);
  const resolve = useMemoryStore((s) => s.resolve);
  const clearSuggest = useMemoryStore((s) => s.clearSuggest);
  const meetings = useMeetingStore((s) => s.recentMeetings);
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const update = useWorkspaceStore((s) => s.update);
  const [dialog, setDialog] = useState<{ id: string | null; mode: "read" | "edit" | "add" } | null>(null);
  const [forgetting, setForgetting] = useState<MemoryRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false);
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
    setDialog(null);
    setForgetting(null);
    setShowAll(false);
    setReviewed(new Set());
  }, [workspaceId]);

  const all = items ?? [];
  const suggested = all.filter((m) => m.status === "suggested");
  const saved = savedItems(all);
  const savedCount = saved.length;
  const fromMeeting = suggested[0]?.source_meeting ? meetings.find((m) => m.id === suggested[0].source_meeting)?.title : undefined;
  const memoryModel = useMemoryModel();
  // Automatic means what the backend says it means right now ("Claude Haiku (cheapest)"), not a guess.
  const automatic = useAutomaticModel(memoryModel.value.provider).model;
  const modelName = describeModel(memoryModel.value, automatic);
  const reviewedItems = suggested.filter((m) => reviewed.has(m.id));
  const opened = dialog?.id ? (all.find((m) => m.id === dialog.id) ?? null) : null;

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

  /** From the "Show all" dialog a choice first closes it: one dialog at a time keeps focus where it belongs. */
  const row = (m: MemoryRow, fromDialog: boolean) => {
    const go = (next: () => void) => () => {
      if (fromDialog) setShowAll(false);
      next();
    };
    return (
      <SavedRow
        key={m.id}
        item={m}
        onOpen={go(() => setDialog({ id: m.id, mode: "read" }))}
        onEdit={go(() => setDialog({ id: m.id, mode: "edit" }))}
        onForget={go(() => setForgetting(m))}
      />
    );
  };

  return (
    <PanelSection
      id="memory"
      icon={Brain}
      title="Memory"
      count={savedCount}
      info="What the AI should remember here: people, decisions, facts and preferences. Used in this workspace's answers, and nowhere else. After a meeting it can propose items; nothing is kept until you save it. Forgetting an item deletes it."
      infoLabel="About memory"
      action={<PanelAction label="Add to memory" icon={Plus} onClick={() => setDialog({ id: null, mode: "add" })} />}
      bodyClassName="space-y-2"
    >
      {suggest?.status === "running" && (
        <p role="status" className="ui-meta flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Reading the meeting for things worth remembering
        </p>
      )}
      {suggest?.status === "failed" && (
        <div role="alert" className="ui-meta text-destructive">
          <p>Couldn't get suggestions: {suggest.error}</p>
          <p className={`${hintClass} text-muted-foreground`}>Check the AI model in Settings, then try again from the meeting.</p>
          <button type="button" className="mt-1 rounded underline underline-offset-2" onClick={() => clearSuggest(workspaceId)}>
            Dismiss
          </button>
        </div>
      )}
      {suggest?.status === "none" && suggested.length === 0 && (
        <p role="status" className="ui-meta text-muted-foreground">
          Nothing new to remember was found in that meeting.{" "}
          <button type="button" className="rounded underline underline-offset-2" onClick={() => clearSuggest(workspaceId)}>
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
          <ul className="max-h-72 divide-y divide-border overflow-y-auto overscroll-contain">
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

      {loadError && (
        <p role="alert" className="ui-meta text-destructive">
          Couldn't load memory: {loadError}
        </p>
      )}

      {savedCount === 0 && suggested.length === 0 && !suggest && !loadError && <PanelEmpty>Nothing remembered yet.</PanelEmpty>}
      {savedCount > 0 && (
        <PanelList label="Memory items" noun="memory items" count={savedCount} onShowAll={() => setShowAll(true)}>
          {saved.map((m) => row(m, false))}
        </PanelList>
      )}

      <div className="flex items-center gap-1 pt-0.5">
        <Switch
          checked={!!detail?.suggest_memory}
          onChange={(on) => void update(workspaceId, { suggest_memory: on }).catch((e) => showToast(`Couldn't change it: ${messageOf(e)}`, "error"))}
          label="Suggest after meetings"
        />
        <InfoTip label="About suggesting after meetings">
          {`After a meeting here, its transcript goes to ${modelName} in up to 4 calls (a very long meeting keeps its start and end). It proposes up to 8 items. Nothing is kept until you save it.`}
        </InfoTip>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setChoosingModel(true)} aria-label={`Model for suggestions: ${modelName}`} aria-haspopup="dialog">
          Model
        </Button>
      </div>
      {memoryModel.error && (
        <p className="ui-meta text-muted-foreground" role="alert">
          {memoryModel.error}
        </p>
      )}

      <Dialog open={choosingModel} onClose={() => setChoosingModel(false)} title="Model for memory suggestions" description="Used for this and every later suggestion.">
        <ModelField label="Model for memory suggestions" value={memoryModel.value} onChange={(v) => void memoryModel.change(v)} />
      </Dialog>
      <ShowAllDialog
        open={showAll}
        onClose={() => setShowAll(false)}
        title="Memory"
        noun="memory"
        items={saved}
        keyOf={(m) => m.id}
        textOf={(m) => `${m.title} ${m.text} ${memoryLook(m.kind).word}`}
        renderRow={(m) => row(m, true)}
      />
      {dialog && (dialog.mode === "add" || opened) && (
        <MemoryDialog
          key={`${dialog.id}:${dialog.mode}`}
          workspaceId={workspaceId}
          item={opened}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onForget={(m) => {
            setDialog(null);
            setForgetting(m);
          }}
        />
      )}
      <ConfirmDialog
        open={forgetting !== null}
        tone="danger"
        title={`Forget ${forgetting ? displayText(forgetting.title) : ""}?`}
        body="It is deleted from this workspace's memory and the AI stops using it."
        confirmLabel="Forget"
        cancelLabel="Keep"
        onConfirm={() => {
          const m = forgetting;
          setForgetting(null);
          if (m) void forget(m).catch((e) => showToast(`Couldn't forget it: ${messageOf(e)}`, "error"));
        }}
        onCancel={() => setForgetting(null)}
      />
    </PanelSection>
  );
}
