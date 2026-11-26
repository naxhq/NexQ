// Review-only page: index.html?view=ui-gallery, dev builds only (main.tsx guards
// the import with import.meta.env.DEV, so none of this reaches a release).

import { useMemo, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  ColorSwatches,
  Combobox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  InlineEdit,
  Kbd,
  Menu,
  Segmented,
  Select,
  SlideOver,
  Switch,
  Tooltip,
  WORKSPACE_HUES,
  Button,
  IconButton,
} from "./index";
import { ContextWave, MeetingWave, VoiceprintMark } from "../voiceprint";
import type { ContextBar, ContextLayer } from "../lib/types";
import { cn } from "../lib/utils";
import { ChipsBlock, OffersBlock, TextStylesBlock } from "./galleryTalkingPoints";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-6">
      <h2 className="ui-section mb-3">{title}</h2>
      {children}
    </section>
  );
}

function sampleBars(n: number): ContextBar[] {
  const layers: ContextLayer[] = ["instructions", "meetings", "documents", "folders", "conversation"];
  const out: ContextBar[] = [];
  for (let i = 0; i < n; i++) {
    const layer = layers[Math.min(layers.length - 1, Math.floor((i / n) * layers.length))];
    out.push({
      id: `b${i}`,
      layer,
      title: `${layer} item ${i + 1}`,
      tokens: 60 + ((i * 97) % 700),
      relevance: ((i * 37) % 100) / 100,
      pinned: i % 17 === 0,
      included: i % 29 !== 5,
    });
  }
  return out;
}

const MEETINGS = Array.from({ length: 36 }, (_, i) => ({
  id: `m${i}`,
  title: `Weekly sync ${i + 1}`,
  date: new Date(2026, 0, 3 + i * 6).toISOString(),
  duration_seconds: i % 7 === 0 ? null : 600 + ((i * 431) % 3600),
}));

export default function UiGallery() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState("balanced");
  const [hue, setHue] = useState<string | null>("violet");
  const [name, setName] = useState("Acme renewal");
  const [pick, setPick] = useState<string | null>("b");
  const [dialog, setDialog] = useState<null | "plain" | "danger" | "sheet">(null);
  const [wave, setWave] = useState(40);
  const bars = useMemo(() => sampleBars(wave), [wave]);

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
  };

  const options = [
    { value: "a", label: "Acme renewal", description: "12 meetings" },
    { value: "b", label: "Board prep" },
    { value: "c", label: "Course: statistics" },
    { value: "d", label: "General", description: "Always on" },
  ];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-2 flex items-center justify-between">
        <h1 className="ui-title">UI gallery</h1>
        <Button onClick={toggleTheme}>
          {dark ? "Switch to light" : "Switch to dark"}
        </Button>
      </header>
      <p className="ui-body ui-measure text-muted-foreground">Review page for the workspace kit. Not part of the release build.</p>

      <Block title="Type scale">
        <p className="ui-title">Page title 22 semibold</p>
        <p className="ui-section">Section 13 semibold</p>
        <p className="ui-body ui-measure">Body 13.5 on a 1.55 line, kept to a reading measure of at most seventy-two characters wide.</p>
        <p className="ui-meta text-muted-foreground">Meta 11.5</p>
      </Block>

      <Block title="Voiceprint marks">
        <div className="flex flex-wrap items-center gap-6">
          {WORKSPACE_HUES.map((h, i) => (
            <span key={h.id} className="inline-flex items-center gap-2">
              <VoiceprintMark id={`workspace-${i}-${h.id}`} hue={h.id} size={24} />
              <span className="ui-body">{h.name}</span>
            </span>
          ))}
        </div>
      </Block>

      <Block title="Context wave">
        <div className="mb-3">
          <Segmented
            label="Items"
            value={String(wave)}
            onChange={(v) => setWave(Number(v))}
            options={[
              { value: "0", label: "None" },
              { value: "1", label: "One" },
              { value: "40", label: "40" },
              { value: "400", label: "400" },
            ]}
          />
        </div>
        <ContextWave bars={bars} window={128000} budget={24000} onSelect={(s) => setPick(s.layer)} />
      </Block>

      <Block title="Meeting wave">
        <MeetingWave meetings={MEETINGS} hue="violet" onOpen={(id) => setName(id)} />
        <p className="ui-meta mb-1 mt-5 text-muted-foreground">Three meetings</p>
        <MeetingWave meetings={MEETINGS.slice(1, 4)} hue="teal" onOpen={(id) => setName(id)} />
      </Block>

      <Block title="Controls">
        <div className="flex flex-wrap items-start gap-6">
          <Switch checked={on} onChange={setOn} label="Prepare recaps with AI" description="Uses the model shown in Settings" />
          <Segmented label="Depth" value={mode} onChange={setMode} options={[{ value: "lean", label: "Lean" }, { value: "balanced", label: "Balanced" }, { value: "deep", label: "Deep" }]} />
          <Select label="Workspace" value={pick} onChange={setPick} options={options} />
          <Combobox label="Borrow from" value={pick} onChange={setPick} options={options} />
          <Menu
            label="Panels"
            renderTrigger={(props) => (
              <Button {...props}>Panels</Button>
            )}
            items={[
              { id: "t", label: "Transcript", checked: true, onSelect: () => {} },
              { id: "n", label: "Notes", checked: false, hint: <Kbd>N</Kbd>, onSelect: () => {} },
              { id: "d", label: "Delete layout", danger: true, separatorBefore: true, onSelect: () => {} },
            ]}
          />
          <Tooltip content="Search deeper uses the deep budget">
            <Button>Hover or focus me</Button>
          </Tooltip>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <VoiceprintMark id="inline" hue={hue} size={18} />
          <InlineEdit value={name} onCommit={setName} label="workspace" className="ui-section" />
        </div>
        <div className="mt-4">
          <ColorSwatches value={hue} onChange={setHue} />
        </div>
      </Block>

      <Block title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg">Start meeting</Button>
          <Button variant="primary">Primary</Button>
          <Button>Quiet</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button size="sm">Small quiet</Button>
          <Button disabled>Disabled</Button>
          <IconButton aria-label="Add"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></IconButton>
          <IconButton aria-label="Add (larger)" size="md" variant="quiet"><Plus className="h-4 w-4" aria-hidden="true" /></IconButton>
        </div>
      </Block>

      <Block title="Dialogs and sheets">
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setDialog("plain")}>Dialog</Button>
          <Button variant="danger" onClick={() => setDialog("danger")}>Confirm delete</Button>
          <Button onClick={() => setDialog("sheet")}>Slide over</Button>
        </div>
        <Dialog
          open={dialog === "plain"}
          onClose={() => setDialog(null)}
          title="New workspace"
          description="A place for the meetings, chats and material of one job."
          footer={<Button variant="primary" onClick={() => setDialog(null)}>Create</Button>}
        >
          <InlineEdit value="" onCommit={() => {}} label="name" placeholder="Name" />
        </Dialog>
        <ConfirmDialog
          open={dialog === "danger"}
          title="Delete Acme renewal?"
          body="Its 12 meetings move to General. Documents stay in the library."
          confirmLabel="Delete workspace"
          tone="danger"
          onConfirm={() => setDialog(null)}
          onCancel={() => setDialog(null)}
        />
        <SlideOver open={dialog === "sheet"} onClose={() => setDialog(null)} title="Library">
          <p className="ui-body text-muted-foreground">Documents, folders and tools.</p>
        </SlideOver>
      </Block>

      <Block title="Talking points: text styles">
        <TextStylesBlock />
      </Block>

      <Block title="Talking points: the reader's offers">
        <OffersBlock />
      </Block>

      <Block title="Assistant footer chips (off, then on)">
        <ChipsBlock />
      </Block>

      <Block title="Empty state">
        <EmptyState
          mark={<VoiceprintMark id="empty" size={28} />}
          title="No meetings yet"
          body="Start one, or add material to ask questions across it."
          action={<Button variant="primary">Start meeting</Button>}
        />
      </Block>
    </div>
  );
}
