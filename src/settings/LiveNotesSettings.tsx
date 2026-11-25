import { useEffect } from "react";
import { useLiveNotesStore, DEFAULT_NOTETAKER_SETTINGS } from "../stores/liveNotesStore";
import { useLiveBriefStore, DEFAULT_BRIEF_SETTINGS } from "../stores/liveBriefStore";
import { getBriefSettings, getNotetakerSettings } from "../lib/ipc";
import { NotesSettingsForm } from "../live-notes/NotesSettingsForm";
import { BriefSettingsForm } from "../live-brief/BriefSettingsForm";

/** Settings for the two meeting helpers that run beside live answers. */
export function LiveNotesSettings() {
  const notes = useLiveNotesStore((s) => s.settings);
  const brief = useLiveBriefStore((s) => s.settings);

  useEffect(() => {
    let alive = true;
    void getNotetakerSettings()
      .then((s) => alive && useLiveNotesStore.setState({ settings: s }))
      .catch(() => alive && useLiveNotesStore.setState((c) => ({ settings: c.settings ?? DEFAULT_NOTETAKER_SETTINGS })));
    void getBriefSettings()
      .then((s) => alive && useLiveBriefStore.setState({ settings: s }))
      .catch(() => alive && useLiveBriefStore.setState((c) => ({ settings: c.settings ?? DEFAULT_BRIEF_SETTINGS })));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="ls-notes" className="flex flex-col gap-3">
        <div>
          <h2 id="ls-notes" className="ui-dialog-title">Live notes</h2>
          <p className="ui-body text-muted-foreground">A tidy page of topics, decisions, tasks and questions, written while you talk.</p>
        </div>
        {notes && <NotesSettingsForm settings={notes} onChange={(p) => void useLiveNotesStore.getState().patchSettings(p)} />}
      </section>
      <section aria-labelledby="ls-brief" className="flex flex-col gap-3">
        <div>
          <h2 id="ls-brief" className="ui-dialog-title">Brief</h2>
          <p className="ui-body text-muted-foreground">A short sheet of what the workspace knows about the topic, kept fresh for live answers.</p>
        </div>
        {brief && <BriefSettingsForm settings={brief} onChange={(p) => void useLiveBriefStore.getState().patchSettings(p)} />}
      </section>
    </div>
  );
}
