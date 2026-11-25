import { useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Menu, type MenuItemSpec } from "../ui";
import { VoiceprintMark } from "../voiceprint";
import { cn } from "../lib/utils";
import { getMeetingScope } from "../lib/ipc";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { GENERAL_ID, useWorkspaceStore, workspaceById } from "../stores/workspaceStore";
import { borrowBlocker, moveMeetingTo, setBorrowed, syncActiveScope } from "./meetingScope";

/**
 * Shows which workspace a running meeting is filed in (and what it also uses),
 * and changes both. Used by the meeting window's header. The menu lists "Filed
 * in" choices, then "Also use" toggles; keep-separate combinations are
 * disabled with the reason.
 */
export function MeetingWorkspaceChip({ meetingId, className }: { meetingId: string; className?: string }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const home = useMeetingStore((s) => (s.activeMeeting?.id === meetingId ? s.activeMeeting.workspace_id : undefined)) ?? GENERAL_ID;
  const borrowed = useMeetingStore((s) => s.activeBorrowed);

  // The scope of a meeting this window did not start comes from the backend once.
  useEffect(() => {
    let live = true;
    getMeetingScope(meetingId)
      .then((scope) => (live ? syncActiveScope(scope) : undefined))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId]);

  const homeWs = workspaceById(workspaces, home);
  const items = useMemo<MenuItemSpec[]>(() => {
    const open = workspaces.filter((w) => !w.archived);
    const fail = (what: string) => (e: unknown) => showToast(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`, "error");
    const filed: MenuItemSpec[] = open.map((w) => ({
      id: `home-${w.id}`,
      label: w.id === home ? `Filed in ${w.name}` : `File in ${w.name}`,
      checked: w.id === home,
      disabled: w.id === home,
      onSelect: () => {
        moveMeetingTo(meetingId, w.id).catch(fail("move the meeting"));
      },
    }));
    const also: MenuItemSpec[] = open
      .filter((w) => w.id !== home)
      .map((w, i) => {
        const blocked = borrowBlocker(homeWs, w);
        const on = borrowed.includes(w.id);
        return {
          id: `use-${w.id}`,
          label: `Also use ${w.name}`,
          hint: blocked ?? undefined,
          checked: on,
          // Taking one back is always allowed.
          disabled: !!blocked && !on,
          separatorBefore: i === 0,
          onSelect: () => {
            const next = on ? borrowed.filter((b) => b !== w.id) : [...borrowed, w.id];
            setBorrowed(meetingId, next).catch(fail("change what this meeting uses"));
          },
        };
      });
    return [...filed, ...also];
  }, [workspaces, home, borrowed, homeWs, meetingId]);

  const name = homeWs?.name ?? "General";
  const extra = borrowed.length;

  return (
    <Menu
      label="Workspace of this meeting"
      items={items}
      align="end"
      className={className}
      renderTrigger={(props, state) => (
        <button
          type="button"
          {...props}
          aria-label={`Workspace: ${name}${extra ? `, also using ${extra}` : ""}`}
          className={cn(
            "ui-meta inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md px-2 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
            state.open && "bg-accent",
          )}
        >
          <VoiceprintMark id={home} hue={homeWs?.color} size={14} />
          <span className="truncate">{name}</span>
          {extra > 0 && <span className="text-muted-foreground">+{extra}</span>}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      )}
    />
  );
}
