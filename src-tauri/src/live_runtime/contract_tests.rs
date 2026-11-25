//! Contract fixtures for live notes, the brief and memory suggestions: what the
//! webview receives (events) and sends (command arguments), written once as JSON in
//! `src/contracts/fixtures/<name>.json` and checked from both sides (see `crate::contract`).
//! `NEXQ_REWRITE_CONTRACTS=1 cargo test --lib` rewrites the event fixtures from the code.

use super::notes::{doc_to_contract, NoteEdit};
use super::settings::{merge, BriefSettings, MemorySettings, NotetakerSettings};
use super::brief::sheet_to_contract;
use super::state::{Ended, ModelLabel, MovedOnline, NotCovered, RunSnapshot};
use crate::assert_contract;
use crate::contract::read;
use serde_json::{json, Value};

fn model() -> Option<ModelLabel> {
    Some(ModelLabel { provider: "openai".into(), model: "gpt-5-nano".into(), label: "OpenAI \u{b7} gpt-5-nano (cheapest)".into() })
}

#[test]
fn event_notetaker_state() {
    let s = RunSnapshot {
        meeting_id: "m1".into(),
        status: "on",
        reason: None,
        error_kind: None,
        can: vec!["update", "pause"],
        tokens_used: 4_200,
        total_tokens: 21_000,
        cap: 120_000,
        next_in_ms: Some(30_000),
        model: model(),
        not_covered: None,
        ended: None,
        moved_online: Some(MovedOnline { from: "ollama".into(), to: "openai".into() }),
    };
    assert_contract!("notetaker_state", s);
}

/// The finished notes carry the stretch they never covered as data (not only in the reason text).
#[test]
fn event_notetaker_state_finished_with_a_range_not_covered() {
    let s = RunSnapshot {
        meeting_id: "m1".into(),
        status: "finished",
        reason: Some("Not covered: 02:00 to 40:00".into()),
        error_kind: None,
        can: vec!["update"],
        tokens_used: 4_200,
        total_tokens: 21_000,
        cap: 120_000,
        next_in_ms: None,
        model: model(),
        not_covered: Some(NotCovered { from_ms: 120_000, to_ms: 2_400_000 }),
        ended: Some(Ended { kind: "out_of_time".into(), detail: None }),
        moved_online: None,
    };
    assert_contract!("notetaker_state_finished", s);
}

#[test]
fn event_brief_state() {
    let s = RunSnapshot {
        meeting_id: "m1".into(),
        status: "paused",
        reason: Some("Usage limit reached, resets at 5pm".into()),
        error_kind: Some("plan_limit".into()),
        can: vec!["try_again"],
        tokens_used: 9_000,
        total_tokens: 40_000,
        cap: 120_000,
        next_in_ms: None,
        model: None,
        not_covered: None,
        ended: None,
        moved_online: None,
    };
    assert_contract!("brief_state", s);
}

#[test]
fn every_state_the_ui_can_get_is_in_the_contract_vocabulary() {
    let statuses = ["off", "waiting", "on", "running", "paused", "capped", "error", "finished"];
    let can = ["update", "pause", "resume", "keep_going", "try_again", "start"];
    for name in ["notetaker_state", "notetaker_state_finished", "brief_state"] {
        let v = read(name);
        assert!(statuses.contains(&v["status"].as_str().unwrap()), "{name}");
        for c in v["can"].as_array().unwrap() {
            assert!(can.contains(&c.as_str().unwrap()), "{name}: {c}");
        }
        for key in ["meeting_id", "status", "reason", "error_kind", "can", "tokens_used", "total_tokens", "cap", "next_in_ms", "model", "not_covered", "ended", "moved_online"] {
            assert!(v.get(key).is_some(), "{name} has `{key}`");
        }
    }
}

#[test]
fn event_settings_changed() {
    assert_contract!("notetaker_settings_changed", NotetakerSettings::default());
    assert_contract!("brief_settings_changed", BriefSettings::default());
    assert_contract!("memory_settings_changed", MemorySettings::default());
}

#[test]
fn event_notetaker_doc() {
    let mut d = crate::live_notes::doc::NoteDoc::new();
    let t = d.user_add(crate::live_notes::doc::BlockKind::Topic, None, "Plan", 5_000).unwrap();
    d.user_add(crate::live_notes::doc::BlockKind::Bullet, Some(&t), "Do it", 6_000).unwrap();
    let payload = json!({"meeting_id": "m1", "version": 2, "doc": doc_to_contract(&d)});
    // block ids come from the document: the fixture keeps the shape, not the ids
    let mut fixed = payload.clone();
    if let Some(blocks) = fixed["doc"]["blocks"].as_array_mut() {
        for (i, b) in blocks.iter_mut().enumerate() {
            b["id"] = json!(format!("b{i}"));
            if b["parent"].is_string() {
                b["parent"] = json!("b0");
            }
        }
    }
    assert_contract!("notetaker_doc", fixed);
}

/// Command arguments, exactly as `invoke(name, args)` passes them.
#[test]
fn command_inputs_fit_their_types() {
    let p = read("set_notetaker_settings");
    let merged: NotetakerSettings = merge(&NotetakerSettings::default(), &p["patch"]).expect("the notes patch is accepted");
    assert_eq!(merged.cap, 90_000);
    assert_eq!(merged.update_mode, "manual");
    let p = read("set_brief_settings");
    let merged: BriefSettings = merge(&BriefSettings::default(), &p["patch"]).expect("the brief patch is accepted");
    assert_eq!(merged.cap, 60_000);
    let p = read("set_memory_settings");
    let merged: MemorySettings = merge(&MemorySettings::default(), &p["patch"]).expect("the memory patch is accepted");
    assert_eq!(merged.provider.as_deref(), Some("openai"));

    // One fixture per op, each the exact arguments of one call: { meetingId, edit }.
    for (name, op) in [("save_meeting_notes_edit", "update"), ("save_meeting_notes_edit_add", "add"), ("save_meeting_notes_edit_delete", "delete")] {
        let e = read(name);
        assert!(e["meetingId"].is_string(), "{name}");
        assert_eq!(e["edit"]["op"], op, "{name}");
        let _: NoteEdit = serde_json::from_value(e["edit"].clone()).unwrap_or_else(|err| panic!("{name}: edit does not fit: {err}"));
    }
    for name in ["get_notetaker_state", "get_brief_state", "notetaker_pause", "notetaker_resume", "brief_pause", "brief_resume", "notetaker_dismiss_moved", "brief_dismiss_moved"] {
        assert_eq!(read(name)["meetingId"], "m1", "{name}");
    }
    assert_eq!(read("get_automatic_model")["provider"], Value::Null);
}

/// What the webview sends to create a memory item by hand carries no `unsupported`.
#[test]
fn a_hand_written_memory_item_fits_without_unsupported() {
    let c: crate::workspace::types::MemoryCreate = serde_json::from_value(read("create_memory_by_hand")["input"].clone()).unwrap();
    assert!(!c.unsupported);
    assert_eq!(c.status.as_deref(), Some("saved"));
}

#[test]
fn getter_documents_and_the_brief_sheet_event() {
    use crate::live_brief::sheet::{Fact, Sheet};
    let sheet = Sheet {
        now: "Acme pricing".into(),
        facts: vec![Fact { text: "Acme pays 12 dollars per seat".into(), source: "P1".into(), source_id: "document:d1#3".into(), source_title: "Pricing.pdf".into(), source_ms: None }],
        earlier: vec!["Intro done".into()],
    };
    let one = sheet_to_contract(&sheet, 1_700_000_000_000);
    assert_contract!("brief_sheet", json!({"meeting_id": "m1", "sheet": one}));
    // `get_meeting_brief` returns the sheet itself
    assert_contract!("get_meeting_brief", one);
    let mut d = crate::live_notes::doc::NoteDoc::new();
    d.user_add(crate::live_notes::doc::BlockKind::Topic, None, "Plan", 5_000).unwrap();
    let mut v = doc_to_contract(&d);
    v["blocks"][0]["id"] = json!("b0");
    assert_contract!("get_meeting_notes", v);
}
