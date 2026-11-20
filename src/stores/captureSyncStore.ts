// What the audio capture last settled on, so Web Speech (which listens to the OS
// default microphone) starts after Rust has applied the matching default-mic override.

import { create } from "zustand";

interface CaptureSyncState {
  /** `overrideKey` of the config the capture last finished starting with; null when nothing syncs it. */
  settledOverrideKey: string | null;
  setSettledOverrideKey: (key: string | null) => void;
}

export const useCaptureSyncStore = create<CaptureSyncState>((set) => ({
  settledOverrideKey: null,
  setSettledOverrideKey: (key) => set({ settledOverrideKey: key }),
}));
