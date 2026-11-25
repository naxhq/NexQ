//! The rules of sharing between workspaces, in one place. Scope, borrowing
//! and the settings of a workspace all ask here.

use super::types::{Workspace, GENERAL_ID};

/// `include_general` and `keep_separate` of a workspace as they may be
/// stored: a keep-separate workspace never includes General, and General
/// itself is never kept separate.
pub fn normalize_flags(id: &str, include_general: bool, keep_separate: bool) -> Result<(bool, bool), String> {
    if id == GENERAL_ID {
        if keep_separate {
            return Err("General is shared with the other workspaces, so it can't be kept separate".to_string());
        }
        return Ok((true, false));
    }
    Ok((include_general && !keep_separate, keep_separate))
}

/// Whether a meeting homed in `home` also uses General's material.
pub fn includes_general(home: &Workspace) -> bool {
    home.id != GENERAL_ID && home.include_general && !home.keep_separate
}

/// Whether `other` may be borrowed by a meeting homed in `home`: neither side
/// may be kept separate.
pub fn may_borrow(home: &Workspace, other: &Workspace) -> Result<(), String> {
    if other.id == home.id {
        return Err("A meeting already uses its own workspace".to_string());
    }
    if home.keep_separate {
        return Err(format!("\"{}\" is kept separate, so it can't use other workspaces", home.name));
    }
    if other.keep_separate {
        return Err(format!("\"{}\" is kept separate, so other workspaces can't use it", other.name));
    }
    if other.archived {
        return Err(format!("\"{}\" is archived", other.name));
    }
    Ok(())
}

/// The borrowed workspaces of `home` that may be used now: one that became
/// kept separate since is left out, and so is everything when `home` is.
pub fn usable_borrowed<'a>(home: &Workspace, borrowed: &'a [Workspace]) -> Vec<&'a Workspace> {
    if home.keep_separate {
        return Vec::new();
    }
    borrowed.iter().filter(|b| b.id != home.id && !b.keep_separate).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str, include_general: bool, keep_separate: bool) -> Workspace {
        Workspace {
            id: id.into(),
            name: id.into(),
            icon: None,
            color: None,
            description: String::new(),
            instructions: String::new(),
            include_general,
            keep_separate,
            default_scenario: None,
            recaps_with_ai: false,
            suggest_memory: false,
            brief_default: false,
            is_default: false,
            pinned: false,
            archived: false,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn keep_separate_never_includes_general() {
        assert_eq!(normalize_flags("a", true, true), Ok((false, true)));
        assert_eq!(normalize_flags("a", true, false), Ok((true, false)));
        assert_eq!(normalize_flags("general", false, false), Ok((true, false)));
        assert!(normalize_flags("general", true, true).is_err());
    }

    #[test]
    fn general_is_used_only_when_the_home_includes_it_and_is_not_separate() {
        assert!(includes_general(&ws("a", true, false)));
        assert!(!includes_general(&ws("a", false, false)));
        assert!(!includes_general(&ws("a", true, true)));
        assert!(!includes_general(&ws("general", true, false)));
    }

    #[test]
    fn borrowing_is_refused_when_either_side_is_separate() {
        let home = ws("a", false, false);
        assert!(may_borrow(&home, &ws("b", false, false)).is_ok());
        assert!(may_borrow(&home, &ws("b", false, true)).unwrap_err().contains("kept separate"));
        assert!(may_borrow(&ws("a", false, true), &ws("b", false, false)).unwrap_err().contains("kept separate"));
        assert!(may_borrow(&home, &ws("a", false, false)).is_err());
        let mut archived = ws("c", false, false);
        archived.archived = true;
        assert!(may_borrow(&home, &archived).unwrap_err().contains("archived"));
    }
}
