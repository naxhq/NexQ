//! Reading a file once, without following links, from a handle that is
//! checked after it is open (no gap between "is it safe" and "read it").
//!
//! Windows: opened with `FILE_FLAG_OPEN_REPARSE_POINT`, so a symbolic link or
//! junction opens as the link itself and is refused; the handle's final path
//! (`GetFinalPathNameByHandleW`) must lie inside the canonical root, which also
//! catches a parent folder swapped for a junction after the crawl. Unix:
//! `O_NOFOLLOW` plus the canonical path of the opened descriptor where the OS
//! offers one. The size is checked on the handle and the read is bounded.

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug)]
pub struct ReadFile {
    pub bytes: Vec<u8>,
    pub size: u64,
}

fn open_nofollow(path: &Path) -> std::io::Result<File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        // share read, write and delete so a file being saved is not blocked
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).share_mode(7);
    }
    #[cfg(all(unix, target_os = "linux"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0o400000); // O_NOFOLLOW
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0x100); // O_NOFOLLOW (macOS, BSD)
    }
    opts.open(path)
}

#[cfg(windows)]
fn final_path(file: &File) -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
    let handle = HANDLE(file.as_raw_handle());
    let mut buf = vec![0u16; 32_768];
    let n = unsafe { GetFinalPathNameByHandleW(handle, &mut buf, FILE_NAME_NORMALIZED) } as usize;
    if n == 0 || n > buf.len() {
        return Err("could not resolve the file's location".into());
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
}

#[cfg(target_os = "linux")]
fn final_path(file: &File) -> Result<std::path::PathBuf, String> {
    use std::os::unix::io::AsRawFd;
    std::fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "could not resolve the file's location".to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn final_path(_file: &File) -> Result<std::path::PathBuf, String> {
    Err("no descriptor path".into())
}

/// Read `path` if it is a regular file of at most `max` bytes that really
/// lives inside `canon_root`, without ever following a link.
pub fn read_confined(path: &Path, canon_root: &Path, max: u64) -> Result<ReadFile, String> {
    let file = open_nofollow(path).map_err(|e| format!("not readable ({:?})", e.kind()))?;
    let md = file.metadata().map_err(|e| format!("not readable ({:?})", e.kind()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & 0x400 != 0 {
            return Err("link or junction; not followed".into());
        }
    }
    if !md.is_file() {
        return Err("not a regular file".into());
    }
    if md.len() > max {
        return Err("over 2 MB".into());
    }
    match final_path(&file) {
        Ok(real) => {
            if !real.starts_with(canon_root) {
                return Err("resolves outside the folder".into());
            }
        }
        Err(e) => match std::fs::canonicalize(path) {
            Ok(c) if c.starts_with(canon_root) => {}
            _ => return Err(e),
        },
    }
    let mut bytes = Vec::with_capacity(md.len().min(max) as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("not readable ({:?})", e.kind()))?;
    if bytes.len() as u64 > max {
        return Err("over 2 MB".into());
    }
    Ok(ReadFile { size: bytes.len() as u64, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::test_support::temp_dir;
    use std::fs;

    #[test]
    fn reads_a_file_inside_the_root() {
        let root = temp_dir("so1");
        fs::write(root.join("a.txt"), "hello").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        let r = read_confined(&canon.join("a.txt"), &canon, 100).unwrap();
        assert_eq!(r.bytes, b"hello");
        assert!(read_confined(&canon.join("a.txt"), &canon, 3).unwrap_err().contains("over"));
        assert!(read_confined(&canon.join("missing.txt"), &canon, 100).is_err());
        assert!(read_confined(&canon, &canon, 100).is_err(), "a folder is not a file");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_file_outside_the_root_is_refused() {
        let root = temp_dir("so2");
        let other = temp_dir("so2b");
        fs::write(other.join("leak.txt"), "CANARY").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        let err = read_confined(&fs::canonicalize(&other).unwrap().join("leak.txt"), &canon, 100).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&other).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_swapped_in_after_the_crawl_is_not_followed() {
        let root = temp_dir("so3");
        let outside = temp_dir("so3b");
        fs::write(outside.join("leak.md"), "OUTSIDE CANARY").unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "inside").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        let victim = canon.join("notes").join("a.md");
        assert!(read_confined(&victim, &canon, 100).is_ok());
        // between crawl and read: the folder becomes a junction to somewhere else
        fs::remove_dir_all(root.join("notes")).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("notes"))
            .arg(&outside)
            .output();
        if made.map(|o| o.status.success()).unwrap_or(false) {
            fs::write(outside.join("a.md"), "OUTSIDE CANARY").unwrap();
            let err = read_confined(&victim, &canon, 100).unwrap_err();
            assert!(err.contains("outside") || err.contains("link"), "{err}");
            let _ = fs::remove_dir(root.join("notes"));
        }
        assert!(outside.join("leak.md").exists());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_symlink_file_is_opened_as_the_link_and_refused() {
        let root = temp_dir("so4");
        let outside = temp_dir("so4b");
        fs::write(outside.join("leak.md"), "OUTSIDE CANARY").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        if std::os::windows::fs::symlink_file(outside.join("leak.md"), root.join("l.md")).is_ok() {
            let r = read_confined(&canon.join("l.md"), &canon, 100);
            assert!(r.is_err(), "{r:?}");
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
