import autoDetectCases from '../../../src/lib/autoDetectCases.json';

// Single source of truth for links and facts shown on the site.
// Facts here are taken from CHANGELOG.md, README.md, docs/user-guide/ and the app source.
// Do not add numbers, quotes or claims that are not in those sources.
// The version number and the release list are NOT here: see releases.ts (built from the repo).

export const REPO = 'https://github.com/naxhq/NexQ';
export const RELEASES_LATEST = `${REPO}/releases/latest`;
export const RELEASES_URL = `${REPO}/releases`;
export const CHANGELOG = `${REPO}/blob/main/CHANGELOG.md`;
export const CONTRIBUTING = `${REPO}/blob/main/CONTRIBUTING.md`;
export const LICENSE = `${REPO}/blob/main/LICENSE`;
export const ISSUES = `${REPO}/issues`;
export const DOCS = `${REPO}/tree/main/docs/user-guide`;
/** Link to a user-guide page, e.g. doc('keyboard-shortcuts'). */
export const doc = (name: string) => `${REPO}/blob/main/docs/user-guide/${name}.md`;

export const SITE_TITLE = 'NexQ: Open-Source AI Meeting Assistant & Interview Copilot';
// Keep at or under 160 characters (checked at build time in Layout.astro).
export const SITE_DESCRIPTION =
  'Free, open-source desktop copilot for calls and interviews. Live transcripts of both sides, answers from your own AI, no bot joins. Windows and Mac.';

/** Section ids, in page order. Components use these for `id=` and nav links. */
export const SECTION = {
  hero: 'hero',
  call: 'call',
  ai: 'ai',
  after: 'after',
  demo: 'demo',
  madeFor: 'made-for',
  privacy: 'privacy',
  releases: 'releases',
  download: 'download',
  compare: 'compare',
  faq: 'faq',
} as const;

/** Navbar anchors (max 5). Download is the button, GitHub is a text link. */
export const NAV: { label: string; href: string }[] = [
  { label: 'The call', href: `#${SECTION.call}` },
  { label: 'Your AI', href: `#${SECTION.ai}` },
  { label: 'After the call', href: `#${SECTION.after}` },
  { label: 'Privacy', href: `#${SECTION.privacy}` },
  { label: 'Releases', href: `#${SECTION.releases}` },
];

/** Where something runs. */
type SttWhere = 'device' | 'cloud' | 'cloud-nokey';
type LlmWhere = 'local' | 'cloud' | 'plan';

interface SttProvider {
  name: string;
  /** device: runs on your PC, no key. cloud: needs your key. cloud-nokey: runs in the cloud, no key. */
  where: SttWhere;
  note?: string;
}

// The 11 speech engines, in the order the app's STT settings group them.
export const STT_PROVIDERS: SttProvider[] = [
  { name: 'Parakeet', where: 'device' },
  { name: 'Sherpa-ONNX', where: 'device' },
  { name: 'ORT Streaming', where: 'device' },
  { name: 'Whisper.cpp', where: 'device', note: 'Transcribes recordings only, not live calls.' },
  { name: 'Windows Speech', where: 'device', note: 'Windows only, and only your side (the microphone).' },
  { name: 'Web Speech', where: 'cloud-nokey', note: 'No key, but the audio goes to a cloud service. Your side (the microphone) only.' },
  { name: 'Deepgram', where: 'cloud' },
  { name: 'Groq Whisper', where: 'cloud' },
  { name: 'Whisper API', where: 'cloud' },
  { name: 'Azure Speech', where: 'cloud' },
  { name: 'Cartesia', where: 'cloud' },
];

interface LlmProvider {
  name: string;
  /** local: on your PC. cloud: your own API key. plan: your Claude subscription, no key. */
  where: LlmWhere;
  note?: string;
}

export const LLM_PROVIDERS: LlmProvider[] = [
  { name: 'Ollama', where: 'local' },
  { name: 'LM Studio', where: 'local' },
  { name: 'OpenAI', where: 'cloud' },
  { name: 'Anthropic', where: 'cloud' },
  { name: 'Google Gemini', where: 'cloud' },
  { name: 'Groq', where: 'cloud' },
  { name: 'OpenRouter', where: 'cloud' },
  { name: 'Custom endpoint', where: 'cloud', note: 'Any OpenAI-compatible server.' },
  { name: 'Claude subscription', where: 'plan', note: 'Your Claude Pro or Max plan, no API key.' },
];

// Live translation (src-tauri/src/translation/).
export const TRANSLATION_PROVIDERS: { name: string; where: 'cloud' | 'device' | 'your-ai'; note?: string }[] = [
  { name: 'DeepL', where: 'cloud' },
  { name: 'Google Translate', where: 'cloud' },
  { name: 'Microsoft Translator', where: 'cloud' },
  { name: 'Your AI provider', where: 'your-ai', note: 'Uses whichever AI provider you already set up.' },
  { name: 'OPUS-MT', where: 'device', note: 'Offline models you download once.' },
];

/** The headline numbers, counted from the lists above so they cannot drift (README's compare table says 11 and 9). */
export const COUNTS = {
  stt: STT_PROVIDERS.length,
  llm: LLM_PROVIDERS.length,
  translation: TRANSLATION_PROVIDERS.length,
};

/**
 * Speech engines that offer language auto-detect. The display names are ours; each one is tied to the provider
 * (and model, where only one model qualifies) in src/lib/autoDetectCases.json, the table the app and its tests
 * read. The checks below run when the site builds, so a name that stops being supported, or a supported provider
 * missing from this list, fails the build instead of shipping a wrong claim.
 */
const AUTO_DETECT: { name: string; provider: string; model?: string }[] = [
  { name: 'Deepgram Nova-3', provider: 'deepgram', model: 'nova-3' },
  { name: 'Deepgram Flux Multilingual', provider: 'deepgram', model: 'flux-general-multi' },
  { name: 'Parakeet v3', provider: 'parakeet_tdt', model: 'parakeet-tdt-0.6b-v3-int8' },
  { name: 'multilingual Whisper models', provider: 'whisper_cpp' },
  { name: 'Whisper API', provider: 'whisper_api' },
  { name: 'Groq', provider: 'groq_whisper' },
  { name: 'Cartesia', provider: 'cartesia' },
];
for (const e of AUTO_DETECT) {
  const ok = autoDetectCases.cases.some((c) => c.supported && c.provider === e.provider && (e.model === undefined || c.model === e.model));
  if (!ok) throw new Error(`site.ts: "${e.name}" is not a supported auto-detect case in src/lib/autoDetectCases.json`);
}
for (const p of new Set(autoDetectCases.cases.filter((c) => c.supported).map((c) => c.provider))) {
  if (!AUTO_DETECT.some((e) => e.provider === p)) throw new Error(`site.ts: auto-detect provider "${p}" (src/lib/autoDetectCases.json) has no entry in AUTO_DETECT`);
}
export const AUTO_DETECT_ENGINES: string[] = AUTO_DETECT.map((e) => e.name);

export interface Hotkey {
  /** Keys in order, for one <kbd> each. "Mod" means Ctrl on Windows and Cmd on Mac. */
  keys: string[];
  action: string;
  /** global: works from any app. app: only while a NexQ window is focused in a meeting. */
  scope: 'global' | 'app';
  note?: string;
}

// Verified against docs/user-guide/keyboard-shortcuts.md, src/hooks/useGlobalShortcut.ts and the
// defaults in src/stores/configStore.ts (all CmdOrCtrl, so "Mod" below).
export const HOTKEYS: Hotkey[] = [
  { keys: ['Mod', 'M'], action: 'Start or end a meeting', scope: 'global' },
  { keys: ['Mod', 'B'], action: 'Show or hide the overlay', scope: 'global' },
  { keys: ['Mod', 'Shift', 'Space'], action: 'Assist from any app', scope: 'global', note: 'Answers without switching to NexQ.' },
  { keys: ['Mod', 'Shift', 'H'], action: 'Hide from screen share', scope: 'global' },
  {
    keys: ['Mod', 'Shift', 'S'],
    action: 'Capture the screen into Ask',
    scope: 'global',
    note: 'Windows only, Claude subscription only.',
  },
  { keys: ['Space'], action: 'Assist', scope: 'app' },
  { keys: ['1'], action: 'What to say', scope: 'app' },
  { keys: ['2'], action: 'Shorten', scope: 'app' },
  { keys: ['3'], action: 'Follow-up', scope: 'app' },
  { keys: ['4'], action: 'Recap', scope: 'app' },
  { keys: ['5'], action: 'Ask', scope: 'app' },
];

export const SCENARIOS = [
  { id: 'interview', name: 'Interview' },
  { id: 'meeting', name: 'Team meeting' },
  { id: 'lecture', name: 'Lecture' },
  { id: 'webinar', name: 'Webinar' },
  { id: 'custom', name: 'Your own' },
] as const;

/**
 * Optional hand-written one-liners for the release timeline, keyed by full version
 * ("2.41.0"). A release without one shows its first changelog line. Keep each one plain
 * and true to that release's CHANGELOG entry.
 */
export const RELEASE_ONELINERS: Record<string, string> = {
  '2.41.0': 'Notes and tools for your Claude answers.',
  '2.40.0': 'Choose how much each AI provider thinks.',
  '2.39.0': 'Switch each side’s transcription language from the overlay.',
  '2.38.0': 'Each side in its own language, auto-detect, and screenshots in Ask.',
  '2.37.0': 'Click the tray icon to bring NexQ back.',
  '2.36.0': 'Echo cancellation, and stealth also leaves the taskbar.',
  '2.35.0': 'NexQ’s own installer, and a what’s new before you update.',
  '2.34.0': 'Auto-Answer replies as soon as Cartesia or Deepgram Flux hear the speaker finish.',
  '2.33.0': 'Auto-Answer is off by default, and Cartesia isn’t billed while a side is muted.',
  '2.32.0': 'Question detection and Auto-Answer are now separate.',
  '2.31.0': 'Cartesia ink-2 joins the speech engines. Chinese and Japanese questions are detected too.',
  '2.30.0': 'Vietnamese transcription.',
  '2.29.0': 'Assist from any app with one shortcut.',
  '2.28.0': 'A warning when audio comes in but the engine returns nothing.',
  '2.27.0': 'A rotating log file, and Diagnostics in Settings, About.',
  '2.26.0': 'On Windows, NexQ notices Zoom, Teams, Meet and Webex calls and offers to start.',
  '2.25.0': 'macOS arrives, and NexQ can hide from screen sharing.',
  '2.24.0': 'A thinking setting for Claude, accurate usage, a transcript scope picker.',
  '2.23.0': 'Claude models read from the CLI, with effort set per model.',
  '2.22.0': 'Your Claude subscription as a provider, and quiet background updates.',
};

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is NexQ really free?',
    a: 'Yes. NexQ is open source under the MIT license, with no subscription and no feature limits. If you pick a cloud provider such as OpenAI or Deepgram, that provider bills you directly. Local engines and models cost nothing.',
  },
  {
    q: 'Does a bot join my meeting?',
    a: 'No. NexQ runs on your computer and listens to your microphone and your system audio, so it works with Zoom, Teams, Google Meet or any other app without adding a participant. Follow the recording and consent rules that apply to you.',
  },
  {
    q: 'Does my audio leave my computer?',
    a: 'Only if you choose a cloud provider. With an on-device speech engine such as Parakeet and a local model through Ollama or LM Studio, audio, transcripts and answers stay on your machine. A cloud provider receives what you send it, and Web Speech sends your microphone audio to a cloud service even though it needs no key. Meetings are stored in a local database on your computer, and API keys sit in the system credential store (Windows Credential Manager, or Keychain on a Mac).',
  },
  {
    q: 'Can other people see NexQ when I share my screen?',
    a: 'With Hide from screen share on, the overlay stays on your screen and is kept out of screen shares, recordings and screenshots. On Windows 10 version 2004 or later this works with the usual tools. On macOS 14 and later, some recorders that use ScreenCaptureKit can still capture NexQ, so try a test share first. Please check that using NexQ is allowed in your call.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'Windows 10 and 11 (x64), with a per-user installer that needs no admin rights. macOS on Apple Silicon is available as a beta. Intel Macs and Linux are not supported yet. Contributions are welcome. Detecting calls so NexQ can offer to start is Windows only for now.',
  },
  {
    q: 'Do I need an API key?',
    a: 'No. Web Speech and the on-device engines need no key, and Ollama or LM Studio can write the answers locally. If you already pay for Claude Pro or Max, the Claude subscription option uses that plan through the official Claude Code CLI, also without an API key.',
  },
  {
    q: 'How does the Claude subscription option work?',
    a: 'NexQ starts the official claude command-line tool on your PC, with its tools turned off, in an empty private folder. You sign in inside Claude’s own tool, so NexQ never sees your credentials. The only things it can reach are the notes folders and tools you add under Personal sources, and you choose per answer whether to use them. What it reads in your notes and tools goes to Anthropic, like the transcript does. Usage counts toward your plan. NexQ shows the numbers Claude reports as an estimate, and switches to a fallback provider you choose if Claude is unavailable.',
  },
  {
    q: 'Why does Windows show a SmartScreen warning?',
    a: 'NexQ is not code-signed yet, which is common for open-source apps. Click “More info”, then “Run anyway”. You can also build it from source, since all the code is on GitHub. Updates are signed with an Ed25519 key and checked before they install.',
  },
  {
    q: 'Why does my Mac say NexQ can’t be opened?',
    a: 'The macOS beta is not notarized, so Gatekeeper blocks the first launch. After you drag NexQ into Applications, run xattr -cr /Applications/NexQ.app once, then open it.',
  },
  {
    q: 'How do updates work?',
    a: 'NexQ checks GitHub Releases in the background and downloads new versions quietly. When one is ready, a pill shows what’s new with an Install button, or it installs the next time you quit. It never installs during a meeting. You can turn automatic updates off or skip a version in Settings, About.',
  },
];
