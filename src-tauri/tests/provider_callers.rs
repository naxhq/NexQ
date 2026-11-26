//! Guard: the router's active provider and the CLI agents' active kind change
//! only through the `set_llm_provider` / `set_active_model` commands (and the
//! startup default). The workspace, chat, notes, brief and AI-run code reads
//! them to pick a default and never writes them: a workspace action must never
//! change the global provider.

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn only_the_provider_commands_write_the_active_provider_or_model() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut all = Vec::new();
    rust_files(&src, &mut all);
    // Code that must only read the active provider.
    let readers = [
        "workspace_chat", "workspace", "workspace_search", "live_runtime", "live_notes", "live_brief",
        "live_common.rs", "ai_runs", "intelligence",
    ];
    let writes = [".set_provider(", ".set_active_model(", "cli_settings.set_active(", "settings().set_active(", ".set_active(CliAgentKind"];
    let mut offenders = Vec::new();
    for f in all {
        let rel = f.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        let is_test_file = rel.ends_with("tests.rs") || rel.ends_with("/tests/mod.rs");
        if is_test_file || !readers.iter().any(|r| rel == *r || rel.starts_with(&format!("{r}/"))) {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        // Drop `#[cfg(test)]` modules: tests may set a provider up.
        let live = text.split("#[cfg(test)]").next().unwrap_or("");
        for w in writes {
            if live.contains(w) {
                offenders.push(format!("{rel}: {w}"));
            }
        }
    }
    assert!(offenders.is_empty(), "these write the global provider: {offenders:?}");
}

#[test]
fn the_provider_commands_are_where_the_router_and_the_active_kind_change() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let cmds = std::fs::read_to_string(src.join("commands/llm_commands.rs")).unwrap();
    assert!(cmds.contains(".set_provider(config)") && cmds.contains("cli_settings.set_active(kind)"));
    assert!(cmds.contains(".set_active_model(model_id"));
}
