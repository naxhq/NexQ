import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import { useDemoStore } from './demoStore';
import { demoScenarios } from './scenarios';
import { launchDemo } from './demoEngine';
import { useMeetingStore } from '../stores/meetingStore';
import type { DemoScenario } from './scenarios';

export function DemoPicker() {
  const pickerOpen = useDemoStore((s) => s.pickerOpen);
  const closePicker = useDemoStore((s) => s.closePicker);
  // Demo data would overwrite a live meeting's stores, so demos wait until it ends.
  const meetingRunning = useMeetingStore((s) => s.activeMeeting !== null || s.meetingStarting);

  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(demoScenarios[0]?.id ?? '');
  const [selectedMode, setSelectedMode] = useState<'screenshot' | 'play'>('screenshot');
  const [isVisible, setIsVisible] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  const selectedScenario = demoScenarios.find((s) => s.id === selectedScenarioId);

  // Animate in when opened
  useEffect(() => {
    if (pickerOpen) {
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [pickerOpen]);

  // Close with animation
  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => closePicker(), 150);
  }, [closePicker]);

  // Escape key closes the picker
  useEffect(() => {
    if (!pickerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pickerOpen, handleClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        handleClose();
      }
    },
    [handleClose]
  );

  // Launch selected scenario
  const handleStart = useCallback(() => {
    if (!selectedScenario || meetingRunning) return;
    const mode = selectedScenario.supportsPlay ? selectedMode : 'screenshot';
    launchDemo(selectedScenario, mode);
  }, [selectedScenario, selectedMode, meetingRunning]);

  if (!pickerOpen) return null;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-150 ${
        isVisible
          ? 'bg-background/70'
          : 'bg-background/0'
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Demo Mode"
        className={`w-[520px] max-h-[600px] flex flex-col rounded-2xl border border-border/20 bg-popover shadow-2xl shadow-black/20 transition-all duration-200 ${
          isVisible
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-[0.97] translate-y-3'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div>
            <h2 className="text-lg font-bold text-foreground">Demo Mode</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select a scenario for screenshots or recordings
            </p>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground cursor-pointer"
            title="Close (Esc)"
            aria-label="Close demo picker"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scenario List */}
        <div className="flex-1 overflow-y-auto px-6 space-y-2">
          {demoScenarios.map((scenario) => (
            <ScenarioCard
              key={scenario.id}
              scenario={scenario}
              isSelected={scenario.id === selectedScenarioId}
              onSelect={() => setSelectedScenarioId(scenario.id)}
            />
          ))}
        </div>

        {meetingRunning && (
          <p role="status" className="px-6 pt-3 text-xs text-muted-foreground">
            A meeting is running. End it before starting a demo.
          </p>
        )}

        {/* Footer: Mode toggle + Start */}
        <div className="flex items-center justify-between border-t border-border/20 px-6 py-4 mt-2">
          {/* Mode toggle — only visible when selected scenario supports play */}
          <div className="flex items-center gap-1">
            {selectedScenario?.supportsPlay ? (
              <>
                <ModeButton
                  label="Screenshot"
                  active={selectedMode === 'screenshot'}
                  onClick={() => setSelectedMode('screenshot')}
                />
                <ModeButton
                  label="Play"
                  active={selectedMode === 'play'}
                  onClick={() => setSelectedMode('play')}
                />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Screenshot only</span>
            )}
          </div>

          <button
            onClick={handleStart}
            disabled={!selectedScenario || meetingRunning}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            Start Demo
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Scenario card ──────────────────────────────────────────────────────

function ScenarioCard({
  scenario,
  isSelected,
  onSelect,
}: {
  scenario: DemoScenario;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-all duration-150 cursor-pointer ${
        isSelected
          ? 'ring-2 ring-primary/50 bg-primary/5'
          : 'border border-border/20 bg-card/40 hover:bg-card/60'
      }`}
    >
      <span className="text-2xl leading-none mt-0.5" aria-hidden="true">
        {scenario.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{scenario.name}</span>
          <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">
            {scenario.window === 'overlay' ? 'Overlay' : 'Launcher'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {scenario.description}
        </p>
      </div>
    </button>
  );
}

// ── Mode toggle button ─────────────────────────────────────────────────

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
        active
          ? 'bg-primary/10 text-primary border-primary/20'
          : 'text-muted-foreground border-border/20 hover:bg-accent/50'
      }`}
    >
      {label}
    </button>
  );
}
