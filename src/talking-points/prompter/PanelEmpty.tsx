import { EmptyState, Button } from "../../ui";
import { cn } from "../../lib/utils";

/** What the panel shows before there is a note: loading, a failed load, or the first-note invitation. */
export function PanelEmpty({
  loading,
  error,
  onRetry,
  onStart,
}: {
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  onStart: () => void;
}) {
  if (loading) {
    return (
      <div className="ui-body p-4 text-muted-foreground" role="status">
        Loading your notes
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        title="Your notes did not load"
        body={error}
        action={
          <Button variant="primary"  onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex h-full items-center">
      <EmptyState
        title="Write your first talking points"
        body="Keep what you want to say in front of you. NexQ can follow your voice and tick off what you have covered."
        action={
          <Button variant="primary"  onClick={onStart}>
            Write a note
          </Button>
        }
      />
    </div>
  );
}
