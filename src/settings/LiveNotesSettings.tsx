import { useEffect } from "react";
import { useLiveNotesStore } from "../stores/liveNotesStore";
import { useLiveBriefStore } from "../stores/liveBriefStore";
import { NotesSettingsForm } from "../live-notes/NotesSettingsForm";
import { BriefSettingsForm } from "../live-brief/BriefSettingsForm";

/** Settings for the two meeting helpers that run beside live answers. */
export function LiveNotesSettings() {
  const notes = useLiveNotesStore((s) => s.settings);
  const brief = useLiveBriefStore((s) => s.settings);

  useEffect(() => {
    const offs: Array<() => void> = [];
    let gone = false;
    const keep = (p: Promise<() => void>) => void p.then((u) => (gone ? u() : offs.push(u))).catch(() => {});
    keep(useLiveNotesStore.getState().watchSettings());
    keep(useLiveBriefStore.getState().watchSettings());
    return () => {
      gone = true;
      offs.forEach((u) => u());
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
          <p className="ui-body text-muted-foreground">A short sheet of what the workspace knows about the topic, kept fresh for live answers. Turn it on per workspace from the Brief panel.</p>
        </div>
        {brief && <BriefSettingsForm settings={brief} onChange={(p) => void useLiveBriefStore.getState().patchSettings(p)} />}
      </section>
    </div>
  );
}
