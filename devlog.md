# Dev Log

## Repository

- Upstream repository: `https://github.com/VahidAlizadeh/NexQ.git`
- Current local branch: `Rus-Localization`
- Previous STT fix commit: `a4ff29e  Final Fix STT language persistence`

## CONTRIBUTING.md Notes

The project contribution flow requires:

1. Fork the repository.
2. Create a branch from `main`.
3. Make atomic commits using Conventional Commits:
   - `feat(scope): description`
   - `fix(scope): description`
   - `docs: description`
   - `refactor(scope): description`
4. Verify changes with:
   - `npx tsc --noEmit`
   - `cargo check`
   - `npx tauri dev`
5. Push the branch to the fork.
6. Open a Pull Request to upstream `main`.

## Work Already Completed

### STT Language Persistence Fix

Implemented a full STT language persistence and backend sync path.

Changed areas:

- `src/stores/configStore.ts`
  - Added persisted `sttLanguage`.
  - Added `setSTTLanguage`.
  - Loaded `sttLanguage` from Tauri plugin-store.
  - Synced language to Rust backend on startup.
  - Synced language to Rust backend immediately when changed.

- `src/settings/STTSettings.tsx`
  - Replaced local language `useState("en-US")`.
  - Connected the Language dropdown to Zustand `sttLanguage`.
  - Added Parakeet CTC 110M warning for non-English languages.

- `src/lib/ipc.ts`
  - Added frontend IPC wrapper `setSTTLanguage(language)`.

- `src-tauri/src/commands/stt_commands.rs`
  - Added Tauri command `set_stt_language`.

- `src-tauri/src/lib.rs`
  - Registered `stt_commands::set_stt_language`.

- `src/hooks/useSpeechRecognition.ts`
  - Replaced hardcoded Web Speech `en-US` with persisted `sttLanguage`.
  - Restart effect now reacts to language changes.

- `src-tauri/src/stt/deepgram.rs`
  - Added Deepgram language normalization.
  - Example: UI `ru-RU` becomes Deepgram API language code `ru`.

- `src-tauri/src/stt/provider.rs`
  - Updated Parakeet TDT metadata with multilingual language support, including `ru`.

### Documentation

- Created `Fix STT language.md`.
- Translated it to Russian for local planning.
- Created `russian_localization.md` with a step-by-step Russian UI localization plan.

## Verification Already Run

Frontend:

```bash
npm run build
```

Result:

- Passed.
- Vite reported existing chunk/dynamic import warnings.

Rust:

```bash
cd src-tauri
cargo check
cd ..
```

Result:

- Passed.

Formatting:

```bash
cd src-tauri
cargo fmt --check
cd ..
```

Result:

- Failed because the repository already has many unrelated Rust formatting differences.
- Did not run `cargo fmt` to avoid a huge unrelated diff.

Manual dev run:

```powershell
$env:TAURI_DEV_HOST="127.0.0.1"
npm run tauri dev -- --config '{"build":{"devUrl":"http://127.0.0.1:5173"}}'
```

Result:

- Worked.
- The issue was Vite binding to IPv6 `::1` while Tauri/WebView expected a reachable `localhost`/IPv4 endpoint.

## Current Localization Work

Created branch:

```bash
Rus-Localization
```

Created localization plan:

```text
russian_localization.md
```

Current plan direction:

- Do not reuse transcript translation code for UI localization.
- Add a separate UI i18n layer.
- Translate UI by area:
  - shell/navigation;
  - settings;
  - onboarding wizard;
  - launcher;
  - overlay;
  - context/RAG UI;
  - call log;
  - tray menu.

## Important Notes Before PR

The commit `a4ff29e  Final Fix STT language persistence` does not follow the Conventional Commits format from `CONTRIBUTING.md`.

For future commits on the fork, use messages like:

```bash
fix(stt): persist language selection
docs(localization): add Russian UI localization plan
feat(ui): add Russian localization infrastructure
```

If this branch will be submitted as a PR, consider either:

- leaving the existing commit as-is if maintainers do not enforce commit linting; or
- rewriting/squashing commits before PR so the final commit messages follow Conventional Commits.

## Current Git Caveat

`git status --short` may show:

```text
M CONTRIBUTING.md
M src-tauri/Cargo.toml
```

Current content diff for those files is empty. This appears to be a line-ending/worktree metadata issue. Do not stage them unless there is a real content diff.
