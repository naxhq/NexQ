import type { DemoScenario } from './scenarios/types';
import { useDemoStore } from './demoStore';
import { useMeetingStore } from '../stores/meetingStore';
import { useTranscriptStore } from '../stores/transcriptStore';
import { useStreamStore } from '../stores/streamStore';
import { useCallLogStore } from '../stores/callLogStore';
import { useTranslationStore } from '../stores/translationStore';
import { useBookmarkStore } from '../stores/bookmarkStore';
import { useActionItemStore } from '../stores/actionItemStore';
import { useTopicSectionStore } from '../stores/topicSectionStore';
import { useSpeakerStore } from '../stores/speakerStore';
import { useContextStore } from '../stores/contextStore';
import { useRagStore } from '../stores/ragStore';
import { useQuestionStore } from '../stores/questionStore';
import { useConfigStore } from '../stores/configStore';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let storeSnapshots: Record<string, unknown> = {};
let playCleanup: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Stores to snapshot / restore
// ---------------------------------------------------------------------------
const storesToSnapshot = [
  { store: useMeetingStore, key: 'meeting' },
  { store: useTranscriptStore, key: 'transcript' },
  { store: useStreamStore, key: 'stream' },
  { store: useCallLogStore, key: 'callLog' },
  { store: useTranslationStore, key: 'translation' },
  { store: useBookmarkStore, key: 'bookmark' },
  { store: useActionItemStore, key: 'actionItem' },
  { store: useTopicSectionStore, key: 'topicSection' },
  { store: useSpeakerStore, key: 'speaker' },
  { store: useContextStore, key: 'context' },
  { store: useRagStore, key: 'rag' },
  { store: useQuestionStore, key: 'question' },
  { store: useConfigStore, key: 'config' },
] as const;

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function snapshotStores() {
  storeSnapshots = {};
  for (const { store, key } of storesToSnapshot) {
    storeSnapshots[key] = { ...store.getState() };
  }

  // Deep-clone Map/Set from translationStore so mutations don't bleed
  const tState = useTranslationStore.getState();
  storeSnapshots.translation = {
    ...tState,
    translations: new Map(tState.translations),
    translating: new Set(tState.translating),
  };
}

function restoreStores() {
  // A real meeting may be starting right now (it exits the demo first); the
  // snapshot predates it and must not clear that flag.
  const meetingStarting = useMeetingStore.getState().meetingStarting;
  // The demo's detected questions (and what the question panel remembers about
  // each transcript line) must not outlive it. clear() also empties the
  // panel's module-level line memory, which setState cannot reach.
  useQuestionStore.getState().clear();
  for (const { store, key } of storesToSnapshot) {
    const snapshot = storeSnapshots[key];
    if (snapshot) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).setState(snapshot);
    }
  }
  storeSnapshots = {};
  useMeetingStore.setState({ meetingStarting });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launch a demo scenario.
 *
 * - `screenshot` mode: calls `scenario.populate()` to fill stores instantly.
 * - `play` mode: calls `scenario.play()` which returns a cleanup function
 *   that cancels any running timers/intervals.
 *
 * IMPORTANT: Uses `setState()` (not setter actions) to avoid persisting demo
 * data to disk via Tauri plugin-store.
 */
export function launchDemo(scenario: DemoScenario, mode: 'play' | 'screenshot') {
  // Demo data would overwrite a real meeting that is running or still starting
  // (activeMeeting is only set after async setup). A demo's own meeting doesn't count.
  const { meetingStarting, activeMeeting } = useMeetingStore.getState();
  if (meetingStarting) return;
  if (activeMeeting && !useDemoStore.getState().isDemoActive) return;
  // 1. Snapshot current store state so we can restore later
  snapshotStores();
  // A demo starts without the questions of whatever ran before it.
  useQuestionStore.getState().clear();

  // 2. Populate or play
  if (mode === 'screenshot') {
    scenario.populate();
  } else if (mode === 'play' && scenario.play) {
    playCleanup = scenario.play();
  }

  // 3. Update demo store
  useDemoStore.getState().activate(scenario.id, mode);

  // 4. Switch to the scenario's target window
  if (scenario.window === 'overlay') {
    useMeetingStore.setState({ currentView: 'overlay' });
  } else {
    useMeetingStore.setState({ currentView: 'launcher' });
  }
}

/**
 * Exit the active demo — cancels play timers, restores all stores.
 */
export function exitDemo() {
  // 1. Cancel play timers
  if (playCleanup) {
    playCleanup();
    playCleanup = null;
  }

  // 2. Restore stores to pre-demo state
  restoreStores();

  // 3. Reset demo store
  useDemoStore.getState().deactivate();
}
