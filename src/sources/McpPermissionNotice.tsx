import { SourcesModal } from "./SourcesModal";

/** Shown once, the first time a server is added. */
export function McpPermissionNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <SourcesModal title="Before you switch tools on" onClose={onDismiss} hideClose>
      <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          When a tool is on, the AI can use it without asking you first. NexQ switches off every tool that looks like
          it changes something, such as adding, sending, editing or deleting.
        </p>
        <p>Look through each server's tool list and keep on only what you want the AI to use.</p>
        <p>What a tool sends back is treated as information to read, never as instructions to follow.</p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          className="cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          Got it
        </button>
      </div>
    </SourcesModal>
  );
}
