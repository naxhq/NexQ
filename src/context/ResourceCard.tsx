import { useState } from "react";
import { FileText, X, RefreshCw } from "lucide-react";
import type { ContextResource, RagIndexStatus } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useRagStore } from "../stores/ragStore";
import { rebuildFileIndex } from "../lib/ipc";
import { showToast } from "../stores/toastStore";

interface ResourceCardProps {
  resource: ContextResource;
  onRemove: (id: string) => void;
}

export function ResourceCard({ resource, onRemove }: ResourceCardProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const indexStatus = useRagStore((s) => s.indexStatus);
  const [isReindexing, setIsReindexing] = useState(false);

  const handleReindex = async () => {
    setIsReindexing(true);
    try {
      await rebuildFileIndex(resource.id);
      showToast(`Re-indexed "${resource.name}"`, "success");
      useRagStore.getState().refreshIndexStatus();
    } catch (e) {
      console.error("Failed to re-index:", e);
      showToast("Couldn't re-index file — try removing and re-adding it", "error");
    } finally {
      setIsReindexing(false);
    }
  };

  const typeConfig = getTypeConfig(resource.file_type);

  const handleRemoveClick = () => {
    if (confirmRemove) {
      onRemove(resource.id);
      setConfirmRemove(false);
    } else {
      setConfirmRemove(true);
      setTimeout(() => setConfirmRemove(false), 3000);
    }
  };

  // Determine index badge for RAG mode
  const isRagActive = contextStrategy === "local_rag";
  const fileIndexStatus = getFileIndexBadge(resource, isRagActive, indexStatus);

  return (
    <div className="group relative flex items-start gap-3 rounded-xl border border-border/40 bg-secondary/20 p-3.5 transition-colors hover:bg-secondary/40">
      {/* File type icon */}
      <div
        className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${typeConfig.color}15` }}
      >
        <FileText className="h-4 w-4" style={{ color: typeConfig.color }} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* File name + badges */}
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {resource.name}
          </span>
          <span
            className="flex-shrink-0 rounded-full px-2 py-0.5 text-meta font-medium uppercase"
            style={{
              backgroundColor: `${typeConfig.color}15`,
              color: typeConfig.color,
            }}
          >
            {resource.file_type}
          </span>
          {/* RAG index badge */}
          {fileIndexStatus && (
            <span
              className={`flex-shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${fileIndexStatus.className}`}
            >
              {fileIndexStatus.label}
            </span>
          )}
        </div>

        {/* Meta row */}
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{formatFileSize(resource.size_bytes)}</span>
          <span className="rounded-full bg-muted/40 px-2 py-0.5">
            ~{formatTokenCount(resource.token_count)} tokens
          </span>
          {isRagActive && resource.chunk_count != null && resource.chunk_count > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
              {resource.chunk_count} chunks
            </span>
          )}
        </div>

        {/* Preview snippet */}
        {resource.preview && (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
            {resource.preview}
          </p>
        )}
      </div>

      {/* Re-index button (RAG mode) */}
      {isRagActive && (
        <button
          onClick={handleReindex}
          disabled={isReindexing}
          className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-primary opacity-0 group-hover:opacity-100"
          title="Re-index file"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isReindexing ? "animate-spin" : ""}`} />
        </button>
      )}

      {/* Remove button */}
      <button
        onClick={handleRemoveClick}
        className={`flex-shrink-0 rounded-lg p-1.5 transition-colors ${
          confirmRemove
            ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
            : "text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100"
        }`}
        title={confirmRemove ? "Click again to confirm removal" : "Remove file"}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function getFileIndexBadge(
  _resource: ContextResource,
  isRagActive: boolean,
  indexStatus: RagIndexStatus | null,
): { label: string; className: string } | null {
  if (!isRagActive) return null;

  const hasChunks = (indexStatus?.total_chunks ?? 0) > 0;
  const indexedFiles = indexStatus?.indexed_files ?? 0;
  const totalFiles = indexStatus?.total_files ?? 0;

  if (!hasChunks) {
    // No index built yet
    return {
      label: "New",
      className: "bg-info/10 text-info",
    };
  }

  if (indexedFiles >= totalFiles && totalFiles > 0) {
    // All files indexed — every resource is covered
    return {
      label: "Indexed",
      className: "bg-success/10 text-success",
    };
  }

  // Index exists but not all files covered
  return {
    label: "Not Indexed",
    className: "bg-warning/10 text-warning",
  };
}

function getTypeConfig(fileType: string): { color: string } {
  switch (fileType) {
    case "pdf":
      return { color: "hsl(var(--warning))" };
    case "md":
      return { color: "hsl(var(--info))" };
    case "docx":
      return { color: "hsl(var(--primary))" };
    case "txt":
    default:
      return { color: "hsl(var(--muted-foreground))" };
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toLocaleString();
}
