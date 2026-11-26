import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type {
  EnvVar,
  McpCheckStatus,
  McpServer,
  McpTool,
  McpTransport,
  NotesFolder,
  PersonalSourcesConfig,
  SourceToggles,
} from "../lib/types";
import { repairPersonalSources, setPersonalSources, type SourcesFiling } from "../lib/ipc";

// Same plugin-store file as `configStore`, so the launcher and the overlay see
// each other's changes through `onKeyChange`.
const STORE_FILE = "config.json";
const CONFIG_KEY = "personalSources";
/** Saved by older versions as `{ notes, tools }` (the pills were global); now only read, as the default of a new meeting. */
const TOGGLES_KEY = "sourceToggles";

export const DEFAULT_SOURCES_CONFIG: PersonalSourcesConfig = {
  notes_folders: [],
  mcp_servers: [],
  mcp_notice_seen: false,
};

/** Both pills start on in every meeting. */
/** Knowledge is on (documents were always used); Tools start nothing until the person turns them on, as in 2.45. */
export const DEFAULT_SOURCE_TOGGLES: SourceToggles = { library: true, tools: false };

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

// ── Normalizing what was saved (older shapes, hand edits, damage) ──

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function normalizeFolder(raw: unknown): NotesFolder | null {
  if (!isObject(raw)) return null;
  const path = str(raw.path);
  const id = str(raw.id);
  if (!path || !id) return null;
  return { id, label: str(raw.label) || path, path, enabled: raw.enabled === true };
}

function normalizeTransport(raw: unknown): McpTransport | null {
  if (!isObject(raw)) return null;
  if (raw.type === "stdio" && typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    return { type: "stdio", command: raw.command, args };
  }
  if (raw.type === "http" && typeof raw.url === "string") {
    const names = Array.isArray(raw.header_names)
      ? raw.header_names.filter((a): a is string => typeof a === "string")
      : [];
    return { type: "http", url: raw.url, header_names: names };
  }
  return null;
}

function normalizeEnv(raw: unknown): EnvVar[] {
  if (!Array.isArray(raw)) return [];
  const out: EnvVar[] = [];
  for (const e of raw) {
    if (!isObject(e) || typeof e.name !== "string" || !e.name) continue;
    const secret = e.secret === true;
    // A secret never has a value here, whatever was saved.
    out.push({ name: e.name, secret, value: secret ? null : typeof e.value === "string" ? e.value : "" });
  }
  return out;
}

function normalizeTools(raw: unknown): McpTool[] {
  if (!Array.isArray(raw)) return [];
  const out: McpTool[] = [];
  for (const t of raw) {
    if (!isObject(t) || typeof t.name !== "string" || !t.name) continue;
    out.push({ name: t.name, full_name: str(t.full_name), allowed: t.allowed === true });
  }
  return out;
}

function normalizeCheck(raw: unknown): McpCheckStatus | null {
  if (!isObject(raw)) return null;
  return {
    ok: raw.ok === true,
    tool_count: typeof raw.tool_count === "number" ? raw.tool_count : 0,
    error: typeof raw.error === "string" ? raw.error : null,
    checked_at_ms: typeof raw.checked_at_ms === "number" ? raw.checked_at_ms : 0,
  };
}

function normalizeServer(raw: unknown): McpServer | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const key = str(raw.key);
  const transport = normalizeTransport(raw.transport);
  if (!id || !key || !transport) return null;
  return {
    id,
    key,
    label: str(raw.label) || key,
    transport,
    enabled: raw.enabled === true,
    env: normalizeEnv(raw.env),
    tools: normalizeTools(raw.tools),
    last_check: normalizeCheck(raw.last_check),
    needs_sign_in: raw.needs_sign_in === true,
  };
}

/** Saved sources with every missing field filled in; a damaged entry is dropped, never a crash. */
export function normalizeSourcesConfig(raw: unknown): PersonalSourcesConfig {
  if (!isObject(raw)) return { ...DEFAULT_SOURCES_CONFIG, notes_folders: [], mcp_servers: [] };
  const folders = Array.isArray(raw.notes_folders) ? raw.notes_folders : [];
  const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  return {
    notes_folders: folders.map(normalizeFolder).filter((f): f is NotesFolder => f !== null),
    mcp_servers: servers.map(normalizeServer).filter((s): s is McpServer => s !== null),
    mcp_notice_seen: raw.mcp_notice_seen === true,
  };
}

/**
 * The pills a meeting starts with, from what an older version saved. `notes` is the old name of
 * the Knowledge pill (`library`); anything not understood, or never saved, is Knowledge on and Tools off.
 */
export function normalizeToggles(raw: unknown): SourceToggles {
  if (!isObject(raw)) return { ...DEFAULT_SOURCE_TOGGLES };
  // An old `notes: false` turned off folders only (documents were always used), so it never turns Knowledge off.
  const knowledge = typeof raw.library === "boolean" ? raw.library : true;
  return { library: knowledge, tools: raw.tools === true };
}

/** Which kinds of source have something an answer could use right now. */
export function enabledKinds(c: PersonalSourcesConfig): { notes: boolean; tools: boolean } {
  return {
    notes: c.notes_folders.some((f) => f.enabled),
    tools: c.mcp_servers.some((s) => s.enabled && !s.needs_sign_in && s.tools.some((t) => t.allowed)),
  };
}

/** Same value, same text, whatever order its keys come back in. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

// ── Store ──

interface SourcesState {
  config: PersonalSourcesConfig;
  /** What a meeting's pills start with (older saved pills, else both on). The pills of a meeting live in `assistSourcesStore`. */
  toggles: SourceToggles;
  loaded: boolean;
  /** Why the backend refused the last config (an invalid or duplicate server key); `null` when it took it. */
  pushError: string | null;
  load: () => Promise<void>;
  /** Set, save and give to the backend. Resolves once the backend has answered; never rejects. */
  /** `filing`: what was just added, filed in a workspace too (startup pushes pass none). */
  setConfig: (c: PersonalSourcesConfig, filing?: SourcesFiling) => Promise<void>;
  /**
   * Like `setConfig` for a change that must not be lost (a removal): rejects when
   * the save fails, then nothing reaches the backend and the config goes back to
   * what it was. `afterSave` runs once the save is done, before the backend gets
   * the new config (it still has the old one then); it must not throw.
   */
  setConfigDurably: (c: PersonalSourcesConfig, afterSave?: () => Promise<void>) => Promise<void>;
}

/** Notices of our own saves come back through `onKeyChange`; skip them. */
const ownSaves: Record<string, string[]> = { [CONFIG_KEY]: [] };
const OWN_SAVES_KEPT = 16;

function rememberOwnSave(key: string, value: unknown): string {
  const mine = fingerprint(value);
  ownSaves[key].push(mine);
  if (ownSaves[key].length > OWN_SAVES_KEPT) ownSaves[key].shift();
  return mine;
}

function forgetOwnSave(key: string, mine: string): void {
  const at = ownSaves[key].lastIndexOf(mine);
  if (at >= 0) ownSaves[key].splice(at, 1);
}

/** Save `value`. A failed write is logged and swallowed, unless `strict`: then it is thrown too. */
async function persist(key: string, value: unknown, strict = false): Promise<void> {
  let mine: string | null = null;
  try {
    const store = await getStore();
    mine = rememberOwnSave(key, value);
    await store.set(key, value);
  } catch (e) {
    if (mine) forgetOwnSave(key, mine);
    console.error(`[sourcesStore] Failed to persist ${key}:`, e);
    if (strict) throw e;
  }
}

/** Pushes reach the backend in the order they were made. */
let pushChain: Promise<void> = Promise.resolve();

/**
 * At startup the window can ask before the backend has finished setting up
 * (Tauri: "state not managed ... call `.manage()`"). That's not a refusal:
 * wait and send again, for up to ~30 s.
 */
const STARTING_RE = /state not managed/i;
const STARTING_WAIT_MS = 150;
const STARTING_TRIES = 200;

async function sendWhenReady(config: PersonalSourcesConfig, filing?: SourcesFiling): Promise<void> {
  // Only a push made after the config was read from disk may say so (see `setPersonalSources`).
  return whenBackendReady(() => setPersonalSources(config, filing, useSourcesStore.getState().loaded));
}

async function whenBackendReady<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!STARTING_RE.test(message) || attempt >= STARTING_TRIES) throw e;
      await new Promise((r) => setTimeout(r, STARTING_WAIT_MS));
    }
  }
}

/**
 * A server or folder saved twice (added in two workspaces by an older version)
 * becomes one, in the saved config and in every workspace's links. Call it after
 * the first push: the backend merges what it holds (it takes nothing from here,
 * so this window can't make it move or delete a secret) and this keeps what it
 * returns. Never throws: on any trouble the config stays as it was and the next
 * start tries again.
 */
async function mergeSavedDuplicates(config: PersonalSourcesConfig): Promise<void> {
  try {
    const result = await whenBackendReady(() => repairPersonalSources());
    const merged = (result?.merged_servers ?? 0) + (result?.merged_folders ?? 0);
    if (merged === 0 || !result.config) return;
    // Something changed it while the backend worked: leave it, the next start repairs.
    if (useSourcesStore.getState().config !== config) return;
    const repaired = normalizeSourcesConfig(result.config);
    useSourcesStore.setState({ config: repaired });
    await persist(CONFIG_KEY, repaired);
  } catch (e) {
    console.warn("[sourcesStore] Couldn't merge duplicate sources:", e);
  }
}

function pushToBackend(config: PersonalSourcesConfig, filing?: SourcesFiling): Promise<void> {
  const run = async () => {
    try {
      await sendWhenReady(config, filing);
      useSourcesStore.setState({ pushError: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[sourcesStore] Backend refused the sources:", message);
      useSourcesStore.setState({ pushError: message });
    }
  };
  pushChain = pushChain.then(run, run);
  return pushChain;
}

let unlisten: Array<() => void> = [];

async function watchSaved(): Promise<void> {
  for (const stop of unlisten) stop();
  unlisten = [];
  const store = await getStore();
  unlisten.push(
    await store.onKeyChange<unknown>(CONFIG_KEY, (saved) => {
      if (saved === undefined || saved === null) return;
      const own = ownSaves[CONFIG_KEY].indexOf(fingerprint(saved));
      if (own >= 0) {
        ownSaves[CONFIG_KEY].splice(own, 1);
        return;
      }
      // The window that saved it already told the backend.
      useSourcesStore.setState({ config: normalizeSourcesConfig(saved) });
    }),
  );
}

export const useSourcesStore = create<SourcesState>((set, get) => ({
  config: DEFAULT_SOURCES_CONFIG,
  toggles: DEFAULT_SOURCE_TOGGLES,
  loaded: false,
  pushError: null,

  load: async () => {
    try {
      const store = await getStore();
      // Loading never writes: an old config.json keeps exactly what it had.
      const config = normalizeSourcesConfig(await store.get<unknown>(CONFIG_KEY));
      const toggles = normalizeToggles(await store.get<unknown>(TOGGLES_KEY));
      set({ config, toggles, loaded: true });
      await watchSaved();
      // The backend is the source of truth for answers: give it what we have.
      await pushToBackend(config);
      // The same server saved twice becomes one, from what the backend now holds.
      await mergeSavedDuplicates(config);
    } catch (e) {
      console.error("[sourcesStore] Failed to load:", e);
      set({ loaded: true });
    }
  },

  setConfig: (c, filing) => {
    const config = normalizeSourcesConfig(c);
    set({ config });
    // Save first so a window that opens next sees it, then tell the backend.
    return persist(CONFIG_KEY, config).then(() => pushToBackend(config, filing));
  },

  setConfigDurably: async (c, afterSave) => {
    const config = normalizeSourcesConfig(c);
    const previous = get().config;
    set({ config });
    try {
      await persist(CONFIG_KEY, config, true);
    } catch (e) {
      // Put the old config back, unless something else has changed it meanwhile.
      if (get().config === config) set({ config: previous });
      throw e;
    }
    await afterSave?.();
    await pushToBackend(config);
  },
}));
