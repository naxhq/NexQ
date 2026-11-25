import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFrontendLogging } from "./lib/logger";
import { registerAzureMaiSdk } from "./lib/azureMaiBridge";

// Check if this window was opened as a detached DevLog view
const params = new URLSearchParams(window.location.search);
const view = params.get("view");

installFrontendLogging();

if (import.meta.env.DEV && view === "ui-gallery") {
  // Review page for the UI kit. Dev builds only: the branch is removed from release bundles.
  import("./ui/gallery").then(({ default: UiGallery }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <UiGallery />
      </React.StrictMode>
    );
  });
} else if (view === "meeting-prompt") {
  // Meeting detection prompt: its own tiny root, none of the app's hooks
  // (global shortcuts, config sync) run in this window.
  import("./meeting-prompt/MeetingPrompt").then(({ MeetingPromptWindow }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <MeetingPromptWindow />
      </React.StrictMode>
    );
  });
} else if (view === "devlog") {
  // Render only the DevLog in this window — it subscribes to Tauri events
  // independently and reads from the shared devLogStore.
  import("./components/DevLogPanel").then(({ DevLogFullPage }) => {
    // The detached window also needs its own event subscription
    import("./hooks/useDevLog").then(({ useDevLog }) => {
      // Wrapper component that runs the useDevLog hook
      function DevLogWindow() {
        useDevLog();
        return <DevLogFullPage />;
      }
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <DevLogWindow />
        </React.StrictMode>
      );
    });
  });
} else {
  // Allow Rust to reach the launcher SDK before the user can start a meeting.
  void registerAzureMaiSdk().catch(() => console.warn("Azure MAI Streaming SDK registration failed"));
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
