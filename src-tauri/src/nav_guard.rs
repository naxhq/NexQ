//! Keeps both windows on the app's own pages. An answer, a note or a tool
//! result can carry a link; a click on one must never turn a window into a web
//! page that runs inside NexQ (with its IPC bridge). Links open in the system
//! browser, after the user confirms the address (`answerMarkdown`).

use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use url::Url;

/// Whether a window may go to `target`. The app's pages live on
/// `tauri.localhost` (`tauri://` on other systems); `dev_url` is the dev
/// server in `tauri dev`. `about:blank` is how a page starts.
pub fn navigation_allowed(target: &Url, dev_url: Option<&Url>) -> bool {
    match target.scheme() {
        "tauri" => true,
        "about" => target.as_str() == "about:blank",
        "http" | "https" => {
            target.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|dev| {
                    target.scheme() == dev.scheme()
                        && target.host_str() == dev.host_str()
                        && target.port_or_known_default() == dev.port_or_known_default()
                })
        }
        _ => false,
    }
}

/// The plugin that applies [`navigation_allowed`] to every window.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("nexq-nav-guard")
        .on_navigation(|webview, url| {
            use tauri::Manager;
            let dev = webview.app_handle().config().build.dev_url.clone();
            let allowed = navigation_allowed(url, dev.as_ref());
            if !allowed {
                log::warn!("blocked navigation of a window to {}", url.origin().ascii_serialization());
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_apps_own_pages_are_allowed() {
        let dev = u("http://localhost:5173");
        for ok in ["http://tauri.localhost/index.html?window=overlay", "https://tauri.localhost/", "tauri://localhost/", "about:blank", "http://localhost:5173/index.html"] {
            assert!(navigation_allowed(&u(ok), Some(&dev)), "{ok}");
        }
        for bad in [
            "https://example.com/",
            "http://localhost:9999/",
            "http://tauri.localhost.evil.com/",
            "https://evil.com/tauri.localhost",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "about:srcdoc",
            "ftp://tauri.localhost/",
        ] {
            assert!(!navigation_allowed(&u(bad), Some(&dev)), "{bad}");
        }
        // Without a dev server (a release build) the dev address is not special.
        assert!(!navigation_allowed(&u("http://localhost:5173/"), None));
    }
}
