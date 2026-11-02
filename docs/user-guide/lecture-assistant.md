# How to Use NexQ as Your Lecture Assistant

![NexQ Lecture Assistant overlay](../../website/public/screenshots/Lecture.png)

NexQ can transcribe lectures in real-time, automatically detect topics and extract action items, and let you bookmark key moments for later review.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- An STT provider configured ([AI Providers Guide](ai-providers.md))
- An LLM provider configured ([AI Providers Guide](ai-providers.md))

## Setting Up for Lectures

### 1. Choose Your STT Provider

Open Settings (`Ctrl+,`) > Speech-to-Text:

- **Web Speech API** -- recommended for lectures. It is free, handles long sessions well (2+ hours), and provides continuous real-time transcription without session limits.
- **Groq** -- better accuracy than Web Speech API, free tier available. Good for shorter lectures or when precision matters.
- **Deepgram** -- highest accuracy for real-time streaming. Best when you need reliable transcription of technical content.

### 2. Choose Your LLM Provider

Open Settings > LLM:

- **Ollama** (local, free) -- works well for lecture summarization and question generation
- **Any cloud provider** -- OpenAI, Anthropic, Groq, or Gemini all work. Choose based on your preference and budget.

### 3. Select the Lecture Scenario

In NexQ Settings, select the **Lecture** scenario. This tunes the AI to focus on educational content: summarization, key concept extraction, and study-relevant assistance.

## Audio Setup for Lectures

The audio setup depends on whether the lecture is in-person or virtual.

### In-Person Lectures

- Set the **"You" channel** (mic) to your laptop microphone or an external microphone
- The "Them" channel is not needed -- you can leave it muted
- Sit close enough for the microphone to pick up the lecturer clearly
- An external USB microphone significantly improves capture quality in large rooms

### Virtual Lectures (Zoom, Teams, Google Meet)

- NexQ captures system audio automatically via WASAPI loopback
- Set the **"Them" channel** to the audio output device your meeting app uses
- The lecturer's audio is captured through system audio -- no extra configuration needed
- Set the "You" channel to your mic if you want to capture your own questions

See [Audio Setup Guide](audio-setup.md) for detailed device configuration.

## During the Lecture

### Real-Time Transcription

Start the meeting with `Ctrl+M` before the lecture begins. NexQ transcribes continuously with speaker labels ("You" and "Them").

### Bookmarking Key Moments

When the lecturer says something important:

- Click the **bookmark button** in the overlay to mark the current moment
- Bookmarks are timestamped and linked to the transcript position
- Use bookmarks to flag key definitions, important dates, exam hints, or anything you want to revisit

### Topic Detection

NexQ automatically segments the lecture into topics as the conversation progresses. Each topic section gets a label based on the content discussed, making it easy to navigate the transcript later.

### Action Item Extraction

NexQ listens for actionable content and extracts it automatically:

- Homework assignments
- Reading assignments
- Project deadlines
- Exam dates and topics
- Study recommendations

### AI Assistance During the Lecture

- Press **Space** to get an instant AI summary of what was just discussed
- Press **4** (Recap) for a running summary of the full lecture so far
- Press **3** (Follow-Up) to generate study questions based on the content
- Press **5** (Ask Question) to ask the AI anything about the lecture content

## After the Lecture

### Review the Transcript

Open the Launcher to access the full meeting record:

1. **Browse bookmarked moments** -- jump directly to the parts you flagged as important
2. **Navigate by topic** -- use the auto-generated topic sections to find specific content
3. **Review action items** -- check the extracted list of homework, deadlines, and tasks

### Use AI for Study

- Select a section of the transcript and ask the AI to **summarize** it
- Use **Ask Question** to quiz yourself on the material
- Generate **follow-up questions** to deepen your understanding

### Export Notes

- Copy the full transcript or selected sections
- Action items and bookmarks are included in the export
- Use the exported notes as a study guide

Suggested export filenames preserve your meeting title's Unicode text, including Chinese, Japanese and Korean. Characters that are invalid in filenames are removed; an empty result uses `meeting`.

## Tips

- **For long lectures (2+ hours)**, use Web Speech API. It handles extended sessions without session timeouts or API cost concerns.
- **Bookmark liberally.** It is easier to review too many bookmarks than to miss something important. You can always delete irrelevant ones later.
- **Load course materials via RAG.** Before the lecture, load your syllabus, textbook excerpts, or previous lecture notes into Context Intelligence. The AI can then reference these when answering your questions. See [Using Context Intelligence (RAG)](rag-context.md).
- **Review the same day.** Transcripts are most useful when reviewed while the content is fresh. Use the AI summarization to create condensed study notes.
- **For in-person lectures**, an external USB microphone placed near the front of the room captures significantly better audio than a laptop mic.

## Next Steps

- [Audio Setup Guide](audio-setup.md) -- Optimize mic and system audio capture
- [Using Context Intelligence (RAG)](rag-context.md) -- Load course materials for AI context
- [AI Providers Guide](ai-providers.md) -- Compare providers for best lecture transcription
- [Keyboard Shortcuts](keyboard-shortcuts.md) -- Full shortcut reference
