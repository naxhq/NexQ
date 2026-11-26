import { useEffect, useRef } from "react";
import type { Meeting } from "../../lib/types";
import { FileText, NotebookText, Sparkles, MessageSquare, MessageCircleQuestion, Users, ListTodo, Bookmark, Loader2, ChevronDown } from "lucide-react";
import { Button, Menu, type MenuItemSpec } from "../../ui";
import { ExportDropdown } from "./ExportDropdown";

export type MeetingTab = "transcript" | "summary" | "notes" | "ask" | "ai" | "speakers" | "actions" | "bookmarks";

interface MeetingTabBarProps {
  activeTab: MeetingTab;
  setActiveTab: (tab: MeetingTab) => void;
  meeting: Meeting;
  onGenerateSummary?: () => void;
  onSuggestBookmarks?: () => void;
  onExtractActions?: () => void;
  isSummaryGenerating?: boolean;
  isBookmarksSuggesting?: boolean;
  isActionsExtracting?: boolean;
  /** Show the "Ask" tab (finished meetings only). */
  showAsk?: boolean;
  /** AI Log entries: AI interactions plus answered Ask questions. */
  aiLogCount?: number;
}

export function MeetingTabBar({ activeTab, setActiveTab, meeting, onGenerateSummary, onSuggestBookmarks, onExtractActions, isSummaryGenerating, isBookmarksSuggesting, isActionsExtracting, showAsk, aiLogCount }: MeetingTabBarProps) {
  const actionCount = meeting.action_items?.length ?? 0;
  const bookmarkCount = meeting.bookmarks?.length ?? 0;
  // Named remote speaker tags are labels for "Them" lines, not tab entries.
  const speakerCount = meeting.speakers?.filter((s) => s.source !== "remote_tag").length ?? 0;

  const strip = useRef<HTMLDivElement | null>(null);
  // The chosen tab is always in view, however narrow the window.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeTab]);

  const noTranscript = meeting.transcript.length === 0;
  const aiItems: MenuItemSpec[] = [];
  if (onGenerateSummary) {
    aiItems.push({ id: "summary", label: isSummaryGenerating ? "Writing the summary" : meeting.summary ? "Regenerate summary" : "Generate summary", disabled: isSummaryGenerating || noTranscript, onSelect: onGenerateSummary });
  }
  if (onExtractActions) {
    aiItems.push({ id: "actions", label: isActionsExtracting ? "Finding action items" : "Extract action items", disabled: isActionsExtracting || noTranscript, onSelect: onExtractActions });
  }
  if (onSuggestBookmarks) {
    aiItems.push({ id: "bookmarks", label: isBookmarksSuggesting ? "Finding bookmarks" : "Suggest bookmarks", disabled: isBookmarksSuggesting || noTranscript, onSelect: onSuggestBookmarks });
  }
  const aiBusy = !!(isSummaryGenerating || isActionsExtracting || isBookmarksSuggesting);

  return (
    <div className="relative flex items-center border-b border-border/20 px-3 py-1.5" role="tablist" aria-label="Meeting sections">
      <div ref={strip} className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabButton
          active={activeTab === "transcript"}
          onClick={() => setActiveTab("transcript")}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Transcript"
          count={meeting.transcript.length}
        />
        <TabButton
          active={activeTab === "summary"}
          onClick={() => setActiveTab("summary")}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="Summary"
          indicator={!!meeting.summary}
        />
        <TabButton
          active={activeTab === "notes"}
          onClick={() => setActiveTab("notes")}
          icon={<NotebookText className="h-3.5 w-3.5" />}
          label="Notes"
        />
        {showAsk && (
          <TabButton
            active={activeTab === "ask"}
            onClick={() => setActiveTab("ask")}
            icon={<MessageCircleQuestion className="h-3.5 w-3.5" />}
            label="Ask"
          />
        )}
        <TabButton
          active={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="AI Log"
          count={aiLogCount ?? meeting.ai_interactions.length}
        />
        <TabButton
          active={activeTab === "speakers"}
          onClick={() => setActiveTab("speakers")}
          icon={<Users className="h-3.5 w-3.5" />}
          label="Speakers"
          count={speakerCount > 0 ? speakerCount : undefined}
        />
        <TabButton
          active={activeTab === "actions"}
          onClick={() => setActiveTab("actions")}
          icon={<ListTodo className="h-3.5 w-3.5" />}
          label="Actions"
          count={actionCount > 0 ? actionCount : undefined}
        />
        <TabButton
          active={activeTab === "bookmarks"}
          onClick={() => setActiveTab("bookmarks")}
          icon={<Bookmark className="h-3.5 w-3.5" />}
          label="Bookmarks"
          count={bookmarkCount > 0 ? bookmarkCount : undefined}
        />
      </div>

      {/* The AI actions live in one menu; Export stays beside it, outside the scrolling strip */}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {aiItems.length > 0 && (
          <Menu
            label="AI actions"
            align="end"
            items={aiItems}
            renderTrigger={(props) => (
              <Button {...props} variant="ghost" size="sm" aria-label="AI actions">
                {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3 w-3" aria-hidden="true" />}
                AI
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </Button>
            )}
          />
        )}
        <div className="mx-1 h-4 w-px bg-border/20" />
        <ExportDropdown meeting={meeting} />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  indicator,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  indicator?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
      }`}
    >
      {/* Active indicator bar */}
      <span className={`absolute bottom-0 left-2 right-2 h-0.5 rounded-full transition-all duration-200 ${
        active ? "bg-primary scale-x-100" : "bg-transparent scale-x-0"
      }`} />
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <span className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums font-semibold ${
          active ? "bg-primary/10 text-primary/80" : "bg-primary/5 text-muted-foreground/50"
        }`}>
          {count}
        </span>
      )}
      {indicator && (
        <span className="h-2 w-2 rounded-full bg-success" />
      )}
    </button>
  );
}
