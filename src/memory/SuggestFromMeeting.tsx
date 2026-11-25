import { BookmarkPlus, Loader2 } from "lucide-react";
import { showToast } from "../stores/toastStore";
import { cn } from "../lib/utils";
import { useMemoryStore } from "./memoryStore";
import { Button, Dialog } from "../ui";
import { useState } from "react";
import { ModelField, describeModel } from "../models/ModelField";
import { useMemoryModel } from "./useMemoryModel";

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
  const [choosing, setChoosing] = useState(false);
  const model = useMemoryModel();

  const click = async () => {
    await run(workspaceId, meetingId);
    const after = useMemoryStore.getState().suggest[workspaceId];
    if (after?.status === "done") showToast(`${after.count} ${after.count === 1 ? "suggestion" : "suggestions"} waiting in this workspace's memory`, "success");
    else if (after?.status === "none") showToast("Nothing new to remember was found in this meeting", "info");
    else if (after?.status === "failed") showToast(`Couldn't get suggestions: ${after.error}`, "error");
  };

  return (
    <>
      <Button variant="ghost" onClick={() => void click()} disabled={running} aria-busy={running} className={cn(className)}>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />}
        {running && mine ? "Reading the meeting" : "Suggest from this meeting"}
      </Button>
      <Button variant="ghost" onClick={() => setChoosing(true)} className={cn(className)} aria-label={`Model for suggestions: ${describeModel(model.value)}`}>
        Model
      </Button>
      <Dialog open={choosing} onClose={() => setChoosing(false)} title="Model for memory suggestions" description="Used for this and every later suggestion.">
        <ModelField label="Model for memory suggestions" value={model.value} onChange={(v) => void model.change(v)} />
        {model.error && <p className="ui-meta mt-1 text-muted-foreground" role="alert">{model.error}</p>}
      </Dialog>
    </>
  );
}
