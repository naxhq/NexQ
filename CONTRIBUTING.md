# Contributing to NexQ

Thank you for considering a contribution. NexQ is a community project, and every bug report, docs fix, translation, test and pull request makes it better for the people who rely on it in their most important meetings.

This guide covers everything you need to go from idea to merged pull request. If anything here is unclear, that is a docs bug: please [open an issue](https://github.com/naxhq/NexQ/issues/new/choose) or ask in [Discussions](https://github.com/naxhq/NexQ/discussions).

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Contents

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Coding conventions](#coding-conventions)
- [Testing](#testing)
- [Commit messages](#commit-messages)
- [Branches and pull requests](#branches-and-pull-requests)
- [How releases work](#how-releases-work)
- [Licensing](#licensing)
- [Getting help](#getting-help)

## Ways to contribute

You do not need to write Rust to help.

- **Report bugs.** Use the [bug report form](https://github.com/naxhq/NexQ/issues/new?template=bug_report.yml). Your NexQ version, OS, providers and log make a bug fixable: copy the log from **Settings → About → Diagnostics** ([details](docs/user-guide/troubleshooting.md#collecting-logs-for-a-bug-report)).
- **Test on macOS.** macOS support (Apple Silicon) is in beta. Real-world reports on different Macs, audio setups and meeting apps are very valuable.
- **Improve the docs.** The [user guide](docs/user-guide/) and developer docs ([architecture](docs/ARCHITECTURE.md), [development](docs/DEVELOPMENT.md)) always need clearer steps and fresh screenshots.
- **Suggest features.** Use the [feature request form](https://github.com/naxhq/NexQ/issues/new?template=feature_request.yml) and describe the problem before the solution.
- **Add languages and providers.** New STT languages, translation targets, and STT or LLM providers are well-scoped contributions.
- **Fix issues.** Look for [`good first issue`](https://github.com/naxhq/NexQ/labels/good%20first%20issue) and [`help wanted`](https://github.com/naxhq/NexQ/labels/help%20wanted).
- **Review pull requests.** Trying a branch locally and reporting what you saw is real help.

For larger changes (a new provider, a new window, a database migration, or anything touching audio capture), please open an issue or discussion first so we can agree on the approach before you invest the time.

## Development setup

### Prerequisites

| | Windows 10 / 11 | macOS (Apple Silicon) |
|---|---|---|
| Node.js | 20+ | 20+ |
| Rust | stable via [rustup](https://rustup.rs/) | stable via rustup |
| Platform SDK | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) and the MSVC build tools | Xcode Command Line Tools: `xcode-select --install` |
| Native build tools | CMake, Ninja and LLVM (needed by whisper.cpp) | CMake: `brew install cmake` |

On Windows, install the native tools with:

```powershell
winget install --silent Kitware.CMake Ninja-build.Ninja LLVM.LLVM
```

`src-tauri/.cargo/config.toml` points `LIBCLANG_PATH` at `C:\Program Files\LLVM\bin` and uses the Ninja generator, so `cmake` and `ninja` must be on `PATH`. Open a new shell after installing.

See also the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Run the app

```bash
git clone https://github.com/<your-username>/NexQ.git
cd NexQ
npm install
npx tauri dev
```

`npx tauri dev` stages ONNX Runtime (`scripts/fetch-onnxruntime.mjs`), starts the Vite dev server on port 5173, compiles the Rust backend and opens the app. Frontend changes hot-reload; Rust changes trigger a rebuild. The first Rust build takes a while because whisper.cpp is compiled from source.

On macOS, run `source scripts/macos-env.sh` once per shell before `npx tauri dev` (it overrides the Windows libclang/CMake defaults). `./build-mac.sh` builds the `.app` and `.dmg` and installs to `/Applications`; run `./build-mac.sh --help` for options.

More detail, including debugging and log locations, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Project structure

```
src/                     React + TypeScript frontend
  launcher/              Main window (900x650): meetings list, details, setup
  overlay/               In-meeting overlay (always on top, transparent)
  settings/              Settings panels
  calllog/               AI Call Log sidebar
  context/               Context Intelligence panel (documents, RAG)
  components/            shadcn/ui primitives and shared components
  stores/                Zustand stores, one per feature domain
  hooks/                 useXxx hooks: side effects and Tauri event listeners
  lib/
    types.ts             All TypeScript types (mirrors Rust structs)
    ipc.ts               Typed invoke() wrappers for every Tauri command
    events.ts            Typed Tauri event listeners
src-tauri/src/           Rust backend
  lib.rs                 Module registration and Tauri setup
  state.rs               AppState: Arc<Mutex<>> manager slots
  commands/              IPC command modules
  audio/                 Mic and system audio capture, VAD, recording
  stt/                   STT providers behind a trait-based router
  llm/                   Streaming LLM providers (cli_agent/ is the Claude CLI provider)
  intelligence/          Prompt assembly, transcript buffer, question detection
  rag/                   Local RAG: chunking, embeddings, FTS, vector search
  translation/           Translation providers, including offline OPUS-MT
  context/               Document loading (PDF, TXT, MD, DOCX)
  db/                    SQLite (rusqlite) and migrations
  credentials/           OS credential store
docs/user-guide/         End-user documentation
website/                 Project website (Astro), deployed to GitHub Pages
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how data flows between these pieces.

## Coding conventions

### Keep TypeScript and Rust in sync

- `src/lib/types.ts` is the single source of truth for frontend types and **must mirror the Rust structs exactly**. A mismatched field name or shape breaks IPC serialization silently: no compile error, just missing data at runtime.
- Every Tauri command has a typed wrapper in `src/lib/ipc.ts`. Components call the wrapper, never raw `invoke()`.
- Every backend event has a typed listener in `src/lib/events.ts`.

### Adding a Tauri command

1. Write the command in the right module under `src-tauri/src/commands/`:
   ```rust
   #[command]
   pub async fn my_command(arg: String, state: State<'_, AppState>, app: AppHandle) -> Result<MyResult, String>
   ```
2. Register it in `src-tauri/src/lib.rs` (new command groups must be added there too).
3. Add the types to `src/lib/types.ts` and a wrapper to `src/lib/ipc.ts`.
4. Backend-to-frontend notifications use `app_handle.emit("event_name", payload)` plus a listener in `events.ts`.

### Frontend

- **State:** Zustand stores in `src/stores/`, one per feature domain. Remember there are two windows (launcher and overlay), each with its own store instances; state crosses windows through IPC events.
- **Hooks:** side effects and event subscriptions live in `useXxx` hooks in `src/hooks/`.
- **Styling:** Tailwind CSS, shadcn/ui and the CSS custom properties used for theming. Avoid hard-coded colors.
- **Naming:** camelCase in TypeScript, snake_case in Rust.

### Design principles

NexQ aims to feel like a premium instrument: bold, refined, alive. When you touch UI:

1. **Every pixel is intentional.** No leftover defaults.
2. **Motion earns attention.** Animation communicates state, never decorates.
3. **Hierarchy over density.** Size, weight, color and space create layers.
4. **Color with meaning.** Every color communicates something.
5. **Restraint is confidence.**

Please include before/after screenshots for any visual change. The full design context is in [`.impeccable.md`](.impeccable.md).

### Known pitfalls

- **Two-party audio:** "You" (mic) and "Them" (system audio) are independent streams with separate STT providers, mute controls and levels. Changes must handle both.
- **Web Speech hot-swap:** recreating `SpeechRecognition` mid-session breaks the browser API. Stop cleanly before switching.
- **RAG is async:** indexing reports progress via `rag_index_progress` events and must never block the UI thread.
- **Platform code:** gate OS-specific Rust with `#[cfg(target_os = "...")]` and keep both Windows and macOS compiling.

## Testing

Run these before opening a pull request:

```bash
npx tsc --noEmit                 # TypeScript type check
npm test                         # Vitest (jsdom) frontend tests
npm run build                    # tsc + Vite production build
cd src-tauri && cargo test --lib # Rust unit tests
```

CI runs the type check, the frontend tests and `cargo check` on every pull request, plus `cargo test --lib` on macOS.

- Add or update tests for behavior you change. Frontend tests live next to the code (`*.test.ts` / `*.test.tsx`); Rust tests are `#[cfg(test)]` modules in the same file.
- For audio, STT and overlay changes, also do a manual smoke test with `npx tauri dev` and describe what you tested in the PR.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The changelog and the version bump are generated from commit messages, so the format matters.

```
<type>(<optional scope>): <description>
```

| Type | Use for | Version effect |
|---|---|---|
| `feat` | A new user-facing feature | minor (2.24.0 → 2.25.0) |
| `fix` | A bug fix | patch (2.24.0 → 2.24.1) |
| `perf` | A performance improvement | in changelog |
| `refactor` | Code change with no behavior change | none |
| `docs` | Documentation only | none |
| `test` | Adding or fixing tests | none |
| `chore` | Tooling, dependencies, housekeeping | none |
| `ci` | CI configuration | none |
| `style` | Formatting only | none |

A breaking change uses `feat!:` or a `BREAKING CHANGE:` footer and triggers a major bump.

Common scopes: `stt`, `llm`, `claude`, `audio`, `overlay`, `launcher`, `settings`, `intelligence`, `rag`, `context`, `calllog`, `translation`, `meetings`, `db`, `updater`, `tray`, `ui`, `macos`, `build`.

```
feat(stt): add Deepgram Nova-3 provider
fix(overlay): window position not persisting between sessions
perf(player): cache waveform layer and cap peaks
docs: add macOS build steps to DEVELOPMENT.md
```

Write the description in the imperative mood and keep commits atomic: one logical change per commit.

## Branches and pull requests

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b fix/overlay-position main
   ```
   Name branches `<type>/<short-description>`, for example `feat/czech-stt`, `fix/deepgram-reconnect`, `docs/macos-setup`.
2. **Make your change** with focused, conventional commits.
3. **Run the checks** in [Testing](#testing).
4. **Open a pull request** against `main` and fill in the template. Link the issue it resolves (`Closes #123`).
5. **Keep it small.** Smaller PRs get reviewed faster. Split refactors from behavior changes.

### Review expectations

- A maintainer will usually respond within a few days. If a week passes without a response, a friendly ping on the PR is welcome.
- CI must pass. Reviewers may ask for changes; push follow-up commits to the same branch rather than opening a new PR.
- A PR may be squash-merged, so give it a title that is itself a valid Conventional Commit message.
- Be patient and kind with each other. Reviews are about the code, never the person.

## How releases work

Releases are cut by maintainers only:

- `npm run release` reads the commits since the last tag, generates `CHANGELOG.md`, bumps the version in `package.json`, `src/lib/version.ts`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then commits, tags and pushes.
- GitHub Actions builds, signs and publishes the installers and the updater manifest to GitHub Releases.

**Contributors must not** bump versions, edit `CHANGELOG.md`, or create tags. Your conventional commit messages are what end up in the release notes.

## Licensing

NexQ is released under the [MIT License](LICENSE). There is no CLA or DCO sign-off: by submitting a contribution you agree that it is licensed under the MIT License and that you have the right to submit it.

## Getting help

- **Stuck on setup or have a question?** Ask in [Discussions](https://github.com/naxhq/NexQ/discussions).
- **Want to pick up an issue?** Comment on it so others know it is taken.
- **Security issue?** Do not open a public issue; follow [SECURITY.md](SECURITY.md).

Thanks again for helping build NexQ.
