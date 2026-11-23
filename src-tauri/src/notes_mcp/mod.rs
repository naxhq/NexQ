//! NexQ's own read-only notes server for the Antigravity and Codex CLIs.
//!
//! Those CLIs read files with their own tools, and what such a tool will read
//! is decided by the CLI (it can auto-allow, and its arguments are free-form).
//! So their sessions get no file tools at all. The notes folders are served by
//! this MCP server instead, started by the CLI as `nexq.exe --notes-mcp`, where
//! Rust opens every file itself and decides what is inside a folder
//! ([`vault`]).
//!
//! Protocol: MCP over stdio, JSON-RPC 2.0, one message per line. Methods:
//! `initialize`, `notifications/initialized`, `ping`, `tools/list`,
//! `tools/call`. Tools (all read-only): `list_notes`, `search_notes`,
//! `read_note`.
//!
//! The folders arrive in the environment variable [`DIRS_ENV`] as a JSON array
//! of paths (paths are not secrets, and this keeps the argument list short).
//! The mode is picked in `main` before anything of the app starts, so it never
//! hands over to a running NexQ and never opens a window.

pub mod vault;

use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use vault::Notes;

/// The argument that makes `nexq.exe` run as the notes server.
pub const NOTES_MCP_ARG: &str = "--notes-mcp";
/// The environment variable that carries the allowed folders (a JSON array).
pub const DIRS_ENV: &str = "NEXQ_NOTES_DIRS";
/// The key NexQ gives the server in the CLI's MCP configuration.
pub const SERVER_KEY: &str = "nexq_notes";
/// The tools it offers.
pub const TOOLS: [&str; 3] = ["list_notes", "search_notes", "read_note"];

/// MCP revisions this server speaks, newest first.
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
/// A line longer than this is not read.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Was NexQ started as the notes server?
pub fn is_notes_mode<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter().skip(1).any(|a| a.as_ref() == OsStr::new(NOTES_MCP_ARG))
}

/// What the CLI's MCP configuration needs to start the server: the command,
/// its arguments and its environment, for the folders `dirs`.
pub fn server_command(exe: &std::path::Path, dirs: &[PathBuf]) -> Value {
    let list: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect();
    json!({
        "command": exe.to_string_lossy(),
        "args": [NOTES_MCP_ARG],
        "env": { DIRS_ENV: serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()) },
    })
}

/// The folders from [`DIRS_ENV`]'s value; anything that is not a JSON array of
/// strings gives none.
pub fn dirs_from_env(value: Option<&str>) -> Vec<PathBuf> {
    value
        .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
        .map(|v| v.into_iter().filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default()
}

/// Run the server on stdin and stdout until stdin closes. The exit code for `main`.
pub fn run_stdio() -> i32 {
    let dirs = dirs_from_env(std::env::var(DIRS_ENV).ok().as_deref());
    let (notes, skipped) = Notes::open(&dirs);
    for why in skipped {
        eprintln!("nexq notes: left out {why}");
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    match serve(stdin.lock(), stdout.lock(), &notes) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("nexq notes: {e}");
            1
        }
    }
}

/// Answer the messages on `input` to `output` until `input` ends.
pub fn serve(mut input: impl BufRead, mut output: impl Write, notes: &Notes) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let read = Read::take(&mut input, MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut buf)?;
        if read == 0 {
            return Ok(());
        }
        let too_long = buf.len() > MAX_LINE_BYTES && !buf.ends_with(b"\n");
        if too_long {
            // Skip the rest of the line.
            loop {
                buf.clear();
                let n = Read::take(&mut input, MAX_LINE_BYTES as u64).read_until(b'\n', &mut buf)?;
                if n == 0 || buf.ends_with(b"\n") {
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&buf).trim().to_string();
        let reply = if too_long {
            Some(error_reply(&Value::Null, -32600, "Request too large"))
        } else if text.is_empty() {
            continue;
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(message) => handle(&message, notes),
                Err(_) => Some(error_reply(&Value::Null, -32700, "Parse error")),
            }
        };
        if let Some(reply) = reply {
            writeln!(output, "{reply}")?;
            output.flush()?;
        }
    }
}

fn error_reply(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok_reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The reply to one message, `None` for a notification.
pub fn handle(message: &Value, notes: &Notes) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(error_reply(&Value::Null, -32600, "Invalid request"));
    };
    let method = object.get("method").and_then(Value::as_str);
    let id = object.get("id").filter(|id| !id.is_null());
    let (Some(method), Some(id)) = (method, id) else {
        // A notification (or a response to a request we never made): no reply.
        return if method.is_some() { None } else { Some(error_reply(&Value::Null, -32600, "Invalid request")) };
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            let version = SUPPORTED_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&SUPPORTED_VERSIONS[0]);
            ok_reply(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "nexq-notes", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => ok_reply(id, json!({})),
        "tools/list" => ok_reply(id, json!({ "tools": tool_list() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match call_tool(name, &args, notes) {
                Some(Ok(text)) => ok_reply(id, tool_result(&text, false)),
                Some(Err(text)) => ok_reply(id, tool_result(&text, true)),
                None => error_reply(id, -32602, &format!("Unknown tool: {name}")),
            }
        }
        _ => error_reply(id, -32601, "Method not found"),
    })
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// `None`: no such tool.
fn call_tool(name: &str, args: &Value, notes: &Notes) -> Option<Result<String, String>> {
    let text = |key: &str| args.get(key).and_then(Value::as_str);
    Some(match name {
        "list_notes" => notes.list(text("folder"), text("subpath")),
        "search_notes" => match text("query") {
            Some(query) => notes.search(query, text("folder")),
            None => Err("`query` is required.".into()),
        },
        "read_note" => match text("path") {
            Some(path) => notes.read(path),
            None => Err("`path` is required.".into()),
        },
        _ => return None,
    })
}

fn tool_list() -> Value {
    let read_only = json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
    json!([
        {
            "name": "list_notes",
            "description": "List the user's notes folders, or the notes and sub folders inside one folder. Call this first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "A notes folder name from the first call. Optional when there is only one." },
                    "subpath": { "type": "string", "description": "A sub folder inside it, like projects/falcon. Optional." }
                }
            },
            "annotations": read_only,
        },
        {
            "name": "search_notes",
            "description": "Search the text of the notes (.md, .markdown, .txt) for a word or phrase, ignoring case. Returns path:line: text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The text to look for." },
                    "folder": { "type": "string", "description": "Search only this notes folder. Optional." }
                },
                "required": ["query"]
            },
            "annotations": read_only,
        },
        {
            "name": "read_note",
            "description": "Read one note. Use a path from list_notes or search_notes, like Folder/sub/note.md.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "The note's path." } },
                "required": ["path"]
            },
            "annotations": read_only,
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn notes_in(tag: &str) -> (Notes, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nexq-mcp-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("Vault")).unwrap();
        std::fs::write(dir.join("Vault").join("falcon.md"), "Project Falcon launches on March 3.\n").unwrap();
        std::fs::write(dir.join("secret.md"), "TOPSECRET").unwrap();
        let (notes, _) = Notes::open_with(&[dir.join("Vault")], &|_| None);
        (notes, dir)
    }

    /// Feed `lines` to the server and return what it printed, one JSON value per line.
    fn talk(notes: &Notes, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        serve(Cursor::new(input.into_bytes()), &mut out, notes).unwrap();
        String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn call(id: u64, name: &str, args: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": args } })
    }

    #[test]
    fn a_client_session_from_initialize_to_a_note() {
        let (notes, dir) = notes_in("session");
        let replies = talk(
            &notes,
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
                call(4, "list_notes", json!({})),
                call(5, "search_notes", json!({ "query": "falcon" })),
                call(6, "read_note", json!({ "path": "Vault/falcon.md" })),
            ],
        );
        // The notification gets no reply.
        assert_eq!(replies.len(), 6);
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "nexq-notes");
        assert!(replies[0]["result"]["capabilities"]["tools"].is_object());
        assert_eq!(replies[1]["result"], json!({}));
        let names: Vec<&str> = replies[2]["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, TOOLS);
        for tool in replies[2]["result"]["tools"].as_array().unwrap() {
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(text(&replies[3]).contains("Vault/falcon.md"));
        assert!(text(&replies[4]).contains("Vault/falcon.md:1: Project Falcon launches on March 3."));
        assert_eq!(text(&replies[5]).trim(), "Project Falcon launches on March 3.");
        assert_eq!(replies[5]["result"]["isError"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_path_outside_the_folder_is_a_tool_error_not_a_file() {
        let (notes, dir) = notes_in("outside");
        let replies = talk(
            &notes,
            &[
                call(1, "read_note", json!({ "path": "../secret.md" })),
                call(2, "read_note", json!({ "path": dir.join("secret.md").to_string_lossy() })),
                call(3, "read_note", json!({ "path": "C:\\Windows\\win.ini" })),
                call(4, "list_notes", json!({ "subpath": ".." })),
            ],
        );
        for reply in &replies {
            assert_eq!(reply["result"]["isError"], true, "{reply}");
            assert!(!reply.to_string().contains("TOPSECRET"), "{reply}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_methods_tools_and_bad_input_get_errors() {
        let (notes, dir) = notes_in("errors");
        let replies = talk(
            &notes,
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }),
                call(2, "write_note", json!({ "path": "x.md", "text": "y" })),
                call(3, "read_note", json!({})),
                call(4, "search_notes", json!({ "query": 5 })),
                json!({ "jsonrpc": "2.0", "id": 5, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }),
                json!([1, 2]),
            ],
        );
        assert_eq!(replies[0]["error"]["code"], -32601);
        assert_eq!(replies[1]["error"]["code"], -32602);
        assert_eq!(replies[2]["result"]["isError"], true);
        assert_eq!(replies[3]["result"]["isError"], true);
        // An unknown revision gets the newest one.
        assert_eq!(replies[4]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(replies[5]["error"]["code"], -32600);
        // Nothing was written.
        assert!(!dir.join("Vault").join("x.md").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn garbage_gets_a_parse_error_and_the_server_keeps_going() {
        let (notes, dir) = notes_in("garbage");
        let mut out = Vec::new();
        let input = format!("not json\n\n{}\n", json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" }));
        serve(Cursor::new(input.into_bytes()), &mut out, &notes).unwrap();
        let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["error"]["code"], -32700);
        assert_eq!(lines[1]["id"], 9);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn with_no_folders_every_tool_says_so() {
        let replies = talk(&Notes::default(), &[call(1, "list_notes", json!({})), call(2, "read_note", json!({ "path": "a.md" }))]);
        assert!(replies.iter().all(|r| r["result"]["isError"] == true));
    }

    #[test]
    fn the_mode_argument_and_the_environment_are_read() {
        assert!(is_notes_mode(["nexq.exe", "--notes-mcp"]));
        assert!(!is_notes_mode(["nexq.exe"]));
        // The program name is not an argument.
        assert!(!is_notes_mode(["--notes-mcp"]));
        assert_eq!(dirs_from_env(Some(r#"["C:\\Notes","D:\\Wiki",""]"#)), [PathBuf::from("C:\\Notes"), PathBuf::from("D:\\Wiki")]);
        assert!(dirs_from_env(Some("not json")).is_empty() && dirs_from_env(None).is_empty());
        let cmd = server_command(std::path::Path::new("C:\\NexQ\\nexq.exe"), &[PathBuf::from("C:\\My Notes")]);
        assert_eq!(cmd["command"], "C:\\NexQ\\nexq.exe");
        assert_eq!(cmd["args"], json!(["--notes-mcp"]));
        assert_eq!(dirs_from_env(cmd["env"][DIRS_ENV].as_str()), [PathBuf::from("C:\\My Notes")]);
    }
}
