//! Watching the Library folders, so a file that is added, edited, renamed or
//! deleted is indexed again within seconds, with no manual scan.
//!
//! One operating-system watcher per linked folder (`notify`). Its events are
//! only a hint that a folder changed: they are debounced (a burst of saves, a
//! sync client writing many files, an editor's temporary files) and then turned
//! into one "index this folder" request for the indexer, which does the real
//! work with its usual rules (hidden and secret-looking names, the private
//! folder, size and type limits, the pause while a meeting runs). An event
//! carries no trust: nothing it names is read here.
//!
//! The indexer's periodic sweep stays as the safety net for events that never
//! come (network drives, a watch that failed to start, a watcher that was
//! overrun).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::crawler::{is_secret_like, SUPPORTED_EXTENSIONS};

/// The quiet time after the last event of a folder before it is indexed again.
pub const WATCH_DEBOUNCE: Duration = Duration::from_secs(2);
/// A folder that never goes quiet (a file saved every second) is indexed at
/// least this often.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// Which folders are being watched right now (for status and tests).
#[derive(Clone, Default)]
pub struct WatchStatus(Arc<Mutex<BTreeSet<String>>>);

impl WatchStatus {
    pub fn folders(&self) -> Vec<String> {
        self.0.lock().map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }
}

enum Ev {
    Touched(String),
    Forget(String),
    Stop,
}

struct Active {
    path: PathBuf,
    _watcher: RecommendedWatcher,
}

/// The watchers of the linked folders and the debounce that turns their events
/// into requests. Dropping it stops everything.
pub struct FolderWatchers {
    active: HashMap<String, Active>,
    /// Folders that could not be watched, and at which path (said once, not at every sweep).
    failed: HashMap<String, PathBuf>,
    status: WatchStatus,
    tx: Sender<Ev>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Whether an event path can matter to the index: not hidden, not
/// secret-looking, not in a skipped directory, not a type the index never
/// reads (a directory, which has no extension, can: its files moved or went).
fn relevant(rel: &Path, private: Option<&Path>, abs: &Path) -> bool {
    if private.is_some_and(|p| abs.starts_with(p)) {
        return false;
    }
    let mut last: Option<String> = None;
    for part in rel.components() {
        let name = part.as_os_str().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if name.starts_with('.') || is_secret_like(&name) || lower == "node_modules" || lower == "__pycache__" || name.ends_with('~') {
            return false;
        }
        last = Some(name);
    }
    match last.as_deref().and_then(|n| n.rsplit_once('.')).map(|(_, ext)| ext.to_lowercase()) {
        Some(ext) => SUPPORTED_EXTENSIONS.contains(&ext.as_str()),
        None => true,
    }
}

fn changes_content(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

impl FolderWatchers {
    /// `on_due(folder_id)` runs on the debounce thread when a folder has been
    /// quiet for `debounce` after a change.
    pub fn new(debounce: Duration, on_due: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        let (tx, rx) = mpsc::channel::<Ev>();
        let thread = std::thread::Builder::new()
            .name("nexq-folder-watch".into())
            .spawn(move || {
                // folder id -> (first change in this burst, latest change)
                let mut pending: HashMap<String, (Instant, Instant)> = HashMap::new();
                loop {
                    let now = Instant::now();
                    let next = pending
                        .values()
                        .map(|(first, last)| (*last + debounce).min(*first + MAX_WAIT))
                        .min()
                        .map(|due| due.saturating_duration_since(now))
                        .unwrap_or(Duration::from_secs(3600));
                    match rx.recv_timeout(next) {
                        Ok(Ev::Touched(id)) => {
                            let now = Instant::now();
                            pending.entry(id).and_modify(|e| e.1 = now).or_insert((now, now));
                        }
                        Ok(Ev::Forget(id)) => {
                            pending.remove(&id);
                        }
                        Ok(Ev::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    let now = Instant::now();
                    let due: Vec<String> = pending
                        .iter()
                        .filter(|(_, (first, last))| now.duration_since(*last) >= debounce || now.duration_since(*first) >= MAX_WAIT)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in due {
                        pending.remove(&id);
                        on_due(&id);
                    }
                }
            })
            .ok();
        FolderWatchers { active: HashMap::new(), failed: HashMap::new(), status: WatchStatus::default(), tx, thread }
    }

    pub fn status(&self) -> WatchStatus {
        self.status.clone()
    }

    /// Watch exactly these folders (id, path): new ones start, ones that are
    /// gone (unlinked, switched off) or whose path changed stop. A folder that
    /// can't be watched is logged and left to the periodic sweep.
    pub fn sync(&mut self, wanted: &[(String, PathBuf)]) {
        let keep: BTreeSet<&str> = wanted.iter().map(|(id, _)| id.as_str()).collect();
        self.failed.retain(|id, _| keep.contains(id.as_str()));
        let gone: Vec<String> = self.active.keys().filter(|id| !keep.contains(id.as_str())).cloned().collect();
        for id in gone {
            self.stop_one(&id);
        }
        for (id, path) in wanted {
            if self.active.get(id).is_some_and(|a| &a.path == path) || self.failed.get(id) == Some(path) && !path.is_dir() {
                continue;
            }
            self.stop_one(id);
            match self.start_one(id, path) {
                Ok(active) => {
                    self.failed.remove(id);
                    self.active.insert(id.clone(), active);
                }
                Err(e) => {
                    if self.failed.insert(id.clone(), path.clone()).as_ref() != Some(path) {
                        log::warn!("Folder {} is not watched ({e}); the periodic scan keeps it current", path.display());
                    }
                }
            }
        }
        if let Ok(mut s) = self.status.0.lock() {
            *s = self.active.keys().cloned().collect();
        }
    }

    fn stop_one(&mut self, id: &str) {
        if self.active.remove(id).is_some() {
            // dropping the watcher ends its events; a burst already waiting is not run
            let _ = self.tx.send(Ev::Forget(id.to_string()));
        }
    }

    fn start_one(&self, id: &str, path: &Path) -> Result<Active, String> {
        if !path.is_dir() {
            return Err("it is not a folder that exists".into());
        }
        let tx = self.tx.clone();
        let folder_id = id.to_string();
        let root = path.to_path_buf();
        let private = std::fs::canonicalize(crate::sources::private_files::private_dir()).ok();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(ev) = res else {
                // the watcher was overrun or lost a path: look at the whole folder
                let _ = tx.send(Ev::Touched(folder_id.clone()));
                return;
            };
            if !changes_content(&ev.kind) {
                return;
            }
            let matters = ev.paths.is_empty()
                || ev.paths.iter().any(|abs| {
                    let rel = abs.strip_prefix(&root).unwrap_or(abs);
                    relevant(rel, private.as_deref(), abs)
                });
            if matters {
                let _ = tx.send(Ev::Touched(folder_id.clone()));
            }
        })
        .map_err(|e| e.to_string())?;
        watcher.watch(path, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        Ok(Active { path: path.to_path_buf(), _watcher: watcher })
    }

    /// Stop every watcher and the debounce thread.
    pub fn stop(&mut self) {
        self.active.clear();
        if let Ok(mut s) = self.status.0.lock() {
            s.clear();
        }
        let _ = self.tx.send(Ev::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for FolderWatchers {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-watch-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_changes_the_index_could_care_about_count() {
        let root = Path::new("C:/notes");
        let r = |rel: &str| relevant(Path::new(rel), None, &root.join(rel));
        assert!(r("plan.md") && r("sub/dir/plan.TXT") && r("report.pdf") && r("a.docx"));
        assert!(r("a folder moved"), "a directory has no extension: its files moved");
        assert!(!r(".git/index") && !r("sub/.hidden/a.md") && !r(".env") && !r("node_modules/x/readme.md"));
        assert!(!r("my password list.txt") && !r("id_rsa") && !r("notes.md~") && !r("a.md.tmp") && !r("image.png"));
        // NexQ's own private folder is never a reason to index
        let private = Path::new("C:/private");
        assert!(!relevant(Path::new("a.md"), Some(private), &private.join("a.md")));
        assert!(!changes_content(&EventKind::Access(notify::event::AccessKind::Any)));
        assert!(changes_content(&EventKind::Remove(notify::event::RemoveKind::Any)));
    }

    #[test]
    fn a_burst_of_changes_is_one_request_after_the_quiet_time_and_unlinking_stops_it() {
        let dir = temp("burst");
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = hits.clone();
        let mut w = FolderWatchers::new(Duration::from_millis(250), Arc::new(move |id| {
            assert_eq!(id, "f1");
            h2.fetch_add(1, Ordering::SeqCst);
        }));
        w.sync(&[("f1".into(), dir.clone())]);
        assert_eq!(w.status().folders(), vec!["f1"]);
        // let the OS watch settle, then write several files quickly
        std::thread::sleep(Duration::from_millis(200));
        for i in 0..5 {
            fs::write(dir.join(format!("n{i}.md")), format!("note {i}")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let t = Instant::now();
        while hits.load(Ordering::SeqCst) == 0 && t.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(hits.load(Ordering::SeqCst) >= 1, "the burst was noticed");
        std::thread::sleep(Duration::from_millis(600));
        assert!(hits.load(Ordering::SeqCst) <= 2, "a burst is one request, not one per file: {}", hits.load(Ordering::SeqCst));
        // junk is not a reason
        let before = hits.load(Ordering::SeqCst);
        fs::write(dir.join("photo.png"), "x").unwrap();
        fs::write(dir.join(".secret.md"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(hits.load(Ordering::SeqCst), before, "an image and a hidden file do not count");
        // unlinked: the watcher is gone and nothing more arrives
        w.sync(&[]);
        assert!(w.status().folders().is_empty());
        fs::write(dir.join("late.md"), "late").unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(hits.load(Ordering::SeqCst), before);
        w.stop();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_that_moves_is_watched_at_its_new_path_and_a_missing_one_is_left_to_the_sweep() {
        let (a, b) = (temp("a"), temp("b"));
        let mut w = FolderWatchers::new(Duration::from_millis(100), Arc::new(|_| {}));
        w.sync(&[("f".into(), a.clone()), ("gone".into(), a.join("does-not-exist"))]);
        assert_eq!(w.status().folders(), vec!["f"], "a path that does not exist is not watched, and nothing breaks");
        w.sync(&[("f".into(), b.clone())]);
        assert_eq!(w.status().folders(), vec!["f"]);
        w.stop();
        w.stop(); // idempotent
        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
    }
}
