# Getting Started with NexQ

NexQ is an AI Meeting Assistant and Real-Time Interview Copilot for Windows. It runs as a desktop application with real-time transcription, AI-powered assistance, and an always-on-top overlay you can use during meetings.

## System Requirements

- Windows 10 or Windows 11
- 8 GB RAM minimum (16 GB recommended for local STT/LLM)
- Microphone for voice capture
- Internet connection (for cloud STT/LLM providers) or local models installed

## Installation

### 1. Download the Installer

Download the latest `.exe` installer from the [GitHub Releases](https://github.com/naxhq/NexQ/releases) page. The file is named `NexQ_x.x.x_x64-setup.exe`.

### 2. Run the Installer

Double-click the downloaded `.exe` file. You may see a Windows SmartScreen warning since the app is not yet code-signed.

**If Windows SmartScreen appears:**

1. Click **"More info"** (the text link, not the button)
2. Click **"Run anyway"**

The installer uses NSIS and installs per-user (no admin rights required). The default location is `%LOCALAPPDATA%\NexQ`.

### 3. First Launch

After installation, NexQ starts automatically. You will see:

- **Launcher window** -- your workspaces: meetings, a chat across them, the files the AI can use, and settings. It opens at 1180x740 (smaller on a small screen) and remembers its size and place. See [Workspaces](workspaces.md)
- **System tray icon** -- NexQ lives in your taskbar tray; closing the window hides it to tray rather than quitting. Click the icon to bring NexQ back

## Quick Setup

![General Settings panel](../../website/public/screenshots/Setting/Setting-General.png)

Open Settings (click the gear icon or press `Ctrl+,`) to access all configuration options. The General settings panel is shown above.

### Configure a Speech-to-Text Provider

NexQ needs an STT provider to transcribe audio. The fastest way to get started:

**Option A: Web Speech for you, a free local model for them**

1. Open Settings (click the gear icon or press `Ctrl+,`)
2. Go to **STT Providers**, select **Parakeet TDT**, download the model (one-time, 465 MB) and click **Activate**
3. Go to **Audio & Devices > Presets** and choose **Free**
4. Web Speech transcribes "You" (mic) with no key. It can't hear system audio, so "Them" uses the Parakeet TDT local model, which works offline once downloaded

The Free preset only saves the settings; it doesn't download the model for you.

Web Speech can only be used by one party, and only with a microphone. For "Them" (system audio) pick a local model or a cloud provider such as Deepgram.

**Option B: Deepgram or Groq (cloud, high accuracy)**

1. Open Settings > STT Providers
2. Select **Deepgram** or **Groq**
3. Enter your API key (get one from [deepgram.com](https://deepgram.com) or [groq.com](https://groq.com))
4. Click **Test Connection** to verify

### Configure an LLM Provider

NexQ uses an LLM to generate AI assistance during meetings. The easiest local option:

**Option A: Ollama (local, free, private)**

1. Install [Ollama](https://ollama.ai) on your machine
2. Pull a model: `ollama pull llama3.2` (or any model you prefer)
3. NexQ auto-detects Ollama on startup -- no configuration needed
4. Open Settings > LLM to verify the connection and select your model

**Option B: OpenAI, Anthropic, or Groq (cloud)**

1. Open Settings > LLM
2. Select your provider
3. Enter your API key
4. Select a model from the dropdown
5. Click **Test Connection** to verify

## Start Your First Meeting

1. **Select audio devices** -- In the launcher, choose your microphone (for "You") and system audio output (for "Them" / remote participants)
2. **Press Start meeting**, or use the keyboard shortcut `Ctrl+M`. The button opens a small dialog where you confirm the audio mode, the workspace and the scenario. `Ctrl+M` starts at once in your default workspace
3. The **overlay window** appears (always-on-top, 500x700) showing:
   - Live transcript with speaker labels (You / Them)
   - AI assist panel with contextual suggestions
4. **Press Space** during the meeting to trigger AI Assist on the current conversation
5. **Press Ctrl+M** again to end the meeting

The meeting is saved automatically with full transcript, AI interactions, and summary. Open it from the list to read it. The **AI** menu in the meeting details has **Generate summary** (**Regenerate summary** when there is one), **Extract action items** and **Suggest bookmarks**. They are dimmed until the meeting has a transcript.

In meeting details, **Words** counts each Chinese character and Japanese kana individually, since those languages don't put spaces between words. Other text, including Korean, is counted by whitespace-separated words. Punctuation alone is not counted. **Pace** and the header's speaker percentages use the same counts.

## Add Your Own Files

To give the AI your resume, notes or course material, open the workspace you will use (you start with **General**) and click **Add** in the **Library** on the right. Add files, a folder or a tool, or paste text. After a few meetings you can ask questions across them in the workspace chat. See [Workspaces](workspaces.md) and [Workspace chat](workspace-chat.md).

## Next Steps

- [Interview Copilot Guide](interview-copilot.md) -- Use NexQ as your real-time interview assistant
- [Lecture Assistant Guide](lecture-assistant.md) -- Transcribe and study from lectures
- [Audio Setup Guide](audio-setup.md) -- Detailed audio device configuration and troubleshooting
- [AI Providers Guide](ai-providers.md) -- Compare all STT and LLM providers to find the best fit
- [Workspaces](workspaces.md) -- Keep the meetings, chats and files of each job, client or course apart
- [Workspace Chat](workspace-chat.md) -- Ask questions across a workspace's meetings and files
- [Meeting Window Layout](meeting-layout.md) -- Choose and arrange the panels
- [Talking Points](talking-points.md) -- Notes you read during a call, with voice-following
- [Live Notes and the Brief](live-notes-and-brief.md) -- Notes written for you while you talk
- [Memory](memory.md) -- Facts a workspace keeps, with a link back to the moment
- [The Library](library.md) -- Documents, folders and tools, and the Knowledge and Tools pills
- [Using Context Intelligence (RAG)](rag-context.md) -- Load documents for AI-enhanced responses
- [Configuration Guide](configuration.md) -- Full provider setup and configuration options
- [Keyboard Shortcuts](keyboard-shortcuts.md) -- Full shortcuts reference
- [Troubleshooting](troubleshooting.md) -- Common issues and solutions
