import type { DemoScenario } from './types';
import { useMeetingStore } from '../../stores/meetingStore';
import { useConfigStore } from '../../stores/configStore';

// ---------------------------------------------------------------------------
// populate()
// ---------------------------------------------------------------------------

function populate(): void {
  // 1. Set meeting active so overlay renders, with settings panel open
  useMeetingStore.setState({
    currentView: 'overlay',
    settingsOpen: true,
    activeMeeting: {
      id: 'demo-settings-001',
      title: 'Demo Meeting',
      start_time: new Date(Date.now() - 300000).toISOString(),
      end_time: null,
      duration_seconds: null,
      transcript: [],
      ai_interactions: [],
      summary: null,
      config_snapshot: null,
      audio_mode: 'online',
      ai_scenario: 'interview',
    },
    isRecording: false,
    elapsedMs: 300000,
    meetingStartTime: Date.now() - 300000,
    audioMode: 'online',
    aiScenario: 'interview',
  });

  // 2. Set config via setState (NOT individual setters that call persistValue)
  useConfigStore.setState({
    sttProvider: 'deepgram',
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    recordingEnabled: true,
    autoTrigger: true,
    autoSummary: true,
    contextWindowSeconds: 120,
    contextStrategy: 'local_rag',
    theme: 'dark',
    firstRunCompleted: true,
    deepgramConfig: {
      model: 'nova-3',
      smart_format: false,
      interim_results: true,
      endpointing: 300,
      punctuate: true,
      diarize: false,
      profanity_filter: false,
      numerals: false,
      dictation: false,
      vad_events: true,
      keyterms: [],
    },
    hotkeys: {
      mode_assist: 'Space',
      mode_say: '1',
      mode_shorten: '2',
      mode_followup: '3',
      mode_recap: '4',
      mode_ask: '5',
    },
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const settingsScenario: DemoScenario = {
  id: 'settings',
  name: 'Settings Panel',
  description: 'Overlay with settings panel open showing configured providers',
  icon: '⚙️',
  supportsPlay: false,
  window: 'overlay',
  populate,
};
