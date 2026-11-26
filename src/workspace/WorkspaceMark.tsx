import { VoiceprintMark } from "../voiceprint";
import { cn } from "../lib/utils";
import type { WorkspaceSummary } from "../lib/types";

/** The mark always sits beside the name (it is decoration for assistive tech, the name carries the meaning). */
export function WorkspaceName({
  workspace,
  size = 18,
  className,
  nameClassName,
}: {
  workspace: Pick<WorkspaceSummary, "id" | "name" | "color">;
  size?: number;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <VoiceprintMark id={workspace.id} hue={workspace.color} size={size} />
      <span className={cn("truncate", nameClassName)}>{workspace.name}</span>
    </span>
  );
}
