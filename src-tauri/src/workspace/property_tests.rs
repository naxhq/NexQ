//! Random sequences of changes and asks over three workspaces and two
//! meetings. After every step the scope of each meeting (what an ask starting
//! now would be built from) must equal an oracle written straight from the
//! rules and the tables, so no document, folder, server or talking point of a
//! workspace outside the scope in force can be in an ask. Every ask also keeps
//! its own snapshot, which must still hold the canaries of the scope in force
//! when it started, whatever changed after.

use std::collections::BTreeSet;

use rusqlite::{params, Connection};

use super::meetings::{move_meeting_atomic, set_meeting_scope};
use super::scope::{scope_for, ScopeOwner};
use super::store;
use super::talking_points::{create_talking_point, patch_talking_point};
use super::test_support::memory_db;
use super::types::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self) -> bool {
        self.next() % 2 == 0
    }
}

fn strings(conn: &Connection, sql: &str, ids: &[String]) -> BTreeSet<String> {
    let json = serde_json::to_string(ids).unwrap();
    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map(params![json], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

/// What a meeting may use, from the rules of the spec and the raw tables.
struct Expected {
    material: BTreeSet<String>,
    documents: BTreeSet<String>,
    folders: BTreeSet<String>,
    servers: BTreeSet<String>,
    points: BTreeSet<String>,
}

fn oracle(conn: &Connection, meeting: &str) -> Expected {
    let flags = |id: &str| -> Option<(bool, bool)> {
        conn.query_row("SELECT include_general, keep_separate FROM workspaces WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok()
    };
    let home: String = conn.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![meeting], |r| r.get(0)).unwrap();
    let (include_general, home_separate) = flags(&home).unwrap();
    let mut material = BTreeSet::from([home.clone()]);
    if !home_separate {
        let mut stmt = conn.prepare("SELECT workspace_id FROM meeting_borrowed WHERE meeting_id = ?1 AND removed_at IS NULL").unwrap();
        let borrowed: Vec<String> = stmt.query_map(params![meeting], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        for b in borrowed {
            if let Some((_, separate)) = flags(&b) {
                if !separate && b != home {
                    material.insert(b);
                }
            }
        }
        if home != "general" && include_general {
            material.insert("general".to_string());
        }
    }
    let ids: Vec<String> = material.iter().cloned().collect();
    let items = |kind: &str| {
        strings(
            conn,
            &format!("SELECT ref_id FROM workspace_items WHERE kind = '{kind}' AND workspace_id IN (SELECT value FROM json_each(?1))"),
            &ids,
        )
    };
    Expected {
        documents: items("document"),
        folders: items("folder"),
        servers: items("server"),
        points: strings(
            conn,
            "SELECT id FROM talking_points WHERE in_context = 1 AND workspace_id IN (SELECT value FROM json_each(?1))",
            &ids,
        ),
        material,
    }
}

fn check(conn: &Connection, meeting: &str, step: &str) {
    let got = scope_for(conn, ScopeOwner::Meeting(meeting)).unwrap();
    let want = oracle(conn, meeting);
    let set = |v: &Vec<String>| v.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(set(&got.material_workspaces), want.material, "workspaces after {step}");
    assert_eq!(set(&got.document_ids), want.documents, "documents after {step}");
    assert_eq!(set(&got.folder_ids), want.folders, "folders after {step}");
    assert_eq!(set(&got.server_ids), want.servers, "servers after {step}");
    assert_eq!(set(&got.talking_point_ids), want.points, "talking points after {step}");
}

/// The canary of an item is its id: everything an ask is built from is named
/// by these.
fn canaries(scope: &super::scope::EffectiveScope) -> BTreeSet<String> {
    scope
        .document_ids
        .iter()
        .chain(&scope.folder_ids)
        .chain(&scope.server_ids)
        .chain(&scope.talking_point_ids)
        .cloned()
        .collect()
}

fn run_sequence(seed: u64) {
    let conn = memory_db();
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut workspaces: Vec<String> = vec!["general".to_string()];
    for name in ["A", "B", "C"] {
        workspaces.push(store::create_workspace(&conn, CreateWorkspaceInput { name: name.into(), ..Default::default() }).unwrap().id);
    }
    let pool = |kind: &str| (0..3).map(|i| format!("{kind}{i}")).collect::<Vec<_>>();
    for doc in pool("doc") {
        conn.execute(
            "INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES (?1, ?1, 'txt', 'x', 'now')",
            params![doc],
        )
        .unwrap();
    }
    let meetings = ["m1", "m2"];
    for m in meetings {
        let home = workspaces[rng.below(workspaces.len())].clone();
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES (?1, ?1, 'x', ?2)", params![m, home]).unwrap();
    }
    // Asks that already started: the scope they were built from, and the canaries it held.
    let mut asks: Vec<(String, super::scope::EffectiveScope, BTreeSet<String>)> = Vec::new();

    for step in 0..40 {
        let ws = workspaces[rng.below(workspaces.len())].clone();
        let meeting = meetings[rng.below(2)];
        let kind = [ItemKind::Document, ItemKind::Folder, ItemKind::Server][rng.below(3)];
        let ref_id = format!("{}{}", ["doc", "folder", "server"][kind as usize], rng.below(3));
        let label = match rng.below(10) {
            0 => {
                let _ = store::add_item(&conn, &ws, kind, &ref_id, None);
                format!("add {ref_id} to {ws}")
            }
            1 => {
                let _ = store::remove_item(&conn, &ws, kind, &ref_id);
                format!("remove {ref_id} from {ws}")
            }
            2 => {
                let wanted: Vec<String> = workspaces.iter().filter(|_| rng.chance()).cloned().collect();
                let _ = set_meeting_scope(&conn, meeting, &wanted);
                format!("borrow {wanted:?} in {meeting}")
            }
            3 => {
                let _ = move_meeting_atomic(&conn, meeting, &ws);
                format!("move {meeting} to {ws}")
            }
            4 => {
                let _ = store::update_workspace(&conn, &ws, WorkspacePatch { keep_separate: Some(rng.chance()), ..Default::default() });
                format!("keep_separate of {ws}")
            }
            5 => {
                let _ = store::update_workspace(&conn, &ws, WorkspacePatch { include_general: Some(rng.chance()), ..Default::default() });
                format!("include_general of {ws}")
            }
            6 => {
                let _ = store::archive_workspace(&conn, &ws, rng.chance());
                format!("archive {ws}")
            }
            7 => {
                let content = TalkingContent { doc_json: None, markdown: None, plain_text: Some("note".into()), in_context: rng.chance() };
                let _ = create_talking_point(&conn, &ws, None, content);
                format!("new point in {ws}")
            }
            8 => {
                let id: Option<String> = conn.query_row("SELECT id FROM talking_points ORDER BY RANDOM() LIMIT 1", [], |r| r.get(0)).ok();
                if let Some(id) = id {
                    let _ = patch_talking_point(&conn, &id, TalkingPointPatch { in_context: Some(rng.chance()), ..Default::default() }, None);
                }
                "toggle a point".to_string()
            }
            _ => {
                if ws != "general" && rng.below(4) == 0 {
                    let _ = store::delete_workspace(&conn, &ws, DeleteMode::Move);
                }
                format!("delete {ws}")
            }
        };
        let step = format!("seed {seed} step {step}: {label}");
        for m in meetings {
            check(&conn, m, &step);
        }
        // An ask starts now: it keeps the scope in force at this moment.
        if rng.chance() {
            let scope = scope_for(&conn, ScopeOwner::Meeting(meeting)).unwrap();
            let held = canaries(&scope);
            asks.push((meeting.to_string(), scope, held));
        }
    }
    // Whatever changed since, an ask's snapshot is exactly what it started with:
    // nothing later was added to it, and nothing outside its scope was ever in it.
    for (_, scope, held) in &asks {
        assert_eq!(&canaries(scope), held);
    }
}

#[test]
fn no_ask_ever_holds_material_outside_the_scope_in_force_when_it_started() {
    for seed in 1..=150 {
        run_sequence(seed);
    }
}

#[test]
fn the_oracle_agrees_on_a_hand_made_case() {
    let conn = memory_db();
    let a = store::create_workspace(&conn, CreateWorkspaceInput { name: "A".into(), ..Default::default() }).unwrap().id;
    let b = store::create_workspace(&conn, CreateWorkspaceInput { name: "B".into(), ..Default::default() }).unwrap().id;
    conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
    super::test_support::file(&conn, &b, "document", "doc-b");
    super::test_support::file(&conn, "general", "folder", "folder-g");
    assert!(oracle(&conn, "m").documents.is_empty());
    set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
    assert!(oracle(&conn, "m").documents.contains("doc-b"));
    store::update_workspace(&conn, &b, WorkspacePatch { keep_separate: Some(true), ..Default::default() }).unwrap();
    assert!(oracle(&conn, "m").documents.is_empty(), "revoked at once");
    check(&conn, "m", "hand made");
    assert!(oracle(&conn, "m").folders.is_empty());
}
