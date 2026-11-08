import {
  Github,
  FileText,
  AlertCircle,
  HelpCircle,
  FolderOpen,
  Copy,
  Check,
} from "lucide-react";
import { NEXQ_VERSION, NEXQ_BUILD_DATE, NEXQ_DEVELOPER } from "../lib/version";
import { useEffect, useState } from "react";
import { getLogInfo, getRecentLogs, openLogFolder, setVerboseLogging } from "../lib/ipc";
import type { LogInfo } from "../lib/types";
import { persistValue } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import {
  checkForUpdates,
  downloadUpdateNow,
  hydrateUpdater,
  openUpdateDialog,
  setAutoUpdate,
  skipVersion,
} from "../hooks/useUpdater";
import { open } from "@tauri-apps/plugin-shell";

const GITHUB_URL = "https://github.com/naxhq/NexQ";

function timeSince(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function formatBuildDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/** The app log: where it is, a copy of its end for bug reports, verbose mode. */
function Diagnostics() {
  const [info, setInfo] = useState<LogInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getLogInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const copyRecent = async () => {
    try {
      await navigator.clipboard.writeText(await getRecentLogs(400));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showToast(`Couldn't copy the log: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const toggleVerbose = async () => {
    if (!info) return;
    const verbose = !info.verbose;
    await setVerboseLogging(verbose);
    persistValue("verboseLogging", verbose);
    setInfo({ ...info, verbose });
  };

  const openFolder = () =>
    openLogFolder().catch((err) => showToast(String(err), "error"));

  const buttonClass =
    "inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary disabled:opacity-50";

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
      <div>
        <p className="text-sm font-medium text-foreground">Diagnostics</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          NexQ keeps a log on this computer to help diagnose problems. API keys are removed
          automatically; attach it when you report an issue.
        </p>
        {info && (
          <p className="mt-2 truncate font-mono text-meta text-muted-foreground/60" title={info.file}>
            {info.file}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={openFolder} disabled={!info} className={buttonClass}>
          <FolderOpen className="h-3.5 w-3.5" />
          Open log folder
        </button>
        <button onClick={copyRecent} disabled={!info} className={buttonClass}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy recent log"}
        </button>
      </div>

      <div className="h-px bg-border/20" />

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-foreground">Verbose logging</label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Records more detail while you reproduce a problem. Turn it off afterwards.
          </p>
        </div>
        <button
          onClick={toggleVerbose}
          disabled={!info}
          role="switch"
          aria-checked={!!info?.verbose}
          aria-label="Toggle verbose logging"
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:opacity-50 ${
            info?.verbose ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              info?.verbose ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

export function AboutSettings() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const autoUpdate = useUpdaterStore((s) => s.autoUpdate);
  const skippedVersion = useUpdaterStore((s) => s.skippedVersion);

  // The update loop lives in the launcher; this page may open in either window.
  useEffect(() => {
    hydrateUpdater();
  }, []);

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  let dotClass = "bg-success";
  let title = "You're up to date";
  let detail = lastChecked ? `Last checked ${timeSince(lastChecked)}` : "Not checked yet";
  let action: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean } | null = {
    label: "Check for updates",
    onClick: () => checkForUpdates({ manual: true }),
  };

  if (phase === "checking") {
    dotClass = "animate-pulse bg-warning";
    title = "Checking for updates…";
    detail = "Connecting to GitHub";
    action = { ...action, disabled: true };
  } else if (phase === "downloading") {
    dotClass = "animate-pulse bg-warning";
    title = version ? `Downloading v${version}` : "Downloading update";
    detail = pct !== null ? `${pct}%` : "In the background";
    action = null;
  } else if (phase === "ready" && version) {
    dotClass = "bg-primary";
    title = `v${version} ready to install`;
    detail = autoUpdate ? "Installs when you quit NexQ" : "Open it to install";
    action = { label: "What's new", onClick: () => openUpdateDialog(), primary: true };
  } else if (phase === "error") {
    dotClass = "bg-destructive";
    title = version ? "Download failed" : "Update check failed";
    detail = error ?? "Unknown error";
    if (version) action = { label: "Retry", onClick: () => downloadUpdateNow({ explicit: true }) };
  } else if (version) {
    dotClass = "bg-primary";
    title = `v${version} available`;
    detail = "Automatic updates are off";
    action = { label: "Download", onClick: () => downloadUpdateNow({ explicit: true }), primary: true };
  }

  const canSkip =
    !!version && phase !== "checking" && phase !== "downloading" && skippedVersion !== version;

  return (
    <div className="space-y-6">
      {/* App Identity Card */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-6">
        <div className="flex items-start gap-5">
          <img src="/nexq-icon.png" alt="NexQ" className="h-14 w-14 shrink-0 rounded-2xl" />
          <div>
            <h3 className="text-lg font-bold text-foreground">NexQ</h3>
            <p className="text-xs text-muted-foreground">
              v{NEXQ_VERSION}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              AI Meeting Assistant &amp; Real-Time Interview Copilot
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                Tauri 2
              </span>
              <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                React + Rust
              </span>
              <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                Windows x64
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Meta Grid (2x2) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">Build Date</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {formatBuildDate(NEXQ_BUILD_DATE)}
          </p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">Developer</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {NEXQ_DEVELOPER}
          </p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">Architecture</p>
          <p className="mt-1 text-sm font-medium text-foreground">x86_64</p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">License</p>
          <p className="mt-1 text-sm font-medium text-foreground">MIT</p>
        </div>
      </div>

      {/* Updates */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="truncate text-meta text-muted-foreground/60">{detail}</p>
            </div>
          </div>

          {action && (
            <button
              onClick={action.onClick}
              disabled={action.disabled}
              className={
                action.primary
                  ? "shrink-0 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  : "shrink-0 rounded-lg border border-border/40 bg-secondary/50 px-4 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary disabled:opacity-50"
              }
            >
              {action.label}
            </button>
          )}
        </div>

        {canSkip && version && (
          <button
            onClick={() => skipVersion(version)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip this version
          </button>
        )}

        <div className="h-px bg-border/20" />

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Automatic updates</label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Download in the background and install when you quit
            </p>
          </div>
          <button
            onClick={() => setAutoUpdate(!autoUpdate)}
            role="switch"
            aria-checked={autoUpdate}
            aria-label="Toggle automatic updates"
            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
              autoUpdate ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
                autoUpdate ? "translate-x-5 scale-[1.05]" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <Diagnostics />

      {/* Quick Links Row */}
      <div className="grid grid-cols-4 gap-3">
        <button
          onClick={() => open(GITHUB_URL)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <Github className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            GitHub
          </span>
        </button>
        <button
          onClick={() => open(`${GITHUB_URL}/blob/main/CHANGELOG.md`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            Changelog
          </span>
        </button>
        <button
          onClick={() => open(`${GITHUB_URL}/issues/new/choose`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            Report Issue
          </span>
        </button>
        <button
          onClick={() => open(`${GITHUB_URL}/wiki`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            Documentation
          </span>
        </button>
      </div>

      {/* Footer */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <p className="text-xs text-muted-foreground/60 leading-relaxed">
          NexQ is an open desktop application. All processing can run locally
          with Ollama or LM Studio, or optionally connect to cloud AI providers.
        </p>
      </div>
    </div>
  );
}
