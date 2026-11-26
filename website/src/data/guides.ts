/**
 * The guides: plain how-to pages that answer one question each, so people who search for it find it.
 * Each slug has a page in src/pages/guides/. The footer, the guides index and "More guides" read this list.
 * Facts follow the same rule as site.ts: README.md, docs/user-guide/ or the app source.
 */
export interface Guide {
  slug: string;
  /** Short name for links. */
  label: string;
  /** Page heading, and the <title> before " | NexQ". */
  title: string;
  /** Meta description, 160 characters at most (checked in Layout.astro). */
  description: string;
}

export const GUIDES: Guide[] = [
  {
    slug: 'workspaces-for-clients-and-projects',
    label: 'Workspaces for clients, classes and projects',
    title: 'Workspaces: Keep Each Client, Class or Project Apart',
    description:
      'Give each client, class or project its own meetings, files, notes and memory, and keep them apart. How to make one, what is shared, and what an update does.',
  },
  {
    slug: 'workspace-chat-with-sources',
    label: 'Ask across your meetings (workspace chat)',
    title: 'Ask Across Your Meetings and Files, With Sources',
    description:
      'Ask a question across a workspace’s meetings, documents and folders and get an answer with sources. The context view, the depth setting and what leaves your PC.',
  },
  {
    slug: 'talking-points-that-follow-your-voice',
    label: 'Talking points that follow your voice',
    title: 'Talking Points That Follow Your Voice During a Call',
    description:
      'Read your notes in the meeting window and let them scroll as you speak. Manual, Auto and My voice, ticking off what you said, and the honest limits.',
  },
  {
    slug: 'live-notes-and-meeting-brief',
    label: 'Live notes and the meeting brief',
    title: 'Live Meeting Notes and a Brief From Your Own Files',
    description:
      'Turn on live notes, and a brief that surfaces what your workspace already knows about the topic. Settings, limits, cost and what is sent to the model.',
  },
  {
    slug: 'meeting-memory',
    label: 'Memory for a workspace',
    title: 'Meeting Memory: Facts Your Assistant Keeps, You Approve',
    description:
      'Keep people, decisions, open items and preferences in a workspace. NexQ suggests them after a meeting with a link to the moment, and you save what is right.',
  },
  {
    slug: 'library-knowledge-and-tools',
    label: 'Library: documents, folders and tools',
    title: 'The Library: Documents, Notes, Folders and Tools for Your AI',
    description:
      'Add documents, notes, folders and tools to a workspace, and choose per answer what the AI may use with the Knowledge and Tools pills. Setup and privacy.',
  },
  {
    slug: 'transcribe-both-sides-of-a-call',
    label: 'Transcribe both sides of a call',
    title: 'How to Transcribe Both Sides of a Call Without a Bot',
    description:
      'Keep your voice and the other side apart by capturing the microphone and the system audio as two streams. Steps for Windows and Mac.',
  },
  {
    slug: 'local-call-transcription-windows',
    label: 'Transcribe calls locally on Windows',
    title: 'Local Call Transcription on Windows, Free and Offline',
    description:
      'Transcribe Zoom, Teams or Meet calls on your own PC with Parakeet or Sherpa-ONNX. What to download, what to set, and what still goes online.',
  },
  {
    slug: 'transcribe-calls-on-a-mac',
    label: 'Transcribe calls on a Mac',
    title: 'Transcribe Calls on a Mac Without a Bot or Audio Driver',
    description:
      'Transcribe Zoom, Teams or Meet calls on an Apple Silicon Mac, both sides, with a local speech engine. Setup, permissions and what the beta lacks.',
  },
  {
    slug: 'ollama-lm-studio-meeting-assistant',
    label: 'Meeting assistant with Ollama or LM Studio',
    title: 'Use Ollama or LM Studio as a Live Meeting Assistant',
    description:
      'Get answers during a call from a model on your own computer, using your own notes. Setup with Ollama or LM Studio, and honest limits.',
  },
  {
    slug: 'own-whisper-server',
    label: 'Use your own Whisper server',
    title: 'Live Call Transcription With Your Own Whisper Server',
    description:
      'Point a call transcription app at faster-whisper (Speaches), whisper.cpp or any OpenAI-compatible speech server. Commands, settings and limits.',
  },
  {
    slug: 'live-call-translation',
    label: 'Translate a call live',
    title: 'Translate a Call Live, Offline or With Your Own Key',
    description:
      'See a translation under each line of a call as it happens. Offline between English and 11 languages with OPUS-MT, or with DeepL, Google or an LLM.',
  },
  {
    slug: 'open-source-otter-granola-alternative',
    label: 'Open-source alternatives to Otter and Granola',
    title: 'Open-Source Alternatives to Otter and Granola',
    description:
      'NexQ, Meetily and anarlog next to Otter and Granola: where the audio goes, whether a bot joins, and which one fits you. Checked November 2026.',
  },
];

export const guideBySlug = (slug: string): Guide => {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) throw new Error(`guides.ts: no guide with slug "${slug}"`);
  return g;
};
