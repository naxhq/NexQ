import { useEffect, useState } from "react";
import { listMemory, listWorkspaceMeetings } from "../../lib/ipc";
import type { MeetingSummary, MemoryItem, WorkspaceSummary } from "../../lib/types";
import { VoiceprintMark } from "../../voiceprint";
import { COLUMN } from "./column";

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Up to three questions made from what is really in the workspace; none when it is empty. */
export function buildExamples(meetings: MeetingSummary[], memory: MemoryItem[]): string[] {
  const saved = memory.filter((m) => m.status === "saved" && m.title.trim());
  const people = saved.filter((m) => m.kind === "person");
  const open = saved.filter((m) => m.kind === "open_item");
  const titled = meetings.filter((m) => m.title.trim() && m.segment_count > 0);
  const out: string[] = [];
  const add = (q: string | undefined) => q && !out.includes(q) && out.length < 3 && out.push(q);
  if (titled[0]) add(`What did we decide in "${clip(titled[0].title.trim())}"?`);
  if (people[0]) add(`What have I promised ${clip(people[0].title.trim(), 32)}?`);
  if (open[0]) add(`What is still open on ${clip(open[0].title.trim(), 40)}?`);
  if (titled[1]) add(`Summarize "${clip(titled[1].title.trim())}" in five lines.`);
  if (people[1]) add(`What did ${clip(people[1].title.trim(), 32)} last ask me for?`);
  if (titled[2]) add(`What came up in "${clip(titled[2].title.trim())}" that I haven't followed up?`);
  return out;
}

export function useExamples(workspaceId: string): string[] {
  const [examples, setExamples] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    setExamples([]);
    Promise.all([
      listWorkspaceMeetings(workspaceId, null, 6, 0).then((p) => p.meetings, () => [] as MeetingSummary[]),
      listMemory(workspaceId).catch(() => [] as MemoryItem[]),
    ]).then(([meetings, memory]) => {
      if (alive) setExamples(buildExamples(meetings, memory));
    });
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return examples;
}

/** The empty chat: the workspace's name and voiceprint, quietly. The composer below is the focus. */
export function StartHeading({ workspace }: { workspace: WorkspaceSummary | null; }) {
  return (
    <div className={`${COLUMN} flex items-center gap-2.5 px-0 pb-4`}>
      {workspace && <VoiceprintMark id={workspace.id} hue={workspace.color} size={18} />}
      <h2 className="ui-section text-muted-foreground">{workspace?.name ?? "Workspace"}</h2>
    </div>
  );
}

export function ExampleQuestions({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className={`${COLUMN} pt-4`}>
      <p className="ui-meta pb-1 text-muted-foreground">Try asking</p>
      <ul>
        {questions.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="ui-body w-full rounded-md px-2 py-1.5 text-left text-foreground/85 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
