import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * Slots other parts of the app fill. Each is found by file name when it exists,
 * so this screen builds and runs with or without them (an absent slot renders
 * nothing). To fill one, add the file with a named export of the same name;
 * props are `{ workspaceId }`. The component draws its own heading.
 *
 *   src/memory/MemorySection.tsx                       export function MemorySection
 *   src/talking-points/TalkingPointsSection.tsx        export function TalkingPointsSection
 *   src/talking-points/TalkingPointsEditor.tsx         export function TalkingPointsEditor
 *
 * (Any sub folder works: `src/talking-points/editor/TalkingPointsEditor.tsx`.)
 */
export interface WorkspaceSlotProps {
  workspaceId: string;
}

type Loader = () => Promise<Record<string, unknown>>;

function emptySlot(): ComponentType<WorkspaceSlotProps> {
  return () => null;
}

function slot(loaders: Loader[], name: string): LazyExoticComponent<ComponentType<WorkspaceSlotProps>> {
  return lazy(async () => {
    const load = loaders[0];
    if (!load) return { default: emptySlot() };
    try {
      const mod = await load();
      const found = (mod[name] ?? mod.default) as ComponentType<WorkspaceSlotProps> | undefined;
      return { default: found ?? emptySlot() };
    } catch (e) {
      console.warn(`[workspace] The ${name} slot failed to load:`, e);
      return { default: emptySlot() };
    }
  });
}

const memoryFiles = import.meta.glob<Record<string, unknown>>("../memory/**/MemorySection.tsx");
const pointSectionFiles = import.meta.glob<Record<string, unknown>>("../talking-points/**/TalkingPointsSection.tsx");
const pointEditorFiles = import.meta.glob<Record<string, unknown>>("../talking-points/**/TalkingPointsEditor.tsx");

export const MemorySection = slot(Object.values(memoryFiles), "MemorySection");
/** The talking points list of the workspace (the editor opens from it). */
export const TalkingPointsSection = slot(Object.values(pointSectionFiles), "TalkingPointsSection");
/** The editor itself, for a place that wants to open a note directly; absent until it exists. */
export const TalkingPointsEditor = slot(Object.values(pointEditorFiles), "TalkingPointsEditor");

/** Whether each slot has a file (for tests and for hiding an empty section's frame). */
export const slotAvailability = {
  memory: Object.keys(memoryFiles).length > 0,
  talkingPoints: Object.keys(pointSectionFiles).length > 0,
  talkingPointsEditor: Object.keys(pointEditorFiles).length > 0,
};
