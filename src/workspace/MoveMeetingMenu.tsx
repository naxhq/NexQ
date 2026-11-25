import type { ReactNode } from "react";
import { FolderInput } from "lucide-react";
import { Menu, type MenuTriggerProps, Button, IconButton } from "../ui";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { cn } from "../lib/utils";
import { moveMeetingTo } from "./meetingScope";

export interface MoveMeetingMenuProps {
  meetingId: string;
  /** Where it is filed now (shown ticked); "general" when unknown. */
  currentWorkspaceId?: string;
  /** `icon` for a row, `button` for a header ("Move to workspace"). */
  variant?: "icon" | "button";
  onMoved?: (workspaceId: string) => void;
  className?: string;
}

/**
 * "Move to workspace": a menu of the workspaces a meeting can be filed in.
 * Exported for the rail and for the meeting details header.
 */
export function MoveMeetingMenu({ meetingId, currentWorkspaceId = "general", variant = "icon", onMoved, className }: MoveMeetingMenuProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const targets = workspaces.filter((w) => !w.archived || w.id === currentWorkspaceId);

  const items = targets.map((w) => ({
    id: w.id,
    label: w.name,
    checked: w.id === currentWorkspaceId,
    disabled: w.id === currentWorkspaceId,
    onSelect: () => {
      moveMeetingTo(meetingId, w.id)
        .then(() => {
          showToast(`Moved to ${w.name}`, "success");
          onMoved?.(w.id);
        })
        .catch((e) => showToast(`Couldn't move it: ${e instanceof Error ? e.message : String(e)}`, "error"));
    },
  }));

  return (
    <Menu
      label="Move to workspace"
      items={items}
      align="end"
      className={className}
      renderTrigger={(props: MenuTriggerProps, state): ReactNode =>
        variant === "icon" ? (
          <IconButton
            {...props}
            onClick={(e) => {
              e.stopPropagation();
              props.onClick();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              props.onKeyDown(e);
            }}
            aria-label="Move to workspace" className={cn(state.open && "bg-accent text-foreground")}>
            <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        ) : (
          <Button variant="ghost" {...props} className={cn(state.open && "bg-accent text-foreground")}>
            <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
            Move to workspace
          </Button>
        )
      }
    />
  );
}
