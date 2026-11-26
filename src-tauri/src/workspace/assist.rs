//! The assistant panel's two pills, Knowledge and Tools, resolved against the
//! meeting's own scope. What a pill covers is read from the scope, never from
//! the global list of saved sources. (Internally the Knowledge pill is
//! "library": its saved key and field names stay.)
//!
//! - Knowledge: the workspace Library's documents, pasted notes and folders.
//!   A folder in the Library is used (indexed and searched); taking it out of
//!   the Library is how to stop using it. One switched off in Settings is not.
//! - Tools: the scope's MCP servers that can be used, with their allowed tools.
//!
//! A pill that is off is a lock: nothing of its kind goes into a prompt or a
//! CLI session for that answer.

use serde::Serialize;

use crate::context::ContextResource;
use crate::sources::config::{PersonalSourcesConfig, SourceToggles};

use super::runtime::scoped_sources;
use super::scope::EffectiveScope;

/// File type of a pasted note in the library (a document of the app's own).
pub const NOTE_TYPE: &str = "note";

/// Modes that run by themselves, never because the user asked: no pill applies
/// and they never use folders or tools.
fn is_background(mode: &str) -> bool {
    crate::llm::cli_agent::routing::BACKGROUND_MODES.contains(&mode)
}

/// What a scope holds of each pill's kind right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Held {
    /// Any document, note or folder.
    pub library: bool,
    /// Folders a CLI session could be given.
    pub folders: bool,
    /// Servers a CLI session could be given.
    pub servers: bool,
}

fn is_listed_document(r: &ContextResource) -> bool {
    r.status != crate::context::STATUS_MISSING
}

/// Folders of `scope` an answer may use: linked to the workspace's Library and
/// switched on in Settings.
pub fn usable_folders<'a>(cfg: &'a PersonalSourcesConfig, scope: &EffectiveScope) -> Vec<&'a crate::sources::config::NotesFolder> {
    cfg.enabled_folders().into_iter().filter(|f| scope.allows_folder(&f.id)).collect()
}

/// Servers of `scope` a session may be given.
pub fn usable_servers<'a>(cfg: &'a PersonalSourcesConfig, scope: &EffectiveScope) -> Vec<&'a crate::sources::config::McpServer> {
    cfg.usable_servers().into_iter().filter(|s| scope.allows_server(&s.id)).collect()
}

pub fn held(scope: &EffectiveScope, cfg: &PersonalSourcesConfig, resources: &[ContextResource]) -> Held {
    let docs = resources.iter().any(|r| scope.allows_document(&r.id) && is_listed_document(r));
    let folders = !usable_folders(cfg, scope).is_empty();
    Held { library: docs || folders, folders, servers: !usable_servers(cfg, scope).is_empty() }
}

/// What one request may use, from its pills and what the scope holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// Library material may be used (documents, notes, folder text).
    pub library: bool,
    /// A CLI session is launched with the Library folders.
    pub folders: bool,
    /// A CLI session is launched with the Tools servers.
    pub servers: bool,
    /// The scope holds Tools (the key of a session that has none says so).
    pub has_servers: bool,
}

impl Plan {
    /// Both on: today's behaviour with nothing locked.
    pub fn open() -> Self {
        Plan { library: true, folders: false, servers: false, has_servers: false }
    }

    /// The request runs on a session launched with folders or tools.
    pub fn with_sources(&self) -> bool {
        self.folders || self.servers
    }

    /// The session key's flags: (no library material, a sources session without its servers).
    pub fn key_flags(&self) -> (bool, bool) {
        (!self.library, self.with_sources() && self.has_servers && !self.servers)
    }
}

/// The plan of one request.
///
/// - A background mode, and an automatic answer (no pills sent), keep the
///   Library on and launch no folders or tools.
/// - Shorten and FollowUp work on an earlier answer: the session that wrote it
///   decides whether folders and tools are launched, but a pill that is off
///   still locks its kind out.
/// - Any other request launches what its pills ask for and the scope holds.
/// - A Library pill left off in a scope with no Library material locks nothing
///   (there is nothing to lock), so it never makes a session of its own.
pub fn plan(mode: &str, toggles: Option<SourceToggles>, last_answer_with_sources: bool, held: Held) -> Plan {
    let has_servers = held.servers;
    if is_background(mode) {
        return Plan { library: true, folders: false, servers: false, has_servers };
    }
    let Some(t) = toggles else {
        return Plan { library: true, folders: false, servers: false, has_servers };
    };
    let (asks_folders, asks_servers) = match mode {
        "Shorten" | "FollowUp" => (last_answer_with_sources && t.library, last_answer_with_sources && t.tools),
        _ => (t.library, t.tools),
    };
    Plan {
        library: t.library || !held.library,
        folders: asks_folders && held.folders,
        servers: asks_servers && held.servers,
        has_servers,
    }
}

/// The saved sources cut to what a CLI session may be launched with: folders
/// only when Knowledge is on (and then only the scope's own),
/// servers only when Tools is on. Nothing outside the scope, ever.
pub fn session_sources(cfg: &PersonalSourcesConfig, scope: &EffectiveScope, folders: bool, servers: bool) -> PersonalSourcesConfig {
    let base = scoped_sources(cfg, scope);
    PersonalSourcesConfig {
        notes_folders: if folders { base.notes_folders } else {
            Vec::new()
        },
        mcp_servers: if servers { base.mcp_servers } else { Vec::new() },
        mcp_notice_seen: base.mcp_notice_seen,
    }
}

// ── What the pills show ─────────────────────────────────────────────────────

/// A folder of the meeting's Library, and whether answers use it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssistFolder {
    pub label: String,
    /// Switched on in Settings (a folder linked to the Library is otherwise used).
    pub used: bool,
}

/// A server of the meeting's Tools.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssistServer {
    pub label: String,
    pub allowed_tools: usize,
    pub total_tools: usize,
    /// Switched on, signed in and with an allowed tool.
    pub usable: bool,
}

/// What the Library and Tools pills show for one meeting's workspace.
/// Mirrors `AssistSources` in `src/lib/types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssistSources {
    pub workspace_id: String,
    pub documents: usize,
    pub notes: usize,
    pub folders: Vec<AssistFolder>,
    pub servers: Vec<AssistServer>,
}

/// The Library and Tools of `scope`, for the pills.
pub fn summarize(scope: &EffectiveScope, cfg: &PersonalSourcesConfig, resources: &[ContextResource]) -> AssistSources {
    let mut documents = 0;
    let mut notes = 0;
    for r in resources.iter().filter(|r| scope.allows_document(&r.id) && is_listed_document(r)) {
        if r.file_type == NOTE_TYPE {
            notes += 1;
        } else {
            documents += 1;
        }
    }
    let folders = cfg
        .notes_folders
        .iter()
        .filter(|f| scope.allows_folder(&f.id))
        .map(|f| AssistFolder { label: f.label.clone(), used: f.enabled })
        .collect();
    let usable: Vec<&str> = usable_servers(cfg, scope).iter().map(|s| s.id.as_str()).collect();
    let servers = cfg
        .mcp_servers
        .iter()
        .filter(|s| scope.allows_server(&s.id))
        .map(|s| AssistServer {
            label: s.label.clone(),
            allowed_tools: s.allowed_tools().count(),
            total_tools: s.tools.len(),
            usable: usable.contains(&s.id.as_str()),
        })
        .collect();
    AssistSources { workspace_id: scope.home.clone(), documents, notes, folders, servers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{McpServer, McpTool, NotesFolder};

    fn folder(id: &str, enabled: bool) -> NotesFolder {
        NotesFolder { id: id.into(), label: format!("{id} vault"), path: format!("C:/{id}"), enabled }
    }

    fn server(id: &str, allowed: usize, total: usize) -> McpServer {
        McpServer {
            id: id.into(),
            key: id.into(),
            label: format!("{id} tools"),
            enabled: true,
            tools: (0..total)
                .map(|i| McpTool { name: format!("t{i}"), full_name: format!("mcp__{id}__t{i}"), allowed: i < allowed, ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    fn doc(id: &str, file_type: &str) -> ContextResource {
        ContextResource {
            id: id.into(),
            name: format!("{id}.{file_type}"),
            file_type: file_type.into(),
            file_path: String::new(),
            size_bytes: 0,
            token_count: 0,
            preview: String::new(),
            loaded_at: String::new(),
            status: crate::context::STATUS_READY.into(),
        }
    }

    fn scope() -> EffectiveScope {
        EffectiveScope {
            home: "ws".into(),
            document_ids: vec!["d1".into(), "n1".into()],
            folder_ids: vec!["fa".into(), "fb".into()],
            server_ids: vec!["sa".into()],
            ..Default::default()
        }
    }

    fn cfg() -> PersonalSourcesConfig {
        PersonalSourcesConfig {
            notes_folders: vec![folder("fa", true), folder("fb", true), folder("fother", true)],
            mcp_servers: vec![server("sa", 9, 19), server("sother", 3, 3)],
            mcp_notice_seen: true,
        }
    }

    fn resources() -> Vec<ContextResource> {
        vec![doc("d1", "pdf"), doc("n1", NOTE_TYPE), doc("other", "pdf")]
    }

    #[test]
    fn the_pills_describe_the_scope_not_the_saved_list() {
        let s = summarize(&scope(), &cfg(), &resources());
        assert_eq!((s.documents, s.notes), (1, 1), "another workspace's document is not counted");
        assert_eq!(s.folders.len(), 2, "another workspace's folder is not listed");
        assert!(s.folders.iter().any(|f| f.label == "fa vault" && f.used));
        let mut off = cfg();
        off.notes_folders[1].enabled = false;
        let s2 = summarize(&scope(), &off, &resources());
        assert!(s2.folders.iter().any(|f| f.label == "fb vault" && !f.used), "a folder switched off in Settings is listed as not used");
        assert_eq!(s.servers.len(), 1);
        assert_eq!((s.servers[0].allowed_tools, s.servers[0].total_tools, s.servers[0].usable), (9, 19, true));
        assert!(!format!("{s:?}").contains("other"));
    }

    #[test]
    fn held_counts_documents_and_linked_folders() {
        let h = held(&scope(), &cfg(), &resources());
        assert_eq!(h, Held { library: true, folders: true, servers: true });
        // only a folder switched off in Settings: no Knowledge
        let mut off = cfg();
        off.notes_folders.iter_mut().for_each(|f| f.enabled = false);
        let only_folders = EffectiveScope { document_ids: vec![], ..scope() };
        assert!(!held(&only_folders, &off, &resources()).library);
        assert!(held(&only_folders, &cfg(), &resources()).library, "a folder in the Library is used");
        // nothing at all
        assert_eq!(held(&EffectiveScope::default(), &cfg(), &resources()), Held::default());
        // a server that needs a sign-in is not Tools
        let mut c = cfg();
        c.mcp_servers[0].needs_sign_in = true;
        assert!(!held(&scope(), &c, &resources()).servers);
    }

    #[test]
    fn a_pill_that_is_off_locks_its_kind_out() {
        let h = Held { library: true, folders: true, servers: true };
        let on = SourceToggles { library: true, tools: true };
        let p = plan("Assist", Some(on), false, h);
        assert!(p.library && p.folders && p.servers && p.with_sources());
        assert_eq!(p.key_flags(), (false, false));

        let lib_off = plan("Assist", Some(SourceToggles { library: false, tools: true }), false, h);
        assert!(!lib_off.library && !lib_off.folders && lib_off.servers);
        assert_eq!(lib_off.key_flags(), (true, false));

        let tools_off = plan("Assist", Some(SourceToggles { library: true, tools: false }), false, h);
        assert!(tools_off.library && tools_off.folders && !tools_off.servers);
        assert_eq!(tools_off.key_flags(), (false, true));

        let both_off = plan("Assist", Some(SourceToggles::default()), false, h);
        assert!(!both_off.library && !both_off.with_sources());
        assert_eq!(both_off.key_flags(), (true, false), "plain session without the library");
    }

    #[test]
    fn automatic_and_background_answers_keep_the_library_and_launch_nothing() {
        let h = Held { library: true, folders: true, servers: true };
        for p in [plan("Assist", None, true, h), plan("MeetingSummary", Some(SourceToggles::default()), true, h)] {
            assert!(p.library && !p.with_sources());
        }
    }

    #[test]
    fn shorten_and_follow_up_follow_the_answer_but_never_beat_a_pill() {
        let h = Held { library: true, folders: true, servers: true };
        let on = Some(SourceToggles { library: true, tools: true });
        assert!(plan("Shorten", on, true, h).with_sources());
        assert!(!plan("Shorten", on, false, h).with_sources(), "the answer came from the plain session");
        let tools_off = plan("FollowUp", Some(SourceToggles { library: true, tools: false }), true, h);
        assert!(tools_off.folders && !tools_off.servers);
        let lib_off = plan("FollowUp", Some(SourceToggles { library: false, tools: true }), true, h);
        assert!(!lib_off.library && !lib_off.folders && lib_off.servers);
    }

    #[test]
    fn a_pill_left_off_where_there_is_nothing_to_lock_makes_no_session_of_its_own() {
        let nothing = Held::default();
        let p = plan("Assist", Some(SourceToggles::default()), false, nothing);
        assert!(p.library && !p.with_sources());
        assert_eq!(p.key_flags(), (false, false));
    }

    #[test]
    fn a_session_is_launched_with_what_is_on_and_in_the_scope() {
        let all = session_sources(&cfg(), &scope(), true, true);
        let folders: Vec<&str> = all.notes_folders.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(folders, vec!["fa", "fb"], "both of the workspace's folders, not another workspace's");
        assert_eq!(all.mcp_servers.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["sa"]);

        let no_lib = session_sources(&cfg(), &scope(), false, true);
        assert!(no_lib.notes_folders.is_empty() && no_lib.mcp_servers.len() == 1);
        let no_tools = session_sources(&cfg(), &scope(), true, false);
        assert!(no_tools.mcp_servers.is_empty() && no_tools.notes_folders.len() == 2);
        assert!(!session_sources(&cfg(), &scope(), false, false).has_enabled());
        // another workspace's scope sees none of it
        let other = EffectiveScope { home: "other".into(), ..Default::default() };
        assert!(!session_sources(&cfg(), &other, true, true).has_enabled());
    }
}
