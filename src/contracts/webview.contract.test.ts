// The webview half of every contract fixture (the Rust half is src-tauri/src/contract.rs).
//
//  * a COMMAND fixture is the exact arguments object: the real ipc wrapper is called with it
//    and must invoke the same command with exactly those arguments;
//  * a RESULT fixture is what the backend answers: every field the TS type requires must be
//    there and nothing the type does not know may be;
//  * an EVENT fixture is a payload: the real listener from events.ts is fed it and must hand
//    it on, and it must fit the listener's payload type.
//
// A fixture file with no test here fails, and so does an ipc wrapper of a new command with no
// fixture. Both lists below are short on purpose; every line says why.
import { beforeEach, describe, expect, it, vi } from "vitest";
import ipcSource from "../lib/ipc.ts?raw";
import eventsSource from "../lib/events.ts?raw";
import typesSource from "../lib/types.ts?raw";
import libRs from "../../src-tauri/src/lib.rs?raw";
import { fixtureNames, loadFixture } from "./loadFixture";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  },
  emit: async () => {},
}));

import * as ipc from "../lib/ipc";
import * as events from "../lib/events";

// ---- what is exempt (each with its reason)

/** Fixtures with no wrapper, reader or listener to test, and why. */
const NO_TS_COUNTERPART: Record<string, string> = {
  get_meeting_recap_none_result: "a null answer: the wrapper's type (`MeetingRecap | null`) is the whole check",
};

/** Command fixtures that are variants of one command (same wrapper, other arguments). */
const VARIANT_OF: Record<string, string> = {
  ask_workspace_deeper: "ask_workspace",
  list_workspace_meetings_unfiled: "list_workspace_meetings",
  set_chat_item_pref_exclude: "set_chat_item_pref",
  create_memory_by_hand: "create_memory",
  save_meeting_notes_edit_add: "save_meeting_notes_edit",
  save_meeting_notes_edit_delete: "save_meeting_notes_edit",
};

/** Event fixtures that are variants of one event (same listener, another payload). */
const EVENT_VARIANT_OF: Record<string, string> = {
  workspace_chat_approval_refused_off: "workspace_chat_approval_refused",
  notetaker_state_finished: "notetaker_state",
  notetaker_state_finished_stopped: "notetaker_state",
  notetaker_state_finished_interrupted: "notetaker_state",
  notetaker_state_finished_other_meeting: "notetaker_state",
  notetaker_state_finished_nothing_to_note: "notetaker_state",
};

/** Fixtures named like a command that are its RESULT, with the TS type that reads them. */
const RESULT_OF_COMMAND: Record<string, string> = {
  get_meeting_brief: "BriefSheet",
  get_meeting_notes: "NoteDoc",
  workspaces_status_problem: "WorkspacesStatus",
  start_meeting_result: "Meeting",
};

/** Result fixtures (`<command>_result`): the TS type each is read as; `[]` after it means a list. */
const RESULT_TYPES: Record<string, string> = {
  create_workspace_chat_result: "WorkspaceChat",
  get_chat_capabilities_result: "ChatCapabilities",
  get_db_integrity_result: "DbIntegrityFinding",
  get_index_status_result: "IndexStatus",
  get_meeting_recap_result: "MeetingRecap",
  list_chat_item_prefs_result: "ItemPref[]",
  list_chat_meeting_prefs_result: "ChatMeetingPref[]",
  list_workspace_chats_result: "WorkspaceChat[]",
  list_workspace_meetings_result: "WorkspaceMeetingPage",
  list_workspace_messages_result: "WorkspaceMessage[]",
  preview_chat_context_result: "ContextReport",
  retry_open_database_result: "RetryOpenResult",
};

/** Events whose only reader is not a `listen` wrapper in events.ts, and who reads them. */
const EVENT_READ_ELSEWHERE: Record<string, string> = {
  store_recovered: "the same list comes back from `take_store_recovery` (StoreRecovery[]) which StoreRecoveryNotice reads",
};

/** Event fixtures read as a type when events.ts has no wrapper of its own. */
const EVENT_TYPES: Record<string, string> = {
  store_recovered: "StoreRecovery[]",
};

/** Modules of the new features: every registered command of these needs a fixture. */
const NEW_COMMAND_MODULES = ["workspace_commands", "workspace_chat_commands", "db_recovery_commands", "live_commands"];

/** Registered commands of those modules with no fixture yet, and who owes it. */
const PENDING_COMMANDS: string[] = [];

// ---- reading the TS sources

type Wrapper = { fn: string; params: string[]; required: string[]; pairs: Array<[string, string]>; optionalKeys: string[] };

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("<({[".includes(ch)) depth++;
    if (">)}]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** command name -> its wrapper in ipc.ts (the parameters in order, and what the invoke object sends). */
function wrappers(): Map<string, Wrapper> {
  const out = new Map<string, Wrapper>();
  const head = /export (?:async )?function (\w+)\(/g;
  const heads: Array<{ fn: string; at: number; end: number }> = [];
  for (let m = head.exec(ipcSource); m; m = head.exec(ipcSource)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < ipcSource.length && depth > 0) {
      if (ipcSource[i] === "(") depth++;
      if (ipcSource[i] === ")") depth--;
      i++;
    }
    heads.push({ fn: m[1], at: m.index, end: i - 1 });
  }
  const call = /invoke(?:<[^(]*?>)?\(\s*"(\w+)"\s*(,\s*)?/g;
  for (let m = call.exec(ipcSource); m; m = call.exec(ipcSource)) {
    const owner = [...heads].reverse().find((h) => h.at < m!.index);
    if (!owner) continue;
    const sig = ipcSource.slice(ipcSource.indexOf("(", owner.at) + 1, owner.end);
    const sigParts = splitTop(sig).map((p) => p.replace(/^\.\.\./, ""));
    const params = sigParts.map((p) => p.split(/[?:=]/)[0].trim());
    // a parameter with `?` or a default may be left out of a fixture
    const required = sigParts.filter((p) => !/^\w+\s*\?/.test(p) && !/=/.test(p)).map((p) => p.split(/[?:=]/)[0].trim());
    // the invoke object, read with its braces balanced (it may hold a spread of an optional key)
    let object = "";
    if (m[2] && ipcSource[m.index + m[0].length] === "{") {
      let depth = 0;
      for (let k = m.index + m[0].length; k < ipcSource.length; k++) {
        if (ipcSource[k] === "{") depth++;
        if (ipcSource[k] === "}" && --depth === 0) {
          object = ipcSource.slice(m.index + m[0].length + 1, k);
          break;
        }
      }
    }
    const pairs: Array<[string, string]> = [];
    const optionalKeys: string[] = [];
    for (const item of object ? splitTop(object) : []) {
      if (item.startsWith("...")) {
        for (const inner of item.matchAll(/\{\s*(\w+)\s*\}/g)) {
          pairs.push([inner[1], inner[1]]);
          optionalKeys.push(inner[1]);
        }
        continue;
      }
      const [k, v] = item.split(":").map((s) => s.trim());
      pairs.push([k, v ?? k]);
    }
    if (!out.has(m[1])) out.set(m[1], { fn: owner.fn, params, required, pairs, optionalKeys });
  }
  return out;
}

/** Every field of an interface in types.ts or ipc.ts: name -> optional. */
function fieldsOf(typeName: string): Map<string, boolean> {
  for (const src of [typesSource, ipcSource]) {
    const at = src.search(new RegExp(`export interface ${typeName}\\b[^{]*\\{`));
    if (at < 0) continue;
    const start = src.indexOf("{", at) + 1;
    let depth = 1;
    let i = start;
    let level1 = "";
    let line = "";
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      if (ch === "}" || ch === ")" || ch === "]") depth--;
      if (depth === 1 && ch !== "}") line += ch;
      if (ch === "\n" || depth === 0) {
        level1 += line + "\n";
        line = "";
      }
      i++;
    }
    const out = new Map<string, boolean>();
    const parent = src.slice(at, start).match(/extends\s+(\w+)/);
    if (parent) for (const [k, v] of fieldsOf(parent[1])) out.set(k, v);
    for (const m of level1.matchAll(/^\s*(?:readonly\s+)?(\w+)(\?)?\s*:/gm)) out.set(m[1], !!m[2]);
    return out;
  }
  throw new Error(`no interface ${typeName} in types.ts or ipc.ts`);
}

function checkFits(typeSpec: string, value: unknown, where: string) {
  const list = typeSpec.endsWith("[]");
  const name = list ? typeSpec.slice(0, -2) : typeSpec;
  const items = list ? (value as unknown[]) : [value];
  if (list) {
    expect(Array.isArray(value), `${where} is a list`).toBe(true);
    expect(items.length, `${where} has an element (an empty list proves nothing)`).toBeGreaterThan(0);
  }
  const fields = fieldsOf(name);
  for (const item of items) {
    const keys = Object.keys(item as object);
    for (const [f, optional] of fields) {
      if (optional) continue;
      expect(keys, `${where}: ${name}.${f} is required by the TS type`).toContain(f);
    }
    for (const k of keys) {
      expect([...fields.keys()], `${where}: ${k} is not a field of ${name}`).toContain(k);
    }
  }
}

function eventWrappers(): Map<string, { fn: string; type: string | null }> {
  const out = new Map<string, { fn: string; type: string | null }>();
  for (const m of eventsSource.matchAll(/export function (\w+)\([^)]*\)[^{]*\{\s*return listen(?:<([^>]*)>)?\(\s*"([\w:]+)"/g)) {
    out.set(m[3], { fn: m[1], type: m[2] ?? null });
  }
  return out;
}

const names = fixtureNames();
const cmdWrappers = wrappers();
const evWrappers = eventWrappers();

function kindOf(name: string): "command" | "result" | "event" | "exempt" | "none" {
  if (name in NO_TS_COUNTERPART) return "exempt";
  if (name in RESULT_OF_COMMAND || name in RESULT_TYPES) return "result";
  if (name in VARIANT_OF || cmdWrappers.has(name)) return "command";
  if (evWrappers.has(name) || name in EVENT_TYPES || name in EVENT_VARIANT_OF) return "event";
  return "none";
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listeners.clear();
});

describe("every fixture has a test on the webview side", () => {
  it("is covered by a command, result or event test, or is exempt", () => {
    const uncovered = names.filter((n) => kindOf(n) === "none");
    expect(uncovered, `fixtures no TS test reads: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("has a fixture for every ipc wrapper of a new command", () => {
    const registered: string[] = [];
    for (const m of libRs.matchAll(/^\s*(\w+)::(\w+),/gm)) if (NEW_COMMAND_MODULES.includes(m[1])) registered.push(m[2]);
    expect(registered.length).toBeGreaterThan(30);
    const bare = registered.filter((c) => cmdWrappers.has(c) && !names.includes(c) && !PENDING_COMMANDS.includes(c));
    expect(bare, `ipc wrappers with no fixture: ${bare.join(", ")}`).toEqual([]);
    for (const c of PENDING_COMMANDS) expect(names, `${c} has one now: take it off the pending list`).not.toContain(c);
  });
});

describe("command fixtures: the real wrapper sends exactly these arguments", () => {
  const commands = names.filter((n) => kindOf(n) === "command");
  it("finds the wrappers", () => expect(commands.length).toBeGreaterThan(50));
  for (const name of commands) {
    it(name, async () => {
      const command = VARIANT_OF[name] ?? name;
      const w = cmdWrappers.get(command)!;
      const args = loadFixture<Record<string, unknown>>(name);
      // the invoke object's key for each parameter (`{ id, kind }` or `{ workspaceId: id }`)
      const keyOf = (param: string) => w.pairs.find(([, v]) => v === param)?.[0] ?? param;
      // The fixture must name every argument the wrapper needs, and only ones it sends: an
      // argument missing here would otherwise pass (`undefined` is not sent, so nothing differs).
      const sentKeys = w.pairs.map(([k]) => k);
      for (const p of w.required) expect(Object.keys(args), `${name}: the wrapper needs \`${p}\` and the fixture lacks it`).toContain(keyOf(p));
      for (const k of Object.keys(args)) expect(sentKeys, `${name}: \`${k}\` is not an argument the wrapper sends`).toContain(k);
      // start_meeting answers with the meeting as JSON text
      if (command === "start_meeting") invoke.mockResolvedValue(JSON.stringify(loadFixture("start_meeting_result")));
      const call = w.params.map((p) => args[keyOf(p)]);
      await (ipc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[w.fn](...call);
      expect(invoke).toHaveBeenCalledTimes(1);
      const [sentName, sentArgs] = invoke.mock.calls[0];
      expect(sentName).toBe(command);
      // JSON is what crosses the bridge: `undefined` is not sent
      expect(JSON.parse(JSON.stringify(sentArgs ?? {}))).toEqual(args);
    });
  }
});

describe("result fixtures: every field the TS type needs is there and nothing else", () => {
  for (const name of names.filter((n) => kindOf(n) === "result")) {
    it(name, () => {
      const type = RESULT_OF_COMMAND[name] ?? RESULT_TYPES[name];
      checkFits(type, loadFixture(name), name);
    });
  }
});

describe("event fixtures: the real listener passes the payload on", () => {
  for (const name of names.filter((n) => kindOf(n) === "event")) {
    it(name, async () => {
      const payload = loadFixture(name);
      const event = EVENT_VARIANT_OF[name] ?? name;
      const w = evWrappers.get(event);
      if (!w) {
        expect(name in EVENT_READ_ELSEWHERE, `${name} has no listener in events.ts and no stated reader`).toBe(true);
        checkFits(EVENT_TYPES[name], payload, name);
        return;
      }
      const got = vi.fn();
      await (events as unknown as Record<string, (h: (e: unknown) => void) => Promise<unknown>>)[w.fn](got);
      const cb = listeners.get(event);
      expect(cb, `${w.fn} listens for ${event}`).toBeTruthy();
      cb!({ payload });
      expect(got).toHaveBeenCalledTimes(1);
      expect(got.mock.calls[0][0]).toEqual(payload);
      if (w.type && /^[A-Z]\w+(\[\])?$/.test(w.type)) {
        try {
          fieldsOf(w.type.replace(/\[\]$/, ""));
        } catch {
          return; // a type alias, not an interface: the listener round trip above is the check
        }
        checkFits(w.type, payload, name);
      }
    });
  }
});
