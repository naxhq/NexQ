# Developing NexQ

Everything you need to build, run, test and debug NexQ locally. For how the code is organized, read [ARCHITECTURE.md](ARCHITECTURE.md); for the contribution workflow, read [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

### Windows 10 / 11

- [Node.js](https://nodejs.org/) 20 or newer
- [Rust](https://rustup.rs/) stable (MSVC toolchain) and the Visual Studio C++ build tools
- [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11)
- CMake, Ninja and LLVM, required to compile whisper.cpp:
  ```powershell
  winget install --silent Kitware.CMake Ninja-build.Ninja LLVM.LLVM
  ```
  `src-tauri/.cargo/config.toml` sets `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin` and uses the Ninja generator, so `cmake` and `ninja` must be on `PATH`. Open a new terminal after installing.

### macOS (Apple Silicon)

- Node.js 20 or newer and Rust stable
- Xcode Command Line Tools: `xcode-select --install`
- CMake: `brew install cmake` (Ninja optional: `brew install ninja`)
- Before `npx tauri dev`, run `source scripts/macos-env.sh` in that shell: it points `LIBCLANG_PATH` at the Xcode toolchain and picks a CMake generator, overriding the Windows defaults in `src-tauri/.cargo/config.toml`. `./build-mac.sh` does this for you.

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) if something is missing.

## First run

```bash
git clone https://github.com/naxhq/NexQ.git
cd NexQ
npm install
npx tauri dev
```

`npx tauri dev` runs the `beforeDevCommand` from `src-tauri/tauri.conf.json`: it stages ONNX Runtime with `scripts/fetch-onnxruntime.mjs` (downloaded once into `src-tauri/ort/`, checksum-verified, skipped when already present), starts Vite on port 5173, then compiles and launches the Rust app. The first build compiles whisper.cpp and takes several minutes; later builds are incremental.

Development builds, release builds, and CI use the same staging script. On Windows x64 and Apple Silicon, it tries the pinned GitHub release archive first. If that download fails, it uses the same version of the official [Microsoft.ML.OnnxRuntime package on NuGet](https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime). Each archive has its own pinned SHA-256 checksum, which the script checks before extracting the runtime.

## Everyday commands

| Command | What it does |
|---|---|
| `npx tauri dev` | Full app with frontend hot reload and Rust rebuild on change |
| `npm run dev` | Vite dev server only (UI in a browser, no backend; IPC calls fail) |
| `npm run build` | TypeScript check and Vite production build |
| `npx tsc --noEmit` | Type check only |
| `npm test` | Vitest (jsdom) frontend tests, run once |
| `npm run test:watch` | Vitest in watch mode |
| `cargo test --lib` | Rust unit tests (run in `src-tauri/`) |
| `cargo check` | Fast Rust compile check (run in `src-tauri/`) |
| `npx tauri build` | Production build (NSIS installer on Windows) |
| `./build-mac.sh` | macOS: build the `.app` and `.dmg` and install to `/Applications` (`--help` for options) |

Do not run `npm run release`; releases are cut by maintainers (see [CONTRIBUTING.md](../CONTRIBUTING.md#how-releases-work)).

## Testing

- **Frontend:** tests sit next to the code as `*.test.ts` / `*.test.tsx` and use Vitest, jsdom and Testing Library. Global setup is in `src/test/setup.ts`. Tauri APIs are not available in jsdom, so mock `src/lib/ipc.ts` or `@tauri-apps/api` in tests.
- **Backend:** unit tests are `#[cfg(test)]` modules inside the Rust files. Recorded protocol fixtures for the Claude CLI provider live in `src-tauri/src/llm/cli_agent/fixtures/`.
- **CI** (`.github/workflows/ci.yml`) runs `npx tsc --noEmit`, `npm test` and `cargo check` on Windows for every pull request.
- **Manual testing:** audio and STT behavior depends on real devices. For changes there, test with an actual call (or any audio playing for "Them") and say in the PR which providers and devices you used. Demo mode (scripted scenarios in `src/demo/`) is handy for UI work without a live meeting.

## Logs and debugging

### Logs

Logging never blocks the caller: `log` macros hand the line to a writer thread over a bounded channel, so audio callbacks and STT loops can log freely. Lines that look like API keys or bearer tokens are masked before they're written. Never log transcript text, prompts or responses; log counts and lengths instead.

| Source | How to see it |
|---|---|
| App log file | `src-tauri/src/logging.rs`. Every `log::info!`/`warn!`/`error!` from our crate, warnings from dependencies, frontend `console.error`/`console.warn`, uncaught errors and Rust panics go to `nexq.log` in the OS log folder, and to the terminal running `npx tauri dev`. Settings → About → Diagnostics opens the folder, copies the last 400 lines, and toggles **Verbose logging** (adds our `debug!` lines and dependencies' `info!`). This is what to ask users for. |
| Dev Log panel | In the overlay, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or click the terminal icon. Shows STT connection status and debug messages live; it can be detached into its own window. |
| AI Call Log | Sidebar listing every LLM request with provider, model, prompt, timing, usage and errors. |
| Frontend console | Dev builds include WebView devtools: press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> (<kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>I</kbd> on macOS). Each window (launcher, overlay) has its own console. |

### Data locations

| | Windows | macOS |
|---|---|---|
| App data (database `nexq.db`, `models/`, `recordings/`, settings) | `%APPDATA%\com.nexq.app\` | `~/Library/Application Support/com.nexq.app/` |
| App log (`nexq.log`, rotated to `nexq.1.log`…`nexq.4.log` at 4 MB) | `%LOCALAPPDATA%\com.nexq.app\logs\` | `~/Library/Logs/com.nexq.app/` |
| API keys | Windows Credential Manager | Keychain |

Deleting `nexq.db` (with the app closed) gives you a clean database; migrations recreate it on next launch. Back it up first if it holds meetings you care about.

### Tips

- **Two windows, two consoles.** The launcher and overlay each have their own JavaScript context and store instances. If state looks stale in one window, check that the relevant event is emitted and handled in both.
- **IPC shape bugs are silent.** If a field arrives as `undefined`, compare the Rust struct (including `serde` renames) with `src/lib/types.ts`.
- **whisper.cpp build flags are cached.** `whisper-rs-sys` does not rebuild when the `GGML_*` variables in `src-tauri/.cargo/config.toml` change. Run `cargo clean -p whisper-rs-sys` in `src-tauri/` after editing them (CI uses a cache key prefix for the same reason).
- **ONNX Runtime problems.** Local ONNX engines (Parakeet TDT, ORT Streaming) load the runtime staged in `src-tauri/ort/`. If loading fails, delete that folder and rerun `node scripts/fetch-onnxruntime.mjs`.
- **Web Speech hot-swap.** Do not recreate `SpeechRecognition` mid-session; stop it cleanly before switching providers or devices.
- **Claude CLI provider.** Requires the `claude` CLI installed and logged in with a subscription account. See the [Claude subscription guide](user-guide/claude-subscription.md) and the code in `src-tauri/src/llm/cli_agent/`.
- **Rust debugging.** The backend is a normal Rust binary: attach a debugger such as CodeLLDB (VS Code) or the Visual Studio debugger to the running `nexq` process from a dev build.
