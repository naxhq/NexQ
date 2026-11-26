import { useState, useCallback, useRef, useEffect } from "react";
import type { Meeting, ActionItem } from "../../lib/types";
import type { ActionItemsExtractionState } from "../../hooks/useActionItemsExtraction";
import { updateActionItem, deleteActionItem, saveMeetingActionItems } from "../../lib/ipc";
import { useStreamStore } from "../../stores/streamStore";
import { useConfigStore } from "../../stores/configStore";
import { showToast } from "../../stores/toastStore";
import { useAudioPlayerStore } from "../../stores/audioPlayerStore";
import { formatTimestamp } from "../../lib/utils";
import { relMs } from "../../lib/time";
import { isCliAgent } from "../../lib/cliAgents";
import {
  CheckSquare,
  Square,
  Sparkles,
  Loader2,
  X,
  RefreshCw,
  GripVertical,
  Pencil,
  Trash2,
  Check,
  Download,
  Copy,
} from "lucide-react";

interface ActionItemsTabProps {
  meeting: Meeting;
  extraction: ActionItemsExtractionState;
  onItemsUpdated: (items: ActionItem[]) => void;
}

// ---------------------------------------------------------------------------
// Individual action item row with inline edit, drag handle, delete
// ---------------------------------------------------------------------------
export function ActionItemRow({
  item,
  assignee,
  meetingStartMs,
  onToggle,
  onEdit,
  onDelete,
  onDragStart,
  onDragEnd,
  isDragTarget,
}: {
  item: ActionItem;
  assignee?: { display_name: string; color?: string };
  meetingStartMs: number;
  onToggle: (id: string, completed: boolean) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  isDragTarget: boolean;
}) {
  const isPlaying = useAudioPlayerStore((s) => s.isPlaying);
  const seekToTimestamp = useAudioPlayerStore((s) => s.seekToTimestamp);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const handleSave = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== item.text) {
      onEdit(item.id, trimmed);
    }
    setEditing(false);
  };

  const relativeMs = relMs(item.timestamp_ms, meetingStartMs);
  const hasTimestamp = relativeMs > 0;
  const hasAssignee = !!assignee;
  const showMeta = hasTimestamp || hasAssignee;

  return (
    <div
      data-item-id={item.id}
      draggable={!editing}
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      className={`group flex items-start gap-1.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-secondary/20 ${
        ""
      } ${isDragTarget ? "border-t-2 border-primary/40" : "border-t-2 border-transparent"}`}
    >
      {/* Drag handle */}
      <div className="mt-0.5 shrink-0 cursor-grab text-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity active:cursor-grabbing">
        <GripVertical className="h-4 w-4" />
      </div>

      {/* Checkbox */}
      <button
        onClick={() => onToggle(item.id, !item.completed)}
        className="mt-0.5 shrink-0 text-muted-foreground/50 hover:text-primary transition-colors cursor-pointer"
        aria-label={item.completed ? "Mark incomplete" : "Mark complete"}
      >
        {item.completed ? (
          <CheckSquare className="h-4 w-4 text-success" />
        ) : (
          <Square className="h-4 w-4" />
        )}
      </button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") { setEditText(item.text); setEditing(false); }
              }}
              onBlur={handleSave}
              className="flex-1 rounded-md border border-border/30 bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-primary/20"
            />
            <button
              onClick={handleSave}
              aria-label="Save edit"
              className="rounded p-0.5 text-success hover:bg-success/10 cursor-pointer"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setEditText(item.text); setEditing(false); }}
              aria-label="Cancel edit"
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p
            onDoubleClick={() => { setEditText(item.text); setEditing(true); }}
            className={`text-sm leading-relaxed text-foreground/80 cursor-default ${
              item.completed ? "line-through text-muted-foreground/50" : ""
            }`}
            title="Double-click to edit"
          >
            {item.text}
          </p>
        )}
        {showMeta && !editing && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/40">
            {hasTimestamp && (
              <button
                type="button"
                onClick={() => { if (isPlaying) seekToTimestamp(item.timestamp_ms); }}
                className={`tabular-nums transition-colors ${isPlaying ? "cursor-pointer hover:text-primary" : "cursor-default"}`}
                title={isPlaying ? "Seek to this moment" : undefined}
              >
                {formatTimestamp(relativeMs)}
              </button>
            )}
            {hasTimestamp && hasAssignee && <span>&middot;</span>}
            {hasAssignee && (
              <span className="flex items-center gap-1 font-medium text-muted-foreground/60">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: assignee.color ?? "#6b7280" }}
                />
                {assignee.display_name}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Actions — visible on hover */}
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => { setEditText(item.text); setEditing(true); }}
            className="rounded-md p-1 text-muted-foreground/30 hover:text-foreground/60 hover:bg-secondary/30 transition-colors cursor-pointer"
            title="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="rounded-md p-1 text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------
export function ActionItemsTab({
  meeting,
  extraction,
  onItemsUpdated,
}: ActionItemsTabProps) {
  const items = meeting.action_items ?? [];
  const meetingStartMs = new Date(meeting.start_time).getTime();
  const isOtherStreaming = useStreamStore((s) => s.isStreaming);
  const llmModel = useConfigStore((s) => s.llmModel);
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragItemId = useRef<string | null>(null);
  const dragOverIdRef = useRef<string | null>(null);

  const hasTranscript = meeting.transcript.length > 0;
  // A CLI agent picks its own model, so an empty slot (Codex before its catalog is read) is fine.
  const hasLlm = !!llmModel || isCliAgent(llmProvider);
  const completedCount = items.filter((i) => i.completed).length;

  // Toggle completion
  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      const prev = items;
      onItemsUpdated(items.map((a) => a.id === itemId ? { ...a, completed } : a));
      try {
        await updateActionItem(itemId, completed);
      } catch {
        onItemsUpdated(prev);
      }
    },
    [items, onItemsUpdated]
  );

  // Inline edit
  const handleEdit = useCallback(
    async (itemId: string, newText: string) => {
      const updated = items.map((a) => a.id === itemId ? { ...a, text: newText } : a);
      onItemsUpdated(updated);
      try {
        const itemsWithMeetingId = updated.map((a) => ({ ...a, meeting_id: meeting.id }));
        await saveMeetingActionItems(meeting.id, JSON.stringify(itemsWithMeetingId));
      } catch {
        showToast("Failed to save edit", "error");
      }
    },
    [items, meeting.id, onItemsUpdated]
  );

  // Delete
  const handleDelete = useCallback(
    async (itemId: string) => {
      const prev = items;
      onItemsUpdated(items.filter((a) => a.id !== itemId));
      try {
        await deleteActionItem(itemId);
      } catch {
        onItemsUpdated(prev);
        showToast("Failed to delete", "error");
      }
    },
    [items, onItemsUpdated]
  );

  // Drag & drop reorder — container-level handlers for reliability
  const findItemId = (el: HTMLElement | null): string | null => {
    while (el) {
      if (el.dataset?.itemId) return el.dataset.itemId;
      el = el.parentElement;
    }
    return null;
  };

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    dragItemId.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const targetId = findItemId(e.target as HTMLElement);
    if (targetId && dragItemId.current && dragItemId.current !== targetId) {
      dragOverIdRef.current = targetId;
      setDragOverId(targetId);
    }
  }, []);

  const handleContainerDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const fromId = dragItemId.current;
      const toId = dragOverIdRef.current;
      dragItemId.current = null;
      dragOverIdRef.current = null;
      setDragOverId(null);
      if (!fromId || !toId || fromId === toId) return;

      const fromIdx = items.findIndex((a) => a.id === fromId);
      const toIdx = items.findIndex((a) => a.id === toId);
      if (fromIdx === -1 || toIdx === -1) return;

      const reordered = [...items];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      onItemsUpdated(reordered);

      try {
        const itemsWithMeetingId = reordered.map((a) => ({ ...a, meeting_id: meeting.id }));
        await saveMeetingActionItems(meeting.id, JSON.stringify(itemsWithMeetingId));
      } catch {
        showToast("Failed to reorder", "error");
      }
    },
    [items, meeting.id, onItemsUpdated]
  );

  const handleDragEnd = useCallback(() => {
    dragItemId.current = null;
    dragOverIdRef.current = null;
    setDragOverId(null);
  }, []);

  // Export as text
  const handleExport = useCallback(() => {
    const lines = items.map(
      (item, i) => `${item.completed ? "[x]" : "[ ]"} ${i + 1}. ${item.text}`
    );
    const text = `# Action Items — ${meeting.title}\n\n${lines.join("\n")}`;
    navigator.clipboard.writeText(text);
    showToast("Action items copied to clipboard", "success");
  }, [items, meeting.title]);

  // Re-extract
  const handleReextract = useCallback(() => {
    if (items.length > 0) {
      const confirmed = window.confirm(
        `This will replace ${items.length} existing action items. Continue?`
      );
      if (!confirmed) return;
    }
    extraction.extract();
  }, [items.length, extraction]);

  // ---- Extracting ---- //
  if (extraction.isExtracting) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="rounded-xl border border-primary/20 bg-card/30 px-8 py-6 text-center">
          <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" />
          <p className="mb-1 text-sm font-medium text-foreground/70">Analyzing transcript...</p>
          <p className="mb-4 text-[11px] text-muted-foreground/40">Extracting action items, assignments, and follow-ups</p>
          <button onClick={extraction.cancel} className="flex items-center gap-1.5 mx-auto rounded-lg px-3 py-1.5 text-xs text-muted-foreground/50 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer">
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---- Error ---- //
  if (extraction.error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          {extraction.error}
        </div>
        <button onClick={() => extraction.extract()} className="rounded-xl bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20 cursor-pointer">
          Try Again
        </button>
      </div>
    );
  }

  // ---- Has items ---- //
  if (items.length > 0) {
    return (
      <div className="p-3">
        {/* Header bar */}
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
            {completedCount} of {items.length} completed
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleExport}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-muted-foreground/40 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
              title="Copy action items to clipboard"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
            <button
              onClick={handleReextract}
              disabled={isOtherStreaming || extraction.isExtracting}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-muted-foreground/40 hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-30 cursor-pointer"
              title="Re-extract action items"
            >
              <RefreshCw className="h-3 w-3" />
              Re-extract
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-3 px-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-secondary/40">
            <div
              className="h-full rounded-full bg-success transition-all duration-300"
              style={{ width: `${Math.round((completedCount / items.length) * 100)}%` }}
            />
          </div>
        </div>

        {/* Checklist — container handles dragOver/drop for reliable reorder */}
        <div
          className="space-y-0.5"
          onDragOver={handleContainerDragOver}
          onDrop={handleContainerDrop}
        >
          {items.map((item) => {
            const speaker = meeting.speakers?.find((s) => s.id === item.assignee_speaker_id);
            return (
              <ActionItemRow
                key={item.id}
                item={item}
                assignee={speaker ? { display_name: speaker.display_name, color: speaker.color } : undefined}
                meetingStartMs={meetingStartMs}
                onToggle={handleToggle}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                isDragTarget={dragOverId === item.id}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Empty state ---- //
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <Sparkles className="mb-4 h-8 w-8 text-primary/20" />
      <p className="mb-1 text-sm font-semibold text-muted-foreground/50">Extract Action Items</p>
      <p className="mb-5 max-w-xs text-center text-xs text-muted-foreground/40">
        AI will analyze the full transcript to find action items, assignments, and follow-ups
      </p>
      <button
        onClick={() => extraction.extract()}
        disabled={!hasTranscript || !hasLlm || isOtherStreaming}
        className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/10 transition-all duration-200 hover:shadow-lg hover:shadow-primary/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        title={!hasTranscript ? "No transcript" : !hasLlm ? "Configure LLM" : isOtherStreaming ? "Wait for AI" : "Extract action items"}
      >
        <Sparkles className="h-4 w-4" />
        Extract Action Items
      </button>
    </div>
  );
}
