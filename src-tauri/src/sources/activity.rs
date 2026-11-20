//! What the user sees while an answer uses sources: short activity lines and
//! the chips shown at the end. Mirrors `SourceActivity` in `src/lib/types.ts`.

use crate::llm::cli_agent::protocol::ToolUse;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Notes,
    Tool,
    /// A message about the sources themselves (e.g. they could not be loaded).
    Notice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceChip {
    pub kind: SourceKind,
    pub label: String,
    /// The full path of a note, so the chip can open it.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceActivity {
    pub kind: SourceKind,
    pub label: String,
    pub chip: Option<SourceChip>,
    /// Only the chip is new (the call it belongs to ended well): no activity
    /// line of its own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub chip_only: bool,
}

impl SourceActivity {
    /// The chip a successful call leaves behind, as an activity of its own.
    pub fn chip_only(chip: SourceChip) -> Self {
        SourceActivity { kind: chip.kind, label: chip.label.clone(), chip: Some(chip), chip_only: true }
    }
}

/// A line about the sources themselves (no chip).
pub fn notice(label: impl Into<String>) -> SourceActivity {
    SourceActivity { kind: SourceKind::Notice, label: label.into(), chip: None, chip_only: false }
}

/// What a with-sources session came up without: servers that did not start
/// (`failed_keys`, named by `server_labels`) and sources left out at build time
/// (`left_out` reasons). `None` when nothing is missing.
pub fn sources_degraded_notice(
    server_labels: &[(String, String)],
    failed_keys: &[String],
    left_out: &[String],
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if !failed_keys.is_empty() {
        let names: Vec<&str> = failed_keys
            .iter()
            .map(|k| {
                server_labels
                    .iter()
                    .find(|(key, _)| key == k)
                    .map(|(_, label)| label.as_str())
                    .unwrap_or(k.as_str())
            })
            .collect();
        let list = match names.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => names.join(""),
        };
        let (verb, pronoun) = if names.len() == 1 { ("didn't", "its tools aren't") } else { ("didn't", "their tools aren't") };
        parts.push(format!("{list} {verb} start, so {pronoun} available"));
    }
    if !left_out.is_empty() {
        parts.push(format!("Left out: {}", left_out.join("; ")));
    }
    (!parts.is_empty()).then(|| parts.join(". "))
}

/// One tool use as an activity line, plus the chip it leaves behind.
/// `server_labels` maps an MCP server key to the name the user gave it.
pub fn describe_tool_use(t: &ToolUse, server_labels: &[(String, String)]) -> SourceActivity {
    let text = |field: &str| t.input.get(field).and_then(|v| v.as_str()).unwrap_or("");
    match t.name.as_str() {
        "Grep" => notes_line(format!("Searching notes for '{}'", text("pattern"))),
        "Glob" => notes_line(format!("Looking for notes named '{}'", text("pattern"))),
        "Read" => {
            let path = text("file_path");
            if path.is_empty() {
                return notes_line("Reading a note".to_string());
            }
            let name = file_name(path);
            SourceActivity {
                kind: SourceKind::Notes,
                label: format!("Reading {name}"),
                chip: Some(SourceChip {
                    kind: SourceKind::Notes,
                    label: name.to_string(),
                    path: Some(path.to_string()),
                }),
                chip_only: false,
            }
        }
        other => match other.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
            Some((key, tool)) => {
                let label = server_labels
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, l)| l.as_str())
                    .unwrap_or(key);
                let line = format!("{label}: {tool}");
                SourceActivity {
                    kind: SourceKind::Tool,
                    label: line.clone(),
                    chip: Some(SourceChip { kind: SourceKind::Tool, label: line, path: None }),
                    chip_only: false,
                }
            }
            None => SourceActivity {
                kind: SourceKind::Tool,
                label: format!("Using {other}"),
                chip: None,
                chip_only: false,
            },
        },
    }
}

fn notes_line(label: String) -> SourceActivity {
    SourceActivity { kind: SourceKind::Notes, label, chip: None, chip_only: false }
}

/// Last path component, for `\` and `/` separators alike.
fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).find(|p| !p.is_empty()).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn use_of(name: &str, input: serde_json::Value) -> ToolUse {
        ToolUse { id: String::new(), name: name.into(), input }
    }

    #[test]
    fn describe_tool_use_labels() {
        let labels = vec![("mira".to_string(), "Mira".to_string())];
        let d = describe_tool_use(&use_of("Grep", json!({"pattern": "budget review"})), &labels);
        assert_eq!(d.label, "Searching notes for 'budget review'");
        assert_eq!((d.kind, d.chip), (SourceKind::Notes, None));

        let g = describe_tool_use(&use_of("Glob", json!({"pattern": "**/Dana*.md"})), &labels);
        assert_eq!(g.label, "Looking for notes named '**/Dana*.md'");

        let r = describe_tool_use(&use_of("Read", json!({"file_path": "D:\\V\\People\\Dana.md"})), &labels);
        assert_eq!(r.label, "Reading Dana.md");
        let chip = r.chip.unwrap();
        assert_eq!(chip.kind, SourceKind::Notes);
        assert_eq!(chip.label, "Dana.md");
        assert_eq!(chip.path.as_deref(), Some("D:\\V\\People\\Dana.md"));

        let m = describe_tool_use(&use_of("mcp__mira__person_brief", json!({})), &labels);
        assert_eq!(m.label, "Mira: person_brief");
        assert_eq!(m.chip.unwrap(), SourceChip { kind: SourceKind::Tool, label: "Mira: person_brief".into(), path: None });

        let other = describe_tool_use(&use_of("WebFetch", json!({})), &labels);
        assert_eq!((other.label.as_str(), other.chip), ("Using WebFetch", None));
    }

    #[test]
    fn unknown_server_key_falls_back_to_the_key_and_forward_slashes_work() {
        let m = describe_tool_use(&use_of("mcp__other__x", json!({})), &[]);
        assert_eq!(m.label, "other: x");
        let r = describe_tool_use(&use_of("Read", json!({"file_path": "D:/V/a b.md"})), &[]);
        assert_eq!(r.label, "Reading a b.md");
        let none = describe_tool_use(&use_of("Read", json!({})), &[]);
        assert_eq!((none.label.as_str(), none.chip), ("Reading a note", None));
    }

    #[test]
    fn degraded_notice_names_failed_servers_and_left_out_sources() {
        let labels = vec![("mira".to_string(), "Mira".to_string()), ("wiki".to_string(), "Wiki".to_string())];
        assert_eq!(sources_degraded_notice(&labels, &[], &[]), None);
        assert_eq!(
            sources_degraded_notice(&labels, &["mira".into()], &[]).as_deref(),
            Some("Mira didn't start, so its tools aren't available")
        );
        assert_eq!(
            sources_degraded_notice(&labels, &["mira".into(), "wiki".into()], &[]).as_deref(),
            Some("Mira and Wiki didn't start, so their tools aren't available")
        );
        assert_eq!(
            sources_degraded_notice(&labels, &["other".into()], &["Vault: folder not found".into(), "B: x".into()]).as_deref(),
            Some("other didn't start, so its tools aren't available. Left out: Vault: folder not found; B: x")
        );
        assert_eq!(
            sources_degraded_notice(&labels, &[], &["Vault: folder not found".into()]).as_deref(),
            Some("Left out: Vault: folder not found")
        );
    }

    #[test]
    fn a_chip_only_activity_carries_the_chip_and_is_marked() {
        let chip = SourceChip { kind: SourceKind::Notes, label: "a.md".into(), path: Some("D:/a.md".into()) };
        let a = SourceActivity::chip_only(chip.clone());
        assert!(a.chip_only && a.chip == Some(chip));
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["chip_only"], true);
        // A normal line doesn't carry the flag.
        let line = describe_tool_use(&use_of("Grep", json!({"pattern": "x"})), &[]);
        assert!(serde_json::to_value(&line).unwrap().get("chip_only").is_none());
    }

    #[test]
    fn serializes_in_snake_case() {
        let a = describe_tool_use(&use_of("Read", json!({"file_path": "a.md"})), &[]);
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["kind"], "notes");
        assert_eq!(v["chip"]["path"], "a.md");
    }
}
