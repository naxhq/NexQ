//! Codex's model list and sign-in state, read without a model call.

use super::launch::{run_probe, DISABLED_FEATURES};
use super::protocol::{self, Account};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// One model the account can pick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModel {
    /// What `thread/start` and `turn/start` take as `model`, e.g. `gpt-6.2-sol`.
    pub slug: String,
    pub display_name: String,
    /// Reasoning efforts the model supports, in Codex's order (`low` .. `ultra`).
    pub efforts: Vec<String>,
    pub default_effort: String,
}

/// Models out of `codex debug models` (`{"models":[{slug, display_name,
/// visibility, priority, default_reasoning_level, supported_reasoning_levels:
/// [{effort}]}]}`): the ones with `visibility == "list"`, in priority order.
pub fn parse_debug_models(json: &str) -> Option<Vec<CodexModel>> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    let mut items: Vec<&Value> = v.get("models")?.as_array()?.iter().collect();
    // Lower priority number comes first; the sort is stable for equal or missing ones.
    items.sort_by_key(|m| m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX));
    Some(
        items
            .into_iter()
            .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
            .filter_map(|m| {
                let slug = m.get("slug")?.as_str()?.to_string();
                Some(CodexModel {
                    display_name: m.get("display_name").and_then(Value::as_str).unwrap_or(&slug).to_string(),
                    efforts: m
                        .get("supported_reasoning_levels")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|e| e.get("effort")?.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    default_effort: m
                        .get("default_reasoning_level")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    slug,
                })
            })
            .collect(),
    )
}

/// Models out of an app-server `model/list` result
/// (`{"data":[{model, displayName, hidden, defaultReasoningEffort,
/// supportedReasoningEfforts:[{reasoningEffort}]}], "nextCursor"}`), hidden
/// ones left out.
pub fn parse_model_list(result: &Value) -> Vec<CodexModel> {
    result
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|m| !m.get("hidden").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|m| {
                    let slug = m.get("model").or_else(|| m.get("id"))?.as_str()?.to_string();
                    Some(CodexModel {
                        display_name: m.get("displayName").and_then(Value::as_str).unwrap_or(&slug).to_string(),
                        efforts: m
                            .get("supportedReasoningEfforts")
                            .and_then(Value::as_array)
                            .map(|a| {
                                a.iter().filter_map(|e| e.get("reasoningEffort")?.as_str().map(str::to_string)).collect()
                            })
                            .unwrap_or_default(),
                        default_effort: m
                            .get("defaultReasoningEffort")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        slug,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The account's models: the app-server's `model/list` (what the account can
/// actually use), else `codex debug models` (instant, but the raw catalog).
/// `Err` carries a readable reason when both fail.
pub async fn probe_models(program: &Path, prefix_args: &[String]) -> Result<Vec<CodexModel>, String> {
    match app_server_model_list(program, prefix_args).await {
        Ok(models) if !models.is_empty() => return Ok(models),
        Ok(_) => log::warn!("codex: model/list returned no models; trying `codex debug models`"),
        Err(e) => log::warn!("codex: model/list failed ({e}); trying `codex debug models`"),
    }
    let (ok, stdout, stderr) = run_probe(program, prefix_args, &["debug", "models"])
        .await
        .ok_or_else(|| "Codex did not answer `debug models`".to_string())?;
    if !ok {
        return Err(first_line(&stderr, "`codex debug models` failed"));
    }
    parse_debug_models(&stdout).ok_or_else(|| "Could not read Codex's model list".to_string())
}

/// `initialize`, then `model/list` (all pages) on a short-lived app-server.
/// No thread is started, so none of the user's MCP servers run.
async fn app_server_model_list(program: &Path, prefix_args: &[String]) -> Result<Vec<CodexModel>, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(prefix_args).arg("app-server");
    for feature in DISABLED_FEATURES {
        cmd.args(["--disable", feature]);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for key in super::launch::STRIPPED_ENV {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("cannot start codex: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();

    let work = async {
        let mut next_id = 1u64;
        fn send(line: String) -> Vec<u8> {
            let mut bytes = line.into_bytes();
            bytes.push(b'\n');
            bytes
        }
        stdin
            .write_all(&send(protocol::initialize_request(next_id, "probe")))
            .await
            .map_err(|e| e.to_string())?;
        wait_for_response(&mut lines, next_id).await?;
        stdin.write_all(&send(protocol::initialized_notification())).await.map_err(|e| e.to_string())?;
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            next_id += 1;
            let request = match &cursor {
                Some(c) => serde_json::json!({ "id": next_id, "method": "model/list", "params": { "cursor": c } })
                    .to_string(),
                None => protocol::model_list_request(next_id),
            };
            stdin.write_all(&send(request)).await.map_err(|e| e.to_string())?;
            let result = wait_for_response(&mut lines, next_id).await?;
            models.extend(parse_model_list(&result));
            cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok::<_, String>(models)
    };
    let out = tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| "Codex did not answer model/list in time".to_string())?;
    drop(stdin);
    let _ = child.kill().await;
    out
}

async fn wait_for_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Codex closed its output".to_string())?;
        if let Some(protocol::Incoming::Response { id: got, result }) = protocol::parse_line(&line) {
            if got == id {
                return result.map_err(|e| e.message);
            }
        }
    }
}

fn first_line(text: &str, fallback: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(fallback).to_string()
}

/// How the Codex CLI is signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexLogin {
    /// A ChatGPT subscription login (what NexQ wants).
    ChatGpt { email: Option<String>, plan: Option<String> },
    /// An API key: pay-per-token, not a subscription.
    ApiKey,
    LoggedOut,
    /// `codex login status` could not be run or made no sense.
    Unavailable(String),
}

/// Classify the output of `codex login status` (stdout and stderr together):
/// `Logged in using ChatGPT`, `Logged in using an API key - sk-...`, or
/// `Not logged in`. The key shown after the dash is never kept.
pub fn parse_login_status(success: bool, output: &str) -> CodexLogin {
    let text = output.to_lowercase();
    if text.contains("not logged in") {
        CodexLogin::LoggedOut
    } else if text.contains("logged in using chatgpt") {
        CodexLogin::ChatGpt { email: None, plan: None }
    } else if text.contains("logged in using") && text.contains("api key") {
        CodexLogin::ApiKey
    } else if success {
        CodexLogin::Unavailable(format!("unrecognised `codex login status` output ({} chars)", output.len()))
    } else {
        CodexLogin::LoggedOut
    }
}

/// `codex login status`, plus the account's email and plan for a ChatGPT login
/// (read from the `id_token` claims in `auth.json`, nothing else of that file).
pub async fn login_status(program: &Path, prefix_args: &[String]) -> CodexLogin {
    let Some((ok, stdout, stderr)) = run_probe(program, prefix_args, &["login", "status"]).await else {
        return CodexLogin::Unavailable("Codex did not answer `login status`".into());
    };
    match parse_login_status(ok, &format!("{stdout}\n{stderr}")) {
        CodexLogin::ChatGpt { .. } => {
            let (email, plan) = tokio::task::spawn_blocking(|| read_auth_claims(&codex_home()))
                .await
                .unwrap_or((None, None));
            CodexLogin::ChatGpt { email, plan }
        }
        other => other,
    }
}

/// `CODEX_HOME`, else `~/.codex`.
pub fn codex_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default();
    PathBuf::from(home).join(".codex")
}

/// `(email, plan)` from `<home>/auth.json`'s `id_token` claims. Only those two
/// claims leave this function; the tokens never do.
fn read_auth_claims(home: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(home.join("auth.json")) else { return (None, None) };
    claims_from_auth_json(&text)
}

/// [`read_auth_claims`] on the file's text.
pub fn claims_from_auth_json(text: &str) -> (Option<String>, Option<String>) {
    let Ok(auth) = serde_json::from_str::<Value>(text) else { return (None, None) };
    let Some(token) = auth.get("tokens").and_then(|t| t.get("id_token")).and_then(Value::as_str) else {
        return (None, None);
    };
    let Some(payload) = token.split('.').nth(1).and_then(base64url_decode) else { return (None, None) };
    let Ok(claims) = serde_json::from_slice::<Value>(&payload) else { return (None, None) };
    let email = claims.get("email").and_then(Value::as_str).map(str::to_string);
    let plan = claims
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (email, plan)
}

/// URL-safe base64 without padding (a JWT segment). `None` on a bad character.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in input.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The account the session talks to, from an `account/read` result, as a login.
pub fn login_from_account(account: &Account) -> CodexLogin {
    match account {
        Account::ChatGpt { email, plan } => CodexLogin::ChatGpt { email: email.clone(), plan: plan.clone() },
        Account::ApiKey | Account::Other(_) => CodexLogin::ApiKey,
        Account::LoggedOut => CodexLogin::LoggedOut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEBUG_MODELS: &str = include_str!("testdata/real_debug_models.json");
    const MODEL_LIST: &str = include_str!("testdata/real_model_list_response.json");

    #[test]
    fn debug_models_keep_only_the_listed_ones() {
        let models = parse_debug_models(DEBUG_MODELS).unwrap();
        let slugs: Vec<&str> = models.iter().map(|m| m.slug.as_str()).collect();
        // `gpt-reserve` has visibility "hide".
        assert_eq!(slugs, ["gpt-6.2-sol", "gpt-6-luna"]);
        let sol = &models[0];
        assert_eq!(sol.display_name, "GPT-6.2-Sol");
        assert_eq!(sol.default_effort, "low");
        assert_eq!(sol.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
        // A model without `ultra`.
        assert_eq!(models[1].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models[1].default_effort, "medium");
    }

    #[test]
    fn debug_models_are_ordered_by_priority() {
        let json = r#"{"models":[
            {"slug":"b","display_name":"B","visibility":"list","priority":5,"default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"}]},
            {"slug":"a","display_name":"A","visibility":"list","priority":1,"default_reasoning_level":"low","supported_reasoning_levels":[]},
            {"slug":"h","display_name":"H","visibility":"hide","priority":0}
        ]}"#;
        let slugs: Vec<String> = parse_debug_models(json).unwrap().into_iter().map(|m| m.slug).collect();
        assert_eq!(slugs, ["a", "b"]);
        assert!(parse_debug_models("{}").is_none());
        assert!(parse_debug_models("garbage").is_none());
    }

    #[test]
    fn the_app_servers_model_list_is_read() {
        let v: Value = serde_json::from_str(MODEL_LIST).unwrap();
        let models = parse_model_list(&v["result"]);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].slug, "gpt-6.2-sol");
        assert_eq!(models[0].default_effort, "low");
        assert!(models[0].efforts.contains(&"max".to_string()));
        // Hidden models are skipped.
        let hidden = serde_json::json!({ "data": [
            { "model": "x", "displayName": "X", "hidden": true, "defaultReasoningEffort": "low", "supportedReasoningEfforts": [] },
            { "model": "y", "displayName": "Y", "hidden": false, "defaultReasoningEffort": "low", "supportedReasoningEfforts": [] }
        ]});
        assert_eq!(parse_model_list(&hidden).len(), 1);
    }

    #[test]
    fn login_status_output_is_classified() {
        assert_eq!(
            parse_login_status(true, "Logged in using ChatGPT\n"),
            CodexLogin::ChatGpt { email: None, plan: None }
        );
        assert_eq!(parse_login_status(true, "Logged in using an API key - sk-proj-****abcd"), CodexLogin::ApiKey);
        assert_eq!(parse_login_status(false, "Not logged in"), CodexLogin::LoggedOut);
        assert_eq!(parse_login_status(false, ""), CodexLogin::LoggedOut);
        assert!(matches!(parse_login_status(true, "something new"), CodexLogin::Unavailable(_)));
    }

    #[test]
    fn email_and_plan_come_from_the_id_token_and_nothing_else() {
        // header.payload.signature; the payload is {"email":"a@b.co","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}
        let payload = r#"{"email":"a@b.co","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#;
        let seg = base64url_encode(payload.as_bytes());
        let auth = format!(
            r#"{{"auth_mode":"chatgpt","tokens":{{"id_token":"e30.{seg}.sig","access_token":"SECRET-ACCESS","refresh_token":"SECRET-REFRESH"}}}}"#
        );
        assert_eq!(claims_from_auth_json(&auth), (Some("a@b.co".into()), Some("plus".into())));
        assert_eq!(claims_from_auth_json("{}"), (None, None));
        assert_eq!(claims_from_auth_json("nope"), (None, None));
        assert_eq!(claims_from_auth_json(r#"{"tokens":{"id_token":"a.b!.c"}}"#), (None, None));
    }

    #[test]
    fn base64url_round_trips() {
        for s in ["", "a", "ab", "abc", "abcd", "{\"k\":\"v?>~\"}"] {
            assert_eq!(base64url_decode(&base64url_encode(s.as_bytes())).unwrap(), s.as_bytes());
        }
    }

    fn base64url_encode(bytes: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |a, (i, b)| a | (u32::from(*b) << (16 - 8 * i)));
            let chars = chunk.len() + 1;
            for i in 0..chars {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn an_account_maps_to_a_login() {
        assert_eq!(
            login_from_account(&Account::ChatGpt { email: Some("e".into()), plan: None }),
            CodexLogin::ChatGpt { email: Some("e".into()), plan: None }
        );
        assert_eq!(login_from_account(&Account::ApiKey), CodexLogin::ApiKey);
        assert_eq!(login_from_account(&Account::LoggedOut), CodexLogin::LoggedOut);
    }
}
