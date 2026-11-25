//! Showing a file of a library folder in the file manager. A path from the
//! webview is only ever a relative name below a saved folder: it is resolved
//! (links and junctions followed) and must stay inside the folder's real root.
//! The file manager is started with an argument list, never through a shell,
//! and only ever selects the file; nothing is executed or opened.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// The real path of `sub_path` below the saved folder `root`, or why it is refused.
/// An empty `sub_path` is the folder itself.
pub fn resolve_in_folder(root: &Path, sub_path: &str) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(root).map_err(|_| "This folder can't be found".to_string())?;
    if !canonical_root.is_dir() {
        return Err("This is not a folder".to_string());
    }
    // A network drive that now leads to another machine than the one saved.
    if is_unc(&canonical_root) && !is_unc(root) {
        return Err("This folder is on a network location that is not the one saved".to_string());
    }
    let relative = clean_relative(sub_path)?;
    if relative.as_os_str().is_empty() {
        return Ok(canonical_root);
    }
    let real = std::fs::canonicalize(canonical_root.join(&relative)).map_err(|_| "This file can't be found".to_string())?;
    // Component-wise: a link or junction that leaves the folder resolves outside it.
    if !real.starts_with(&canonical_root) {
        return Err("This file is outside the folder".to_string());
    }
    Ok(real)
}

/// A relative name from the webview: only plain names. No drive, root, UNC
/// share, `..`, URL-like text or stream suffix (`:`), no control characters.
fn clean_relative(sub_path: &str) -> Result<PathBuf, String> {
    let refused = || "This path isn't allowed".to_string();
    if sub_path.chars().any(|c| c.is_control() || c == ':' || c == '|' || c == '<' || c == '>' || c == '?' || c == '*') {
        return Err(refused());
    }
    if sub_path.starts_with('\\') || sub_path.starts_with('/') || sub_path.contains("\\\\") {
        return Err(refused());
    }
    let mut out = PathBuf::new();
    for part in sub_path.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".") {
        let parts: Vec<Component<'_>> = Path::new(part).components().collect();
        // One plain name per part: no `..`, no prefix, no root.
        if parts.len() != 1 || !matches!(parts[0], Component::Normal(_)) {
            return Err(refused());
        }
        out.push(part);
    }
    Ok(out)
}

fn is_unc(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with(r"\\?\UNC\") || (text.starts_with(r"\\") && !text.starts_with(r"\\?\"))
}

/// The path as the user knows it: without the `\\?\` form Windows resolves to.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.to_string()
    }
}

/// The program and arguments that show `path` in the file manager (the file
/// selected, or the folder itself), for this operating system.
pub fn reveal_command(path: &Path) -> (PathBuf, Vec<OsString>) {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
        (PathBuf::from(root).join("explorer.exe"), windows_argv(path))
    } else if cfg!(target_os = "macos") {
        (PathBuf::from("/usr/bin/open"), mac_argv(path))
    } else {
        (PathBuf::from("xdg-open"), linux_argv(path))
    }
}

/// `explorer.exe /select,<path>`: one argument, the path whole.
pub fn windows_argv(path: &Path) -> Vec<OsString> {
    let mut arg = OsString::from("/select,");
    arg.push(display_path(path));
    vec![arg]
}

/// `open -R <path>` (reveal in Finder).
pub fn mac_argv(path: &Path) -> Vec<OsString> {
    vec![OsString::from("-R"), OsString::from("--"), path.as_os_str().to_os_string()]
}

/// `xdg-open <directory>`: the directory that holds the file.
pub fn linux_argv(path: &Path) -> Vec<OsString> {
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    vec![OsString::from("--"), dir.as_os_str().to_os_string()]
}

/// Opens `dir` itself in the file manager (a folder NexQ chose, never one from the webview).
pub fn open_directory(dir: &Path) -> Result<(), String> {
    let (program, args) = if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
        (PathBuf::from(root).join("explorer.exe"), vec![dir.as_os_str().to_os_string()])
    } else if cfg!(target_os = "macos") {
        (PathBuf::from("/usr/bin/open"), vec![OsString::from("--"), dir.as_os_str().to_os_string()])
    } else {
        (PathBuf::from("xdg-open"), vec![OsString::from("--"), dir.as_os_str().to_os_string()])
    };
    std::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

/// Starts the file manager on `path` with an argument list.
pub fn reveal(path: &Path) -> Result<(), String> {
    let (program, args) = reveal_command(path);
    std::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the file manager: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-reveal-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn a_file_below_the_folder_resolves_and_the_folder_itself_is_the_empty_path() {
        let root = tree("ok");
        std::fs::create_dir_all(root.join("notes").join("2026")).unwrap();
        std::fs::write(root.join("notes").join("2026").join("plan.md"), b"x").unwrap();
        let real = resolve_in_folder(&root, "notes/2026\\plan.md").unwrap();
        assert!(real.ends_with("plan.md"));
        assert_eq!(resolve_in_folder(&root, "./notes/").unwrap(), std::fs::canonicalize(root.join("notes")).unwrap());
        assert_eq!(resolve_in_folder(&root, "").unwrap(), std::fs::canonicalize(&root).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn traversal_absolute_unc_url_stream_and_control_paths_are_refused() {
        let root = tree("bad");
        let outside = root.with_extension("outside.txt");
        std::fs::write(&outside, b"secret").unwrap();
        std::fs::write(root.join("a.txt"), b"x").unwrap();
        let name = outside.file_name().unwrap().to_string_lossy().to_string();
        let bad = [
            format!("../{name}"),
            format!("a/../../{name}"),
            format!("..\\{name}"),
            "..".to_string(),
            "C:\\Windows\\System32\\cmd.exe".to_string(),
            "C:evil".to_string(),
            "/etc/passwd".to_string(),
            "\\Windows".to_string(),
            "\\\\server\\share\\x.txt".to_string(),
            "//server/share/x.txt".to_string(),
            "a//b".to_string().replace("//", "\\\\"),
            "http://example.com/x".to_string(),
            "file:///C:/Windows/win.ini".to_string(),
            "javascript:alert(1)".to_string(),
            "a.txt:hidden".to_string(),
            "a.txt\0.png".to_string(),
            "a.txt\n".to_string(),
            "a?.txt".to_string(),
            "*".to_string(),
        ];
        for path in bad {
            assert!(resolve_in_folder(&root, &path).is_err(), "{path:?} must be refused");
        }
        assert!(resolve_in_folder(&root, "missing.txt").is_err(), "a file that is not there");
        assert!(resolve_in_folder(&root.join("nope"), "a.txt").is_err(), "a folder that is not there");
        assert!(resolve_in_folder(&root.join("a.txt"), "").is_err(), "a root that is a file");
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_junction_or_symlink_that_leaves_the_folder_is_refused() {
        let root = tree("link");
        let elsewhere = tree("elsewhere");
        std::fs::write(elsewhere.join("secret.txt"), b"x").unwrap();
        let link = root.join("sneaky");
        assert!(link_dir(&link, &elsewhere), "the test needs a directory link");
        assert!(resolve_in_folder(&root, "sneaky/secret.txt").is_err());
        assert!(resolve_in_folder(&root, "sneaky").is_err());
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(elsewhere);
    }

    #[test]
    fn a_root_that_is_a_link_is_resolved_and_its_files_stay_inside_the_real_root() {
        let real_root = tree("realroot");
        std::fs::write(real_root.join("a.txt"), b"x").unwrap();
        let holder = tree("holder");
        let link = holder.join("vault");
        assert!(link_dir(&link, &real_root));
        let resolved = resolve_in_folder(&link, "a.txt").unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(&real_root).unwrap()));
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(real_root);
        let _ = std::fs::remove_dir_all(holder);
    }

    #[test]
    fn commas_quotes_and_spaces_in_names_resolve_and_reach_the_file_manager_as_one_argument() {
        let root = tree("names");
        let name = "Q3, plan 'final' (v2) & notes.md";
        std::fs::write(root.join(name), b"x").unwrap();
        let real = resolve_in_folder(&root, name).unwrap();
        let argv = windows_argv(&real);
        assert_eq!(argv.len(), 1, "one argument, never split at the comma or space");
        let arg = argv[0].to_string_lossy().to_string();
        assert!(arg.starts_with("/select,") && arg.ends_with(name), "{arg}");
        // The other systems pass the path whole too, after `--` so it is never read as an option.
        assert_eq!(mac_argv(&real).last().unwrap(), real.as_os_str());
        assert_eq!(mac_argv(&real)[1], OsString::from("--"));
        assert_eq!(linux_argv(&real).last().unwrap(), real.parent().unwrap().as_os_str());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_file_manager_is_started_by_absolute_path_and_the_display_path_drops_the_verbatim_prefix() {
        let (program, _) = reveal_command(Path::new("x"));
        if cfg!(windows) {
            assert!(program.is_absolute() && program.ends_with("explorer.exe"), "{program:?}");
        }
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\me\a.md")), r"C:\Users\me\a.md");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share\a.md")), r"\\srv\share\a.md");
        assert_eq!(display_path(Path::new("/home/me/a.md")), "/home/me/a.md");
    }
}
