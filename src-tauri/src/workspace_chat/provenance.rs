//! What an answer rests on. Every assistant message is stored with a
//! provenance record: everything the run could use (the sources of its prompt,
//! the saved memory it carried, and for a CLI chat also the folders, servers
//! and meeting transcripts its session could reach) plus, transitively, the
//! provenance of every earlier answer it was sent and of what the condensed
//! history covers. The record is separate from the bars the UI draws, which
//! can be redacted.
//!
//! One function, [`allowed`], decides against the chat's current scope whether
//! a record may still be used. The live guard and the check on stored answers
//! both call it, so they cannot drift. It fails closed: a kind this build
//! does not know, a missing record and an unreadable scope are all "not allowed".

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::scope_adapter::ChatScope;
use crate::workspace_search::store::sha_hex;

/// Most entries kept per record; beyond it the record keeps one digest of the
/// scope instead (any change of what the chat may use then makes it unusable).
pub const MAX_ENTRIES: usize = 1500;
/// The record format.
pub const VERSION: u8 = 1;

/// Every kind a run can draw on. `instructions` and `conversation` carry no
/// access of their own (instructions are the workspace's own text, the history
/// is covered through its own records).
const KINDS: &[&str] = &["meeting", "document", "folder", "launch_folder", "talking_point", "server", "memory"];
const NO_ACCESS_KINDS: &[&str] = &["instructions", "conversation"];

fn key(kind: &str, id: &str) -> String {
    sha_hex(format!("{kind}\u{1}{id}").as_bytes())[..10].to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capped {
    pub count: usize,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    pub v: u8,
    /// Things this build could not classify: the record is never allowed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bad: Vec<String>,
    /// Sorted, hashed `kind:id` entries.
    #[serde(default)]
    pub ids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capped: Option<Capped>,
}

impl Default for Provenance {
    fn default() -> Self {
        Provenance { v: VERSION, bad: Vec::new(), ids: BTreeSet::new(), capped: None }
    }
}

impl Provenance {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one source. Kinds with no access of their own are skipped; a
    /// kind that is not on the list, or an empty id, poisons the record.
    pub fn add(&mut self, kind: &str, id: &str) {
        let kind = match kind {
            "transcript" | "summary" | "notes" | "card" => "meeting",
            "folder_file" | "folder_passage" => "folder",
            "tool" => "server",
            other => other,
        };
        if NO_ACCESS_KINDS.contains(&kind) {
            return;
        }
        if !KINDS.contains(&kind) {
            self.bad.push(format!("kind:{kind}"));
        } else if id.is_empty() {
            self.bad.push(format!("{kind}:empty"));
        } else {
            self.ids.insert(key(kind, id));
        }
    }

    /// Everything `other` rested on, too (history, condensed text).
    pub fn merge(&mut self, other: &Provenance) {
        self.ids.extend(other.ids.iter().cloned());
        self.bad.extend(other.bad.iter().cloned());
        if other.v != VERSION {
            self.bad.push(format!("version:{}", other.v));
        }
        if other.capped.is_some() {
            self.capped = other.capped.clone();
        }
    }

    /// Keeps the record small: past [`MAX_ENTRIES`] (or when a merged record
    /// was already capped) it is replaced by a digest of the scope at this moment.
    pub fn seal(&mut self, universe: &Universe) {
        if self.capped.is_some() || self.ids.len() > MAX_ENTRIES {
            self.ids.clear();
            self.capped = Some(universe.digest());
        }
    }
}

/// Everything the chat may use right now, as hashed entries.
#[derive(Debug, Clone, Default)]
pub struct Universe {
    set: BTreeSet<String>,
}

impl Universe {
    /// `memory_ids`: the saved memory items the scope may use now.
    pub fn of(scope: &ChatScope, memory_ids: impl IntoIterator<Item = String>) -> Universe {
        let mut set = BTreeSet::new();
        for m in &scope.meetings {
            set.insert(key("meeting", &m.id));
        }
        for d in &scope.eff.document_ids {
            set.insert(key("document", d));
        }
        // indexed folders: opted in and in the scope; launch folders: in the scope
        for f in &scope.folder_ids {
            set.insert(key("folder", f));
        }
        for f in &scope.eff.folder_ids {
            set.insert(key("launch_folder", f));
        }
        for t in &scope.eff.talking_point_ids {
            set.insert(key("talking_point", t));
        }
        for s in &scope.eff.server_ids {
            set.insert(key("server", s));
        }
        for m in memory_ids {
            set.insert(key("memory", &m));
        }
        Universe { set }
    }

    pub fn digest(&self) -> Capped {
        let joined = self.set.iter().cloned().collect::<Vec<_>>().join(",");
        Capped { count: self.set.len(), digest: sha_hex(joined.as_bytes()) }
    }
}

/// Whether everything a record rests on is still part of the chat's scope.
pub fn allowed(p: &Provenance, now: &Universe) -> bool {
    if p.v != VERSION || !p.bad.is_empty() {
        return false;
    }
    match &p.capped {
        Some(c) => *c == now.digest(),
        None => p.ids.is_subset(&now.set),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_kinds_empty_ids_and_other_versions_are_never_allowed() {
        let u = Universe::default();
        let mut p = Provenance::new();
        assert!(allowed(&p, &u), "nothing used: nothing to lose");
        p.add("instructions", "");
        p.add("conversation", "");
        assert!(allowed(&p, &u), "kinds with no access of their own are fine");
        let mut q = Provenance::new();
        q.add("hologram", "x");
        assert!(!allowed(&q, &u));
        let mut q = Provenance::new();
        q.add("meeting", "");
        assert!(!allowed(&q, &u));
        let mut q = Provenance::new();
        q.v = 9;
        assert!(!allowed(&q, &u));
        let mut merged = Provenance::new();
        merged.merge(&q);
        assert!(!allowed(&merged, &u), "a record from another format poisons what includes it");
    }

    #[test]
    fn aliases_map_to_the_kinds_they_are_checked_as() {
        let mut p = Provenance::new();
        p.add("transcript", "m1");
        p.add("summary", "m1");
        p.add("notes", "m1");
        p.add("card", "m1");
        p.add("tool", "s1");
        assert_eq!(p.ids.len(), 2);
        assert!(p.ids.contains(&key("meeting", "m1")) && p.ids.contains(&key("server", "s1")));
    }

    #[test]
    fn a_big_record_is_replaced_by_a_digest_and_follows_the_whole_scope() {
        let mut p = Provenance::new();
        for i in 0..(MAX_ENTRIES + 5) {
            p.add("meeting", &format!("m{i}"));
        }
        let mut set = Universe::default();
        for i in 0..(MAX_ENTRIES + 5) {
            set.set.insert(key("meeting", &format!("m{i}")));
        }
        p.seal(&set);
        assert!(p.ids.is_empty() && p.capped.is_some());
        assert!(allowed(&p, &set));
        set.set.insert(key("meeting", "new"));
        assert!(!allowed(&p, &set), "fails closed on any change");
        // the size stays small
        assert!(serde_json::to_string(&p).unwrap().len() < 200);
        // a capped record stays capped when merged
        let mut next = Provenance::new();
        next.add("meeting", "m1");
        next.merge(&p);
        next.seal(&set);
        assert!(next.capped.is_some());
    }

    #[test]
    fn a_normal_record_is_small() {
        let mut p = Provenance::new();
        for i in 0..500 {
            p.add("meeting", &format!("{}-{i}", uuid::Uuid::new_v4()));
        }
        assert!(serde_json::to_string(&p).unwrap().len() < 7_000);
    }
}
