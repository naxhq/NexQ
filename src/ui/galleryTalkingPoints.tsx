// Review blocks for the meeting window: talking points text styles, the reader's offers and the
// assistant footer chips. Used by the UI gallery only (dev builds).

import { useMemo, useState } from "react";
import { BookOpen, Clock3, Wrench } from "lucide-react";
import { DocView, type BlockState } from "../talking-points/reader/DocView";
import { docFromText } from "../talking-points/doc/model";
import { ReadingSettingsPopover } from "../talking-points/prompter/ReadingSettingsPopover";
import { ReaderOffers } from "../talking-points/prompter/ReaderOffers";
import type { PrompterState } from "../talking-points/prompter/prompterTypes";
import { DEFAULT_READING, type ReadingSettings } from "../stores/talkingPointsStore";
import { CHIP_BASE, CHIP_OFF } from "../overlay/chipStyles";
import { cn } from "../lib/utils";

const LINES = [
  "Open with the quarter in one sentence",
  "Revenue grew twelve percent on enterprise renewals",
  "Churn fell to two point one percent after the support overhaul",
  "We hired fourteen engineers across three teams",
  "Next quarter: offline mode and the new billing dashboard",
  "The main risk is the data migration in November",
];
const ORDER: BlockState[] = ["said", "autosaid", "past", "current", "ahead", "ahead"];

export function TextStylesBlock() {
  const [reading, setReading] = useState<ReadingSettings>({ ...DEFAULT_READING, mode: "auto" });
  const doc = useMemo(() => docFromText(LINES.join("\n")), []);
  const states = useMemo(() => new Map(doc.content.flatMap((b, i) => (b.type === "paragraph" ? [[b.attrs.id, ORDER[i]] as const] : []))), [doc]);
  return (
    <div className="grid gap-4 md:grid-cols-[20rem_1fr]">
      <div className="rounded-xl border border-border bg-popover">
        <ReadingSettingsPopover reading={reading} onChange={(patch) => setReading((r) => ({ ...r, ...patch }))} />
      </div>
      <div className="rounded-xl border border-border bg-background p-4" style={{ fontSize: 20, lineHeight: 1.5 }}>
        <DocView doc={doc} states={states} ticks focusDim textStyle={reading.textStyle} />
      </div>
    </div>
  );
}

const noop = () => {};
const mock = (over: Partial<PrompterState>) =>
  ({ suggestion: null, canGoBack: false, yielding: false, goToSuggestion: noop, goBack: noop, resume: noop, ...over }) as unknown as PrompterState;

export function OffersBlock() {
  const cases: Array<[string, Partial<PrompterState>]> = [
    ["Paused, with a Go to offer", { yielding: true, suggestion: { blockId: "b", text: "Churn fell to two point one percent", edge: "bottom" } }],
    ["Paused, Go to and Back", { yielding: true, canGoBack: true, suggestion: { blockId: "b", text: "The main risk is the data migration", edge: "bottom" } }],
    ["Paused, Go to at the top", { yielding: true, suggestion: { blockId: "b", text: "Open with the quarter", edge: "top" } }],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {cases.map(([title, p]) => (
        <figure key={title}>
          <div className="relative h-56 overflow-hidden rounded-xl border border-border bg-background p-3 text-muted-foreground">
            {LINES.slice(0, 5).map((l) => (
              <p key={l} className="py-1">{l}</p>
            ))}
            <ReaderOffers p={mock(p)} readingMode="auto" />
          </div>
          <figcaption className="ui-meta mt-1 text-muted-foreground">{title}</figcaption>
        </figure>
      ))}
    </div>
  );
}

const ON = {
  notes: "bg-highlight/20 text-highlight ring-1 ring-highlight/30 shadow-sm shadow-highlight/10",
  tools: "bg-primary/20 text-primary ring-1 ring-primary/30 shadow-sm shadow-primary/10",
};

export function ChipsBlock() {
  const [on, setOn] = useState({ notes: false, tools: false });
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-background p-3">
      <button type="button" data-chip="" className={cn(CHIP_BASE, CHIP_OFF)}>
        <Clock3 className="h-3 w-3" aria-hidden /> <span>Last 2 min</span>
      </button>
      {(["notes", "tools"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="switch"
          data-chip=""
          aria-checked={on[k]}
          onClick={() => setOn((s) => ({ ...s, [k]: !s[k] }))}
          className={cn(CHIP_BASE, on[k] ? ON[k] : CHIP_OFF)}
        >
          {k === "notes" ? <BookOpen className="h-3 w-3" aria-hidden /> : <Wrench className="h-3 w-3" aria-hidden />}
          <span>{k === "notes" ? "Notes" : "Tools"}</span>
        </button>
      ))}
    </div>
  );
}
