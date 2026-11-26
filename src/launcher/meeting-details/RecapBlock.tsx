import { useEffect, useState } from "react";
import { ConfirmDialog, Button } from "../../ui";
import { deleteMeetingRecap, getMeetingRecap } from "../../lib/ipc";
import { useMeetingStore } from "../../stores/meetingStore";
import { showToast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { MeetingRecap } from "../../lib/types";

/** "12 Nov 2026": the day a recap was written. */
export function recapDate(created_at: number): string {
  return new Date(created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The short recap the AI wrote for a meeting that has no summary, read-only. Deleting it asks first and
 * it is not written again. Shows nothing when there is none.
 */
export function RecapBlock({ meetingId }: { meetingId: string }) {
  const [recap, setRecap] = useState<MeetingRecap | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    setRecap(null);
    getMeetingRecap(meetingId)
      .then((r) => live && setRecap(r && typeof r.text === "string" && r.text.trim() ? r : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId]);

  if (!recap) return null;

  const remove = async () => {
    setAsking(false);
    try {
      await deleteMeetingRecap(meetingId);
      setRecap(null);
      void useMeetingStore.getState().loadRecentMeetings();
      void useWorkspaceStore.getState().refresh();
    } catch (e) {
      showToast(`Couldn't delete the recap: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  return (
    <section aria-label="AI recap" className="mx-auto mb-4 max-w-3xl px-6 pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="ui-section text-foreground">AI recap, {recapDate(recap.created_at)}</h3>
        <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>
          Delete
        </Button>
      </div>
      <p className="ui-body ui-measure mt-1 whitespace-pre-wrap text-foreground">{recap.text}</p>
      <ConfirmDialog
        open={asking}
        tone="danger"
        title="Delete this recap?"
        body="It isn't written again for this meeting. Your transcript is not touched."
        confirmLabel="Delete recap"
        onConfirm={() => void remove()}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}
