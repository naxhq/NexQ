//! The notes server as the CLIs start it: `nexq --notes-mcp`, folders in
//! `NEXQ_NOTES_DIRS`, MCP over its stdin and stdout. This runs the real binary,
//! so it also proves the mode is picked before the app (no window, no
//! single-instance hand-off) and that stdout carries nothing but replies.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Server {
    fn start(dirs: &[&Path]) -> Server {
        let list: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect();
        let mut child = Command::new(env!("CARGO_BIN_EXE_nexq"))
            .arg("--notes-mcp")
            .env("NEXQ_NOTES_DIRS", serde_json::to_string(&list).unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start nexq --notes-mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Server { child, stdin: Some(stdin), stdout, next_id: 1 }
    }

    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("input is open");
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.stdout.read_line(&mut line).unwrap() > 0, "the server closed its output");
        serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("not JSON on stdout: {line:?} ({e})"))
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let reply = self.read();
        assert_eq!(reply["id"], id, "{reply}");
        reply
    }

    fn call(&mut self, tool: &str, args: Value) -> (bool, String) {
        let reply = self.request("tools/call", json!({ "name": tool, "arguments": args }));
        let result = &reply["result"];
        (result["isError"].as_bool().unwrap(), result["content"][0]["text"].as_str().unwrap().to_string())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tree(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexq-notes-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("Vault").join("projects")).unwrap();
    std::fs::create_dir_all(dir.join("Vault").join(".obsidian")).unwrap();
    std::fs::write(dir.join("Vault").join("projects").join("falcon.md"), "# Falcon\nLaunch date: March 3.\n").unwrap();
    std::fs::write(dir.join("Vault").join(".obsidian").join("workspace.md"), "falcon hidden").unwrap();
    std::fs::write(dir.join("private.md"), "do not leak").unwrap();
    dir
}

#[test]
fn the_binary_speaks_mcp_and_stays_inside_the_folder() {
    let root = tree("session");
    let vault = std::fs::canonicalize(root.join("Vault")).unwrap();
    let vault = PathBuf::from(vault.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    let mut server = Server::start(&[&vault]);

    let init = server.request(
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "it", "version": "1" } }),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "nexq-notes");
    server.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    assert_eq!(server.request("ping", json!({}))["result"], json!({}));

    let tools = server.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["list_notes", "search_notes", "read_note"]);

    let (error, text) = server.call("list_notes", json!({}));
    assert!(!error && text.contains("Vault/projects/") && !text.contains(".obsidian"), "{text}");
    let (error, text) = server.call("search_notes", json!({ "query": "LAUNCH" }));
    assert!(!error && text.contains("Vault/projects/falcon.md:2: Launch date: March 3."), "{text}");
    assert!(!text.contains("hidden"));
    let (error, text) = server.call("read_note", json!({ "path": "Vault/projects/falcon.md" }));
    assert!(!error && text.contains("# Falcon"), "{text}");

    // Everything that points outside, or at something hidden, is a tool error.
    for path in [
        "../private.md".to_string(),
        "Vault/../private.md".to_string(),
        root.join("private.md").to_string_lossy().into_owned(),
        "C:\\Windows\\win.ini".to_string(),
        "\\\\localhost\\c$\\Windows\\win.ini".to_string(),
        ".obsidian/workspace.md".to_string(),
        "projects/falcon.md:stream".to_string(),
        "CON".to_string(),
        "projects/NUL.md".to_string(),
    ] {
        let (error, text) = server.call("read_note", json!({ "path": path }));
        assert!(error, "{path} must be refused: {text}");
        assert!(!text.contains("do not leak") && !text.contains("for 16-bit"), "{path}: {text}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn without_folders_there_are_no_notes_and_the_server_still_answers() {
    let mut server = Server::start(&[]);
    let init = server.request("initialize", json!({ "protocolVersion": "2024-11-05" }));
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    let (error, text) = server.call("list_notes", json!({}));
    assert!(error && text.contains("No notes folders"), "{text}");
}

#[test]
fn the_server_ends_when_its_input_closes() {
    let mut server = Server::start(&[]);
    let _ = server.request("ping", json!({}));
    server.stdin.take();
    let status = server.child.wait().unwrap();
    assert!(status.success(), "{status:?}");
}
