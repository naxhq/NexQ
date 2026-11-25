import type { Ref } from "react";
import { Pause, Play } from "lucide-react";
import type { ReadingSettings, ScrollKind } from "../../stores/talkingPointsStore";
import { Kbd, Segmented, Tooltip } from "../../ui";
import type { PrompterState } from "./prompterTypes";
import type { FollowAvailability } from "./voice";

const FOLLOW_TEXT: Record<string, string> = {
  following: "Following you",
  unsure: "Listening",
  lost: "Lost your place. Scroll to show me.",
  paused: "Waiting for you",
};

/** How the note moves (manual, auto, my voice), play and pause, what is left to say, and the progress line. */
export function ReaderControls({
  reading,
  availability,
  p,
  honesty,
  saidLabel,
  progressRef,
  onMode,
}: {
  reading: ReadingSettings;
  availability: FollowAvailability;
  p: Pick<PrompterState, "playing" | "play" | "pause" | "followState">;
  honesty: string | null;
  saidLabel: string | null;
  progressRef: Ref<HTMLSpanElement>;
  onMode: (mode: ScrollKind) => void;
}) {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 pb-1.5 pt-1">
        <Segmented
          label="How the note moves"
          value={reading.mode}
          onChange={onMode}
          options={[
            { value: "manual", label: "Manual" },
            { value: "auto", label: "Auto" },
            { value: "voice", label: "My voice", ariaLabel: availability.ok ? "Follow my voice" : `Follow my voice, unavailable. ${availability.message}` },
          ]}
        />
        {reading.mode === "auto" && (
          <Tooltip
            content={
              <span className="inline-flex items-center gap-2">
                {p.playing ? "Pause" : "Play"}
                <Kbd>Space</Kbd>
              </span>
            }
          >
            <button
              type="button"
              aria-label={p.playing ? "Pause auto-scroll" : "Start auto-scroll"}
              onClick={() => (p.playing ? p.pause() : p.play())}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 ui-focus ui-focus-pill"
            >
              {p.playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            </button>
          </Tooltip>
        )}
        {reading.mode === "auto" && <span className="ui-meta text-muted-foreground tabular-nums">{reading.wpm} words a minute</span>}
        {saidLabel && (
          <span className="ui-meta ml-auto shrink-0 tabular-nums text-muted-foreground" aria-live="polite">
            {saidLabel}
          </span>
        )}
        {reading.mode === "voice" && availability.ok && p.followState !== "off" && (
          <span className="ui-meta text-muted-foreground" role="status">
            {FOLLOW_TEXT[p.followState]}
          </span>
        )}
      </div>
      {reading.mode === "voice" && availability.ok && honesty && (
        <p className="ui-meta shrink-0 px-3 pb-1.5 text-muted-foreground">{honesty}</p>
      )}
      {reading.mode === "voice" && !availability.ok && (
        <p className="ui-meta shrink-0 px-3 pb-1.5 text-muted-foreground" role="status">
          {availability.message}
        </p>
      )}
      <div className="tp-progress shrink-0" aria-hidden>
        <span ref={progressRef} style={{ transform: "scaleX(0)" }} />
      </div>
    </>
  );
}
