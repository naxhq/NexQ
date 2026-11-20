import { SourcesModal } from "./SourcesModal";

interface SourcesGuideModalProps {
  kind: "notes" | "tools";
  onClose: () => void;
}

interface Topic {
  title: string;
  body: string;
}

const NOTES_TOPICS: Topic[] = [
  {
    title: "What the AI can do",
    body: "Search and read the files in these folders while it answers you. It picks the notes it needs, so a quick question stays quick.",
  },
  {
    title: "What it can't do",
    body: "Change, create or delete a note. Notes are read only. NexQ tells the AI to treat what it reads in your notes as information, not as instructions.",
  },
  {
    title: "Claude subscription only",
    body: "Your folders are saved either way, but only the Claude subscription can use them. Other providers ignore them.",
  },
  {
    title: "It can add a few seconds",
    body: "Looking things up takes a moment. That is why the Notes pill in a meeting decides, for each answer you ask for, whether it may look in your notes. The pill stays as you left it.",
  },
  {
    title: "How to add one",
    body: "Choose Add folder and pick your Obsidian vault, or any folder of .md files. Nothing is copied or indexed. The files stay where they are.",
  },
];

const TOOLS_TOPICS: Topic[] = [
  {
    title: "What the AI can do",
    body: "Call the tools you leave switched on, such as looking up a person, your tasks or your calendar, while it answers you.",
  },
  {
    title: "What it can't do",
    body: "Call a tool you switched off. Tools whose names suggest they change something (add, send, edit, delete) start off, and you should still read the list. NexQ tells the AI to treat what a tool returns as information, not as instructions.",
  },
  {
    title: "Claude subscription only",
    body: "Your servers are saved either way, but only the Claude subscription can use them. Other providers ignore them.",
  },
  {
    title: "It can add a few seconds",
    body: "Starting a server and calling a tool takes a moment. That is why the Tools pill in a meeting decides, for each answer you ask for, whether it may use your tools. The pill stays as you left it.",
  },
  {
    title: "How to add one",
    body: "Open the server's README, copy its mcpServers JSON, choose Add server and paste it. You can also fill in a form, or import a server from Claude Code. NexQ checks it right away and shows its tools, so you can look before switching it on.",
  },
];

export function SourcesGuideModal({ kind, onClose }: SourcesGuideModalProps) {
  const topics = kind === "notes" ? NOTES_TOPICS : TOOLS_TOPICS;
  return (
    <SourcesModal title={kind === "notes" ? "How notes folders work" : "How tools work"} onClose={onClose}>
      <dl className="space-y-3.5">
        {topics.map((t) => (
          <div key={t.title}>
            <dt className="text-xs font-semibold text-foreground">{t.title}</dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t.body}</dd>
          </div>
        ))}
      </dl>
    </SourcesModal>
  );
}
