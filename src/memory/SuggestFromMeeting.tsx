import { BookmarkPlus, Loader2 } from "lucide-react";
import { showToast } from "../stores/toastStore";
import { cn } from "../lib/utils";
import { quietButton } from "../workspace/styles";
import { useMemoryStore } from "./memoryStore";

/**
 * "Suggest from this meeting" for the meeting details header: one AI call that
 * proposes facts for the workspace the meeting is filed in. The suggestions
 * wait in that workspace's Memory until they are saved or dismissed.
 */
export function SuggestFromMeeting({ meetingId, workspaceId = "general", className }: { meetingId: string; workspaceId?: string; className?: string }) {
  const state = useMemoryStore((s) => s.suggest[workspaceId]);
  const run = useMemoryStore((s) => s.runSuggest);
  const mine = state?.meetingId === meetingId ? state : undefined;
  const running = state?.status === "running";

  const click = async () => {
    await run(workspaceId, meetingId);
    const after = useMemoryStore.getState().suggest[workspaceId];
    if (after?.status === "done") showToast(`${after.count} ${after.count === 1 ? "suggestion" : "suggestions"} waiting in this workspace's memory`, "success");
    else if (after?.status === "none") showToast("Nothing new to remember was found in this meeting", "info");
    else if (after?.status === "failed") showToast(`Couldn't get suggestions: ${after.error}`, "error");
  };

  return (
    <button type="button" onClick={() => void click()} disabled={running} aria-busy={running} className={cn(quietButton, className)}>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />}
      {running && mine ? "Reading the meeting" : "Suggest from this meeting"}
    </button>
  );
}
