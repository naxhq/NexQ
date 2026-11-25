// WaveformCanvas — canvas-based waveform visualization with markers and scrubbing
// Renders waveform bars, bookmark markers, topic section dividers, and a glowing playhead.
// Supports click-to-seek and drag-to-scrub.
//
// Performance: the bars are rendered once into offscreen layers (rebuilt only
// when peaks or canvas size change); each frame just blits the layers and
// draws the cheap overlays (topic dividers, bookmarks, playhead).

import React, { memo, useRef, useEffect, useCallback, useMemo, useState } from "react";
import type { WaveformData, MeetingBookmark, TopicSection } from "@/lib/types";
import { downsamplePeaks } from "@/lib/waveform";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WaveformCanvasProps {
  waveformData: WaveformData;
  /** Playback time for static renders (paused / seeking). May update at a low rate. */
  currentTimeMs: number;
  /**
   * Live playback time, written every animation frame by the player. While
   * `isPlaying`, the canvas runs its own RAF loop off this ref so the playhead
   * stays smooth even though `currentTimeMs` (React state) is throttled.
   */
  liveTimeRef?: React.MutableRefObject<number>;
  isPlaying?: boolean;
  durationMs: number;
  meetingStartMs: number;
  recordingOffsetMs: number;
  bookmarks?: MeetingBookmark[];
  topicSections?: TopicSection[];
  onSeek: (ms: number) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Colors are fixed literals (not CSS variables), so the cached bar layers do
// not depend on the app theme. If these ever become theme-driven, resolve them
// at render time and add them to the layer useMemo deps below.
const COLOR_PLAYED = "#6366f1";                          // indigo 500, 3:1 or better on both themes
const COLOR_UNPLAYED = "rgba(100, 116, 139, 0.45)";      // slate, visible on light and dark
const COLOR_PLAYHEAD = "#6366f1";
const COLOR_BOOKMARK = "#d97706";                        // amber 600
const COLOR_TOPIC = "rgba(5, 150, 105, 0.55)";           // emerald 600

const BAR_GAP_RATIO = 0.08;   // minimal gap for smooth continuous look
const BAR_STRIDE_PX = 3;      // device px per bar slot — caps bar count to canvas resolution
const PLAYHEAD_WIDTH = 2;     // px (logical)
const BOOKMARK_RADIUS = 2.5;  // px (logical) — ~5 px diameter
const BOOKMARK_GLOW_BLUR = 6; // px shadow blur for bookmark dots
const PLAYHEAD_GLOW_BLUR = 8; // px shadow blur for playhead
const MIN_BAR_H = 1.5;        // minimum bar height for silence

// Module-level defaults: a fresh `[]` per render would defeat memoisation.
const NO_BOOKMARKS: MeetingBookmark[] = [];
const NO_TOPIC_SECTIONS: TopicSection[] = [];

// ---------------------------------------------------------------------------
// Static bar layers (rendered once per peaks/size, blitted every frame)
// ---------------------------------------------------------------------------

interface CanvasSize {
  width: number;   // logical (CSS) px
  height: number;  // logical (CSS) px
  dpr: number;
}

interface BarLayers {
  played: HTMLCanvasElement;
  unplayed: HTMLCanvasElement;
  slotW: number;
  barW: number;
  gapW: number;
}

function renderBarLayers(bars: number[], size: CanvasSize): BarLayers | null {
  const { width, height, dpr } = size;
  const numBars = bars.length;
  if (numBars === 0 || width <= 0 || height <= 0) return null;

  const make = (color: string) => {
    const layer = document.createElement("canvas");
    layer.width = Math.round(width * dpr);
    layer.height = Math.round(height * dpr);
    const ctx = layer.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = color;
    return { layer, ctx };
  };
  const played = make(COLOR_PLAYED);
  const unplayed = make(COLOR_UNPLAYED);
  if (!played || !unplayed) return null;

  // --- slot & bar geometry ---
  const slotW = width / numBars;
  const gapW = slotW * BAR_GAP_RATIO;
  const barW = Math.max(1, slotW - gapW);
  const radius = Math.min(barW / 2, 1.5);

  // Auto-normalize: find max peak amplitude
  let maxAmplitude = 0;
  for (let i = 0; i < numBars; i++) maxAmplitude = Math.max(maxAmplitude, bars[i]);
  const ampScale = maxAmplitude > 0.01 ? 1.0 / maxAmplitude : 1;

  // sqrt scaling compresses dynamic range: quiet parts stay visible,
  // loud parts don't all clip to the same height.
  const maxBarH = height * 0.92;
  played.ctx.beginPath();
  unplayed.ctx.beginPath();
  for (let i = 0; i < numBars; i++) {
    const barH = Math.max(MIN_BAR_H, Math.sqrt(bars[i] * ampScale) * maxBarH);
    const x = i * slotW + gapW / 2;
    const y = (height - barH) / 2;
    played.ctx.roundRect(x, y, barW, barH, radius);
    unplayed.ctx.roundRect(x, y, barW, barH, radius);
  }
  played.ctx.fill();
  unplayed.ctx.fill();

  return { played: played.layer, unplayed: unplayed.layer, slotW, barW, gapW };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function WaveformCanvasImpl({
  waveformData,
  currentTimeMs,
  liveTimeRef,
  isPlaying = false,
  durationMs,
  bookmarks = NO_BOOKMARKS,
  topicSections = NO_TOPIC_SECTIONS,
  onSeek,
  className,
}: WaveformCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 });

  // -------------------------------------------------------------------------
  // Size tracking — one ResizeObserver for the component's lifetime
  // -------------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const next: CanvasSize = {
        width: container.clientWidth,
        height: container.clientHeight,
        dpr: window.devicePixelRatio || 1,
      };
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr
          ? prev
          : next
      );
    };

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, []);

  // -------------------------------------------------------------------------
  // Peaks -> one magnitude per bar slot, capped to canvas resolution
  // -------------------------------------------------------------------------

  const magnitudes = useMemo(
    () => waveformData.peaks.map(([min, max]) => Math.max(Math.abs(min), Math.abs(max))),
    [waveformData]
  );

  const bars = useMemo(() => {
    if (size.width <= 0) return [];
    const target = Math.ceil((size.width * size.dpr) / BAR_STRIDE_PX);
    return downsamplePeaks(magnitudes, target);
  }, [magnitudes, size.width, size.dpr]);

  // Static layers: rebuilt only when peaks or canvas size change.
  const layers = useMemo(() => renderBarLayers(bars, size), [bars, size]);

  // -------------------------------------------------------------------------
  // Draw: blit cached layers, then overlays (topics, bookmarks, playhead)
  // -------------------------------------------------------------------------

  const draw = useCallback((timeMs: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { width: logicalW, height: logicalH, dpr } = size;
    const pxW = Math.round(logicalW * dpr);
    const pxH = Math.round(logicalH * dpr);

    // Resize canvas backing store to match container + DPR
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!layers || durationMs <= 0) return;

    const progress = Math.min(1, Math.max(0, timeMs / durationMs));
    const playheadX = progress * logicalW;

    // --- bars: bar i is "played" when its centre is at/before the playhead ---
    const { slotW, barW, gapW } = layers;
    const playedCount = Math.min(
      bars.length,
      Math.max(0, Math.floor((playheadX - gapW / 2 - barW / 2) / slotW) + 1)
    );
    const layerW = layers.played.width;
    const layerH = layers.played.height;
    const splitPx = Math.min(layerW, Math.round(playedCount * slotW * dpr));
    if (splitPx > 0) {
      ctx.drawImage(layers.played, 0, 0, splitPx, layerH, 0, 0, splitPx, layerH);
    }
    if (splitPx < layerW) {
      ctx.drawImage(
        layers.unplayed, splitPx, 0, layerW - splitPx, layerH,
        splitPx, 0, layerW - splitPx, layerH
      );
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // --- topic section dividers (dashed vertical lines) ---
    if (topicSections.length > 0) {
      ctx.save();
      ctx.strokeStyle = COLOR_TOPIC;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const section of topicSections) {
        if (section.start_ms <= 0) continue; // skip if at very beginning
        const x = (section.start_ms / durationMs) * logicalW;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, logicalH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // --- bookmark markers (amber dots at top edge) ---
    if (bookmarks.length > 0) {
      ctx.save();
      ctx.shadowColor = COLOR_BOOKMARK;
      ctx.shadowBlur = BOOKMARK_GLOW_BLUR;
      ctx.fillStyle = COLOR_BOOKMARK;
      for (const bookmark of bookmarks) {
        const x = (bookmark.timestamp_ms / durationMs) * logicalW;
        const y = BOOKMARK_RADIUS + 1; // sit just inside the top edge
        ctx.beginPath();
        ctx.arc(x, y, BOOKMARK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // --- playhead (glowing vertical line) ---
    ctx.save();
    ctx.shadowColor = COLOR_PLAYHEAD;
    ctx.shadowBlur = PLAYHEAD_GLOW_BLUR;
    ctx.strokeStyle = COLOR_PLAYHEAD;
    ctx.lineWidth = PLAYHEAD_WIDTH;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, logicalH);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }, [layers, bars, size, durationMs, bookmarks, topicSections]);

  // Static redraw whenever inputs (or the throttled time prop) change.
  useEffect(() => {
    draw(isPlaying && liveTimeRef ? liveTimeRef.current : currentTimeMs);
  }, [draw, currentTimeMs, isPlaying, liveTimeRef]);

  // While playing, redraw every animation frame from the live ref.
  useEffect(() => {
    if (!isPlaying || !liveTimeRef) return;
    let raf = requestAnimationFrame(function tick() {
      draw(liveTimeRef.current);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, liveTimeRef, draw]);

  // -------------------------------------------------------------------------
  // Interaction helpers
  // -------------------------------------------------------------------------

  const seekFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || durationMs <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      onSeek(fraction * durationMs);
    },
    [durationMs, onSeek]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      isDragging.current = true;
      seekFromEvent(e);
    },
    [seekFromEvent]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDragging.current) return;
      seekFromEvent(e);
    },
    [seekFromEvent]
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleMouseLeave = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      seekFromEvent(e);
    },
    [seekFromEvent]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          cursor: "pointer",
          display: "block",
        }}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}

// Memoised: AudioPlayer re-renders on every throttled time update; skip the
// canvas component when its props are unchanged.
export const WaveformCanvas = memo(WaveformCanvasImpl);

export default WaveformCanvas;
