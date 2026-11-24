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
    slug: 'ollama-lm-studio-meeting-assistant',
    label: 'Meeting assistant with Ollama or LM Studio',
    title: 'Use Ollama or LM Studio as a Live Meeting Assistant',
    description:
      'Get answers during a call from a model on your own computer, using your own notes. Setup with Ollama or LM Studio, and honest limits.',
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
