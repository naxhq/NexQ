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
                }
            }
            None => SourceActivity {
                kind: SourceKind::Tool,
                label: format!("Using {other}"),
                chip: None,
            },
        },
    }
}

fn notes_line(label: String) -> SourceActivity {
    SourceActivity { kind: SourceKind::Notes, label, chip: None }
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
        ToolUse { name: name.into(), input }
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
    fn serializes_in_snake_case() {
        let a = describe_tool_use(&use_of("Read", json!({"file_path": "a.md"})), &[]);
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["kind"], "notes");
        assert_eq!(v["chip"]["path"], "a.md");
    }
}
