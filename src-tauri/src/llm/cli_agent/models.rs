//! The model catalog a CLI reports, and which effort each model gets.
//!
//! [`ClaudeModelInfo`] is the one model shape of every CLI agent (the frontend
//! type is shared); Antigravity and Codex fill it from their own lists.
//! Everything below the catalog is about `claude`.
//!
//! The catalog comes from the CLI's `initialize` control request (no model
//! call, no token usage): it lists the aliases (`opus`, `sonnet`, `haiku`,
//! ...) with what they resolve to, then pinned model ids, each with the
//! effort levels it accepts.

use super::command::{configure_command, sandbox_dir};
use super::CliAgentKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

/// Effort levels the CLI accepts for `--effort`, lowest first.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Reasoning efforts Codex models take, lowest first (Claude's list plus `ultra`).
pub const CODEX_EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/// One model the CLI offers (any CLI agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeModelInfo {
    /// What `--model` takes: an alias (`sonnet`) or a pinned id.
    pub value: String,
    /// The model id the value resolves to today.
    pub resolved_model: String,
    pub display_name: String,
    pub description: String,
    pub supports_effort: bool,
    /// Accepted `--effort` values (lowest first); empty without effort support.
    pub effort_levels: Vec<String>,
    /// The effort the model uses when none is asked for (Codex reports one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

/// Request id of the probe's `initialize` control request.
const PROBE_REQUEST_ID: &str = "nexq-models";

/// The `initialize` control request line (without the newline).
pub fn initialize_request() -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": PROBE_REQUEST_ID,
        "request": { "subtype": "initialize" },
    })
    .to_string()
}

/// Parse one stdout line of the probe. `None` for any line that is not the
/// `initialize` answer; `Some(Err)` when the CLI answered with an error or
/// without models. Accepts both `response.response.models` and
/// `response.models`.
pub fn parse_initialize_line(line: &str) -> Option<Result<Vec<ClaudeModelInfo>, String>> {
    let msg: Value = serde_json::from_str(line.trim()).ok()?;
    if msg["type"] != "control_response" {
        return None;
    }
    let response = &msg["response"];
    if response["subtype"] == "error" {
        let error = response["error"].as_str().unwrap_or("initialize failed");
        return Some(Err(error.to_string()));
    }
    let models = response["response"]["models"]
        .as_array()
        .or_else(|| response["models"].as_array());
    let Some(models) = models else {
        return Some(Err("the CLI reported no models".to_string()));
    };
    let models: Vec<ClaudeModelInfo> = models.iter().filter_map(parse_model).collect();
    if models.is_empty() {
        return Some(Err("the CLI reported no models".to_string()));
    }
    Some(Ok(models))
}

/// One catalog entry; `None` without a usable `value`.
fn parse_model(m: &Value) -> Option<ClaudeModelInfo> {
    let value = m["value"].as_str().filter(|v| !v.is_empty())?.to_string();
    let text = |key: &str| m[key].as_str().map(str::to_string);
    // Only levels `--effort` accepts, in the CLI's order.
    let levels: Vec<String> = m["supportedEffortLevels"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|l| EFFORTS.contains(l))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let supports_effort = m["supportsEffort"].as_bool().unwrap_or(!levels.is_empty());
    let effort_levels = match (supports_effort, levels.is_empty()) {
        (false, _) => Vec::new(),
        // Supported without a list: every level the flag takes.
        (true, true) => EFFORTS.iter().map(|s| s.to_string()).collect(),
        (true, false) => levels,
    };
    Some(ClaudeModelInfo {
        resolved_model: text("resolvedModel").unwrap_or_else(|| value.clone()),
        display_name: text("displayName").unwrap_or_else(|| value.clone()),
        description: text("description").unwrap_or_default(),
        supports_effort,
        effort_levels,
        default_effort: None,
        value,
    })
}

/// Effort for `--effort` given the saved one: `None` when the model takes no
/// effort, the saved value when the model accepts it (or is not in the
/// catalog), else the closest level it accepts (ties go to the lower one).
pub fn effective_effort(model: Option<&ClaudeModelInfo>, saved: &str) -> Option<String> {
    effective_effort_in(model, saved, &EFFORTS)
}

/// [`effective_effort`] with the CLI's own ordered list of levels (`ranks`),
/// which decides "closest level" (Codex has `ultra` on top).
pub fn effective_effort_in(model: Option<&ClaudeModelInfo>, saved: &str, ranks: &[&str]) -> Option<String> {
    let Some(model) = model else {
        return Some(saved.to_string());
    };
    if !model.supports_effort || model.effort_levels.is_empty() {
        return None;
    }
    if model.effort_levels.iter().any(|l| l == saved) {
        return Some(saved.to_string());
    }
    let rank = |l: &str| ranks.iter().position(|e| *e == l);
    let Some(target) = rank(saved) else {
        return model.effort_levels.first().cloned();
    };
    model
        .effort_levels
        .iter()
        .filter_map(|l| rank(l).map(|r| (r.abs_diff(target), r, l)))
        // Closest first; on a tie the lower level.
        .min_by_key(|(distance, r, _)| (*distance, *r))
        .map(|(_, _, l)| l.clone())
        .or_else(|| model.effort_levels.first().cloned())
}

/// The last catalog the CLI reported (empty until the first probe).
#[derive(Debug, Default)]
pub struct ModelCatalog {
    models: RwLock<Option<Vec<ClaudeModelInfo>>>,
}

impl ModelCatalog {
    /// The process-wide catalog shared by the command, the provider and the
    /// session manager.
    pub fn global() -> Arc<ModelCatalog> {
        Self::global_for(CliAgentKind::Claude)
    }

    /// The process-wide catalog of one CLI agent (one per kind).
    pub fn global_for(kind: CliAgentKind) -> Arc<ModelCatalog> {
        static GLOBALS: OnceLock<[Arc<ModelCatalog>; 3]> = OnceLock::new();
        let all = GLOBALS.get_or_init(|| std::array::from_fn(|_| Arc::new(ModelCatalog::default())));
        all[CliAgentKind::ALL.iter().position(|k| *k == kind).unwrap_or(0)].clone()
    }

    pub fn get(&self) -> Option<Vec<ClaudeModelInfo>> {
        self.models.read().ok().and_then(|m| m.clone())
    }

    pub fn set(&self, models: Vec<ClaudeModelInfo>) {
        if let Ok(mut m) = self.models.write() {
            *m = Some(models);
        }
    }

    /// Fill an empty catalog (with the list the app saved last time), so
    /// sessions clamp `--effort` even before or without a fresh probe.
    /// Never replaces a catalog; returns whether it seeded.
    pub fn seed(&self, models: Vec<ClaudeModelInfo>) -> bool {
        if models.is_empty() {
            return false;
        }
        match self.models.write() {
            Ok(mut m) if m.is_none() => {
                *m = Some(models);
                true
            }
            _ => false,
        }
    }

    /// The first model of the list (what a saved model that is gone falls back to).
    pub fn first(&self) -> Option<ClaudeModelInfo> {
        self.models.read().ok()?.as_ref()?.first().cloned()
    }

    /// The entry for `model`, matched by value, else by resolved id.
    pub fn find(&self, model: &str) -> Option<ClaudeModelInfo> {
        let models = self.models.read().ok()?;
        let models = models.as_ref()?;
        models
            .iter()
            .find(|m| m.value == model)
            .or_else(|| models.iter().find(|m| m.resolved_model == model))
            .cloned()
    }
}

/// How long the probe may take before it is abandoned.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Launch args of the probe: the session's stream-json protocol and safety
/// flags, without model / effort / system prompt.
pub fn probe_args() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--safe-mode",
        "--tools",
        "",
        "--disallowedTools",
        "*",
        "--permission-prompts",
        "none",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Ask `bin` for its model catalog (see [`probe_models_with_timeout`]).
pub async fn probe_models(bin: &Path) -> Result<Vec<ClaudeModelInfo>, String> {
    probe_models_with_timeout(bin, PROBE_TIMEOUT).await
}

/// Start `bin` with [`probe_args`] (same hygiene as a session: no shell, no
/// console window, sandbox cwd, API-key env stripped), send the `initialize`
/// control request and read until its answer, which is returned right away.
/// The process is ended in the background: stdin is closed, and it is killed
/// if it is still running shortly after.
pub async fn probe_models_with_timeout(
    bin: &Path,
    timeout: Duration,
) -> Result<Vec<ClaudeModelInfo>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut std_cmd = std::process::Command::new(bin);
    std_cmd.args(probe_args());
    configure_command(&mut std_cmd, &sandbox_dir());
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start `claude` for the model list: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;

    let exchange = async {
        stdin
            .write_all(format!("{}\n", initialize_request()).as_bytes())
            .await
            .map_err(|e| format!("cannot write to claude: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("cannot write to claude: {e}"))?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("cannot read from claude: {e}"))?
        {
            if let Some(result) = parse_initialize_line(&line) {
                return result;
            }
        }
        Err("claude exited without listing its models".to_string())
    };
    let result = tokio::time::timeout(timeout, exchange)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "listing models timed out after {} s",
                timeout.as_secs()
            ))
        });

    // Closing stdin ends the CLI; kill it if it lingers. Not awaited: the
    // caller has its answer. (`kill_on_drop` covers a runtime shutting down.)
    tokio::spawn(async move {
        drop(stdin);
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("fixtures/initialize_response.json");

    fn model(value: &str, levels: &[&str]) -> ClaudeModelInfo {
        ClaudeModelInfo {
            value: value.into(),
            resolved_model: format!("claude-{value}"),
            display_name: value.into(),
            description: String::new(),
            supports_effort: !levels.is_empty(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            default_effort: None,
        }
    }

    #[test]
    fn parses_the_cli_initialize_response() {
        let models = parse_initialize_line(FIXTURE)
            .expect("is the answer")
            .unwrap();
        let values: Vec<&str> = models.iter().map(|m| m.value.as_str()).collect();
        assert_eq!(
            values[..6],
            [
                "default",
                "opus",
                "fable",
                "sonnet",
                "haiku",
                "claude-sonnet-5"
            ]
        );
        let sonnet = &models[3];
        assert_eq!(sonnet.resolved_model, "claude-sonnet-5-5");
        assert_eq!(sonnet.display_name, "Sonnet 5.5");
        assert_eq!(sonnet.description, "Efficient for routine tasks");
        assert!(sonnet.supports_effort);
        assert_eq!(sonnet.effort_levels, EFFORTS);

        // Haiku reports no effort support at all.
        let haiku = &models[4];
        assert_eq!(haiku.resolved_model, "claude-haiku-4-5-20251001");
        assert!(!haiku.supports_effort);
        assert!(haiku.effort_levels.is_empty());

        // An older pinned model without xhigh.
        let opus46 = models
            .iter()
            .find(|m| m.value == "claude-opus-4-6")
            .unwrap();
        assert_eq!(opus46.effort_levels, ["low", "medium", "high", "max"]);
    }

    #[test]
    fn parses_the_flat_response_shape_and_ignores_other_lines() {
        let flat = r#"{"type":"control_response","response":{"subtype":"success","request_id":"x","models":[{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"d","supportsEffort":true,"supportedEffortLevels":["low","ultra","high"]}]}}"#;
        let models = parse_initialize_line(flat).unwrap().unwrap();
        assert_eq!(models.len(), 1);
        // Levels the CLI flag doesn't accept are dropped.
        assert_eq!(models[0].effort_levels, ["low", "high"]);

        for other in [
            "",
            "not json",
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"system","subtype":"ini"#,
        ] {
            assert!(parse_initialize_line(other).is_none(), "{other:?}");
        }
    }

    #[test]
    fn an_error_or_empty_answer_is_an_error() {
        let error = r#"{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"boom"}}"#;
        assert_eq!(parse_initialize_line(error), Some(Err("boom".to_string())));
        let empty = r#"{"type":"control_response","response":{"subtype":"success","response":{"models":[]}}}"#;
        assert!(matches!(parse_initialize_line(empty), Some(Err(_))));
        let missing =
            r#"{"type":"control_response","response":{"subtype":"success","response":{}}}"#;
        assert!(matches!(parse_initialize_line(missing), Some(Err(_))));
    }

    #[test]
    fn effort_is_omitted_for_a_model_without_effort() {
        assert_eq!(effective_effort(Some(&model("haiku", &[])), "low"), None);
    }

    #[test]
    fn a_supported_or_unknown_effort_is_kept() {
        let opus = model("opus", &EFFORTS);
        assert_eq!(
            effective_effort(Some(&opus), "xhigh").as_deref(),
            Some("xhigh")
        );
        // Not in the catalog (or no catalog yet): passed as saved.
        assert_eq!(effective_effort(None, "medium").as_deref(), Some("medium"));
    }

    #[test]
    fn an_unsupported_effort_clamps_to_the_closest_level() {
        let old = model("claude-opus-4-6", &["low", "medium", "high", "max"]);
        // xhigh sits between high and max: the tie goes to the lower level.
        assert_eq!(
            effective_effort(Some(&old), "xhigh").as_deref(),
            Some("high")
        );
        let narrow = model("m", &["medium", "high"]);
        assert_eq!(
            effective_effort(Some(&narrow), "max").as_deref(),
            Some("high")
        );
        assert_eq!(
            effective_effort(Some(&narrow), "low").as_deref(),
            Some("medium")
        );
        // A value the CLI doesn't know at all: the model's first level.
        assert_eq!(
            effective_effort(Some(&narrow), "ultra").as_deref(),
            Some("medium")
        );
    }

    #[test]
    fn catalog_finds_by_value_then_resolved_id() {
        let catalog = ModelCatalog::default();
        assert_eq!(catalog.find("haiku"), None);
        catalog.set(parse_initialize_line(FIXTURE).unwrap().unwrap());
        assert_eq!(catalog.find("haiku").unwrap().value, "haiku");
        assert_eq!(
            catalog.find("claude-haiku-4-5-20251001").unwrap().value,
            "haiku"
        );
        assert_eq!(
            catalog.find("claude-opus-4-8").unwrap().display_name,
            "Opus 4.8"
        );
        assert_eq!(catalog.find("gpt-4o"), None);
    }

    #[test]
    fn seeding_fills_only_an_empty_catalog() {
        let catalog = ModelCatalog::default();
        assert!(catalog.seed(vec![model("haiku", &[])]));
        assert_eq!(catalog.find("haiku").unwrap().effort_levels.len(), 0);
        // A probe's answer (or an earlier seed) is never replaced by a seed.
        assert!(!catalog.seed(vec![model("sonnet", &EFFORTS)]));
        assert!(catalog.find("sonnet").is_none());
        assert!(
            !ModelCatalog::default().seed(Vec::new()),
            "an empty list seeds nothing"
        );
    }

    #[test]
    fn probe_sends_initialize_with_session_hygiene_args() {
        let req: Value = serde_json::from_str(&initialize_request()).unwrap();
        assert_eq!(req["type"], "control_request");
        assert_eq!(req["request"]["subtype"], "initialize");
        let args = probe_args();
        let joined = args.join("\u{1}");
        for seq in [
            vec!["--input-format", "stream-json"],
            vec!["--output-format", "stream-json"],
            vec!["--tools", ""],
            vec!["--disallowedTools", "*"],
            vec!["--permission-prompts", "none"],
        ] {
            assert!(joined.contains(&seq.join("\u{1}")), "missing {seq:?}");
        }
        for flag in ["-p", "--verbose", "--safe-mode", "--no-session-persistence"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        for absent in ["--bare", "--model", "--effort", "--system-prompt-file"] {
            assert!(!args.iter().any(|a| a == absent), "unexpected {absent}");
        }
    }
}
