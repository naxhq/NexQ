//! Why an MCP server did not start. The CLI only reports `failed`, so a failed
//! Check starts the server on its own for a few seconds and reports what it
//! says: the last stderr line of a command that stopped, or the HTTP status a
//! URL answered with. Secret values never appear in the text.

use crate::sources::config::{McpServer, McpTransport};
use crate::sources::mcp_json::{credential_id, header_credential_id};
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a failed server is started on its own to find out why.
pub const DIAGNOSE_WAIT: Duration = Duration::from_secs(5);

/// Why `server` won't start, or `None` when the attempt shows nothing.
/// `secret` looks a saved value up by credential id.
pub async fn diagnose_start(
    server: &McpServer,
    secret: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Option<String> {
    match &server.transport {
        McpTransport::Stdio { command, args } => {
            let mut env: Vec<(String, String)> = Vec::new();
            let mut secrets: Vec<String> = Vec::new();
            for var in &server.env {
                let value = if var.secret {
                    let value = secret(&credential_id(&server.key, &var.name))?;
                    secrets.push(value.clone());
                    value
                } else {
                    var.value.clone().unwrap_or_default()
                };
                env.push((var.name.clone(), value));
            }
            let (command, args) = (command.clone(), args.clone());
            tokio::task::spawn_blocking(move || diagnose_stdio(&command, &args, &env, &secrets, DIAGNOSE_WAIT))
                .await
                .ok()
                .flatten()
        }
        McpTransport::Http { url, header_names } => {
            let mut headers: Vec<(String, String)> = Vec::new();
            for name in header_names {
                headers.push((name.clone(), secret(&header_credential_id(&server.key, name))?));
            }
            let secrets: Vec<String> = headers.iter().map(|(_, v)| v.clone()).collect();
            diagnose_http(url, &headers, &secrets).await
        }
    }
}

/// The last non-empty line of `text`, with every secret value hidden and cut
/// to a short length.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().filter(|s| s.len() >= 3) {
        out = out.replace(secret.as_str(), "***");
    }
    let line = out.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > 200 {
        let mut cut: String = line.chars().take(200).collect();
        cut.push('…');
        cut
    } else {
        line.to_string()
    }
}

/// Start the command and wait up to `wait`. `Some(cause)` when it could not be
/// started, stopped by itself, or is still running but printed a message;
/// `None` when it ran quietly.
pub fn diagnose_stdio(
    command: &str,
    args: &[String],
    env: &[(String, String)],
    secrets: &[String],
    wait: Duration,
) -> Option<String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Some(redact(&format!("It couldn't start {command}: {e}."), secrets)),
    };
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let reader = child.stderr.take().map(|stderr| {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                lines.lock().unwrap().push(line);
            }
        })
    });
    let _stdin = child.stdin.take(); // kept open: a server exits when it reads EOF
    let deadline = Instant::now() + wait;
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => break None,
        }
    };
    if exited.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(reader) = reader {
        let _ = reader.join();
    }
    let last = lines.lock().unwrap().iter().rev().find(|l| !l.trim().is_empty()).cloned();
    let last = last.map(|l| redact(&l, secrets));
    match (exited, last) {
        (Some(status), Some(line)) => {
            Some(format!("It stopped right away{}. Its last message: {line}", code_text(status)))
        }
        (Some(status), None) => Some(format!("It stopped right away{}, without saying why.", code_text(status))),
        (None, Some(line)) => Some(format!("Its last message: {line}")),
        (None, None) => None,
    }
}

fn code_text(status: std::process::ExitStatus) -> String {
    status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default()
}

/// Ask the URL what an MCP client asks first and report a refusal.
pub async fn diagnose_http(url: &str, headers: &[(String, String)], secrets: &[String]) -> Option<String> {
    let client = reqwest::Client::builder().timeout(DIAGNOSE_WAIT).build().ok()?;
    let mut req = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": { "name": "nexq-check", "version": "1" } }
        }));
    for (name, value) in headers {
        req = req.header(name.as_str(), value.as_str());
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => None,
        Ok(resp) => {
            let status = resp.status();
            let reason = status.canonical_reason().map(|r| format!(" {r}")).unwrap_or_default();
            Some(format!("The server answered {}{reason}.", status.as_u16()))
        }
        Err(e) => {
            let e = e.without_url();
            let mut text = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(inner) = source {
                text = format!("{text}: {inner}");
                source = inner.source();
            }
            Some(redact(&format!("It couldn't be reached: {text}"), secrets))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_secrets_and_keeps_one_short_line() {
        let secrets = vec!["s3cret-value".to_string(), "ab".to_string()];
        assert_eq!(redact("error: bad key s3cret-value\n", &secrets), "error: bad key ***");
        assert_eq!(redact("first\n\nlast line ab\n", &secrets), "last line ab", "values under 3 chars are left alone");
        let long = "x".repeat(500);
        assert!(redact(&long, &[]).chars().count() <= 201);
    }

    fn shell(script_windows: &str, script_unix: &str) -> (String, Vec<String>) {
        if cfg!(windows) {
            ("cmd".into(), vec!["/C".into(), script_windows.into()])
        } else {
            ("sh".into(), vec!["-c".into(), script_unix.into()])
        }
    }

    #[test]
    fn a_command_that_stops_shows_its_last_stderr_line_without_secrets() {
        let (cmd, args) = shell(
            "echo starting 1>&2 & echo token s3cret-value is wrong 1>&2 & exit 3",
            "echo starting >&2; echo token s3cret-value is wrong >&2; exit 3",
        );
        let cause =
            diagnose_stdio(&cmd, &args, &[], &["s3cret-value".to_string()], Duration::from_secs(5)).unwrap();
        assert!(cause.contains("exit code 3") && cause.contains("token *** is wrong"), "{cause}");
        assert!(!cause.contains("s3cret-value") && !cause.contains("starting"), "{cause}");
    }

    #[test]
    fn a_missing_command_says_it_couldnt_start() {
        let cause = diagnose_stdio("nexq-no-such-command-xyz", &[], &[], &[], Duration::from_secs(1)).unwrap();
        assert!(cause.contains("couldn't start nexq-no-such-command-xyz"), "{cause}");
    }

    #[test]
    fn a_command_that_keeps_running_quietly_shows_nothing() {
        let (cmd, args) = if cfg!(windows) {
            ("ping".to_string(), vec!["-n".to_string(), "4".to_string(), "127.0.0.1".to_string()])
        } else {
            ("sleep".to_string(), vec!["3".to_string()])
        };
        assert_eq!(diagnose_stdio(&cmd, &args, &[], &[], Duration::from_millis(400)), None);
    }

    #[tokio::test]
    async fn an_http_refusal_shows_its_status() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        });
        let cause = diagnose_http(&url, &[("Authorization".into(), "Bearer tok-123".into())], &["Bearer tok-123".into()]).await;
        assert_eq!(cause.as_deref(), Some("The server answered 401 Unauthorized."));
    }

    #[tokio::test]
    async fn a_server_that_cannot_be_reached_says_so_without_its_url() {
        let cause = diagnose_http("http://127.0.0.1:1/mcp?token=hunter22", &[], &["hunter22".into()]).await.unwrap();
        assert!(cause.starts_with("It couldn't be reached"), "{cause}");
        assert!(!cause.contains("hunter22"), "{cause}");
    }
}
