//! Personal sources: notes folders and MCP servers the Claude subscription
//! session can use for answers the user asked for.
//!
//! # How the Claude CLI behaves (checked with claude 2.1.329, `--model haiku`)
//!
//! The with-sources session is a persistent `claude.exe` that differs from the
//! plain one in a few flags. Each of these was tried against a real CLI, a
//! hand-written stdio MCP server and a streamable-HTTP one.
//!
//! | Flag or behavior | Seen | Decision |
//! |---|---|---|
//! | `--safe-mode` with `--mcp-config` | MCP servers are dropped (`mcp_servers: []`). | Not usable with sources. |
//! | `--safe-mode` with `--allowedTools Read Grep Glob` | `Read` of an absolute path outside the cwd and `--add-dir` worked. No confinement. | Not usable with sources. |
//! | `--restricted --strict-mcp-config --mcp-config` | Server `connected`, tools named `mcp__<key>__<tool>`. Your user settings, `~/.claude/CLAUDE.md`, user-scope MCP servers and claude.ai connectors stay out. | Use it for with-sources; plain sessions keep `--safe-mode`. |
//! | `--add-dir` under `--restricted` | Reads fine, also a path with spaces and `@` as one argv entry. | One argv entry per folder. |
//! | Confinement under `--restricted` with `--allowedTools Read Grep Glob` | Absolute outside paths, `..\` paths, and Grep/Glob on the parent were all refused. | No path-scoped rules needed (a deny rule still covers NexQ's private folder). |
//! | `--allowedTools` form | Separate argv entries work. The flag is variadic, so the prompt goes on stdin, never as a positional. | One value per argv entry. |
//! | Tool name | `mcp__<key>__<tool>`; every character outside `[A-Za-z0-9_-]` becomes `_`; `a__b` is ambiguous. | Keys are `[a-z0-9-]` and never contain `__`; tool names are checked (`config::is_valid_tool_full_name`). |
//! | A write tool missing from the allow list | Denied automatically with `--permission-prompts none`. | Use the allow list and also `--disallowedTools` for switched-off tools. |
//! | `${VAR}` in `--mcp-config` | Expanded from the CLI's own environment, but an unset one is not an error: the server starts with the literal text. | Not used. Each server's secrets are written into its entry of a private per-session file (`private_files`), deleted once init arrives. |
//! | Env inheritance | A stdio server inherits the whole `claude.exe` environment, so every server would see every other server's secrets. | Secrets never go in the process env. |
//! | Config file after init | The CLI restarts a killed stdio server from memory with the file already deleted. | Safe to delete the file as soon as `system/init` arrives. |
//! | HTTP server | `{"type":"http","url":...,"headers":{...}}` works; a 401 without OAuth metadata shows as `failed`. | A URL plus header secrets; OAuth sign-in is not supported. |
//! | `system/init` | Prints only after the first stdin message, and after the MCP servers connected (about 0.5 s fast, a hung server shows `failed` at its startup timeout). Carries `name` and `status` per server, no error text. | The session is primed with an empty `shouldQuery:false` message; a failed Check starts the server alone to find the cause (`mcp_diagnose`). |
//! | `MCP_TIMEOUT` (ms) | Measured with a stdio server that never answers: `system/init` arrives at `MCP_TIMEOUT` plus about 0.3 s (8 s gave 8.4 s, 20 s gave 20.3 s) with that server `pending`, not `failed`. | 20 s in meeting sessions; the Check alone gets 60 s (`mcp_check::CHECK_MCP_TIMEOUT_MS`, init limit 75 s), since a first `npx`/`uvx` run downloads the server. |
//! | `MCP_TOOL_TIMEOUT` (ms), `MAX_MCP_OUTPUT_TOKENS` | A tool that outlives `MCP_TOOL_TIMEOUT` returns an error result ("timed out after 3s"). | Set for with-sources sessions only (`command::configure_sources_env`). |
//! | Bare `npx` / `uvx` on Windows | Checked with CLI 2.1.329 and a stand-in `npx.cmd` first on `PATH`: `{"command":"npx"}` and `{"command":"cmd","args":["/c","npx",...]}` both connect (the CLI finds `.cmd` shims itself). | No rewriting of commands. Rust's `Command` adds only `.exe`, so the diagnose run resolves the name through `PATHEXT` itself (`mcp_diagnose::resolve_command`). |
//! | Tool events | An `assistant` line carries each `tool_use` (with its `id`); the `user` line that follows carries the `tool_result` with `is_error`. | A chip is added only after a result without `is_error`. |
//!
//! With-sources launch arguments, each value its own argv entry:
//!
//! ```text
//! -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
//! --restricted
//! --tools Read,Grep,Glob              (--tools "" when there are only tools, no folders)
//! --disallowedTools <switched-off tools>   (omitted when empty; never "*")
//! --permission-prompts none --no-session-persistence
//! --allowedTools Read Grep Glob mcp__<key>__<tool> ...
//! --strict-mcp-config --mcp-config <private file>
//! --add-dir <folder>                  (once per folder)
//! --model <m> [--effort <e>] --system-prompt-file <file>
//! ```
//!
//! The plain session is unchanged: `--safe-mode`, `--tools ""`, `--disallowedTools *`.

pub mod activity;
pub mod config;
pub mod launch;
pub mod mcp_json;
pub mod notes;
pub mod private_files;
