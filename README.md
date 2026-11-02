<div align="center">

<img src="src-tauri/icons/nexq-clean.png" alt="NexQ logo" width="112">

# NexQ

**The open-source, local-first AI meeting assistant and real-time interview copilot.**
Live two-party transcription, instant AI answers grounded in your own documents, and an overlay only you can see.

[![Latest release](https://img.shields.io/github/v/release/naxhq/NexQ?style=flat-square&color=2f81f7)](https://github.com/naxhq/NexQ/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/naxhq/NexQ/total?style=flat-square&color=orange)](https://github.com/naxhq/NexQ/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/naxhq/NexQ/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/naxhq/NexQ/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/naxhq/NexQ?style=flat-square&color=yellow)](https://github.com/naxhq/NexQ/stargazers)
<br>
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%28Apple%20Silicon%2C%20beta%29-lightgrey?style=flat-square)](https://github.com/naxhq/NexQ/releases/latest)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

**[Download](https://github.com/naxhq/NexQ/releases/latest)** ·
**[Website](https://naxhq.github.io/NexQ/)** ·
**[Docs](docs/user-guide/)** ·
**[Contributing](CONTRIBUTING.md)** ·
**[Report a bug](https://github.com/naxhq/NexQ/issues/new?template=bug_report.yml)**

<br>

<img src="website/public/screenshots/live-meeting-demo.gif" alt="NexQ overlay during a live meeting with real-time transcript, translation and AI assist" width="720">

<sub>The NexQ overlay during a live interview: real-time transcription and AI suggestions.</sub>

</div>

---

## Why NexQ?

- **Local-first and private.** Audio is captured on your machine, and you choose where it goes: fully offline engines (Whisper, Parakeet, Ollama) or the cloud providers you configure. No bot joins your call.
- **Free and open source.** MIT licensed, no account, no subscription, no usage caps.
- **Bring your own models.** 11 speech-to-text engines and 9 LLM providers, from local Whisper and Ollama to Deepgram, OpenAI, Gemini, or your existing Claude Pro/Max subscription.
- **Built for the moment.** Answers stream in while the other person is still talking, grounded in your resume, notes, or slides.

## What's new

> **v2.25**
> - **macOS support (Apple Silicon, beta).** Native macOS build, Keychain credential storage and the transparent overlay. A community contribution by [@visitek](https://github.com/visitek).
> - **Stealth Mode: "Hide from screen share".** NexQ stays visible to you but is left out of screen sharing, recordings and screenshots (`WDA_EXCLUDEFROMCAPTURE` on Windows, `NSWindowSharingNone` on macOS). Toggle it in Settings, from the overlay header or the tray, or with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> on macOS).
> - **Czech transcription.**
>
> **Recently shipped:** transcript paragraphs with separated remote speakers, a transcript scope picker and answer history (v2.24); a Claude model picker read from the CLI with per-model effort (v2.23); Claude via your own subscription, silent background updates, and "Ask a past meeting" (v2.22). See the full [CHANGELOG](CHANGELOG.md).

## Features

<table>
<tr>
<td valign="top" width="50%">

**Transcription**
- Two independent streams: your mic ("You") and system audio ("Them"), each with its own engine, language and mute
- 11 STT engines, local or cloud ([table below](#supported-providers))
- Speaker labeling and remote-speaker separation
- Real-time translation into 100+ languages (5 providers, including offline OPUS-MT)

</td>
<td valign="top" width="50%">

**AI copilot**
- Streaming Assist, What to Say, Shorten, Follow-Up, Recap and free-form Ask
- Automatic question detection and one-key AI actions
- Interview, lecture, oral-exam, webinar and team-meeting scenarios with editable prompts
- AI Call Log: inspect every prompt, latency and token count

</td>
</tr>
<tr>
<td valign="top">

**Privacy and local-first**
- Fully offline mode with local STT and a local LLM
- Local RAG over your PDF, DOCX, TXT and MD files (SQLite FTS + embeddings)
- API keys in the OS credential store, never in plain files
- Stealth Mode keeps NexQ out of screen shares and recordings

</td>
<td valign="top">

**Meeting tools**
- Always-on-top, transparent overlay with global shortcuts
- Meeting detection: a prompt to start NexQ when Zoom, Teams, Meet or Webex starts a call (Windows)
- Bookmarks, action items and topic sections
- Audio recording with synced transcript playback
- Searchable meeting history, summaries and "Ask a past meeting"

</td>
</tr>
</table>

## Screenshots

| Live interview | Lecture mode | Past meeting review |
|:---:|:---:|:---:|
| ![Live interview](website/public/screenshots/Interview.png) | ![Lecture mode](website/public/screenshots/Lecture.png) | ![Past meeting review](website/public/screenshots/Past-meeting.png) |

<details>
<summary>More screenshots</summary>

| Dual-party transcription | Real-time AI copilot |
|:---:|:---:|
| ![Dual-party transcription](<website/public/screenshots/Dual-Party Transcription.png>) | ![Real-time AI copilot](<website/public/screenshots/Real-Time AI Copilot.png>) |
| **Local RAG pipeline** | **Multi-language translation** |
| ![Local RAG pipeline](<website/public/screenshots/Local RAG Pipeline.png>) | ![Multi-language translation](<website/public/screenshots/Multi-Language Translation.png>) |

</details>

## Install

### Windows 10 / 11

1. Download the `x64-setup.exe` installer from the [latest release](https://github.com/naxhq/NexQ/releases/latest).
2. Run the installer. If SmartScreen warns about an unrecognized app, click **More info → Run anyway** (the installer is not code-signed; you can always [build from source](#development)).
3. NexQ updates itself in the background and installs on quit, never in the middle of a meeting.

### macOS (Apple Silicon, beta)

1. Download the `.dmg` from the [releases page](https://github.com/naxhq/NexQ/releases) and drag **NexQ** into **Applications**.
2. The beta build is not notarized, so Gatekeeper will block it. Clear the quarantine flag once:
   ```bash
   xattr -cr /Applications/NexQ.app
   ```
3. Grant microphone access when prompted. Please report anything that misbehaves with the `platform: macos` label.

## Quick start

1. **Pick a speech engine** in Settings → STT Providers. Web Speech works with zero setup; download a local model for offline use, or add a Deepgram / Groq key.
2. **Pick an LLM** in Settings → LLM Providers. [Ollama](https://ollama.com) is detected automatically; cloud providers need an API key; Claude can use your existing subscription.
3. **(Optional) Load context** such as your resume or notes in the Context panel.
4. **Start a meeting** with <kbd>Ctrl</kbd>+<kbd>M</kbd>. NexQ captures system audio, so it works with Zoom, Teams, Meet, Discord, or anything else.

Guides: [Getting started](docs/user-guide/getting-started.md) · [Choosing providers](docs/user-guide/ai-providers.md) · [Audio setup](docs/user-guide/audio-setup.md) · [Interview copilot](docs/user-guide/interview-copilot.md) · [Meeting detection](docs/user-guide/meeting-detection.md) · [Keyboard shortcuts](docs/user-guide/keyboard-shortcuts.md) · [Troubleshooting](docs/user-guide/troubleshooting.md)

## Supported providers

<details>
<summary><b>Speech-to-text (11)</b></summary>

| Engine | Runs | Notes |
|---|---|---|
| Web Speech | Browser API | Zero setup; uses the WebView's built-in speech service |
| Windows Speech | Local | Windows only, offline fallback |
| Whisper.cpp | Local | Downloadable Whisper models, tiny to large-v3 |
| Parakeet TDT | Local | NVIDIA Parakeet via ONNX Runtime, high accuracy |
| ORT Streaming | Local | Streaming transducer via ONNX Runtime |
| Sherpa-ONNX | Local | Streaming transducer in a sidecar process |
| Deepgram | Cloud | Nova-3 and others, real-time streaming |
| Groq Whisper | Cloud | Fast Whisper with a free tier |
| Whisper API | Cloud | OpenAI Whisper REST API |
| Azure Speech | Cloud | Azure Cognitive Services |
| Cartesia | Cloud | ink-2 real-time streaming with built-in turn detection |

</details>

<details>
<summary><b>LLM (9)</b></summary>

| Provider | Runs | Notes |
|---|---|---|
| Ollama | Local | Auto-detected at `localhost:11434` |
| LM Studio | Local | OpenAI-compatible local server |
| OpenAI | Cloud | API key |
| Anthropic | Cloud | API key |
| Google Gemini | Cloud | API key; optional Gemini Context Cache and web-search grounding |
| Groq | Cloud | API key, very fast inference |
| OpenRouter | Cloud | Hundreds of models behind one key |
| Claude (subscription, beta) | Local CLI | Uses your Claude Pro/Max login through the `claude` CLI, no API key ([guide](docs/user-guide/claude-subscription.md)) |
| Custom | Any | Your own endpoint, SSE or NDJSON streaming |

</details>

<details>
<summary><b>Translation (5)</b></summary>

DeepL, Google, Microsoft, any configured LLM, and OPUS-MT (offline, local models).

</details>

<details>
<summary><b>How NexQ compares</b></summary>

| | NexQ | Otter.ai | Granola | Krisp |
|---|:---:|:---:|:---:|:---:|
| Price | **Free** | Paid tiers | Paid tiers | Paid tiers |
| Open source | Yes | No | No | No |
| Fully local option | Yes | No | No | Partial |
| No bot joins the call | Yes | No | Yes | Yes |
| Choice of STT / LLM | 10 / 9 | Fixed | Fixed | Fixed |
| Local LLM | Yes | No | No | No |
| Your own documents as context | Yes | No | No | No |

</details>

## Privacy

- **Nothing leaves your machine unless you choose a cloud provider.** With a local STT engine and a local LLM, NexQ works offline.
- **Your data stays on disk you control:** meetings, transcripts, recordings, models and the RAG index live in the app data folder (`%APPDATA%\com.nexq.app` on Windows, `~/Library/Application Support/com.nexq.app` on macOS).
- **Secrets go to the OS credential store:** Windows Credential Manager or the macOS Keychain.
- **No telemetry or analytics.** Apart from the providers you configure, NexQ only contacts GitHub Releases to check for updates, and every update is verified with an Ed25519 signature.
- Found a security issue? Please follow [SECURITY.md](SECURITY.md).

## Development

NexQ is a [Tauri 2](https://v2.tauri.app/) app: a Rust backend (tokio) and a React 18 + TypeScript frontend.

**Prerequisites**

| | Windows | macOS (Apple Silicon) |
|---|---|---|
| Toolchain | [Node.js](https://nodejs.org/) 20+, [Rust](https://rustup.rs/) stable, [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (ships with Windows 11) | Node.js 20+, Rust stable, Xcode Command Line Tools (`xcode-select --install`) |
| Native build tools | CMake, Ninja, LLVM: `winget install Kitware.CMake Ninja-build.Ninja LLVM.LLVM` | CMake: `brew install cmake` |

```bash
git clone https://github.com/naxhq/NexQ.git
cd NexQ
npm install
npx tauri dev          # run the full app with hot reload
```

| Task | Command |
|---|---|
| Frontend tests (Vitest) | `npm test` |
| Rust tests | `cargo test --lib` (in `src-tauri/`) |
| Type check | `npx tsc --noEmit` |
| Production frontend build | `npm run build` |
| Windows installer | `npx tauri build` |
| macOS app + dmg | `./build-mac.sh` |

Read **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** for setup details, debugging and logs, and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how the pieces fit together.

## Contributing

Contributions of every size are welcome: bug reports, docs, translations, new providers, and macOS testing in particular. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** and look for [`good first issue`](https://github.com/naxhq/NexQ/labels/good%20first%20issue) and [`help wanted`](https://github.com/naxhq/NexQ/labels/help%20wanted). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Community and support

- **Questions and ideas:** [GitHub Discussions](https://github.com/naxhq/NexQ/discussions)
- **Bugs and feature requests:** [Issues](https://github.com/naxhq/NexQ/issues/new/choose). For bugs, include your log: **Settings → About → Diagnostics → Copy recent log** ([how](docs/user-guide/troubleshooting.md#collecting-logs-for-a-bug-report))
- **Security reports:** privately, via [SECURITY.md](SECURITY.md)
- More in [SUPPORT.md](SUPPORT.md)

If NexQ helps you, a star helps others find it.

<a href="https://star-history.com/#naxhq/NexQ&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=naxhq/NexQ&type=Date&theme=dark">
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=naxhq/NexQ&type=Date" width="600">
  </picture>
</a>

## License

[MIT](LICENSE) © Vahid Alizadeh and NexQ contributors.

## Acknowledgements

NexQ stands on the shoulders of
[Tauri](https://tauri.app/),
[React](https://react.dev/),
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) and [whisper-rs](https://github.com/tazz4843/whisper-rs),
[ONNX Runtime](https://onnxruntime.ai/) and the [`ort`](https://github.com/pykeio/ort) crate,
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
[cpal](https://github.com/RustAudio/cpal),
[rusqlite](https://github.com/rusqlite/rusqlite),
[Zustand](https://github.com/pmndrs/zustand),
[Tailwind CSS](https://tailwindcss.com/) and [shadcn/ui](https://ui.shadcn.com/),
and [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT).
Thanks to every contributor, including [@visitek](https://github.com/visitek) for the macOS port.
