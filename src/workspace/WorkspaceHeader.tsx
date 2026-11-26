import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronDown, Library, Loader2, PencilLine, Play, Radio } from "lucide-react";
import { MeetingWave, VoiceprintMark, type WaveMeeting } from "../voiceprint";
import { Tooltip, Button, IconButton } from "../ui";
import { cn } from "../lib/utils";
import { formatShortcut } from "../lib/shortcutLabel";
import { useConfigStore } from "../stores/configStore";
import type { WorkspaceSummary } from "../lib/types";
import { AGG_PREFIX } from "./waveMeetings";
import { HEADER_ROW } from "./headerCollapse";
import type { HeaderMode } from "./headerCollapse";
import type { HeaderParts } from "./useHeaderCollapse";
import { SWITCHER_SHORTCUT } from "./WorkspaceSwitcher";

/** Column widths (of this pane, not the window) where the header gives something up. */
export const HEADER_ICONS_BELOW = 700;
export const HEADER_NAME_ONLY_BELOW = 440;
/** Under this the bar has no room for a mini wave; the full header still has the whole one. */
export const MINI_WAVE_BELOW = 600;
/** The bar also holds the wave and Start, so its tools are icons until the column is this wide. */
export const BAR_ICONS_BELOW = 940;

/** "Online, team meeting": what Start will use, said under the button. */
export function startHint(remembered: { audioMode: string; scenario: string } | null, workspace: WorkspaceSummary): string {
  if (remembered) {
    const mode = remembered.audioMode === "online" ? "Online" : "In person";
    const scenario = (workspace.default_scenario ?? remembered.scenario).replace(/^custom_.*/, "custom scenario").replace(/_/g, " ");
    return `${mode}, ${scenario}`;
  }
  return formatShortcut("CmdOrCtrl+M");
}

/** One recipe for both Start meeting buttons: md in the bar, lg in the full header. */
function StartButton({ starting, onStart, small }: { starting: boolean; onStart: () => void; small?: boolean }) {
  return (
    <Button variant="primary" size={small ? "md" : "lg"} onClick={onStart} disabled={starting} aria-busy={starting}>
      {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" fill="currentColor" aria-hidden="true" />}
      {starting ? "Starting" : "Start meeting"}
    </Button>
  );
}

/** What is not for the keyboard or a screen reader while its layer is out of view. */
const INERT = { inert: "" } as Record<string, string>;
const away = (hidden: boolean) => (hidden ? { "aria-hidden": true as const, ...INERT } : {});

export interface WorkspaceHeaderProps {
  workspace: WorkspaceSummary;
  wave: WaveMeeting[];
  total: number;
  starting: boolean;
  live: boolean;
  unavailable: boolean;
  /** Measured width of this pane. */
  width: number;
  /** The collapsing kind: an overlay that condenses as the chat scrolls. Otherwise the full header sits in the flow. */
  collapsing: boolean;
  mode: HeaderMode;
  pinned: boolean;
  /** Pixels the full block is taller than the bar (the overlay's room). */
  extra: number;
  parts: HeaderParts;
  onExtra: (px: number) => void;
  onToggle: () => void;
  onStart: () => void;
  onOpenMeeting: (id: string) => void;
  onEdit: () => void;
  onGoAll: () => void;
  onSwitch: () => void;
  showLibraryToggle: boolean;
  onToggleLibrary: () => void;
}

/**
 * One header for the start screen and the chat. Full: crumbs, the name, Start with what it will use,
 * and the whole wave with its months. In a chat it becomes the bar (crumbs, a mini wave, the count,
 * Start) as you scroll: the full block slides up under the bar and fades, the bar's extras arrive.
 * Both layers are always there; the one out of view is hidden from the keyboard and screen readers.
 */
export function WorkspaceHeader(p: WorkspaceHeaderProps) {
  const remembered = useConfigStore((s) => s.rememberedMeetingSetup);
  const { workspace } = p;
  const iconsOnly = p.width < HEADER_ICONS_BELOW;
  const nameOnly = p.width < HEADER_NAME_ONLY_BELOW;
  const showMini = p.collapsing && p.width >= MINI_WAVE_BELOW && p.wave.length > 0;
  const full = !p.collapsing || p.mode === "full";
  const blockRef = p.parts.block;
  const measured = useRef(0);

  // Measure the full block once per size change: it is the room the overlay needs and the Transcript keeps.
  useLayoutEffect(() => {
    const el = blockRef.current;
    if (!el) return;
    const read = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0 && h !== measured.current) {
        measured.current = h;
        p.onExtra(h);
      }
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
    // onExtra is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockRef]);

  const open = (id: string) => !id.startsWith(AGG_PREFIX) && p.onOpenMeeting(id);

  const crumbs = (
    <nav aria-label="Breadcrumb" className={cn("ui-meta flex min-w-0 items-center gap-1 overflow-hidden text-muted-foreground", p.collapsing ? "shrink" : "flex-1")}>
      {!nameOnly && (
        <>
          <Button variant="ghost" size="sm" onClick={p.onGoAll} className="px-1.5">
            Workspaces
          </Button>
          <span aria-hidden="true" className="shrink-0">
            /
          </span>
        </>
      )}
      <Tooltip content={workspace.name}>
        {/* Buttons do not shrink by default: this one must, or a long name runs under the tools. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={p.onSwitch}
          aria-haspopup="dialog"
          aria-label={`${workspace.name}, switch workspace (${formatShortcut(SWITCHER_SHORTCUT)})`}
          className="min-w-0 shrink overflow-hidden px-1.5 text-foreground"
        >
          <VoiceprintMark id={workspace.id} hue={workspace.color} size={13} />
          <span dir="auto" className="min-w-0 truncate">
            {workspace.name}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </Button>
      </Tooltip>
    </nav>
  );

  const renderTools = (iconsOnly: boolean) => (
    <div className="flex shrink-0 items-center gap-1">
      {p.live && (
        <span className="ui-meta inline-flex items-center gap-1.5 px-1 text-success">
          <Radio className="h-3 w-3" aria-hidden="true" />
          {iconsOnly ? <span className="sr-only">Live</span> : "Live"}
        </span>
      )}
      {iconsOnly ? (
        <Tooltip content="Edit workspace">
          <IconButton aria-label="Edit workspace" onClick={p.onEdit}>
            <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </Tooltip>
      ) : (
        <Button variant="ghost" onClick={p.onEdit}>
          <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
          Edit workspace
        </Button>
      )}
      {p.showLibraryToggle &&
        (iconsOnly ? (
          <Tooltip content="Library">
            <IconButton aria-label="Library" onClick={p.onToggleLibrary}>
              <Library className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </Tooltip>
        ) : (
          <Button variant="ghost" onClick={p.onToggleLibrary}>
            <Library className="h-3.5 w-3.5" aria-hidden="true" />
            Library
          </Button>
        ))}
    </div>
  );
  const tools = renderTools(iconsOnly);
  const barTools = renderTools(p.width < BAR_ICONS_BELOW);

  const count = (
    <Tooltip content="Each bar is one meeting, as long as it ran.">
      <span tabIndex={0} className="ui-meta inline-block rounded text-muted-foreground outline-none ui-focus ui-focus-sm">
        {p.total} {p.total === 1 ? "meeting" : "meetings"}
      </span>
    </Tooltip>
  );

  const px = iconsOnly ? "px-4" : "px-6";
  const expanded = full;

  // The bar's own extras. Only the collapsing kind has them; they are the compact layer.
  const barExtras = p.collapsing && (
    <div ref={p.parts.extras} className="flex min-w-0 flex-1 items-center justify-end gap-3" {...away(p.mode === "full")}>
      {showMini && (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <MeetingWave meetings={p.wave} hue={workspace.color} onOpen={open} height={20} mini />
          </div>
          {count}
        </div>
      )}
      {!showMini && <div className="flex-1" />}
      {barTools}
      <StartButton starting={p.starting} onStart={p.onStart} small />
    </div>
  );

  const chevron = p.collapsing && (
    <Tooltip content={expanded ? "Collapse the header" : "Show the full header"}>
      <IconButton aria-label={expanded ? "Collapse the header" : "Expand the header"} aria-expanded={expanded} onClick={p.onToggle}>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );

  const block: ReactNode = (
    <div
      ref={blockRef}
      className={cn(px, "pb-4", p.collapsing && "absolute inset-x-0 will-change-transform")}
      style={p.collapsing ? { top: HEADER_ROW } : undefined}
      {...away(p.collapsing && p.mode === "compact")}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex min-w-0 items-center gap-3">
            <VoiceprintMark id={workspace.id} hue={workspace.color} size={26} />
            <h1 dir="auto" className="ui-title min-w-0 truncate text-foreground">
              {workspace.name}
            </h1>
          </div>
          {workspace.description && <p className="ui-body ui-measure mt-1.5 text-muted-foreground">{workspace.description}</p>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <StartButton starting={p.starting} onStart={p.onStart} />
          <span className="ui-meta text-muted-foreground">{startHint(remembered, workspace)}</span>
        </div>
      </div>

      <div className="mt-4 flex min-w-0 items-end justify-between gap-3">
        <div className="min-w-0 flex-1 pb-3">
          {p.wave.length > 0 ? (
            <>
              <MeetingWave meetings={p.wave} hue={workspace.color} onOpen={open} height={30} />
              <Tooltip content="Each bar is one meeting, as long as it ran.">
                <span tabIndex={0} className="ui-meta mt-1 inline-block rounded text-muted-foreground outline-none ui-focus ui-focus-sm">
                  {p.total} {p.total === 1 ? "meeting" : "meetings"}
                </span>
              </Tooltip>
            </>
          ) : (
            <p className="ui-meta text-muted-foreground">No meetings yet. Each one you hold here becomes a bar.</p>
          )}
        </div>
        {tools}
      </div>
      {p.unavailable && (
        <p className="ui-meta mt-3 rounded-lg bg-accent px-3 py-2 text-foreground" role="note">
          Workspaces aren't available right now. Everything is in General, and NexQ works as before.
        </p>
      )}
    </div>
  );

  return (
    <>
      {p.collapsing && <div aria-hidden="true" className="shrink-0" style={{ height: HEADER_ROW }} />}
      <header
        ref={p.parts.overlay}
        data-header-shell=""
        className={cn(p.collapsing ? "absolute inset-x-0 top-0 z-20 bg-background" : "relative shrink-0", p.pinned && "shadow-[0_18px_28px_-18px_rgba(0,0,0,0.55)]")}
        style={p.collapsing ? { height: HEADER_ROW + p.extra } : undefined}
      >
        <div className={cn("relative z-10 flex items-center gap-2 bg-background", px)} style={{ height: HEADER_ROW }}>
          {crumbs}
          {barExtras}
          {!p.collapsing && <div className="flex-1" />}
          {chevron}
        </div>
        {block}
      </header>
    </>
  );
}
