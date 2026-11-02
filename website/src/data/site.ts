// Single source of truth for links and facts shown on the site.
// Facts here are taken from CHANGELOG.md, README.md and docs/user-guide/.
// Do not add numbers, quotes or claims that are not in those sources.

export const REPO = 'https://github.com/naxhq/NexQ';
export const RELEASES_LATEST = `${REPO}/releases/latest`;
export const RELEASES = `${REPO}/releases`;
export const CHANGELOG = `${REPO}/blob/main/CHANGELOG.md`;
export const CONTRIBUTING = `${REPO}/blob/main/CONTRIBUTING.md`;
export const LICENSE = `${REPO}/blob/main/LICENSE`;
export const ISSUES = `${REPO}/issues`;
export const DOCS = `${REPO}/tree/main/docs/user-guide`;
export const doc = (name: string) => `${REPO}/blob/main/docs/user-guide/${name}.md`;

export const SITE_TITLE = 'NexQ: Open-Source AI Meeting Assistant & Interview Copilot';
export const SITE_DESCRIPTION =
  'Free, open-source desktop copilot for meetings and interviews. Real-time transcription of both sides, instant AI answers from local or cloud models (or your Claude subscription), local document search, and an overlay you can hide from screen share. No bot joins your call.';

// Grouped the way the app's STT settings group them (src/settings/STTSettings.tsx).
export const STT_PROVIDERS = [
  { name: 'Whisper.cpp', local: true },
  { name: 'Parakeet TDT', local: true },
  { name: 'Sherpa-ONNX', local: true },
  { name: 'ORT Streaming', local: true },
  { name: 'Windows Speech', local: true },
  { name: 'Web Speech', local: true },
  { name: 'Deepgram', local: false },
  { name: 'Groq Whisper', local: false },
  { name: 'Whisper API', local: false },
  { name: 'Azure Speech', local: false },
  { name: 'Cartesia', local: false },
];

export const LLM_PROVIDERS = [
  { name: 'Ollama', local: true },
  { name: 'LM Studio', local: true },
  { name: 'OpenAI', local: false },
  { name: 'Anthropic', local: false },
  { name: 'Google Gemini', local: false },
  { name: 'Groq', local: false },
  { name: 'OpenRouter', local: false },
  { name: 'Custom endpoint', local: false },
  { name: 'Claude subscription', local: false },
];

export interface Release {
  version: string;
  date?: string;
  label?: string;
  summary: string;
  items: { title: string; body: string }[];
}

export const RELEASES_HIGHLIGHTS: Release[] = [
  {
    version: '2.25',
    label: 'Latest',
    summary: 'macOS arrives, and the overlay can hide from screen share.',
    items: [
      {
        title: 'macOS (Apple Silicon), beta',
        body: 'NexQ now runs on Apple Silicon Macs. The port was contributed by the community.',
      },
      {
        title: 'Hide from screen share',
        body: 'Stealth Mode keeps the overlay on your screen but out of screen shares, recordings and screenshots. Toggle it in Settings → General, from the overlay header or the tray, or with Ctrl+Shift+H (Cmd+Shift+H on macOS).',
      },
      {
        title: 'Czech transcription',
        body: 'Czech joins the list of transcription languages.',
      },
    ],
  },
  {
    version: '2.24',
    date: '2026-10-22',
    summary: 'Faster answers, honest numbers and a sharper transcript.',
    items: [
      {
        title: 'Extended thinking, per tier',
        body: 'Switch Claude’s thinking on or off separately for Fast and Deep. With it off, Haiku starts answering in about a second.',
      },
      {
        title: 'Context scope picker',
        body: 'Choose what an action reads: its default, since the last answer, the last few minutes, or the whole meeting.',
      },
      {
        title: 'Real usage, cost and timing',
        body: 'Each request shows the tokens, cost and response time Claude reports, in the footer and the AI Log, with a live answer timer.',
      },
      {
        title: 'Response history and live progress',
        body: 'Every answer of the meeting stays available, and a progress panel shows each phase while an answer is being written.',
      },
      {
        title: 'Transcript paragraphs and remote speakers',
        body: 'Continuous speech merges into paragraphs. On Deepgram, remote voices are told apart as Speaker 1, Speaker 2 and so on, and you can rename them.',
      },
    ],
  },
  {
    version: '2.23',
    date: '2026-10-21',
    summary: 'Claude model catalog.',
    items: [
      {
        title: 'Model pickers from the Claude CLI',
        body: 'Models come straight from the CLI’s catalog, with effort levels clamped per model and clear Check connection feedback.',
      },
      {
        title: 'Settings and footer in sync',
        body: 'Activate Claude right from its Settings panel; Settings and the footer always agree on what is active.',
      },
    ],
  },
  {
    version: '2.22',
    date: '2026-10-20',
    summary: 'Your Claude subscription, and updates that never interrupt.',
    items: [
      {
        title: 'Claude subscription provider (beta)',
        body: 'Use your Claude Pro or Max plan through the official Claude Code CLI. Warm sessions send only what is new. No API key.',
      },
      {
        title: 'Quiet automatic updates',
        body: 'Updates download in the background, a Restart pill appears when ready, and they install when you quit, never mid-meeting.',
      },
      {
        title: 'Ask a past meeting',
        body: 'Chat with any saved meeting; questions and answers are kept with it.',
      },
    ],
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is NexQ really free?',
    a: 'Yes. NexQ is open source under the MIT license, with no subscription and no feature limits. If you pick a cloud provider such as OpenAI or Deepgram, that provider bills you directly under its own pricing. Local providers like Whisper, Ollama and LM Studio cost nothing.',
  },
  {
    q: 'Does a bot join my meeting?',
    a: 'No. NexQ runs on your computer and listens to your microphone and your system audio, so it works with Zoom, Teams, Google Meet or any other app without adding a participant. Please follow the recording and consent rules that apply to you.',
  },
  {
    q: 'Does my audio leave my computer?',
    a: 'Only if you choose a cloud provider. With a local speech engine (such as Whisper or Parakeet) and a local model (Ollama or LM Studio), audio, transcripts and answers stay on your machine. Cloud providers receive what you send them. Meetings are stored in a local SQLite database, and on Windows your API keys are kept in the Windows Credential Manager.',
  },
  {
    q: 'Can other people see NexQ when I share my screen?',
    a: 'With Hide from screen share turned on (v2.25), the overlay stays visible to you but is excluded from screen sharing, recordings and screenshots. On Windows 10 version 2004 or later this works with Zoom, Teams, Google Meet and OBS. On macOS 14 and later, some recorders built on ScreenCaptureKit may still capture the window, so check before you rely on it.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'Windows 10 and 11 (x64), with a per-user installer that needs no admin rights. macOS on Apple Silicon is available as a beta from v2.25. Intel Macs and Linux are not supported yet; contributions are welcome.',
  },
  {
    q: 'Do I need an API key?',
    a: 'No. You can transcribe with the Web Speech API or a local engine and answer with Ollama or LM Studio. If you already pay for Claude Pro or Max, the Claude subscription provider uses that plan through the official Claude Code CLI, also without an API key.',
  },
  {
    q: 'How does the Claude subscription option work?',
    a: 'NexQ starts the official claude command-line tool on your PC, with all tools disabled, in an empty private folder. You sign in in Claude’s own terminal; NexQ never sees your credentials. Requests count toward your plan’s limits. NexQ shows the usage Claude reports as an estimate, and switches to a fallback provider you choose if Claude is unavailable.',
  },
  {
    q: 'Why does Windows show a SmartScreen warning?',
    a: 'NexQ is not code-signed yet, which is common for open-source apps. Click “More info”, then “Run anyway”. You can also build NexQ from source; the full code is on GitHub. Updates are signed with an Ed25519 key and verified before they install.',
  },
  {
    q: 'How do updates work?',
    a: 'NexQ checks GitHub Releases in the background and downloads new versions silently. When one is ready, a Restart pill appears; otherwise it installs the next time you quit. It never installs during a meeting. You can turn automatic updates off or skip a version in Settings → About.',
  },
];
