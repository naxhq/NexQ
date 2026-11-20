import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { cancelGeneration } from "../lib/ipc";
import { runYourAction, useAutoAnswerRunning } from "../lib/autoAnswer";
import { AskImageChips, askPlaceholder, useAskImages } from "./AskImages";
import { SCREENSHOT_EVENT, takePendingScreenshots } from "../lib/screenCapture";
import { sendAsk } from "./sendAsk";
import { DEFAULT_CONTEXT_SCOPE, scopeHint } from "../lib/contextScope";
import { showToast } from "../stores/toastStore";
import { ContextScopePicker } from "./ContextScopePicker";
import type { IntelligenceMode } from "../lib/types";
import {
  Loader2,
  Sparkles,
  MessageSquare,
  Scissors,
  CornerUpRight,
  ListChecks,
  HelpCircle,
  Wand2,
  Send,
  X,
} from "lucide-react";

// Icon mapping for built-in modes
const MODE_ICONS: Record<string, typeof Sparkles> = {
  Assist: Sparkles,
  WhatToSay: MessageSquare,
  Shorten: Scissors,
  FollowUp: CornerUpRight,
  Recap: ListChecks,
  AskQuestion: HelpCircle,
};

// Built-in shortcuts
const MODE_SHORTCUTS: Record<string, string> = {
  Assist: "Space",
  WhatToSay: "1",
  Shorten: "2",
  FollowUp: "3",
  Recap: "4",
  AskQuestion: "5",
};

// Ordered built-in modes — AskQuestion now included
const BUILT_IN_ORDER = ["Assist", "WhatToSay", "Shorten", "FollowUp", "Recap", "AskQuestion"];

export function ModeButtons() {
  const currentMode = useStreamStore((s) => s.currentMode);
  const streaming = useStreamStore((s) => s.isStreaming);
  // A clicked action awaiting its start counts as running.
  const sending = useStreamStore((s) => s.phase === "sending");
  const isStreaming = streaming || sending;
  // An automatic answer gives way to what you ask for; an answer you asked for doesn't.
  const autoRunning = useAutoAnswerRunning();
  const locked = isStreaming && !autoRunning;
  const contextScope = useConfigStore((s) => s.contextScope ?? DEFAULT_CONTEXT_SCOPE);
  const actions = useAIActionsStore((s) => s.configs.actions);
  const [askInputText, setAskInputText] = useState("");
  const [askInputVisible, setAskInputVisible] = useState(false);

  // Listen for keyboard shortcut (Digit5) to toggle ask input
  useEffect(() => {
    const handler = () => setAskInputVisible((v) => !v);
    window.addEventListener("nexq:toggle-ask-input", handler);
    return () => window.removeEventListener("nexq:toggle-ask-input", handler);
  }, []);

  // Build ordered list: built-in modes first (in order), then custom actions
  const visibleModes = useMemo(() => {
    const result: { mode: string; label: string; shortcut: string; icon: typeof Sparkles; isCustom: boolean }[] = [];

    // Add built-in modes in order
    for (const modeKey of BUILT_IN_ORDER) {
      const cfg = actions[modeKey];
      if (cfg && cfg.visible) {
        result.push({
          mode: cfg.mode,
          label: cfg.name,
          shortcut: MODE_SHORTCUTS[modeKey] || "",
          icon: MODE_ICONS[modeKey] || Wand2,
          isCustom: false,
        });
      }
    }

    // Add custom actions
    for (const [key, cfg] of Object.entries(actions)) {
      if (!cfg.isBuiltIn && cfg.visible) {
        result.push({
          mode: cfg.mode,
          label: cfg.name,
          shortcut: "",
          icon: Wand2,
          isCustom: true,
        });
      }
    }

    return result;
  }, [actions]);

  const handleClick = useCallback(
    (mode: string) => {
      if (isStreaming) {
        if (streaming && currentMode === mode) {
          cancelGeneration().catch(() => showToast("Couldn't cancel generation", "error"));
          return;
        }
        if (locked) return;
      }
      // AskQuestion mode: toggle ask input instead of direct generation
      if (mode === "AskQuestion") {
        setAskInputVisible((v) => !v);
        return;
      }
      runYourAction(mode).catch((err) => showToast(err instanceof Error ? err.message : "Couldn't generate AI response", "error"));
    },
    [isStreaming, locked, streaming, currentMode]
  );

  const {
    images: askImages,
    sending: askSending,
    setSending: setAskSending,
    canAttach: canAttachImage,
    announcement: askAnnouncement,
    onPaste: onAskPaste,
    attach: attachAskImages,
    remove: removeAskImage,
    removeSent: removeSentImages,
    clear: clearAskImages,
  } = useAskImages();

  // The overlay stays mounted between meetings: each meeting starts with an
  // empty Ask box (no leftover text or screenshots from the last one).
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  useEffect(() => {
    setAskInputText("");
    setAskInputVisible(false);
    clearAskImages();
  }, [meetingId, clearAskImages]);

  // The capture shortcut: open the Ask box with the screenshot attached, the
  // same way a paste would, and put the cursor in it (also when it was already
  // open). Also takes one that arrived before this mounted.
  const askInputRef = useRef<HTMLInputElement>(null);
  const [focusAsk, setFocusAsk] = useState(0);
  const wantsFocus = useRef(false);
  // The user's own answer is running: the Ask box stays hidden until it ends.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    const take = (e?: Event) => {
      const files = takePendingScreenshots();
      if (files.length === 0) return;
      e?.preventDefault(); // taken: nobody else needs to make room for it
      if (lockedRef.current) showToast("Screenshot added. Ask opens when this answer finishes.", "info");
      setAskInputVisible(true);
      attachAskImages(files);
      wantsFocus.current = true;
      setFocusAsk((n) => n + 1);
    };
    take();
    window.addEventListener(SCREENSHOT_EVENT, take);
    return () => window.removeEventListener(SCREENSHOT_EVENT, take);
  }, [attachAskImages]);
  useEffect(() => {
    // Waits for the Ask box to exist (it is hidden while an answer runs).
    if (wantsFocus.current && askInputRef.current) {
      askInputRef.current.focus();
      wantsFocus.current = false;
    }
  }, [focusAsk, locked, askInputVisible]);

  const handleAskSubmit = useCallback(() => {
    if (locked) return;
    // A screenshot taken while this request is on its way is not part of it.
    const carried = askSending ? [] : askImages;
    const sent = sendAsk({
      typed: askInputText,
      images: carried,
      fallbackError: "Couldn't send question",
      onSending: setAskSending,
      onSent: () => removeSentImages(carried),
      // A failed send keeps the typed text and the images, to send again.
      onFailed: (typed) => setAskInputText((current) => current || typed),
    });
    if (!sent) return;
    setAskInputText("");
    setAskInputVisible(false);
  }, [askInputText, askImages, askSending, locked, removeSentImages, setAskSending]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-0.5">
        {visibleModes.map(({ mode, label, shortcut, icon: Icon, isCustom }) => {
          const isActive = currentMode === mode && isStreaming;
          const isAskActive = mode === "AskQuestion" && askInputVisible && !isStreaming;
          const hint = scopeHint(contextScope, label);
          const name = hint ? `${label} · ${hint}` : label;
          return (
            <button
              key={mode}
              onClick={() => handleClick(mode)}
              disabled={locked && !isActive}
              aria-label={shortcut ? `${name} (${shortcut})` : name}
              title={shortcut ? `${name} (${shortcut})` : name}
              aria-pressed={isActive || isAskActive}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 text-meta font-medium transition-all duration-150 cursor-pointer ${
                isActive
                  ? "bg-primary/20 text-primary ring-1 ring-primary/30 shadow-sm shadow-primary/10"
                  : isAskActive
                    ? "bg-info/10 text-info ring-1 ring-info/20 shadow-sm shadow-info/10"
                    : isCustom
                      ? "text-warning/60 hover:bg-warning/10 hover:text-warning border border-warning/10"
                      : "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
              } ${locked && !isActive ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {isActive ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Icon className="h-3 w-3" aria-hidden="true" />}
              <span>{label}</span>
            </button>
          );
        })}
        <ContextScopePicker />
      </div>

      {/* Inline Ask input */}
      {askInputVisible && !locked && (
        <div
          className="flex flex-col gap-1 rounded-lg border border-info/20 bg-info/5 px-2 py-1 slide-down-enter"
          // Keys pressed on the thumbnails' remove buttons (Space, digits) must not
          // reach the meeting shortcuts; Escape closes the box from anywhere in it.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setAskInputVisible(false);
            }
          }}
        >
          <AskImageChips images={askSending ? [] : askImages} onRemove={removeAskImage} announcement={askAnnouncement} />
          <div className="flex items-center gap-1.5">
          <input
            ref={askInputRef}
            type="text"
            value={askInputText}
            onChange={(e) => setAskInputText(e.target.value)}
            onPaste={onAskPaste}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); handleAskSubmit(); }
              if (e.key === "Escape") { e.preventDefault(); setAskInputVisible(false); }
            }}
            placeholder={askPlaceholder(canAttachImage)}
            aria-label="Ask a question"
            autoFocus
            maxLength={2000}
            className="flex-1 min-w-0 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
          />
          <button
            onClick={handleAskSubmit}
            disabled={!askInputText.trim() && (askImages.length === 0 || askSending)}
            className="rounded-md p-1 text-info/60 hover:bg-info/10 hover:text-info disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Send question"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            onClick={() => setAskInputVisible(false)}
            className="rounded-md p-1 text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground transition-colors"
            aria-label="Close question input"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
          </div>
        </div>
      )}
    </div>
  );
}
