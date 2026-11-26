//! Shared contract tests: what the webview sends and receives, written once as a JSON
//! file in `src/contracts/fixtures/<name>.json` and checked from both sides.
//!
//! * A **command** fixture is the exact arguments object `invoke(name, args)` passes
//!   (top-level keys camelCase, nested structs snake_case).
//! * An **event** fixture is the payload the webview receives.
//!
//! Rust side: `assert_contract!("name", value)` serialises `value` and compares it with the
//! file; `NEXQ_REWRITE_CONTRACTS=1 cargo test --lib` rewrites the files from the code.
//! `input::<T>(name, key)` reads a fixture the way the command would and checks nothing is
//! lost on the way. TS side: `src/contracts/loadFixture.ts`.
//!
//! `every_new_command_and_event_has_a_fixture` lists each registered command and each
//! `emit(` name of the new features and fails when one has no fixture.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("contracts").join("fixtures")
}

fn path_of(name: &str) -> PathBuf {
    fixtures_dir().join(format!("{name}.json"))
}

fn rewriting() -> bool {
    std::env::var("NEXQ_REWRITE_CONTRACTS").map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

pub fn read(name: &str) -> Value {
    let p = path_of(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("fixture {} is not JSON: {e}", p.display()))
}

/// Serialise `value` and compare it with the fixture (or rewrite the fixture).
pub fn check<T: Serialize>(name: &str, value: &T) {
    let actual = serde_json::to_value(value).expect("serialises");
    if rewriting() {
        let text = serde_json::to_string_pretty(&sorted(&actual)).unwrap() + "\n";
        std::fs::write(path_of(name), text).expect("fixture written");
        return;
    }
    let expected = read(name);
    assert_eq!(
        expected, actual,
        "contract `{name}` differs from src/contracts/fixtures/{name}.json (NEXQ_REWRITE_CONTRACTS=1 rewrites it; the TS side must change with it)"
    );
}

/// Read `key` of a command fixture as the command's argument type and serialise it back:
/// a field the type does not know (or drops) shows as a difference.
pub fn input<T: DeserializeOwned + Serialize>(name: &str, key: &str) -> T {
    let fixture = read(name);
    let part = fixture.get(key).unwrap_or_else(|| panic!("fixture {name} has no `{key}`")).clone();
    let typed: T = serde_json::from_value(part.clone()).unwrap_or_else(|e| panic!("fixture {name}.{key} does not fit its type: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(strip_nulls(&part), strip_nulls(&back), "fixture {name}.{key} loses or changes fields in Rust");
    typed
}

fn strip_nulls(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), strip_nulls(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(strip_nulls).collect()),
        other => other.clone(),
    }
}

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), sorted(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

#[macro_export]
macro_rules! assert_contract {
    ($name:expr, $value:expr) => {
        $crate::contract::check($name, &$value)
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::workspace_commands::{MemoryChanged, WorkspacesChanged};
    use crate::db::health::{BackupInfo, DbProblem, ProblemKind};
    use crate::store_guard::StoreRecovery;
    use crate::workspace::types::*;

    // ---- events

    #[test]
    fn event_workspaces_changed() {
        assert_contract!("workspaces_changed", WorkspacesChanged { workspace_id: Some("w1".into()) });
    }

    #[test]
    fn event_automatic_model_updated() {
        assert_contract!("automatic_model_updated", serde_json::json!({ "provider": "openai" }));
    }

    #[test]
    fn event_memory_changed() {
        assert_contract!("memory_changed", MemoryChanged { workspace_id: "w1".into() });
    }

    #[test]
    fn event_store_recovered() {
        let list = vec![StoreRecovery { file: "config.json".into(), kept_as: Some("config.json.corrupt-00000000000000000042".into()), restored: true }];
        assert_contract!("store_recovered", list);
    }

    #[test]
    fn event_workspace_material_unavailable() {
        let payload = crate::workspace::runtime::unavailable_payload(Some("m1"));
        assert_contract!("workspace_material_unavailable", payload);
    }

    /// `start_meeting` answers with the meeting as JSON text, plus `workspace_notice` when it was
    /// filed somewhere other than asked (a meeting always starts).
    #[test]
    fn start_meeting_result_with_a_workspace_notice() {
        let mut meeting = crate::db::meetings::create_meeting(&rusqlite::Connection::open_in_memory().map(|c| {
            c.execute_batch("CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, start_time TEXT, end_time TEXT, duration_seconds INTEGER, transcript TEXT, ai_interactions TEXT, summary TEXT, config_snapshot TEXT, workspace_id TEXT)").unwrap();
            c
        }).unwrap(), "Weekly sync").unwrap();
        meeting.id = "m1".into();
        meeting.start_time = "2026-11-25T10:00:00+00:00".into();
        let text = crate::commands::meeting_commands::meeting_response(&meeting, Some("That workspace is archived, so this meeting is in General.".into())).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_contract!("start_meeting_result", value);
    }

    #[test]
    fn get_assist_sources_result() {
        use crate::workspace::assist::*;
        let sources = AssistSources {
            workspace_id: "w1".into(),
            documents: 3,
            notes: 1,
            folders: vec![AssistFolder { label: "DePaul".into(), used: true }],
            servers: vec![AssistServer { label: "mira".into(), allowed_tools: 9, total_tools: 19, usable: true }],
        };
        assert_contract!("get_assist_sources_result", sources);
    }

    #[test]
    fn get_workspace_note_result() {
        let note = crate::commands::workspace_commands::NoteText { title: "Plan".into(), text: "# Plan
Ship it.".into() };
        assert_contract!("get_workspace_note_result", note);
    }

    #[test]
    fn status_with_a_database_problem() {
        let status = WorkspacesStatus {
            available: false,
            error: Some("The database did not open".into()),
            db: Some(DbProblem {
                kind: ProblemKind::Unreadable,
                message: "A check of your meetings file found damage.".into(),
                path: "C:/data/nexq.db".into(),
                backups: vec![BackupInfo { name: "nexq-before-workspaces.db".into(), created_at: 1_700_000_000_000, bytes: 1024, meetings: Some(3) }],
            }),
        };
        assert_contract!("workspaces_status_problem", status);
    }

    // ---- command inputs: the fixture must fit the Rust type, field for field

    #[test]
    fn command_inputs_fit_their_types() {
        let _: CreateWorkspaceInput = input("create_workspace", "input");
        let _: WorkspacePatch = input("update_workspace", "patch");
        let _: ItemPatch = input("update_workspace_item", "patch");
        let _: TalkingContent = input("create_talking_point", "content");
        let _: TalkingPointPatch = input("patch_talking_point", "patch");
        let _: Vec<PointSaid> = input("save_point_progress", "said");
        let _: MemoryCreate = input("create_memory", "input");
        let _: MemoryUpdate = input("update_memory", "patch");
        let _: MemoryPatch = input("resolve_memory", "patch");
    }

    #[test]
    fn a_talking_point_without_in_context_is_refused() {
        let mut content = read("create_talking_point")["content"].clone();
        content.as_object_mut().unwrap().remove("in_context");
        assert!(serde_json::from_value::<TalkingContent>(content).is_err());
    }

    // ---- every command and event of the new features has a fixture

    /// Command modules and source folders of the features built on this branch.
    const NEW_COMMAND_MODULES: &[&str] = &["workspace_commands", "workspace_chat_commands", "db_recovery_commands", "live_commands"];
    const NEW_SOURCE_PATHS: &[&str] = &[
        "workspace/", "workspace_chat/", "workspace_search/", "workspace_memory/", "live_brief/", "live_common", "live_notes/",
        "live_runtime/", "ai_runs/", "store_guard", "commands/workspace_commands", "commands/workspace_chat_commands",
        "commands/db_recovery_commands",
    ];

    /// Commands of the new modules that still have no fixture. Each line names who owes it.
    /// Remove a line when its fixture lands; the test also fails if a listed name gets one.
    const PENDING_COMMANDS: &[&str] = &[
    ];

    /// Events of the new features that still have no fixture (owner in the comment).
    const PENDING_EVENTS: &[&str] = &[
    ];

    fn src_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    fn has_fixture(name: &str) -> bool {
        path_of(name).exists()
    }

    /// Names registered with `module::name,` in the invoke handler.
    fn registered_commands() -> Vec<(String, String)> {
        let text = std::fs::read_to_string(src_dir().join("lib.rs")).unwrap();
        let start = text.find("generate_handler![").expect("handler list");
        let list = &text[start..];
        let end = list.find("]))").unwrap_or(list.len());
        let mut out = vec![];
        for line in list[..end].lines() {
            let line = line.trim().trim_end_matches(',');
            if line.starts_with("//") {
                continue;
            }
            if let Some((m, n)) = line.split_once("::") {
                if m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push((m.to_string(), n.to_string()));
                }
            }
        }
        out
    }

    /// `emit(...)` names with the file that emits them (test code excluded).
    fn emitted_events() -> Vec<(String, String)> {
        let mut files = vec![];
        rs_files(&src_dir(), &mut files);
        let mut out = vec![];
        for f in files {
            let rel = f.strip_prefix(src_dir()).unwrap().to_string_lossy().replace('\\', "/");
            if rel.ends_with("tests.rs") || rel.contains("/tests/") || rel == "contract.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap();
            let text = text.split("#[cfg(test)]").next().unwrap_or("");
            for marker in ["emit(", "emit)(", "emit_all(", "emit_to("] {
                for (i, _) in text.match_indices(marker) {
                    let mut rest = text[i + marker.len()..].trim_start();
                    // `emit(app, "name", ..)` / `emit_to(label, "name", ..)`: skip one argument.
                    if !rest.starts_with('"') {
                        match rest.split_once(',') {
                            Some((arg, after)) if arg.len() < 40 && !arg.contains('"') => rest = after.trim_start(),
                            _ => continue,
                        }
                    }
                    let Some(rest) = rest.strip_prefix('"') else { continue };
                    let Some(end) = rest.find('"') else { continue };
                    let name = &rest[..end];
                    if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == ':') {
                        out.push((name.to_string(), rel.clone()));
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    #[test]
    fn every_new_command_and_event_has_a_fixture() {
        let mut missing = vec![];
        for (module, name) in registered_commands() {
            if NEW_COMMAND_MODULES.contains(&module.as_str()) && !has_fixture(&name) && !PENDING_COMMANDS.contains(&name.as_str()) {
                missing.push(format!("command {module}::{name}"));
            }
        }
        for (name, file) in emitted_events() {
            let new_feature = NEW_SOURCE_PATHS.iter().any(|p| file.starts_with(p)) || (file == "lib.rs" && name == "store_recovered");
            if new_feature && !has_fixture(&name) && !PENDING_EVENTS.contains(&name.as_str()) {
                missing.push(format!("event {name} (emitted in {file})"));
            }
        }
        assert!(missing.is_empty(), "no fixture in src/contracts/fixtures for:\n  {}\nAdd <name>.json (assert_contract! or by hand), or list it as pending with its owner.", missing.join("\n  "));
    }

    // ---- a fixture carries exactly the arguments of its command

    /// Fixtures named like a command that hold its RESULT (checked by the webview test, not here).
    const RESULT_NAMED_AS_COMMAND: &[&str] = &["get_meeting_brief", "get_meeting_notes"];
    /// Command fixtures that are variants of one command.
    const VARIANT_OF: &[(&str, &str)] = &[
        ("ask_workspace_deeper", "ask_workspace"),
        ("set_chat_item_pref_exclude", "set_chat_item_pref"),
        ("create_memory_by_hand", "create_memory"),
    ];
    /// Arguments a command takes that a fixture may leave out although they are not `Option`
    /// in Rust (the webview wrapper has a default): (command, argument). Empty on purpose.
    const OPTIONAL_ARGS: &[(&str, &str)] = &[];

    fn camel(snake: &str) -> String {
        let mut out = String::new();
        let mut up = false;
        for c in snake.chars() {
            if c == '_' {
                up = true;
            } else if up {
                out.extend(c.to_uppercase());
                up = false;
            } else {
                out.push(c);
            }
        }
        out
    }

    /// `#[command]` functions of one source file: name -> (camelCase argument, optional).
    /// State, AppHandle and window arguments are not the webview's.
    fn command_args(text: &str) -> std::collections::BTreeMap<String, Vec<(String, bool)>> {
        let text = text.split("#[cfg(test)]").next().unwrap_or("");
        let mut out = std::collections::BTreeMap::new();
        for (at, _) in text.match_indices("#[command]") {
            let rest = &text[at..];
            let Some(f) = rest.find("fn ") else { continue };
            let after = &rest[f + 3..];
            let Some(open) = after.find('(') else { continue };
            let name = after[..open].trim().to_string();
            // the parameter list: up to the closing parenthesis that matches the first one
            let (mut depth, mut end) = (0i32, open);
            for (i, c) in after[open..].char_indices() {
                if c == '(' {
                    depth += 1;
                } else if c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
            }
            let sig = &after[open + 1..end];
            let (mut parts, mut cur, mut d) = (vec![], String::new(), 0i32);
            let mut prev = ' ';
            for c in sig.chars() {
                match c {
                    '<' | '(' | '[' => d += 1,
                    '>' if prev != '-' => d -= 1,
                    ')' | ']' => d -= 1,
                    _ => {}
                }
                if c == ',' && d == 0 {
                    parts.push(std::mem::take(&mut cur));
                } else {
                    cur.push(c);
                }
                prev = c;
            }
            parts.push(cur);
            let args = parts
                .iter()
                .filter_map(|p| p.split_once(':'))
                .filter(|(_, ty)| !["State<", "AppHandle", "Window", "WebviewWindow"].iter().any(|s| ty.contains(s)))
                .map(|(n, ty)| (camel(n.trim().trim_start_matches("mut ")), ty.trim().starts_with("Option<")))
                .collect();
            out.insert(name, args);
        }
        out
    }

    #[test]
    fn a_command_fixture_has_exactly_the_arguments_of_its_command() {
        let mut all = std::collections::BTreeMap::new();
        for f in ["workspace_commands", "workspace_chat_commands", "db_recovery_commands", "live_commands", "meeting_commands"] {
            let text = std::fs::read_to_string(src_dir().join("commands").join(format!("{f}.rs"))).unwrap();
            for (k, v) in command_args(&text) {
                all.insert(k, v);
            }
        }
        let mut checked = 0;
        let mut problems = vec![];
        for (module, command) in registered_commands() {
            let new_feature = NEW_COMMAND_MODULES.contains(&module.as_str()) || (module == "meeting_commands" && command == "start_meeting");
            if !new_feature || RESULT_NAMED_AS_COMMAND.contains(&command.as_str()) {
                continue;
            }
            let Some(args) = all.get(&command) else { continue };
            let names: Vec<&str> = std::iter::once(command.as_str()).chain(VARIANT_OF.iter().filter(|(_, c)| *c == command).map(|(v, _)| *v)).collect();
            for fixture in names {
                if !has_fixture(fixture) {
                    continue;
                }
                let value = read(fixture);
                let keys: Vec<String> = value.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                checked += 1;
                for (arg, optional) in args {
                    let allowed_absent = *optional || OPTIONAL_ARGS.iter().any(|(c, a)| *c == command && a == arg);
                    if !keys.contains(arg) && !allowed_absent {
                        problems.push(format!("{fixture}: the command needs `{arg}` and the fixture does not have it"));
                    }
                }
                for k in &keys {
                    if !args.iter().any(|(a, _)| a == k) {
                        problems.push(format!("{fixture}: `{k}` is not an argument of `{command}`"));
                    }
                }
            }
        }
        assert!(checked > 60, "only {checked} command fixtures were compared: the scan is broken");
        assert!(problems.is_empty(), "fixture arguments differ from the Rust commands:\n  {}", problems.join("\n  "));
    }

    #[test]
    fn the_signature_reader_sees_camel_case_and_optional_arguments() {
        let args = command_args("#[command]\npub async fn start_meeting(title: Option<String>, workspace_id: Option<String>, state: State<'_, AppState>, app: AppHandle) -> Result<String, String> { }");
        assert_eq!(args["start_meeting"], vec![("title".to_string(), true), ("workspaceId".to_string(), true)]);
    }

    #[test]
    fn pending_lists_do_not_hide_finished_work() {
        for name in PENDING_COMMANDS.iter().chain(PENDING_EVENTS.iter()) {
            assert!(!has_fixture(name), "`{name}` has a fixture now: remove it from the pending list");
        }
    }

    #[test]
    fn the_scan_finds_what_it_should() {
        let events: Vec<String> = emitted_events().into_iter().map(|(n, _)| n).collect();
        assert!(events.iter().any(|n| n == "workspaces_changed"), "scan found {events:?}");
        let cmds = registered_commands();
        assert!(cmds.iter().any(|(m, n)| m == "workspace_commands" && n == "create_workspace"));
    }

    #[test]
    fn every_fixture_is_json() {
        for e in std::fs::read_dir(fixtures_dir()).unwrap().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "json") {
                let text = std::fs::read_to_string(&p).unwrap();
                serde_json::from_str::<Value>(&text).unwrap_or_else(|err| panic!("{}: {err}", p.display()));
            }
        }
    }
}
