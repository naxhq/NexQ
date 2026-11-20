import { useState, useCallback, useEffect, useRef } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { GeneralSettings } from "./GeneralSettings";
import { AboutSettings } from "./AboutSettings";
import { LLMSettings } from "./LLMSettings";
import { STTSettings } from "./STTSettings";
import { HotkeySettings } from "./HotkeySettings";
import { MeetingAudioSettings } from "./MeetingAudioSettings";
import { ScenarioSettings } from "./ScenarioSettings";
import { NoisePresetSettings } from "./NoisePresetSettings";
import { ConfidenceSettings } from "./ConfidenceSettings";
import {
  X,
  Brain,
  Mic,
  Keyboard,
  SlidersHorizontal,
  Info,
  Headphones,
  Wand2,
  ArrowLeft,
  Database,
  Theater,
  Volume2,
  BarChart2,
  Globe,
} from "lucide-react";
import { ContextStrategySettings } from "./ContextStrategySettings";
import { AIActionsSettings } from "./AIActionsSettings";
import { TranslationSettings } from "./TranslationSettings";
import { Sparkles, BookOpen } from "lucide-react";
import { PersonalSourcesEditor } from "../sources/PersonalSourcesEditor";

type SettingsTab = "meeting_audio" | "llm" | "stt" | "translation" | "ai_actions" | "context_strategy" | "scenarios" | "noise_presets" | "confidence" | "personal_sources" | "hotkeys" | "general" | "about";

// ── Tab groups for sidebar (contextually organized, importance-ordered) ──
interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

interface TabGroup {
  label: string;
  items: TabItem[];
}

const TAB_GROUPS: TabGroup[] = [
  {
    label: "Meeting",
    items: [
      { id: "meeting_audio", label: "Audio & Devices", icon: <Headphones className="h-4 w-4" /> },
    ],
  },
  {
    label: "Providers",
    items: [
      { id: "llm", label: "LLM Providers", icon: <Brain className="h-4 w-4" /> },
      { id: "stt", label: "STT Providers", icon: <Mic className="h-4 w-4" /> },
      { id: "translation", label: "Translation", icon: <Globe className="h-4 w-4" /> },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { id: "ai_actions", label: "AI Actions", icon: <Sparkles className="h-4 w-4" /> },
      { id: "context_strategy", label: "Context Strategy", icon: <Database className="h-4 w-4" /> },
      { id: "personal_sources", label: "Personal Sources", icon: <BookOpen className="h-4 w-4" /> },
      { id: "scenarios", label: "AI Scenarios", icon: <Theater className="h-4 w-4" /> },
      { id: "noise_presets", label: "Noise Presets", icon: <Volume2 className="h-4 w-4" /> },
      { id: "confidence", label: "Confidence", icon: <BarChart2 className="h-4 w-4" /> },
    ],
  },
  {
    label: "System",
    items: [
      { id: "hotkeys", label: "Hotkeys", icon: <Keyboard className="h-4 w-4" /> },
      { id: "general", label: "General", icon: <SlidersHorizontal className="h-4 w-4" /> },
      { id: "about", label: "About", icon: <Info className="h-4 w-4" /> },
    ],
  },
];

// Flat list for modal tabs (same order)
const ALL_TABS: TabItem[] = TAB_GROUPS.flatMap((g) => g.items);

// Tab labels for header display
const TAB_LABELS: Record<SettingsTab, string> = Object.fromEntries(
  ALL_TABS.map((t) => [t.id, t.label])
) as Record<SettingsTab, string>;

interface SettingsOverlayProps {
  isModal?: boolean;
}

export function SettingsOverlay({ isModal = false }: SettingsOverlayProps) {
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const previousView = useMeetingStore((s) => s.previousView);
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    () => (useMeetingStore.getState().settingsTab as SettingsTab | null) ?? "meeting_audio",
  );
  // The requested tab applies to this opening only.
  useEffect(() => {
    useMeetingStore.setState({ settingsTab: null });
  }, []);
  const [isVisible, setIsVisible] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Animate in on mount
  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
  }, []);

  // Close with animation (modal mode)
  const handleCloseModal = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => setSettingsOpen(false), 150);
  }, [setSettingsOpen]);

  // Navigate back to the view settings was opened from
  const handleBack = useCallback(() => {
    setCurrentView(previousView || "launcher");
  }, [setCurrentView, previousView]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isModal) {
          handleCloseModal();
        } else {
          handleBack();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModal, handleCloseModal, handleBack]);

  // Close on click outside (modal only)
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (isModal && e.target === backdropRef.current) {
        handleCloseModal();
      }
    },
    [isModal, handleCloseModal]
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case "meeting_audio":
        return <MeetingAudioSettings />;
      case "llm":
        return <LLMSettings />;
      case "ai_actions":
        return <AIActionsSettings />;
      case "context_strategy":
        return <ContextStrategySettings />;
      case "personal_sources":
        return <PersonalSourcesEditor variant="full" />;
      case "scenarios":
        return <ScenarioSettings />;
      case "noise_presets":
        return <NoisePresetSettings />;
      case "confidence":
        return <ConfidenceSettings />;
      case "stt":
        return <STTSettings />;
      case "translation":
        return <TranslationSettings />;
      case "hotkeys":
        return <HotkeySettings />;
      case "general":
        return <GeneralSettings />;
      case "about":
        return <AboutSettings />;
    }
  };

  const handleRunWizard = useCallback(() => {
    if (isModal) {
      handleCloseModal();
      setTimeout(() => {
        useConfigStore.getState().setFirstRunCompleted(false);
      }, 200);
    } else {
      useConfigStore.getState().setFirstRunCompleted(false);
      setCurrentView("wizard");
    }
  }, [isModal, handleCloseModal, setCurrentView]);

  const currentTabLabel = TAB_LABELS[activeTab] ?? "Settings";

  // Wider content area for two-column settings pages
  const contentMaxW = activeTab === "ai_actions" || activeTab === "translation" ? "max-w-4xl" : "max-w-2xl";

  // ─── Modal mode: render as overlay dialog ───
  if (isModal) {
    return (
      <div
        ref={backdropRef}
        onClick={handleBackdropClick}
        className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-150 ${
          isVisible
            ? "bg-black/60 backdrop-blur-sm"
            : "bg-black/0 backdrop-blur-none"
        }`}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className={`w-[640px] max-h-[520px] flex flex-col rounded-xl border border-border/40 bg-card shadow-2xl shadow-black/20 transition-all duration-200 ${
            isVisible
              ? "opacity-100 scale-100 translate-y-0"
              : "opacity-0 scale-[0.97] translate-y-3"
          }`}
          style={{ transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/30 px-5 py-3.5">
            <h2 className="text-base font-semibold text-foreground">Settings</h2>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRunWizard}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground cursor-pointer"
                title="Run Setup Wizard"
                aria-label="Run setup wizard"
              >
                <Wand2 className="h-4 w-4" />
              </button>
              <button
                onClick={handleCloseModal}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground cursor-pointer"
                title="Close (Esc)"
                aria-label="Close settings"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Tab Navigation (horizontal, uses flat list) */}
          <div className="flex border-b border-border/30 px-2 overflow-x-auto" role="tablist" aria-label="Settings navigation">
            {ALL_TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 py-2.5 text-sm whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                  activeTab === tab.id
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {/* Animated active underline */}
                <div className={`absolute bottom-0 left-1 right-1 h-[2px] rounded-full bg-primary transition-all duration-200 ${
                  activeTab === tab.id ? "opacity-100 scale-x-100" : "opacity-0 scale-x-0"
                }`} />
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-5" role="tabpanel">
            <div key={activeTab} className="settings-content-enter">{renderTabContent()}</div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Full-page mode: sidebar + content ───
  return (
    <div className="flex h-full w-full bg-background">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border/30 bg-card/50">
        {/* Back Button */}
        <div className="flex items-center gap-3 border-b border-border/20 px-4 py-4">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            title="Back to Launcher"
            aria-label="Back to launcher"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
        </div>

        {/* Grouped Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-1" role="tablist" aria-label="Settings navigation">
          {TAB_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? "mt-4" : ""}>
              {/* Group label */}
              <div className="mb-1 px-3 flex items-center gap-2">
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </span>
                <div className="flex-1 h-px bg-primary/10" />
              </div>

              {/* Group items */}
              <div className="space-y-0.5">
                {group.items.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab.id)}
                      className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 cursor-pointer ${
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      {/* Active indicator bar — CSS transition instead of mount/unmount */}
                      <div className={`absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 ease-out ${
                        isActive ? "h-5 w-[3px] opacity-100" : "h-0 w-[3px] opacity-0"
                      }`} />
                      <span className={`shrink-0 transition-colors duration-150 ${
                        isActive ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground/70"
                      }`}>
                        {tab.icon}
                      </span>
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom: Wizard re-run */}
        <div className="border-t border-border/20 px-3 py-3">
          <button
            onClick={handleRunWizard}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground cursor-pointer"
            title="Run Setup Wizard"
            aria-label="Run setup wizard"
          >
            <Wand2 className="h-4 w-4" />
            <span>Run Setup Wizard</span>
          </button>
        </div>
      </aside>

      {/* Content Area */}
      <main className="flex-1 overflow-y-auto" role="tabpanel">
        <div className={`mx-auto ${contentMaxW} px-8 py-8`}>
          {/* Section Heading */}
          <div className="mb-8">
            <h1 className="text-xl font-semibold text-foreground">{currentTabLabel}</h1>
            <div className="mt-2.5 flex items-center gap-2">
              <div className="h-[2px] w-8 rounded-full bg-primary/70" />
              <div className="h-px flex-1 bg-border/20" />
            </div>
          </div>

          {/* Tab Content — animate on tab switch */}
          <div key={activeTab} className="settings-content-enter">{renderTabContent()}</div>
        </div>
      </main>
    </div>
  );
}
