import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Speaker, IntelligenceMode } from "./types";

// shadcn/ui utility
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip <think>...</think> blocks from LLM output.
 * Handles both complete blocks and unclosed tags (mid-stream).
 */
export function stripThinkTags(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.indexOf("<think>");
  if (openIdx !== -1) {
    result = result.substring(0, openIdx);
  }
  return result.trimStart();
}

// Format milliseconds to MM:SS
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

// Format milliseconds to HH:MM:SS for long meetings
export function formatDurationLong(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return formatDuration(ms);
}

// Format timestamp for transcript display
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Format ISO date string to relative time
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Get speaker display color class
export function getSpeakerColor(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return "text-speaker-user";
    case "Interviewer":
    case "Them":
      return "text-speaker-interviewer";
    default:
      return "text-muted-foreground";
  }
}

// Get speaker label
export function getSpeakerLabel(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return "You";
    case "Interviewer":
      return "Interviewer";
    case "Them":
      return "Them";
    default:
      return speaker || "Unknown";
  }
}

// Get intelligence mode label
export function getModeLabel(mode: IntelligenceMode): string {
  switch (mode) {
    case "Assist":
      return "Assist";
    case "WhatToSay":
      return "Say";
    case "Shorten":
      return "Short";
    case "FollowUp":
      return "F/U";
    case "Recap":
      return "Recap";
    case "AskQuestion":
      return "Ask";
    case "MeetingSummary":
      return "Summary";
    case "ActionItemsExtraction":
      return "Actions";
    case "BookmarkSuggestions":
      return "Bookmarks";
    case "MeetingAsk":
      return "Ask meeting";
  }
}

// Format file size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Group meetings by date category
export function getDateGroup(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / 86400000
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  return "Earlier";
}
